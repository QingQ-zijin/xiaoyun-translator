import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiSpeakerHigh } from 'react-icons/pi';

import {
    authorizeEmbeddingInstall,
    askPaper,
    cancelResearchJob,
    choosePdfPaths,
    defineTerm,
    deleteAnnotation,
    enqueueOcrPage,
    getDocument,
    generateChapterInsights,
    generatePaperInsights,
    getPaperInsights,
    getPdfSource,
    getSemanticStatus,
    getTranslationStatus,
    indexDocumentPage,
    isTauriRuntime,
    listAnnotations,
    listChapterInsights,
    listPendingPaperInsights,
    listPaperRelations,
    pauseResearchJob,
    rebuildDocumentOutline,
    replaceDocumentOutline,
    saveAnnotation,
    saveReadingProgress,
    speakText,
    startEmbeddingIndex,
    startOcrJob,
    subscribeToPdfDrops,
    subscribeToResearchJobs,
    translateSelection,
    syncPaperReferences,
    updateDocumentPageCount,
} from '../../domains/research/bridge';
import { DEMO_PAGE, DEMO_TRANSLATION } from '../../domains/research/demoData';
import { UNIFIED_OLLAMA_MODEL } from '../../domains/ollama/runtime';
import {
    annotationKind,
    classifySelection,
    createSelectionAnchor,
    PDF_SELECTION_DEBOUNCE_MS,
    RESEARCH_AI_INTENTS,
    shouldConfirmEmbeddingInstall,
} from '../../domains/research/model';
import { resolveAcademicTargetLanguage } from '../../domains/translation/language';
import { cancelSpeechRequest, useSpeechRequest } from '../../hooks/useVoice';
import { formatShortcutForPlatform, getPlatformPresentation } from '../../utils/platform';
import {
    annotationUndoOperation,
    appendAnnotationUndoAction,
    applyAnnotationUndo,
    createAnnotationUndoAction,
    isCurrentAnnotationSave,
    shouldHandleAnnotationUndo,
} from './annotationUndo';
import AppRail from './components/AppRail';
import AnnotationEditorPopover from './components/AnnotationEditorPopover';
import ImportKindDialog from './components/ImportKindDialog';
import LibrarySidebar from './components/LibrarySidebar';
import PaperLibrary from './components/PaperLibrary';
import PdfWorkspace from './components/PdfWorkspace';
import ReaderTopbar, { getOllamaModelDisplayName, getTranslationStatusPresentation } from './components/ReaderTopbar';
import SelectionContextMenu from './components/SelectionContextMenu';
import SelectionTranslationPopover from './components/SelectionTranslationPopover';
import { useResearchLibrary } from './hooks/useResearchLibrary';
import {
    enqueueImportedPapersInsights,
    enqueuePreparedPaperInsights,
    hasReadyPaperInsights,
} from './paperInsightsQueue';
import { useResearchSidebarResize } from './useResearchSidebarResize';
import './research.css';

const INITIAL_DEMO_SELECTION = createSelectionAnchor({
    paperId: 'demo-memory',
    pageNumber: 2,
    quote: DEMO_PAGE.selected,
    pageText: `${DEMO_PAGE.before} ${DEMO_PAGE.selected} ${DEMO_PAGE.after}`,
});

const PAPER_SELECTION_TRANSLATION_TIMEOUT_MS = 20_000;
const PAPER_SELECTION_RECOVERY_TIMEOUT_MS = 130_000;
const RESEARCH_TOAST_DURATION_MS = 2_200;
const PLATFORM_PRESENTATION = getPlatformPresentation();
const UNDO_SHORTCUT = formatShortcutForPlatform('CommandOrControl+Z');

function createResearchToast(message) {
    const text = String(message ?? '').trim();
    return text ? { id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, text } : null;
}

export function availableLibraryPapers(papers = []) {
    return papers.filter((paper) => paper && !paper.trashedAt && !paper.archivedAt);
}

export function getLibraryPaperCounts(papers = []) {
    const available = availableLibraryPapers(papers);
    return {
        all: available.length,
        tagged: available.filter((paper) => paper.tags?.length > 0).length,
        unclassified: available.filter((paper) => !(paper.projects?.length > 0)).length,
        archive: papers.filter((paper) => paper && !paper.trashedAt && paper.archivedAt).length,
        trash: papers.filter((paper) => paper?.trashedAt).length,
    };
}

function LibraryTopbar({ translationStatus }) {
    const modelStatus = getTranslationStatusPresentation(translationStatus);
    return (
        <header className='library-topbar'>
            <div>
                <strong>AI-driven academic research</strong>
                <span>论文、批注与本地模型都留在你的电脑上</span>
            </div>
            <div className='reader-topbar__status'>
                <span
                    className='model-status'
                    data-state={modelStatus.state}
                    title={translationStatus?.message || '正在检查本地 Ollama'}
                >
                    <i style={{ background: modelStatus.color }} />
                    {getOllamaModelDisplayName(translationStatus?.model)} · {modelStatus.label}
                </span>
                <span className='voice-status'>
                    <PiSpeakerHigh aria-hidden='true' />
                    {PLATFORM_PRESENTATION.speechStatus}
                </span>
            </div>
        </header>
    );
}

export default function Research({ onNavigate, embedded = false, startInLibrary = false }) {
    const library = useResearchLibrary();
    const sidebarResize = useResearchSidebarResize();
    const runSpeechRequest = useSpeechRequest();
    const pdfRef = useRef(null);
    const aiAbortRef = useRef(null);
    const translationRequestRef = useRef({ id: 0, controller: null });
    const startWithDemo = !startInLibrary && !isTauriRuntime();
    const [paperId, setPaperId] = useState(() => (startWithDemo ? 'demo-memory' : ''));
    const paperIdRef = useRef(paperId);
    const [document, setDocument] = useState(null);
    const [documentError, setDocumentError] = useState('');
    const [annotations, setAnnotations] = useState([]);
    const [currentPage, setCurrentPage] = useState(1);
    const [pageCount, setPageCount] = useState(1);
    const [scale, setScale] = useState(1.25);
    const [selection, setSelection] = useState(() => (startWithDemo ? INITIAL_DEMO_SELECTION : null));
    const [selectionPageText, setSelectionPageText] = useState(() =>
        startWithDemo ? `${DEMO_PAGE.before} ${DEMO_PAGE.selected} ${DEMO_PAGE.after}` : ''
    );
    const [translation, setTranslation] = useState(() => ({
        status: startWithDemo ? 'complete' : 'idle',
        loading: false,
        text: startWithDemo ? DEMO_TRANSLATION : '',
        error: '',
        message: '',
    }));
    const [translationRetryToken, setTranslationRetryToken] = useState(0);
    const [lexiconState, setLexiconState] = useState({ loading: false, entry: null, error: '' });
    const [insights, setInsights] = useState({ status: startWithDemo ? 'loading' : 'not_started' });
    const insightsRef = useRef(insights);
    const [insightsError, setInsightsError] = useState('');
    const [chapterInsights, setChapterInsights] = useState([]);
    const [chapterInsightState, setChapterInsightState] = useState({
        selectedIndex: null,
        status: 'idle',
        insight: null,
        error: '',
    });
    const [translationStatus, setTranslationStatus] = useState(() => ({
        model: UNIFIED_OLLAMA_MODEL,
        ready: !isTauriRuntime(),
        message: isTauriRuntime() ? '正在检查本地 Ollama' : 'Gemma 4 E4B 已就绪',
    }));
    const [targetLanguage, setTargetLanguage] = useState('zh_cn');
    const [interactionMode, setInteractionMode] = useState('select');
    const [aiState, setAiState] = useState({
        loading: false,
        answer: '',
        citations: [],
        error: '',
        refused: false,
        retrievalMode: '',
    });
    const [selectionOverlay, setSelectionOverlay] = useState(null);
    const [selectionMenu, setSelectionMenu] = useState(null);
    const [noteEditorOpen, setNoteEditorOpen] = useState(false);
    const [noteEditorTarget, setNoteEditorTarget] = useState(null);
    const [readerSidebarTab, setReaderSidebarTab] = useState('insights');
    const [annotationKindFilter, setAnnotationKindFilter] = useState('');
    const [relations, setRelations] = useState({ outbound: [], inbound: [] });
    const [dragDepth, setDragDepth] = useState(0);
    const [importRequest, setImportRequest] = useState({ open: false, paths: null });
    const [toastNotice, setToastNotice] = useState(null);
    const [researchJob, setResearchJob] = useState(null);
    const ocrProducerRef = useRef(null);
    const indexedPageTextRef = useRef(new Map());
    const indexedDocumentRef = useRef(new Set());
    const persistedOutlineRef = useRef(new Map());
    const observedInsightsJobsRef = useRef(new Set());
    const completedOcrJobsRef = useRef(new Set());
    const chapterInsightRequestRef = useRef(0);
    const annotationUndoStackRef = useRef([]);
    const annotationUndoInFlightRef = useRef(false);
    const annotationsRef = useRef(annotations);
    const readerEpochRef = useRef(0);
    const restoreRecentPaperRef = useRef(!startInLibrary && isTauriRuntime());
    const browserImportKindRef = useRef('paper');
    const libraryPapersRef = useRef(library.papers);
    paperIdRef.current = paperId;
    insightsRef.current = insights;
    annotationsRef.current = annotations;
    libraryPapersRef.current = library.papers;

    useEffect(() => {
        if (!toastNotice) return undefined;
        const noticeId = toastNotice.id;
        const timeoutId = globalThis.setTimeout(() => {
            setToastNotice((current) => (current?.id === noticeId ? null : current));
        }, RESEARCH_TOAST_DURATION_MS);
        return () => globalThis.clearTimeout(timeoutId);
    }, [toastNotice]);

    const invalidateSelectionTranslation = useCallback(() => {
        const active = translationRequestRef.current;
        active.controller?.abort();
        translationRequestRef.current = { id: active.id + 1, controller: null };
    }, []);

    const scheduleImportedInsights = useCallback((importedPapers, options) => {
        for (const { paperId: queuedPaperId, promise } of enqueueImportedPapersInsights(importedPapers, options)) {
            if (observedInsightsJobsRef.current.has(promise)) continue;
            observedInsightsJobsRef.current.add(promise);
            const releaseObservation = () => observedInsightsJobsRef.current.delete(promise);
            void promise
                .then((nextInsights) => {
                    releaseObservation();
                    if (paperIdRef.current === queuedPaperId) {
                        setInsights(nextInsights);
                        setInsightsError('');
                    }
                })
                .catch((reason) => {
                    releaseObservation();
                    if (paperIdRef.current !== queuedPaperId) return;
                    const message = String(reason?.message ?? reason);
                    setInsightsError(message);
                    setInsights((current) =>
                        current?.status === 'ready' ? current : { ...current, status: 'failed', error: message }
                    );
                });
        }
    }, []);

    const openImportKindDialog = useCallback((paths = null) => {
        const safePaths = Array.isArray(paths) && paths.length > 0 ? paths : null;
        setImportRequest({ open: true, paths: safePaths });
    }, []);

    useEffect(() => {
        if (!isTauriRuntime()) return undefined;
        let cancelled = false;
        let timer = null;
        let retryDelay = 5_000;
        const recoverPendingInsights = async () => {
            try {
                const paperIds = await listPendingPaperInsights();
                if (cancelled) return;
                const papersById = new Map(
                    (libraryPapersRef.current ?? []).map((paper) => [String(paper?.id ?? ''), paper])
                );
                // 等论文列表完成加载后再恢复任务，确保书籍不会被误走整篇论文概要流程。
                scheduleImportedInsights((paperIds ?? []).map((id) => papersById.get(String(id))).filter(Boolean));
                retryDelay = 15_000;
            } catch (reason) {
                if (cancelled) return;
                setDocumentError(`恢复待生成论文概要失败：${String(reason?.message ?? reason)}`);
                retryDelay = Math.min(30_000, retryDelay * 2);
            }
            if (!cancelled) timer = setTimeout(recoverPendingInsights, retryDelay);
        };
        void recoverPendingInsights();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [scheduleImportedInsights]);

    useEffect(() => {
        let cancelled = false;
        let timer = null;
        const refresh = async () => {
            let ready = false;
            try {
                const status = await getTranslationStatus();
                ready = status?.ready === true;
                if (!cancelled) setTranslationStatus(status);
            } catch (reason) {
                if (!cancelled) {
                    setTranslationStatus((current) => ({
                        ...current,
                        ready: false,
                        message: `无法检查本地翻译模型：${String(reason)}`,
                    }));
                }
            }
            if (!cancelled) {
                // 启动阶段快速追踪预热结果；就绪后降低轮询频率，避免无意义请求。
                timer = setTimeout(refresh, ready ? 30_000 : 2_000);
            }
        };
        void refresh();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, []);
    const isReader = Boolean(paperId && document);
    const sidebarCollapsed = isReader && sidebarResize.collapsed;
    const selectionKind = useMemo(() => classifySelection(selection?.quote), [selection?.quote]);

    const availablePapers = useMemo(() => availableLibraryPapers(library.papers), [library.papers]);
    const paperCounts = useMemo(() => getLibraryPaperCounts(library.papers), [library.papers]);

    useEffect(() => {
        if (!paperId) {
            setDocument(null);
            setAnnotations([]);
            setRelations({ outbound: [], inbound: [] });
            setNoteEditorOpen(false);
            setNoteEditorTarget(null);
            setReaderSidebarTab('insights');
            setAnnotationKindFilter('');
            setInsights({ status: 'not_started' });
            setInsightsError('');
            setChapterInsights([]);
            setChapterInsightState({ selectedIndex: null, status: 'idle', insight: null, error: '' });
            return undefined;
        }
        let cancelled = false;
        setDocumentError('');
        setInsightsError('');
        Promise.all([
            getDocument(paperId),
            listAnnotations(paperId),
            listPaperRelations(paperId),
            getPaperInsights(paperId).catch((reason) => ({ status: 'failed', error: String(reason) })),
            listChapterInsights(paperId).catch(() => []),
        ])
            .then(([nextDocument, nextAnnotations, nextRelations, nextInsights, nextChapterInsights]) => {
                if (cancelled) return;
                setDocument(nextDocument);
                persistedOutlineRef.current.set(nextDocument.paper.id, JSON.stringify(nextDocument.outline ?? []));
                setAnnotations(nextAnnotations ?? []);
                setRelations(nextRelations ?? { outbound: [], inbound: [] });
                setInsights(
                    nextInsights?.status === 'not_started'
                        ? { ...nextInsights, status: 'indexing' }
                        : nextInsights ?? { status: 'indexing' }
                );
                setInsightsError(nextInsights?.status === 'failed' ? nextInsights.error ?? '' : '');
                setChapterInsights(nextChapterInsights ?? []);
                setChapterInsightState({ selectedIndex: null, status: 'idle', insight: null, error: '' });
                setReaderSidebarTab(nextDocument.paper?.contentKind === 'book' ? 'outline' : 'insights');
                setAnnotationKindFilter('');
                const progress = nextDocument.progress ?? nextDocument.paper?.progress ?? {};
                setCurrentPage(progress.pageNumber ?? 1);
                setScale(progress.scale ?? 1.25);
                setPageCount(nextDocument.pageCount ?? nextDocument.paper?.pageCount ?? 1);
                if (isTauriRuntime()) {
                    setSelection(null);
                    setSelectionOverlay(null);
                    setSelectionMenu(null);
                    setNoteEditorOpen(false);
                    setNoteEditorTarget(null);
                    setTranslation({ status: 'idle', loading: false, text: '', error: '' });
                    setLexiconState({ loading: false, entry: null, error: '' });
                }
            })
            .catch((reason) => {
                if (!cancelled) setDocumentError(String(reason));
            });
        return () => {
            cancelled = true;
        };
    }, [paperId]);

    useEffect(() => {
        let unlisten = () => {};
        void subscribeToResearchJobs((event) => {
            if (!event) return;
            const isActivePaper = event.paperId === paperId;
            if (isActivePaper) setResearchJob(event);
            if (ocrProducerRef.current?.jobId === event.jobId) {
                ocrProducerRef.current.completed = event.completed ?? ocrProducerRef.current.completed;
                if (['failed', 'cancelled'].includes(event.state)) ocrProducerRef.current.cancelled = true;
            }
            if (event.kind?.startsWith('ocr-')) {
                if (isActivePaper) setToastNotice(createResearchToast(event.message || '正在进行后台 OCR'));
                if (event.state === 'completed' && !completedOcrJobsRef.current.has(event.jobId)) {
                    completedOcrJobsRef.current.add(event.jobId);
                    void rebuildDocumentOutline(event.paperId, 'ocr')
                        .then((outline) => {
                            if (paperIdRef.current !== event.paperId || !outline?.length) return;
                            persistedOutlineRef.current.set(event.paperId, JSON.stringify(outline));
                            setDocument((current) =>
                                current?.paper?.id === event.paperId ? { ...current, outline } : current
                            );
                        })
                        .catch((reason) => {
                            if (paperIdRef.current === event.paperId) {
                                setDocumentError(`OCR 完成后重建章节目录失败：${String(reason?.message ?? reason)}`);
                            }
                        });
                    // OCR 文字已经写入 document_chunks，重新排队即可复用持久化概要流程。
                    scheduleImportedInsights([{ id: event.paperId }], { revalidate: true });
                }
            }
        }).then((dispose) => {
            unlisten = dispose;
        });
        return () => unlisten();
    }, [paperId, scheduleImportedInsights]);

    useEffect(() => {
        if (!selection || !document?.paper) return undefined;
        const controller = new AbortController();
        const requestId = translationRequestRef.current.id + 1;
        translationRequestRef.current = { id: requestId, controller };
        const isCurrentRequest = () => translationRequestRef.current.id === requestId && !controller.signal.aborted;
        let watchdogTimer = null;
        // 先立即呈现空的加载浮窗，再用极短防抖发请求；界面响应不再被请求防抖阻塞。
        setTranslation({ status: 'loading', loading: true, text: '', error: '', message: '' });
        const timer = setTimeout(() => {
            const armWatchdog = (timeoutMs, timeoutMessage) => {
                clearTimeout(watchdogTimer);
                watchdogTimer = setTimeout(() => {
                    if (!isCurrentRequest()) return;
                    controller.abort();
                    setTranslation({
                        status: 'failed',
                        loading: false,
                        text: '',
                        error: timeoutMessage,
                        message: '',
                    });
                    setTranslationStatus((current) => ({ ...current, ready: false, message: timeoutMessage }));
                }, timeoutMs);
            };
            armWatchdog(PAPER_SELECTION_TRANSLATION_TIMEOUT_MS, '论文划词翻译等待超过 20 秒，已取消。请重试。');
            void translateSelection({
                selection,
                paperTitle: document.paper.title,
                paperInsights: insightsRef.current,
                targetLanguage,
                signal: controller.signal,
                onDelta: (text) => {
                    if (isCurrentRequest()) {
                        armWatchdog(
                            PAPER_SELECTION_TRANSLATION_TIMEOUT_MS,
                            '论文划词翻译流式输出中断超过 20 秒，已取消。请重试。'
                        );
                        setTranslation({ status: 'loading', loading: true, text, error: '', message: '' });
                    }
                },
                onStatus: (message) => {
                    if (!isCurrentRequest()) return;
                    armWatchdog(
                        PAPER_SELECTION_RECOVERY_TIMEOUT_MS,
                        '本地 AI 自动启动超过 130 秒，已取消。请检查 Ollama 后重试。'
                    );
                    setTranslation((current) => ({
                        ...current,
                        status: 'loading',
                        loading: true,
                        error: '',
                        message,
                    }));
                    setTranslationStatus((current) => ({ ...current, ready: false, message }));
                },
            })
                .then((text) => {
                    clearTimeout(watchdogTimer);
                    if (isCurrentRequest()) {
                        translationRequestRef.current = { id: requestId, controller: null };
                        setTranslation({ status: 'complete', loading: false, text, error: '', message: '' });
                        setTranslationStatus((current) => ({
                            ...current,
                            ready: true,
                            message: `${current.model || '本地翻译模型'} 已就绪`,
                        }));
                    }
                })
                .catch((reason) => {
                    clearTimeout(watchdogTimer);
                    if (isCurrentRequest() && reason?.name !== 'AbortError') {
                        translationRequestRef.current = { id: requestId, controller: null };
                        const message = String(reason?.message ?? reason);
                        setTranslation({ status: 'failed', loading: false, text: '', error: message, message: '' });
                        setTranslationStatus((current) => ({
                            ...current,
                            ready: false,
                            message,
                        }));
                    }
                });
        }, PDF_SELECTION_DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            clearTimeout(watchdogTimer);
            controller.abort();
            if (translationRequestRef.current.id === requestId) {
                translationRequestRef.current = { id: requestId + 1, controller: null };
            }
        };
    }, [document?.paper, selection, targetLanguage, translationRetryToken]);

    useEffect(() => {
        if (selectionKind !== 'vocabulary' || !selection || !document?.paper || translation.status !== 'complete') {
            return undefined;
        }
        const controller = new AbortController();
        // 词典使用研究模型，稍候到用户停止连续划词后再启动；新选区会在模型换入前取消该任务。
        const timer = setTimeout(() => {
            setLexiconState({ loading: true, entry: null, error: '' });
            void defineTerm({ selection, targetLanguage, signal: controller.signal })
                .then((entry) => {
                    if (!controller.signal.aborted) setLexiconState({ loading: false, entry, error: '' });
                })
                .catch((reason) => {
                    if (!controller.signal.aborted && reason?.name !== 'AbortError') {
                        setLexiconState({ loading: false, entry: null, error: String(reason?.message ?? reason) });
                    }
                });
        }, 650);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [document?.paper, selection, selectionKind, targetLanguage, translation.status]);

    useEffect(() => {
        let unlisten = () => {};
        void subscribeToPdfDrops((paths) => {
            if (paths.length > 0) openImportKindDialog(paths);
        }).then((dispose) => {
            unlisten = dispose;
        });
        return () => unlisten();
    }, [openImportKindDialog]);

    useEffect(
        () => () => {
            aiAbortRef.current?.abort();
            cancelSpeechRequest();
            chapterInsightRequestRef.current += 1;
            if (ocrProducerRef.current && !ocrProducerRef.current.cancelled) {
                ocrProducerRef.current.cancelled = true;
                void cancelResearchJob(ocrProducerRef.current.jobId).catch(() => undefined);
            }
        },
        []
    );

    const handleSelection = useCallback(
        (anchor, pageText, overlay) => {
            invalidateSelectionTranslation();
            cancelSpeechRequest();
            setSelection(anchor);
            setSelectionPageText(pageText);
            setSelectionOverlay(overlay);
            setSelectionMenu(null);
            setNoteEditorOpen(false);
            setNoteEditorTarget(null);
            setTargetLanguage((current) => resolveAcademicTargetLanguage(anchor?.quote, current));
            setTranslation({ status: 'loading', loading: true, text: '', error: '' });
            setLexiconState({ loading: false, entry: null, error: '' });
            setAiState({
                loading: false,
                answer: '',
                citations: [],
                error: '',
                refused: false,
                retrievalMode: '',
            });
        },
        [invalidateSelectionTranslation]
    );

    const handleTargetLanguageChange = useCallback(
        (nextTarget) => {
            invalidateSelectionTranslation();
            setTargetLanguage(resolveAcademicTargetLanguage(selection?.quote, nextTarget));
            setTranslation({ status: 'loading', loading: true, text: '', error: '' });
            setLexiconState({ loading: false, entry: null, error: '' });
        },
        [invalidateSelectionTranslation, selection?.quote]
    );

    const retrySelectionTranslation = useCallback(() => {
        if (!selection || !document?.paper) return;
        invalidateSelectionTranslation();
        setTranslation({ status: 'loading', loading: true, text: '', error: '' });
        setTranslationRetryToken((current) => current + 1);
    }, [document?.paper, invalidateSelectionTranslation, selection]);

    const openPaper = useCallback(
        (nextPaperId) => {
            if (!nextPaperId) return;
            pdfRef.current?.flushProgress?.();
            aiAbortRef.current?.abort();
            cancelSpeechRequest();
            if (ocrProducerRef.current && !ocrProducerRef.current.cancelled) {
                ocrProducerRef.current.cancelled = true;
                void cancelResearchJob(ocrProducerRef.current.jobId).catch(() => undefined);
            }
            invalidateSelectionTranslation();
            chapterInsightRequestRef.current += 1;
            readerEpochRef.current += 1;
            annotationUndoStackRef.current = [];
            setSelection(null);
            setSelectionOverlay(null);
            setSelectionMenu(null);
            setNoteEditorOpen(false);
            setNoteEditorTarget(null);
            setReaderSidebarTab('insights');
            setAnnotationKindFilter('');
            setTranslation({ status: 'idle', loading: false, text: '', error: '' });
            setLexiconState({ loading: false, entry: null, error: '' });
            setAiState({
                loading: false,
                answer: '',
                citations: [],
                error: '',
                refused: false,
                retrievalMode: '',
            });
            setToastNotice(null);
            setDocument(null);
            library.markPaperOpened?.(nextPaperId);
            setPaperId(nextPaperId);
        },
        [invalidateSelectionTranslation, library.markPaperOpened]
    );

    useEffect(() => {
        if (!restoreRecentPaperRef.current || library.loading || paperId) return;
        restoreRecentPaperRef.current = false;
        const recentPaper = availablePapers[0];
        if (recentPaper) openPaper(recentPaper.id);
    }, [availablePapers, library.loading, openPaper, paperId]);

    const handlePageJump = useCallback(
        (target) => {
            const annotation = target && typeof target === 'object' ? target : null;
            const pageNumber = annotation?.pageNumber ?? target;
            const safePage = Math.min(pageCount, Math.max(1, Number(pageNumber) || 1));
            setCurrentPage(safePage);
            if (annotation && pdfRef.current?.goToAnnotation) pdfRef.current.goToAnnotation(annotation);
            else pdfRef.current?.goToPage(safePage);
        },
        [pageCount]
    );

    const handleOpenAnnotation = useCallback(
        (annotation) => {
            if (!annotation) return;
            handlePageJump(annotation);
            if (annotationKind(annotation) !== 'note') return;
            sidebarResize.expand();
            setReaderSidebarTab('annotations');
            setAnnotationKindFilter('note');
            setSelectionMenu(null);
            setNoteEditorTarget(annotation);
            setNoteEditorOpen(true);
        },
        [handlePageJump, sidebarResize.expand]
    );

    const requestChapterInsights = useCallback(
        async (chapter, index, force = false) => {
            const activePaperId = document?.paper?.id;
            if (!activePaperId || !chapter?.title) return;
            const requestId = chapterInsightRequestRef.current + 1;
            chapterInsightRequestRef.current = requestId;
            const descriptor = { ...chapter, ordinal: index, index };
            setChapterInsightState({ selectedIndex: index, status: 'loading', insight: null, error: '' });
            try {
                // 非强制调用会由 Rust 按“章节正文哈希 + Gemma 版本”直接命中持久化缓存。
                const generated = await generateChapterInsights(activePaperId, descriptor, { force });
                if (chapterInsightRequestRef.current !== requestId || paperIdRef.current !== activePaperId) return;
                setChapterInsights((current) => {
                    const next = current.filter((item) => item.ordinal !== generated.ordinal);
                    next.push(generated);
                    return next.sort((left, right) => left.ordinal - right.ordinal);
                });
                setChapterInsightState({
                    selectedIndex: index,
                    status: generated.status ?? 'ready',
                    insight: generated,
                    error: generated.error ?? '',
                });
            } catch (reason) {
                if (chapterInsightRequestRef.current !== requestId || paperIdRef.current !== activePaperId) return;
                setChapterInsightState({
                    selectedIndex: index,
                    status: 'failed',
                    insight: null,
                    error: String(reason?.message ?? reason),
                });
            }
        },
        [document?.paper?.id]
    );

    const handleSelectChapter = useCallback(
        (chapter, index) => requestChapterInsights(chapter, index, false),
        [requestChapterInsights]
    );

    const handleRegenerateChapter = useCallback(
        (chapter, index) => requestChapterInsights(chapter, index, true),
        [requestChapterInsights]
    );

    const handleSaveAnnotation = useCallback(
        async (annotation) => {
            if (!document?.paper) return;
            const sourcePaperId = document.paper.id;
            const sourceEpoch = readerEpochRef.current;
            const previous = annotation.id
                ? annotationsRef.current.find((item) => item.id === annotation.id) ?? null
                : null;
            const saved = await saveAnnotation({ ...annotation, paperId: sourcePaperId });
            if (
                !isCurrentAnnotationSave({
                    sourcePaperId,
                    sourceEpoch,
                    currentPaperId: paperIdRef.current,
                    currentEpoch: readerEpochRef.current,
                })
            ) {
                return saved;
            }
            setAnnotations((current) => {
                const exists = current.some((item) => item.id === saved.id);
                const next = exists
                    ? current.map((item) => (item.id === saved.id ? saved : item))
                    : [saved, ...current];
                annotationsRef.current = next;
                return next;
            });
            const action = previous
                ? createAnnotationUndoAction('update', { before: previous, after: saved })
                : createAnnotationUndoAction('create', { after: saved });
            annotationUndoStackRef.current = appendAnnotationUndoAction(annotationUndoStackRef.current, action);
            if (annotationKind(saved) === 'note') {
                sidebarResize.expand();
                setReaderSidebarTab('annotations');
                setAnnotationKindFilter('note');
                setToastNotice(createResearchToast(previous ? '笔记已更新' : '笔记已保存，可在左侧查看'));
            }
            return saved;
        },
        [document?.paper, sidebarResize.expand]
    );

    const undoLatestAnnotation = useCallback(async () => {
        if (annotationUndoInFlightRef.current) return false;
        const action = annotationUndoStackRef.current.pop();
        const operation = annotationUndoOperation(action);
        if (!operation) return false;
        const sourcePaperId = action.before?.paperId ?? action.after?.paperId;
        const sourceEpoch = readerEpochRef.current;
        annotationUndoInFlightRef.current = true;
        try {
            const restored =
                operation.type === 'delete'
                    ? await deleteAnnotation(operation.annotationId)
                    : await saveAnnotation(operation.annotation);
            if (
                isCurrentAnnotationSave({
                    sourcePaperId,
                    sourceEpoch,
                    currentPaperId: paperIdRef.current,
                    currentEpoch: readerEpochRef.current,
                })
            ) {
                setAnnotations((current) => {
                    const next = applyAnnotationUndo(current, action, restored);
                    annotationsRef.current = next;
                    return next;
                });
                const actionLabel = action.type === 'delete' ? '删除' : action.type === 'update' ? '编辑' : '创建';
                setToastNotice(createResearchToast(`已撤销最近一次${actionLabel}`));
            }
            return true;
        } catch (reason) {
            if (
                isCurrentAnnotationSave({
                    sourcePaperId,
                    sourceEpoch,
                    currentPaperId: paperIdRef.current,
                    currentEpoch: readerEpochRef.current,
                })
            ) {
                annotationUndoStackRef.current = appendAnnotationUndoAction(annotationUndoStackRef.current, action);
                setToastNotice(createResearchToast(`撤销批注失败：${String(reason?.message ?? reason)}`));
            }
            return false;
        } finally {
            annotationUndoInFlightRef.current = false;
        }
    }, []);

    useEffect(() => {
        if (!isReader) return undefined;
        const handleUndo = (event) => {
            if (!shouldHandleAnnotationUndo(event) || annotationUndoStackRef.current.length === 0) return;
            event.preventDefault();
            void undoLatestAnnotation();
        };
        globalThis.addEventListener?.('keydown', handleUndo);
        return () => globalThis.removeEventListener?.('keydown', handleUndo);
    }, [isReader, undoLatestAnnotation]);

    const annotationTagSuggestions = useMemo(
        () => [...library.tags.map((tag) => tag.name), ...annotations.flatMap((annotation) => annotation.tags ?? [])],
        [annotations, library.tags]
    );

    const openNoteEditorForSelection = useCallback(() => {
        if (!selection) return;
        setNoteEditorTarget(selection);
        setNoteEditorOpen(true);
    }, [selection]);

    const closeNoteEditor = useCallback(() => {
        setNoteEditorOpen(false);
        setNoteEditorTarget(null);
        setSelectionMenu(null);
    }, []);

    const highlightSelection = useCallback(
        async ({ color = 'violet' } = {}) => {
            if (!selection) return;
            await handleSaveAnnotation({ ...selection, kind: 'highlight', color, note: '', tags: [] });
        },
        [handleSaveAnnotation, selection]
    );

    const handleAnnotationActivate = useCallback(
        (annotation) => {
            if (!annotation) return;
            if (annotationKind(annotation) === 'note') {
                handleOpenAnnotation(annotation);
                return;
            }
            handlePageJump(annotation);
            const tags = (annotation.tags ?? []).map((tag) => `#${tag}`).join(' ');
            setToastNotice(
                createResearchToast([annotation.note, tags].filter(Boolean).join(' · ') || '已定位到这条批注')
            );
        },
        [handleOpenAnnotation, handlePageJump]
    );

    const handlePdfLinkError = useCallback((reason) => {
        const detail = String(reason?.message ?? reason ?? '').trim();
        setToastNotice(createResearchToast(detail ? `PDF 链接无法打开：${detail}` : 'PDF 链接无法打开'));
    }, []);

    const handleDeleteAnnotation = useCallback(
        async (annotation) => {
            if (!annotation?.id) return;
            const sourcePaperId = annotation.paperId ?? document?.paper?.id;
            const sourceEpoch = readerEpochRef.current;
            const snapshot = { ...annotation, paperId: sourcePaperId };
            try {
                await deleteAnnotation(annotation.id);
                if (
                    !isCurrentAnnotationSave({
                        sourcePaperId,
                        sourceEpoch,
                        currentPaperId: paperIdRef.current,
                        currentEpoch: readerEpochRef.current,
                    })
                ) {
                    return;
                }
                setAnnotations((current) => {
                    const next = current.filter((item) => item.id !== annotation.id);
                    annotationsRef.current = next;
                    return next;
                });
                annotationUndoStackRef.current = appendAnnotationUndoAction(
                    annotationUndoStackRef.current,
                    createAnnotationUndoAction('delete', { before: snapshot })
                );
                setToastNotice(
                    createResearchToast(
                        annotation.kind === 'highlight'
                            ? `已取消高亮，可按 ${UNDO_SHORTCUT} 恢复`
                            : `已删除批注，可按 ${UNDO_SHORTCUT} 恢复`
                    )
                );
            } catch (reason) {
                if (sourceEpoch === readerEpochRef.current) {
                    setToastNotice(createResearchToast(`删除批注失败：${String(reason?.message ?? reason)}`));
                }
            }
        },
        [document?.paper?.id]
    );

    const excerptSelection = useCallback(async () => {
        if (!selection || !['vocabulary', 'excerpt'].includes(selectionKind)) return;
        let lexicon = selectionKind === 'vocabulary' ? lexiconState.entry : null;
        if (selectionKind === 'vocabulary' && !lexicon) {
            try {
                lexicon = await defineTerm({ selection, targetLanguage });
                setLexiconState({ loading: false, entry: lexicon, error: '' });
            } catch (reason) {
                setLexiconState({ loading: false, entry: null, error: String(reason?.message ?? reason) });
            }
        }
        await handleSaveAnnotation({
            ...selection,
            kind: selectionKind,
            color: selectionKind === 'vocabulary' ? 'blue' : 'amber',
            note: '',
            tags: [selectionKind === 'vocabulary' ? '词汇' : '摘录'],
            translation: translation.text,
            lexicon,
        });
        setToastNotice(
            createResearchToast(selectionKind === 'vocabulary' ? '单词已摘抄到论文记录' : '句子已摘抄到论文记录')
        );
    }, [handleSaveAnnotation, lexiconState.entry, selection, selectionKind, targetLanguage, translation.text]);

    const closeSelection = useCallback(() => {
        aiAbortRef.current?.abort();
        cancelSpeechRequest();
        invalidateSelectionTranslation();
        setSelection(null);
        setSelectionOverlay(null);
        setSelectionMenu(null);
        setNoteEditorOpen(false);
        setNoteEditorTarget(null);
        setTranslation({ status: 'idle', loading: false, text: '', error: '' });
        setLexiconState({ loading: false, entry: null, error: '' });
        setAiState({
            loading: false,
            answer: '',
            citations: [],
            error: '',
            refused: false,
            retrievalMode: '',
        });
        window.getSelection()?.removeAllRanges();
    }, [invalidateSelectionTranslation]);

    const handleAsk = useCallback(
        async (question, { intent = RESEARCH_AI_INTENTS.PAPER_QA } = {}) => {
            if (!document?.paper) return;
            aiAbortRef.current?.abort();
            const controller = new AbortController();
            aiAbortRef.current = controller;
            setAiState({
                loading: true,
                answer: '',
                citations: [],
                error: '',
                refused: false,
                retrievalMode: '',
            });
            try {
                if (intent !== RESEARCH_AI_INTENTS.EXPLAIN_SELECTION) {
                    const semanticStatus = await getSemanticStatus(document.paper.id);
                    if (shouldConfirmEmbeddingInstall(semanticStatus)) {
                        const confirmed = window.confirm(
                            `首次启用论文语义检索需要安装 ${semanticStatus.model}，预计占用约 ${semanticStatus.estimatedDownloadMb} MB。是否现在授权并开始下载？`
                        );
                        if (!confirmed) {
                            setAiState({
                                loading: false,
                                answer: '',
                                citations: [],
                                error: '未安装嵌入模型；本次未下载任何模型。',
                                refused: false,
                                retrievalMode: '',
                            });
                            return;
                        }
                        await authorizeEmbeddingInstall();
                    }
                    const indexReceipt = await startEmbeddingIndex(document.paper.id);
                    if (indexReceipt.jobId) setResearchJob(indexReceipt);
                }
                const result = await askPaper({
                    paperId: document.paper.id,
                    question,
                    intent,
                    paperTitle: document.paper.title,
                    selection,
                    pageText: selectionPageText,
                    signal: controller.signal,
                });
                if (!controller.signal.aborted)
                    setAiState({
                        loading: false,
                        answer: result.answer,
                        citations: result.citations ?? [],
                        error: '',
                        refused: Boolean(result.refused),
                        retrievalMode: result.retrievalMode ?? '',
                    });
            } catch (reason) {
                if (!controller.signal.aborted)
                    setAiState({
                        loading: false,
                        answer: '',
                        citations: [],
                        error: String(reason),
                        refused: false,
                        retrievalMode: '',
                    });
            }
        },
        [document?.paper, selection, selectionPageText]
    );

    const handleSelectionSpeak = useCallback(
        async (text, options) => {
            if (!text) return;
            try {
                await runSpeechRequest(() => speakText(text, options?.source ? 'en' : targetLanguage));
            } catch (reason) {
                setToastNotice(createResearchToast(`朗读失败：${String(reason?.message ?? reason)}`));
            }
        },
        [runSpeechRequest, targetLanguage]
    );

    const handleDrop = async (event) => {
        event.preventDefault();
        setDragDepth(0);
        const paths = [...event.dataTransfer.files]
            .map((file) => file.path || (!isTauriRuntime() ? file.name : ''))
            .filter(Boolean);
        if (paths.length === 0) return;
        openImportKindDialog(paths);
    };

    const handleDragEnter = (event) => {
        event.preventDefault();
        if (event.dataTransfer.types.includes('Files')) setDragDepth((value) => value + 1);
    };

    const handleDragLeave = (event) => {
        event.preventDefault();
        setDragDepth((value) => Math.max(0, value - 1));
    };

    const closeReader = () => {
        pdfRef.current?.flushProgress?.();
        aiAbortRef.current?.abort();
        if (ocrProducerRef.current && !ocrProducerRef.current.cancelled) {
            ocrProducerRef.current.cancelled = true;
            void cancelResearchJob(ocrProducerRef.current.jobId).catch(() => undefined);
        }
        readerEpochRef.current += 1;
        annotationUndoStackRef.current = [];
        chapterInsightRequestRef.current += 1;
        setPaperId('');
        setSelection(null);
        setSelectionOverlay(null);
        setSelectionMenu(null);
        setNoteEditorOpen(false);
        setNoteEditorTarget(null);
        setReaderSidebarTab('insights');
        setAnnotationKindFilter('');
        setToastNotice(null);
        setDocument(null);
    };

    const handleImport = useCallback(
        async (paths, contentKind = 'paper') => {
            const imported = await library.importPaths(paths, contentKind);
            if (imported[0]) openPaper(imported[0].id);
            scheduleImportedInsights(imported);
            return imported;
        },
        [library.importPaths, openPaper, scheduleImportedInsights]
    );

    const handleImportKindSelect = useCallback(
        async (contentKind) => {
            const pendingPaths = importRequest.paths;
            setImportRequest({ open: false, paths: null });
            if (pendingPaths?.length) return handleImport(pendingPaths, contentKind);

            try {
                const paths = await choosePdfPaths(contentKind);
                if (paths === null) {
                    browserImportKindRef.current = contentKind;
                    globalThis.document.getElementById('research-browser-file-input')?.click();
                    return [];
                }
                return handleImport(paths, contentKind);
            } catch (reason) {
                setDocumentError(`打开文献文件选择器失败：${String(reason)}`);
                return [];
            }
        },
        [handleImport, importRequest.paths]
    );

    const handleChoosePapers = useCallback(() => {
        openImportKindDialog();
    }, [openImportKindDialog]);

    const handlePageCountChange = useCallback(
        (count) => {
            if (!document?.paper?.id) return;
            setPageCount(count);
            void updateDocumentPageCount(document.paper.id, count).catch((reason) => {
                setDocumentError(`保存文档页数失败：${String(reason)}`);
            });
        },
        [document?.paper?.id]
    );

    const handlePageText = useCallback(
        (pageNumber, text) => {
            if (!document?.paper?.id) return;
            const key = `${document.paper.id}:${pageNumber}`;
            if (indexedPageTextRef.current.get(key) === text) return;
            indexedPageTextRef.current.set(key, text);
            void indexDocumentPage(document.paper.id, pageNumber, text).catch((reason) => {
                indexedPageTextRef.current.delete(key);
                setDocumentError(`索引第 ${pageNumber} 页失败：${String(reason)}`);
            });
        },
        [document?.paper?.id]
    );

    const handleReferencePages = useCallback(
        async (pages) => {
            const activePaperId = document?.paper?.id;
            if (!activePaperId) return;
            try {
                const nextRelations = await syncPaperReferences(activePaperId, pages);
                if (paperIdRef.current === activePaperId) setRelations(nextRelations);
            } catch (reason) {
                setDocumentError(`解析参考文献关系失败：${String(reason)}`);
            }
        },
        [document?.paper?.id]
    );

    const handleDocumentOutline = useCallback(
        async (outline) => {
            const activePaperId = document?.paper?.id;
            if (!activePaperId || !Array.isArray(outline) || outline.length === 0) return;
            const fingerprint = JSON.stringify(outline);
            if (persistedOutlineRef.current.get(activePaperId) === fingerprint) return;

            // 先更新阅读器，再持久化；长文档无需等待数据库写入才能使用目录。
            persistedOutlineRef.current.set(activePaperId, fingerprint);
            setDocument((current) => (current?.paper?.id === activePaperId ? { ...current, outline } : current));
            try {
                // PDF 页数与目录几乎同时返回。先完成页数事务，避免后端仍按导入默认值 1
                // 把合法书签页码错误裁剪到第一页。
                const outlinePageCount = outline.reduce(
                    (maximum, item) => Math.max(maximum, Number(item?.endPage ?? item?.pageNumber) || 1),
                    1
                );
                await updateDocumentPageCount(activePaperId, outlinePageCount);
                const saved = await replaceDocumentOutline(activePaperId, outline);
                if (paperIdRef.current !== activePaperId) return;
                persistedOutlineRef.current.set(activePaperId, JSON.stringify(saved));
                setDocument((current) =>
                    current?.paper?.id === activePaperId ? { ...current, outline: saved } : current
                );
            } catch (reason) {
                persistedOutlineRef.current.delete(activePaperId);
                if (paperIdRef.current === activePaperId) {
                    setDocumentError(`保存章节目录失败：${String(reason?.message ?? reason)}`);
                }
            }
        },
        [document?.paper?.id]
    );

    const handleDocumentPages = useCallback(
        async ({ pages, pageCount: extractedPageCount, totalCharacters, outline = [] }) => {
            const activePaperId = document?.paper?.id;
            if (!activePaperId) return;
            if (outline.length > 0) await handleDocumentOutline(outline);
            const runKey = `${activePaperId}:${extractedPageCount}:${totalCharacters}`;
            if (indexedDocumentRef.current.has(runKey)) return;
            indexedDocumentRef.current.add(runKey);
            setInsightsError('');
            setInsights((current) =>
                current?.status === 'ready' ? current : { ...current, status: 'indexing', error: '' }
            );
            try {
                if (paperIdRef.current === activePaperId && !hasReadyPaperInsights(insightsRef.current)) {
                    setInsights((current) => ({ ...current, status: 'generating', error: '' }));
                }
                const generated = await enqueuePreparedPaperInsights(
                    activePaperId,
                    {
                        pages,
                        pageCount: extractedPageCount,
                    },
                    {
                        contentKind: document?.paper?.contentKind,
                    }
                );
                if (paperIdRef.current === activePaperId) setInsights(generated);
            } catch (reason) {
                indexedDocumentRef.current.delete(runKey);
                if (paperIdRef.current !== activePaperId) return;
                const message = String(reason?.message ?? reason);
                setInsightsError(message);
                setInsights((current) =>
                    current?.status === 'ready' ? current : { ...current, status: 'failed', error: message }
                );
            }
        },
        [document?.paper?.contentKind, document?.paper?.id, handleDocumentOutline]
    );

    const regenerateInsights = useCallback(async () => {
        const activePaperId = document?.paper?.id;
        if (!activePaperId) return;
        setInsightsError('');
        setInsights((current) => ({ ...current, status: 'generating', error: '' }));
        try {
            const generated = await generatePaperInsights(activePaperId, { force: true });
            if (paperIdRef.current === activePaperId) setInsights(generated);
        } catch (reason) {
            if (paperIdRef.current !== activePaperId) return;
            const message = String(reason?.message ?? reason);
            setInsightsError(message);
            setInsights((current) => ({ ...current, status: 'failed', error: message }));
        }
    }, [document?.paper?.id]);

    const handleProgress = useCallback(
        (progress) => {
            if (!document?.paper?.id) return;
            const activePaperId = document.paper.id;
            void saveReadingProgress(activePaperId, progress)
                .then((savedProgress) => {
                    library.updatePaperProgress?.(activePaperId, savedProgress ?? progress);
                })
                .catch((reason) => {
                    if (paperIdRef.current === activePaperId) {
                        setDocumentError(`保存阅读进度失败：${String(reason)}`);
                    }
                });
        },
        [document?.paper?.id, library.updatePaperProgress]
    );

    const handleScan = async (scope) => {
        if (!document?.paper) return;
        try {
            const pages =
                scope === 'document' ? Array.from({ length: pageCount }, (_, index) => index + 1) : [currentPage];
            const receipt = await startOcrJob(document.paper.id, scope, pages.length);
            setResearchJob(receipt);
            const producer = { jobId: receipt.jobId, paused: false, cancelled: false, enqueued: 0, completed: 0 };
            ocrProducerRef.current = producer;
            setToastNotice(
                createResearchToast(
                    scope === 'document' ? '正在后台准备整篇页面图像…' : `正在准备第 ${currentPage} 页图像…`
                )
            );
            void (async () => {
                for (const pageNumber of pages) {
                    while ((producer.paused || producer.enqueued - producer.completed >= 2) && !producer.cancelled) {
                        await new Promise((resolve) => setTimeout(resolve, 160));
                    }
                    if (producer.cancelled) break;
                    const imageDataUrl = await pdfRef.current?.renderPageForOcr(pageNumber);
                    if (!imageDataUrl || producer.cancelled) break;
                    await enqueueOcrPage(receipt.jobId, document.paper.id, pageNumber, imageDataUrl);
                    producer.enqueued += 1;
                }
            })().catch((reason) => setToastNotice(createResearchToast(`扫描识别失败：${String(reason)}`)));
        } catch (reason) {
            setToastNotice(createResearchToast(`无法启动扫描识别：${String(reason)}`));
        }
    };

    const handlePauseJob = useCallback(async () => {
        if (!researchJob?.jobId) return;
        const paused = researchJob.state !== 'paused';
        if (ocrProducerRef.current?.jobId === researchJob.jobId) ocrProducerRef.current.paused = paused;
        const next = await pauseResearchJob(researchJob.jobId, paused);
        setResearchJob((current) => ({ ...current, ...next }));
    }, [researchJob]);

    const handleCancelJob = useCallback(async () => {
        if (!researchJob?.jobId) return;
        if (ocrProducerRef.current?.jobId === researchJob.jobId) ocrProducerRef.current.cancelled = true;
        await cancelResearchJob(researchJob.jobId);
        setResearchJob((current) => ({ ...current, state: 'cancelling' }));
    }, [researchJob]);

    return (
        <div
            className={`research-shell ${embedded ? 'is-embedded' : ''} ${isReader ? 'is-reader' : 'is-library'} ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}
            style={{
                ...sidebarResize.rootStyle,
                '--app-context-sidebar-width': sidebarCollapsed ? '0px' : `${sidebarResize.width}px`,
            }}
            onDragEnter={handleDragEnter}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {!embedded ? (
                <AppRail
                    active='research'
                    onNavigate={onNavigate}
                />
            ) : null}
            {!sidebarCollapsed ? (
                <LibrarySidebar
                    mode={isReader ? 'reader' : 'library'}
                    paper={document?.paper}
                    insights={insights}
                    insightsError={insightsError}
                    annotations={annotations}
                    currentPage={currentPage}
                    outline={document?.outline ?? []}
                    chapterInsights={chapterInsights}
                    chapterInsightState={chapterInsightState}
                    onBack={closeReader}
                    onJump={handlePageJump}
                    onOpenAnnotation={handleOpenAnnotation}
                    onSelectChapter={handleSelectChapter}
                    onRegenerateChapter={handleRegenerateChapter}
                    query={library.query}
                    onQueryChange={library.setQuery}
                    view={library.view}
                    onViewChange={(view) => {
                        library.setView(view);
                        library.setActiveTagId('');
                        library.setActiveProjectId('');
                    }}
                    tags={library.tags}
                    activeTagId={library.activeTagId}
                    onTagChange={(tagId) => {
                        library.setActiveTagId(tagId);
                        library.setActiveProjectId('');
                    }}
                    paperCounts={paperCounts}
                    projects={library.projects}
                    activeProjectId={library.activeProjectId}
                    onProjectChange={library.selectProject}
                    onCreateProject={library.addProject}
                    onUpdateProject={library.editProject}
                    onDeleteProject={library.removeProject}
                    onImport={handleChoosePapers}
                    importing={library.importing}
                    relations={relations}
                    onOpenPaper={openPaper}
                    onRegenerate={regenerateInsights}
                    onDeleteAnnotation={handleDeleteAnnotation}
                    readerTab={readerSidebarTab}
                    onReaderTabChange={setReaderSidebarTab}
                    annotationKindFilter={annotationKindFilter}
                    onAnnotationKindFilterChange={setAnnotationKindFilter}
                />
            ) : null}
            {!sidebarCollapsed ? (
                <div
                    className='research-sidebar-resizer'
                    title='拖动调整侧栏宽度；双击恢复默认'
                    {...sidebarResize.separatorProps}
                />
            ) : null}
            {isReader ? (
                <ReaderTopbar
                    paper={document.paper}
                    papers={availablePapers}
                    projects={library.projects}
                    activePaperId={paperId}
                    onPaperChange={openPaper}
                    currentPage={currentPage}
                    pageCount={pageCount}
                    scale={scale}
                    interactionMode={interactionMode}
                    onPageChange={handlePageJump}
                    onInteractionModeChange={setInteractionMode}
                    onSearch={(query) => pdfRef.current?.search(query)}
                    translationStatus={translationStatus}
                    sidebarCollapsed={sidebarCollapsed}
                    onSidebarToggle={sidebarResize.toggleCollapsed}
                />
            ) : (
                <LibraryTopbar translationStatus={translationStatus} />
            )}

            {isReader ? (
                <>
                    <PdfWorkspace
                        ref={pdfRef}
                        source={getPdfSource(document)}
                        document={document}
                        initialProgress={document.progress ?? document.paper?.progress}
                        currentPage={currentPage}
                        scale={scale}
                        interactionMode={interactionMode}
                        annotations={annotations}
                        activeSelection={selection}
                        onPageChange={setCurrentPage}
                        onPageCountChange={handlePageCountChange}
                        onPageText={handlePageText}
                        onDocumentPages={handleDocumentPages}
                        onOutline={handleDocumentOutline}
                        onReferencePages={handleReferencePages}
                        onSelection={handleSelection}
                        onSelectionContextMenu={(menu) => {
                            setSelectionMenu(menu);
                            setSelectionOverlay(null);
                            setNoteEditorOpen(false);
                            setNoteEditorTarget(null);
                        }}
                        onAnnotationActivate={handleAnnotationActivate}
                        onAnnotationDelete={handleDeleteAnnotation}
                        onLinkError={handlePdfLinkError}
                        onProgress={handleProgress}
                        onScaleChange={setScale}
                        onScanPage={() => handleScan('page')}
                        onScanDocument={() => handleScan('document')}
                    />
                    <SelectionTranslationPopover
                        open={Boolean(selection && selectionOverlay && !noteEditorOpen)}
                        anchorRect={selectionOverlay?.anchorRect}
                        selectionRect={selectionOverlay?.selectionRect}
                        boundaryRect={selectionOverlay?.boundaryRect}
                        value={translation.text}
                        sourceText={selection?.quote ?? ''}
                        loading={translation.loading}
                        error={translation.error}
                        statusMessage={translation.message}
                        selectionKind={selectionKind}
                        lexiconState={lexiconState}
                        targetLanguage={targetLanguage}
                        onTargetLanguageChange={handleTargetLanguageChange}
                        onSpeak={handleSelectionSpeak}
                        onHighlight={highlightSelection}
                        onSaveExcerpt={excerptSelection}
                        onOpenNote={openNoteEditorForSelection}
                        onExplain={() => handleAsk('解释所选内容', { intent: RESEARCH_AI_INTENTS.EXPLAIN_SELECTION })}
                        onRetry={retrySelectionTranslation}
                        onClose={closeSelection}
                        aiState={aiState}
                        onJump={handlePageJump}
                    />
                    <SelectionContextMenu
                        open={Boolean(selection && selectionMenu && !noteEditorOpen)}
                        point={selectionMenu}
                        boundaryRect={selectionMenu?.boundaryRect}
                        sourceText={selection?.quote ?? ''}
                        selectionKind={selectionKind}
                        onOpenNote={() => {
                            if (selectionMenu) {
                                setSelectionOverlay({
                                    anchorRect: {
                                        left: selectionMenu.clientX,
                                        right: selectionMenu.clientX,
                                        top: selectionMenu.clientY,
                                        bottom: selectionMenu.clientY,
                                    },
                                    selectionRect: selectionMenu.selectionRect,
                                    boundaryRect: selectionMenu.boundaryRect,
                                });
                            }
                            openNoteEditorForSelection();
                        }}
                        onHighlight={highlightSelection}
                        onSaveExcerpt={excerptSelection}
                        onExplain={() => {
                            if (selectionMenu) {
                                setSelectionOverlay({
                                    anchorRect: {
                                        left: selectionMenu.clientX,
                                        right: selectionMenu.clientX,
                                        top: selectionMenu.clientY,
                                        bottom: selectionMenu.clientY,
                                    },
                                    selectionRect: selectionMenu.selectionRect,
                                    boundaryRect: selectionMenu.boundaryRect,
                                });
                            }
                            void handleAsk('解释所选内容', { intent: RESEARCH_AI_INTENTS.EXPLAIN_SELECTION });
                        }}
                        onClose={() => setSelectionMenu(null)}
                    />
                    <AnnotationEditorPopover
                        open={Boolean(noteEditorTarget && noteEditorOpen)}
                        selection={noteEditorTarget}
                        anchorRect={
                            noteEditorTarget?.id
                                ? undefined
                                : selectionMenu
                                  ? {
                                        left: selectionMenu.clientX,
                                        right: selectionMenu.clientX,
                                        top: selectionMenu.clientY,
                                        bottom: selectionMenu.clientY,
                                    }
                                  : selectionOverlay?.anchorRect
                        }
                        boundaryRect={
                            noteEditorTarget?.id
                                ? undefined
                                : selectionMenu?.boundaryRect ?? selectionOverlay?.boundaryRect
                        }
                        tagSuggestions={annotationTagSuggestions}
                        onSave={handleSaveAnnotation}
                        onClose={closeNoteEditor}
                    />
                </>
            ) : (
                <PaperLibrary
                    papers={library.visiblePapers}
                    tags={library.tags}
                    projects={library.projects}
                    activeProjectId={library.activeProjectId}
                    view={library.view}
                    loading={library.loading}
                    importing={library.importing}
                    error={library.error || documentError}
                    isDragging={dragDepth > 0}
                    sortMode={library.sortMode}
                    onImport={(paths) => handleImport(paths, browserImportKindRef.current)}
                    onChoose={handleChoosePapers}
                    onSortModeChange={library.setSortMode}
                    onOpen={openPaper}
                    onDeletePermanently={library.deletePermanently}
                    onArchivePapers={library.archivePapers}
                    onUnarchivePapers={library.unarchivePapers}
                    onMovePapersToTrash={library.movePapersToTrash}
                    onRestorePapers={library.restorePapers}
                    onTagChange={library.updatePaperTags}
                    onProjectChange={library.updatePaperProjects}
                />
            )}
            {toastNotice ? (
                <div
                    key={toastNotice.id}
                    className='research-toast'
                    role='status'
                    aria-live='polite'
                >
                    {toastNotice.text}
                </div>
            ) : null}
            {researchJob?.jobId && !['completed', 'failed', 'cancelled'].includes(researchJob.state) ? (
                <div
                    className='research-job-float'
                    role='status'
                >
                    <span>{researchJob.message || '本地研究任务进行中'}</span>
                    <button
                        type='button'
                        onClick={handlePauseJob}
                    >
                        {researchJob.state === 'paused' ? '继续' : '暂停'}
                    </button>
                    <button
                        type='button'
                        onClick={handleCancelJob}
                    >
                        取消
                    </button>
                </div>
            ) : null}
            <ImportKindDialog
                open={importRequest.open}
                importing={library.importing}
                pendingFileCount={importRequest.paths?.length ?? 0}
                onSelect={handleImportKindSelect}
                onClose={() => setImportRequest({ open: false, paths: null })}
            />
        </div>
    );
}
