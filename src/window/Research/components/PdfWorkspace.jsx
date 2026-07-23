import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { PiBookmarkSimple, PiFileMagnifyingGlass, PiSpinnerGap, PiTrash } from 'react-icons/pi';
import { LuStickyNote } from 'react-icons/lu';

import { DEMO_PAGE } from '../../../domains/research/demoData';
import {
    clampReadingProgress,
    createSelectionAnchor,
    getVirtualPageWindow,
    shouldTranslateSelection,
} from '../../../domains/research/model';
import { mergeClientRects } from '../floatingPosition';
import {
    computeAnchoredScroll,
    computePanScroll,
    getContinuousPdfScale,
    getGesturePdfScale,
    getPointerPinchGeometry,
    shouldStartPointerPinch,
} from '../pdfInteractions';
import { createPdfDocumentOptions, loadPdfRuntime, loadPdfTextLayerBuilder } from '../pdfRuntime';
import { capturePdfVisualLine, isNearHorizontalPdfGesture, resolvePdfHorizontalRange } from '../pdfSelection';
import { extractSharedPdfText } from '../pdfTextExtraction';
import { deriveOutlineFromPages, extractNativePdfOutline } from '../pdfOutline';
import TextDocumentPage, { isTextResearchDocument } from './TextDocumentPage';

const PDF_BASE_WIDTH = 650;
const PDF_BASE_HEIGHT = 792;
const MAX_RENDER_PIXELS = 16_000_000;
const MAX_OCR_PIXELS = 20_000_000;
const READING_PROGRESS_SAVE_DELAY_MS = 220;
const READING_PROGRESS_RESTORE_SETTLE_MS = 420;
const SELECTION_COMMIT_MAX_ATTEMPTS = 3;

function isSameReadingProgress(left, right) {
    if (!left || !right) return false;
    return (
        left.pageNumber === right.pageNumber &&
        Math.abs(left.scale - right.scale) < 0.001 &&
        Math.abs(left.scrollRatio - right.scrollRatio) < 0.0001
    );
}

function boundedOutputScale(viewport, requestedScale, pixelBudget) {
    const area = Math.max(1, viewport.width * viewport.height);
    const budgetScale = Math.sqrt(pixelBudget / area);
    return Math.max(0.1, Math.min(requestedScale, budgetScale));
}

function nodeElement(node) {
    return node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}

function selectionLayerForNode(node) {
    return nodeElement(node)?.closest?.('[data-pdf-selection-layer]') ?? null;
}

function isInteractiveElement(target) {
    return Boolean(target?.closest?.('button, input, select, textarea, a, [contenteditable="true"]'));
}

function AnnotationMarks({ annotations, onActivate, onDelete }) {
    const [activeAnnotationId, setActiveAnnotationId] = useState('');

    useEffect(() => {
        if (!activeAnnotationId) return undefined;
        const close = () => setActiveAnnotationId('');
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') close();
        };
        const handleOutsidePointerDown = (event) => {
            const control = event.target?.closest?.('[data-annotation-control]');
            if (control?.dataset.annotationId === activeAnnotationId) return;
            close();
        };
        globalThis.addEventListener?.('keydown', handleKeyDown);
        globalThis.document?.addEventListener?.('pointerdown', handleOutsidePointerDown, true);
        return () => {
            globalThis.removeEventListener?.('keydown', handleKeyDown);
            globalThis.document?.removeEventListener?.('pointerdown', handleOutsidePointerDown, true);
        };
    }, [activeAnnotationId]);

    return annotations.flatMap((annotation) => {
        const tags = Array.isArray(annotation.tags) ? annotation.tags.filter(Boolean) : [];
        const description = [tags.map((tag) => `#${tag}`).join(' '), annotation.note].filter(Boolean).join(' · ');
        const rects = annotation.rects ?? [];
        const marks = rects.map((rect, index) => (
            <span
                className={`pdf-annotation-mark pdf-annotation-mark--${annotation.color ?? 'violet'} ${index === 0 && tags.length ? 'has-tags' : ''}`}
                data-tag-count={index === 0 && tags.length ? `#${tags.length}` : undefined}
                key={`${annotation.id}-${index}`}
                title={description || annotation.quote || '论文高亮'}
                style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.width * 100}%`,
                    height: `${rect.height * 100}%`,
                }}
            />
        ));
        const firstRect = rects[0];
        if (!firstRect) return marks;
        const markerLeft = Math.min(0.965, Math.max(0.02, firstRect.x + firstRect.width));
        const markerTop = Math.min(0.965, Math.max(0.01, firstRect.y));
        const deleteLabel =
            annotation.kind === 'highlight'
                ? '取消高亮'
                : annotation.kind === 'note'
                  ? '删除笔记'
                  : annotation.kind === 'vocabulary'
                    ? '删除摘词'
                    : '删除摘录';
        const isActive = activeAnnotationId === annotation.id;
        const triggerLabel =
            annotation.kind === 'note'
                ? `查看第 ${annotation.pageNumber} 页笔记${tags.length ? `，${tags.map((tag) => `标签 ${tag}`).join('，')}` : ''}`
                : `打开批注操作：${annotation.quote || `第 ${annotation.pageNumber} 页批注`}`;
        return [
            ...marks,
            <div
                className='pdf-annotation-control'
                key={`${annotation.id}-control`}
                data-annotation-control='true'
                data-annotation-id={annotation.id}
                style={{ left: `${markerLeft * 100}%`, top: `${markerTop * 100}%` }}
            >
                <button
                    type='button'
                    className={`pdf-annotation-trigger pdf-annotation-trigger--${annotation.color ?? 'violet'} ${annotation.kind === 'note' ? 'is-note' : ''}`}
                    title={description || annotation.quote || '查看论文批注'}
                    data-tooltip={description || annotation.quote || '查看论文批注'}
                    aria-label={triggerLabel}
                    aria-expanded={isActive}
                    onClick={(event) => {
                        event.stopPropagation();
                        setActiveAnnotationId((current) => (current === annotation.id ? '' : annotation.id));
                        onActivate?.(annotation);
                    }}
                >
                    {annotation.kind === 'note' ? (
                        <LuStickyNote aria-hidden='true' />
                    ) : (
                        <PiBookmarkSimple aria-hidden='true' />
                    )}
                </button>
                {isActive ? (
                    <div
                        className='pdf-annotation-menu'
                        role='menu'
                        aria-label='批注操作'
                    >
                        <span>{description || annotation.quote || `第 ${annotation.pageNumber} 页批注`}</span>
                        <button
                            type='button'
                            role='menuitem'
                            aria-label={`${deleteLabel}：${annotation.quote || `第 ${annotation.pageNumber} 页批注`}`}
                            onClick={(event) => {
                                event.stopPropagation();
                                setActiveAnnotationId('');
                                onDelete?.(annotation);
                            }}
                        >
                            <PiTrash aria-hidden='true' />
                            {deleteLabel}
                        </button>
                    </div>
                ) : null}
            </div>,
        ];
    });
}

function VirtualPdfPage({
    pdfDocument,
    pageNumber,
    active,
    scale,
    annotations,
    onAnnotationActivate,
    onAnnotationDelete,
    onText,
    onScanned,
    registerPage,
}) {
    const pageRef = useRef(null);
    const canvasRef = useRef(null);
    const textLayerHostRef = useRef(null);
    const [aspectRatio, setAspectRatio] = useState(PDF_BASE_WIDTH / PDF_BASE_HEIGHT);
    const visualWidth = Math.round(PDF_BASE_WIDTH * (scale / 1.25));

    useEffect(() => {
        const element = pageRef.current;
        if (!element) return undefined;
        registerPage(pageNumber, element);
        return () => {
            registerPage(pageNumber, null);
        };
    }, [pageNumber, registerPage]);

    useEffect(() => {
        if (!active || !pdfDocument || !canvasRef.current || !textLayerHostRef.current) return undefined;
        let cancelled = false;
        let renderTask;
        let textLayerTask;
        let pageProxy;
        const textLayerAbort = new AbortController();

        const render = async () => {
            const [, TextLayerBuilder, page] = await Promise.all([
                loadPdfRuntime(),
                loadPdfTextLayerBuilder(),
                pdfDocument.getPage(pageNumber),
            ]);
            pageProxy = page;
            if (cancelled) {
                pageProxy.cleanup?.();
                return;
            }
            const baseViewport = page.getViewport({ scale: 1 });
            const cssScale = visualWidth / baseViewport.width;
            const viewport = page.getViewport({ scale: cssScale });
            const outputScale = boundedOutputScale(
                viewport,
                Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
                MAX_RENDER_PIXELS
            );
            setAspectRatio(viewport.width / viewport.height);

            const canvas = canvasRef.current;
            const context = canvas.getContext('2d', { alpha: false });
            canvas.width = Math.floor(viewport.width * outputScale);
            canvas.height = Math.floor(viewport.height * outputScale);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            renderTask = page.render({
                canvasContext: context,
                viewport,
                transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
            });

            const textContent = await page.getTextContent();
            const pageText = textContent.items
                .map((item) => `${item.str}${item.hasEOL ? '\n' : ' '}`)
                .join('')
                .trim();
            onText(pageNumber, pageText);
            onScanned(pageNumber, pageText.trim().length === 0);
            const host = textLayerHostRef.current;
            host.replaceChildren();
            // PDF.js 6 的文字层通过 --total-scale-factor 计算字体和选择框尺寸。
            // 该值必须与 canvas 使用的 CSS viewport 完全一致，否则划词位置会随缩放漂移。
            const textLayerWidth = `${Math.floor(viewport.width)}px`;
            const textLayerHeight = `${Math.floor(viewport.height)}px`;
            host.style.width = textLayerWidth;
            host.style.height = textLayerHeight;
            textLayerTask = new TextLayerBuilder({ pdfPage: page, abortSignal: textLayerAbort.signal });
            const textLayer = textLayerTask.div;
            textLayer.dataset.pdfSelectionLayer = 'true';
            textLayer.style.setProperty('--scale-factor', String(cssScale));
            textLayer.style.setProperty('--total-scale-factor', String(cssScale));
            textLayer.style.setProperty('--scale-round-x', '1px');
            textLayer.style.setProperty('--scale-round-y', '1px');
            textLayer.style.width = textLayerWidth;
            textLayer.style.height = textLayerHeight;
            host.append(textLayer);
            await Promise.all([
                renderTask.promise,
                textLayerTask.render({
                    viewport,
                    textContentParams: { includeMarkedContent: true, disableNormalization: true },
                }),
            ]);
            // PDF.js 会写入使用 CSS round() 的尺寸表达式；WebView2 下改回明确像素值，
            // 让文字层、画布和页面外壳始终共享同一套坐标。
            textLayer.style.width = textLayerWidth;
            textLayer.style.height = textLayerHeight;
        };

        void render().catch((error) => {
            if (!cancelled && error?.name !== 'RenderingCancelledException') console.error('PDF 页面渲染失败', error);
        });
        return () => {
            cancelled = true;
            textLayerAbort.abort();
            const pendingRender = renderTask?.promise;
            renderTask?.cancel?.();
            textLayerTask?.cancel?.();
            if (canvasRef.current) {
                canvasRef.current.width = 0;
                canvasRef.current.height = 0;
            }
            textLayerHostRef.current?.replaceChildren();
            const releasePage = () => {
                try {
                    pageProxy?.cleanup?.();
                } catch {
                    // 页面可能已随 PDFDocumentProxy 一起销毁；重复清理不应阻断切页。
                }
            };
            if (pendingRender)
                void Promise.resolve(pendingRender)
                    .catch(() => undefined)
                    .finally(releasePage);
            else releasePage();
        };
    }, [active, onScanned, onText, pageNumber, pdfDocument, visualWidth]);

    return (
        <section
            className={`pdf-page ${active ? 'is-rendered' : ''}`}
            data-page-number={pageNumber}
            ref={pageRef}
            style={{ width: `${visualWidth}px`, aspectRatio }}
            aria-label={`第 ${pageNumber} 页`}
        >
            {active ? (
                <>
                    <canvas ref={canvasRef} />
                    <div
                        ref={textLayerHostRef}
                        className='pdf-text-layer-host'
                    />
                    <div className='pdf-annotation-layer'>
                        <AnnotationMarks
                            annotations={annotations}
                            onActivate={onAnnotationActivate}
                            onDelete={onAnnotationDelete}
                        />
                    </div>
                    <span className='pdf-page__number'>{pageNumber}</span>
                </>
            ) : (
                <div className='pdf-page__placeholder'>
                    <PiSpinnerGap aria-hidden='true' />
                </div>
            )}
        </section>
    );
}

function DemoPdfPage({ selection, annotations, onAnnotationActivate, onAnnotationDelete }) {
    return (
        <article
            className='demo-pdf-page pdf-page'
            data-page-number='2'
            data-page-text={`${DEMO_PAGE.before} ${DEMO_PAGE.selected} ${DEMO_PAGE.after}`}
        >
            <div
                className='demo-pdf-page__body'
                data-pdf-selection-layer='true'
            >
                <h1>{DEMO_PAGE.heading}</h1>
                <p>
                    <span>{DEMO_PAGE.before}</span>
                    <sup>1–3</sup>.
                </p>
                <p className={selection?.quote === DEMO_PAGE.selected ? 'demo-selection' : ''}>
                    <span>{DEMO_PAGE.selected}</span>
                    <sup>4–6</sup>.
                </p>
                <p>
                    <span>{DEMO_PAGE.after}</span>
                </p>
                <h2>Experimental rationale</h2>
                <p>
                    <span>
                        Functional subdivisions were evaluated with participant-level models and conservative correction
                        for multiple comparisons. The analysis preserves anatomical specificity while estimating
                        uncertainty across subjects.
                    </span>
                </p>
                <div
                    className='demo-paper-table'
                    role='table'
                    aria-label='海马亚区及主要功能'
                >
                    <div role='row'>
                        <strong role='columnheader'>Subfield</strong>
                        <strong role='columnheader'>Primary contribution</strong>
                    </div>
                    <div role='row'>
                        <span role='cell'>DG</span>
                        <span role='cell'>Pattern separation</span>
                    </div>
                    <div role='row'>
                        <span role='cell'>CA3</span>
                        <span role='cell'>Pattern completion</span>
                    </div>
                    <div role='row'>
                        <span role='cell'>CA1</span>
                        <span role='cell'>Input integration</span>
                    </div>
                </div>
            </div>
            <div className='pdf-annotation-layer'>
                <AnnotationMarks
                    annotations={annotations}
                    onActivate={onAnnotationActivate}
                    onDelete={onAnnotationDelete}
                />
            </div>
            <span className='pdf-page__number'>2</span>
        </article>
    );
}

const PdfWorkspace = forwardRef(function PdfWorkspace(
    {
        source,
        document,
        initialProgress,
        currentPage,
        scale,
        interactionMode = 'select',
        annotations = [],
        activeSelection,
        onPageChange,
        onPageCountChange,
        onPageText,
        onDocumentPages,
        onOutline,
        onReferencePages,
        onSelection,
        onSelectionContextMenu,
        onAnnotationActivate,
        onAnnotationDelete,
        onProgress,
        onScaleChange,
        onScanPage,
        onScanDocument,
    },
    ref
) {
    const scrollRef = useRef(null);
    const pageElementsRef = useRef(new Map());
    const pageObserverRef = useRef(null);
    const pageTextRef = useRef(new Map());
    const visibilityRef = useRef(new Map());
    const progressTimerRef = useRef(null);
    const selectionGestureRef = useRef(null);
    const selectionFrameRef = useRef(null);
    const selectionCommitIdRef = useRef(0);
    const finishSelectionGestureRef = useRef(null);
    const finishTouchPointerRef = useRef(null);
    const panGestureRef = useRef(null);
    const pendingZoomRef = useRef(null);
    const wheelZoomFrameRef = useRef(null);
    const wheelZoomRef = useRef(null);
    const gestureZoomFrameRef = useRef(null);
    const gestureZoomRef = useRef(null);
    const touchPointersRef = useRef(new Map());
    const pointerPinchRef = useRef(null);
    const pointerPinchFrameRef = useRef(null);
    const restoreFrameRef = useRef(null);
    const restoreSettleTimerRef = useRef(null);
    const restoreReleaseFrameRef = useRef(null);
    const restoreCompleteFrameRef = useRef(null);
    const scaleRef = useRef(scale);
    const currentPageRef = useRef(currentPage);
    const onPageCountChangeRef = useRef(onPageCountChange);
    const onProgressRef = useRef(onProgress);
    const restoringRef = useRef(Boolean(initialProgress));
    const restoredPaperRef = useRef('');
    const latestProgressRef = useRef(null);
    const lastEmittedProgressRef = useRef(null);
    const flushProgressRef = useRef(null);
    const textMode = isTextResearchDocument(document);
    const textContent = String(document?.textContent ?? '');
    const [pdfDocument, setPdfDocument] = useState(null);
    const [loadState, setLoadState] = useState(textMode ? 'text' : source ? 'loading' : 'demo');
    const [error, setError] = useState('');
    const [visiblePages, setVisiblePages] = useState([currentPage]);
    const [scannedPages, setScannedPages] = useState(new Set());
    const [isPanning, setIsPanning] = useState(false);
    const [spacePressed, setSpacePressed] = useState(false);
    const [restoringProgress, setRestoringProgress] = useState(Boolean(initialProgress));
    const [progressContentHidden, setProgressContentHidden] = useState(Boolean(initialProgress));
    const pageCount = textMode ? 1 : pdfDocument?.numPages ?? document?.pageCount ?? 1;
    const paperKey = String(document?.paper?.id ?? '');
    const normalizedInitialProgress = useMemo(
        () =>
            clampReadingProgress({
                ...(initialProgress ?? document?.progress ?? document?.paper?.progress ?? {}),
                pageCount,
            }),
        [document?.paper?.progress, document?.progress, initialProgress, pageCount]
    );
    const renderPages = useMemo(
        () => new Set(getVirtualPageWindow({ visiblePages, pageCount, overscan: 1 })),
        [pageCount, visiblePages]
    );
    currentPageRef.current = currentPage;
    scaleRef.current = scale;
    onPageCountChangeRef.current = onPageCountChange;
    onProgressRef.current = onProgress;

    const cancelPendingSelection = useCallback((clearBrowserSelection = false) => {
        selectionCommitIdRef.current += 1;
        selectionGestureRef.current = null;
        if (selectionFrameRef.current != null) {
            window.cancelAnimationFrame(selectionFrameRef.current);
            selectionFrameRef.current = null;
        }
        if (clearBrowserSelection) window.getSelection()?.removeAllRanges();
    }, []);

    const cancelSelectionForPointer = useCallback(
        (event) => {
            const gesture = selectionGestureRef.current;
            if (!gesture) return false;
            if (event?.pointerId != null && gesture.pointerId !== event.pointerId) return false;
            cancelPendingSelection(true);
            return true;
        },
        [cancelPendingSelection]
    );

    const captureProgress = useCallback(() => {
        const root = scrollRef.current;
        const denominator = root ? Math.max(0, root.scrollHeight - root.clientHeight) : 0;
        return clampReadingProgress({
            pageNumber: currentPageRef.current,
            pageCount,
            scale: scaleRef.current,
            scrollRatio: root && denominator > 0 ? root.scrollTop / denominator : 0,
        });
    }, [pageCount]);

    const emitLatestProgress = useCallback(() => {
        if (restoringRef.current || !onProgressRef.current) return false;
        const nextProgress = latestProgressRef.current ?? captureProgress();
        if (isSameReadingProgress(nextProgress, lastEmittedProgressRef.current)) return false;
        lastEmittedProgressRef.current = nextProgress;
        onProgressRef.current(nextProgress);
        return true;
    }, [captureProgress]);

    const scheduleProgressSave = useCallback(
        (delay = READING_PROGRESS_SAVE_DELAY_MS) => {
            if (restoringRef.current) return;
            latestProgressRef.current = captureProgress();
            clearTimeout(progressTimerRef.current);
            progressTimerRef.current = setTimeout(emitLatestProgress, delay);
        },
        [captureProgress, emitLatestProgress]
    );

    const flushProgress = useCallback(() => {
        clearTimeout(progressTimerRef.current);
        if (restoringRef.current) return false;
        // React 卸载时 DOM ref 可能已经清空；此时必须沿用最后一次滚动快照，
        // 不能把空容器误写成 scrollRatio=0 覆盖刚保存的位置。
        if (scrollRef.current) latestProgressRef.current = captureProgress();
        return emitLatestProgress();
    }, [captureProgress, emitLatestProgress]);
    flushProgressRef.current = flushProgress;

    useEffect(() => {
        pageTextRef.current.clear();
        visibilityRef.current.clear();
        setVisiblePages([currentPageRef.current]);
        setScannedPages(new Set());
        if (textMode) {
            setPdfDocument(null);
            setLoadState('text');
            pageTextRef.current.set(1, textContent);
            onPageCountChangeRef.current?.(1);
            onPageText?.(1, textContent);
            const pages = textContent.trim() ? [{ pageNumber: 1, text: textContent }] : [];
            const outline = deriveOutlineFromPages(pages, 1, 'text');
            if (outline.length > 0) onOutline?.(outline);
            onDocumentPages?.({
                pages,
                pageCount: 1,
                textPageCount: pages.length,
                totalCharacters: textContent.length,
                outline,
            });
            onReferencePages?.(pages);
            return undefined;
        }
        if (!source) {
            setPdfDocument(null);
            setLoadState('demo');
            onPageCountChangeRef.current?.(document?.pageCount ?? 1);
            return undefined;
        }
        let cancelled = false;
        let task;
        setLoadState('loading');
        setError('');
        void loadPdfRuntime()
            .then((pdfjs) => {
                task = pdfjs.getDocument(createPdfDocumentOptions(source));
                return task.promise;
            })
            .then((loaded) => {
                if (cancelled) return loaded.destroy();
                setPdfDocument(loaded);
                setLoadState('ready');
                onPageCountChangeRef.current?.(loaded.numPages);
                void extractNativePdfOutline(loaded).then((outline) => {
                    if (!cancelled && outline.length) onOutline?.(outline);
                });
            })
            .catch((reason) => {
                if (cancelled) return;
                setError(String(reason));
                setLoadState('error');
            });
        return () => {
            cancelled = true;
            task?.destroy?.();
        };
    }, [document?.pageCount, onDocumentPages, onOutline, onPageText, onReferencePages, source, textContent, textMode]);

    useLayoutEffect(() => {
        if (!paperKey || !['ready', 'text', 'demo'].includes(loadState)) return undefined;
        if (restoredPaperRef.current === paperKey) return undefined;

        const root = scrollRef.current;
        if (!root) return undefined;
        restoringRef.current = true;
        setRestoringProgress(true);
        setProgressContentHidden(true);
        latestProgressRef.current = normalizedInitialProgress;
        lastEmittedProgressRef.current = normalizedInitialProgress;

        const applySavedPosition = () => {
            const denominator = Math.max(0, root.scrollHeight - root.clientHeight);
            const targetPage = Math.min(pageCount, Math.max(1, normalizedInitialProgress.pageNumber));
            const targetPageElement = root.querySelector(`[data-page-number="${targetPage}"]`);
            const nextScrollTop =
                normalizedInitialProgress.scrollRatio > 0 && denominator > 0
                    ? normalizedInitialProgress.scrollRatio * denominator
                    : targetPage > 1 && targetPageElement
                      ? Math.max(0, targetPageElement.offsetTop - 14)
                      : 0;
            const previousBehavior = root.style.scrollBehavior;
            root.style.scrollBehavior = 'auto';
            root.scrollTop = Math.min(denominator, Math.max(0, nextScrollTop));
            root.style.scrollBehavior = previousBehavior;
            currentPageRef.current = targetPage;
            latestProgressRef.current = {
                ...normalizedInitialProgress,
                pageNumber: targetPage,
                scrollRatio: denominator > 0 ? root.scrollTop / denominator : 0,
            };
        };

        // 首次布局与虚拟页占位都完成后再复核一次位置，避免先显示第一页再跳转。
        applySavedPosition();
        restoreFrameRef.current = requestAnimationFrame(() => {
            applySavedPosition();
            restoreSettleTimerRef.current = setTimeout(() => {
                // 先揭示内容，让 WebView 完成最终高度与滚动锚定，再跨帧按最终布局复核。
                // 此时 aria-busy 与内部保存门闩仍保持开启，不会误存过渡位置。
                applySavedPosition();
                setProgressContentHidden(false);
                restoreReleaseFrameRef.current = requestAnimationFrame(() => {
                    applySavedPosition();
                    restoreCompleteFrameRef.current = requestAnimationFrame(() => {
                        applySavedPosition();
                        restoredPaperRef.current = paperKey;
                        restoringRef.current = false;
                        setRestoringProgress(false);
                    });
                });
            }, READING_PROGRESS_RESTORE_SETTLE_MS);
        });

        return () => {
            if (restoreFrameRef.current != null) cancelAnimationFrame(restoreFrameRef.current);
            if (restoreReleaseFrameRef.current != null) cancelAnimationFrame(restoreReleaseFrameRef.current);
            if (restoreCompleteFrameRef.current != null) cancelAnimationFrame(restoreCompleteFrameRef.current);
            clearTimeout(restoreSettleTimerRef.current);
            restoreFrameRef.current = null;
            restoreSettleTimerRef.current = null;
            restoreReleaseFrameRef.current = null;
            restoreCompleteFrameRef.current = null;
        };
    }, [loadState, normalizedInitialProgress, pageCount, paperKey]);

    useEffect(() => {
        if (
            !pdfDocument ||
            !source ||
            !paperKey ||
            document?.textIndexComplete ||
            (!onReferencePages && !onDocumentPages)
        ) {
            return undefined;
        }
        let cancelled = false;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void extractSharedPdfText(paperKey, source, { signal: controller.signal })
                .then(async (result) => {
                    if (cancelled) return;
                    for (const page of result.pages) pageTextRef.current.set(page.pageNumber, page.text);
                    const tailStart = Math.max(1, result.pageCount - 23);
                    const referencePages = result.pages.filter(
                        (page) => page.pageNumber <= 2 || page.pageNumber >= tailStart
                    );
                    if (referencePages.length > 0) await onReferencePages?.(referencePages);
                    if (!cancelled) await onDocumentPages?.(result);
                })
                .catch((reason) => {
                    if (!cancelled && reason?.name !== 'AbortError') console.warn('论文全文解析失败', reason);
                });
        }, 360);
        return () => {
            cancelled = true;
            controller.abort();
            clearTimeout(timer);
        };
    }, [document?.textIndexComplete, onDocumentPages, onReferencePages, paperKey, pdfDocument, source]);

    const registerPage = useCallback((pageNumber, element) => {
        const previous = pageElementsRef.current.get(pageNumber);
        if (previous && previous !== element) pageObserverRef.current?.unobserve(previous);
        if (element) {
            pageElementsRef.current.set(pageNumber, element);
            pageObserverRef.current?.observe(element);
        } else {
            pageElementsRef.current.delete(pageNumber);
        }
    }, []);

    const goToPage = useCallback(
        (pageNumber) => {
            const safePage = Math.min(pageCount, Math.max(1, Number(pageNumber) || 1));
            currentPageRef.current = safePage;
            onPageChange?.(safePage);
            requestAnimationFrame(() => pageElementsRef.current.get(safePage)?.scrollIntoView({ block: 'start' }));
        },
        [onPageChange, pageCount]
    );

    const goToAnnotation = useCallback(
        (annotation) => {
            const safePage = Math.min(pageCount, Math.max(1, Number(annotation?.pageNumber) || 1));
            currentPageRef.current = safePage;
            onPageChange?.(safePage);
            requestAnimationFrame(() => {
                const root = scrollRef.current;
                const pageElement = pageElementsRef.current.get(safePage);
                if (!root || !pageElement) return;
                const firstRect = annotation?.rects?.[0];
                if (!firstRect) {
                    pageElement.scrollIntoView({ block: 'start' });
                    return;
                }
                const rootRect = root.getBoundingClientRect();
                const pageRect = pageElement.getBoundingClientRect();
                const annotationY = Math.min(1, Math.max(0, Number(firstRect.y) || 0));
                const visibleOffset = Math.min(120, root.clientHeight * 0.22);
                const targetTop =
                    root.scrollTop + (pageRect.top - rootRect.top) + pageRect.height * annotationY - visibleOffset;
                const maximum = Math.max(0, root.scrollHeight - root.clientHeight);
                root.scrollTo({
                    top: Math.min(maximum, Math.max(0, targetTop)),
                    behavior: 'smooth',
                });
            });
        },
        [onPageChange, pageCount]
    );

    const search = useCallback(
        async (query) => {
            const normalizedQuery = String(query ?? '')
                .trim()
                .toLocaleLowerCase();
            if (!normalizedQuery || !pdfDocument) return null;
            for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
                let pageText = pageTextRef.current.get(pageNumber);
                if (!pageText) {
                    const page = await pdfDocument.getPage(pageNumber);
                    const textContent = await page.getTextContent();
                    pageText = textContent.items
                        .map((item) => `${item.str}${item.hasEOL ? '\n' : ' '}`)
                        .join('')
                        .trim();
                    pageTextRef.current.set(pageNumber, pageText);
                }
                if (pageText.toLocaleLowerCase().includes(normalizedQuery)) {
                    goToPage(pageNumber);
                    return pageNumber;
                }
            }
            return null;
        },
        [goToPage, pdfDocument]
    );

    const renderPageForOcr = useCallback(
        async (pageNumber) => {
            if (!pdfDocument) throw new Error('PDF 尚未加载完成');
            const safePage = Math.min(pdfDocument.numPages, Math.max(1, Number(pageNumber) || 1));
            const page = await pdfDocument.getPage(safePage);
            const baseViewport = page.getViewport({ scale: 1 });
            const requestedScale = Math.min(3, Math.max(1.5, 1800 / baseViewport.width));
            const scaleForOcr = Math.min(
                requestedScale,
                Math.sqrt(MAX_OCR_PIXELS / Math.max(1, baseViewport.width * baseViewport.height))
            );
            const viewport = page.getViewport({ scale: scaleForOcr });
            const canvas = window.document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
            try {
                await page.render({ canvasContext: context, viewport }).promise;
                return canvas.toDataURL('image/png');
            } finally {
                canvas.width = 0;
                canvas.height = 0;
                page.cleanup?.();
            }
        },
        [pdfDocument]
    );

    const zoomTo = useCallback(
        (nextScale, anchorPoint) => {
            const root = scrollRef.current;
            const normalizedScale = Math.min(3, Math.max(0.5, Number(nextScale) || scaleRef.current));
            if (!root || !onScaleChange || Math.abs(normalizedScale - scaleRef.current) < 0.001) return false;
            // 缩放会重建 PDF.js 文字层。先使尚未提交的选区失效，避免旧 Range 在新坐标系中
            // 延迟弹出翻译窗；已经完成的翻译浮窗不会因此被关闭。
            cancelPendingSelection(true);
            const rootRect = root.getBoundingClientRect();
            const targetClientX = anchorPoint?.clientX ?? rootRect.left + rootRect.width / 2;
            const targetClientY = anchorPoint?.clientY ?? rootRect.top + rootRect.height / 2;
            const hitPage = globalThis.document
                .elementFromPoint(targetClientX, targetClientY)
                ?.closest?.('[data-page-number]');
            const pageElement =
                (hitPage && root.contains(hitPage) ? hitPage : null) ??
                pageElementsRef.current.get(currentPageRef.current) ??
                pageElementsRef.current.values().next().value;
            if (!pageElement) return false;
            const pageRect = pageElement.getBoundingClientRect();
            pendingZoomRef.current = {
                pageNumber: Number(pageElement.dataset.pageNumber),
                xRatio: Math.min(1, Math.max(0, (targetClientX - pageRect.left) / Math.max(1, pageRect.width))),
                yRatio: Math.min(1, Math.max(0, (targetClientY - pageRect.top) / Math.max(1, pageRect.height))),
                targetClientX,
                targetClientY,
                nextScale: normalizedScale,
            };
            // 连续触摸板事件可能先于 React 重绘到达，立即更新引用可避免重复基于旧比例计算。
            scaleRef.current = normalizedScale;
            onScaleChange(normalizedScale);
            return true;
        },
        [cancelPendingSelection, onScaleChange]
    );

    useLayoutEffect(() => {
        const pending = pendingZoomRef.current;
        const root = scrollRef.current;
        if (!pending || !root || Math.abs(pending.nextScale - scale) > 0.001) return undefined;
        const frame = requestAnimationFrame(() => {
            const pageElement = pageElementsRef.current.get(pending.pageNumber);
            if (!pageElement) {
                pendingZoomRef.current = null;
                return;
            }
            const pageRect = pageElement.getBoundingClientRect();
            const nextScroll = computeAnchoredScroll({
                scrollLeft: root.scrollLeft,
                scrollTop: root.scrollTop,
                anchorClientX: pageRect.left + pageRect.width * pending.xRatio,
                anchorClientY: pageRect.top + pageRect.height * pending.yRatio,
                targetClientX: pending.targetClientX,
                targetClientY: pending.targetClientY,
                maxScrollLeft: Math.max(0, root.scrollWidth - root.clientWidth),
                maxScrollTop: Math.max(0, root.scrollHeight - root.clientHeight),
            });
            const previousBehavior = root.style.scrollBehavior;
            root.style.scrollBehavior = 'auto';
            root.scrollLeft = nextScroll.scrollLeft;
            root.scrollTop = nextScroll.scrollTop;
            root.style.scrollBehavior = previousBehavior;
            pendingZoomRef.current = null;
        });
        return () => cancelAnimationFrame(frame);
    }, [scale]);

    useEffect(() => {
        const root = scrollRef.current;
        if (!root) return undefined;
        const handleWheel = (event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            cancelPendingSelection(true);
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 320 : 1;
            const pending = wheelZoomRef.current ?? {
                deltaY: 0,
                clientX: event.clientX,
                clientY: event.clientY,
            };
            pending.deltaY += event.deltaY * unit;
            pending.clientX = event.clientX;
            pending.clientY = event.clientY;
            wheelZoomRef.current = pending;
            if (wheelZoomFrameRef.current != null) return;
            wheelZoomFrameRef.current = requestAnimationFrame(() => {
                wheelZoomFrameRef.current = null;
                const next = wheelZoomRef.current;
                wheelZoomRef.current = null;
                if (!next) return;
                const nextScale = getContinuousPdfScale(scaleRef.current, next.deltaY, 0);
                zoomTo(nextScale, { clientX: next.clientX, clientY: next.clientY });
            });
        };
        root.addEventListener('wheel', handleWheel, { passive: false });
        return () => {
            root.removeEventListener('wheel', handleWheel);
            if (wheelZoomFrameRef.current != null) cancelAnimationFrame(wheelZoomFrameRef.current);
            wheelZoomFrameRef.current = null;
            wheelZoomRef.current = null;
        };
    }, [cancelPendingSelection, zoomTo]);

    useEffect(() => {
        const root = scrollRef.current;
        if (!root) return undefined;
        const gesturePoint = (event) => {
            const rootRect = root.getBoundingClientRect();
            return {
                clientX: Number.isFinite(event.clientX) ? event.clientX : rootRect.left + rootRect.width / 2,
                clientY: Number.isFinite(event.clientY) ? event.clientY : rootRect.top + rootRect.height / 2,
            };
        };
        const scheduleGestureZoom = () => {
            if (gestureZoomFrameRef.current != null) return;
            gestureZoomFrameRef.current = requestAnimationFrame(() => {
                gestureZoomFrameRef.current = null;
                const gesture = gestureZoomRef.current;
                if (!gesture) return;
                zoomTo(getGesturePdfScale(gesture.startScale, gesture.gestureScale), gesture);
                if (gesture.ended) gestureZoomRef.current = null;
            });
        };
        const handleGestureStart = (event) => {
            event.preventDefault();
            cancelPendingSelection(true);
            touchPointersRef.current.clear();
            pointerPinchRef.current = null;
            if (pointerPinchFrameRef.current != null) cancelAnimationFrame(pointerPinchFrameRef.current);
            pointerPinchFrameRef.current = null;
            gestureZoomRef.current = {
                startScale: scaleRef.current,
                gestureScale: 1,
                ...gesturePoint(event),
                ended: false,
            };
        };
        const handleGestureChange = (event) => {
            event.preventDefault();
            const current = gestureZoomRef.current ?? {
                startScale: scaleRef.current,
                gestureScale: 1,
                ...gesturePoint(event),
                ended: false,
            };
            gestureZoomRef.current = {
                ...current,
                ...gesturePoint(event),
                gestureScale: Number(event.scale) || current.gestureScale,
                ended: false,
            };
            scheduleGestureZoom();
        };
        const handleGestureEnd = (event) => {
            event.preventDefault();
            if (!gestureZoomRef.current) return;
            gestureZoomRef.current = {
                ...gestureZoomRef.current,
                ...gesturePoint(event),
                gestureScale: Number(event.scale) || gestureZoomRef.current.gestureScale,
                ended: true,
            };
            scheduleGestureZoom();
        };
        root.addEventListener('gesturestart', handleGestureStart, { passive: false });
        root.addEventListener('gesturechange', handleGestureChange, { passive: false });
        root.addEventListener('gestureend', handleGestureEnd, { passive: false });
        return () => {
            root.removeEventListener('gesturestart', handleGestureStart);
            root.removeEventListener('gesturechange', handleGestureChange);
            root.removeEventListener('gestureend', handleGestureEnd);
            if (gestureZoomFrameRef.current != null) cancelAnimationFrame(gestureZoomFrameRef.current);
            gestureZoomFrameRef.current = null;
            gestureZoomRef.current = null;
        };
    }, [cancelPendingSelection, zoomTo]);

    const schedulePointerPinchZoom = useCallback(() => {
        if (pointerPinchFrameRef.current != null) return;
        pointerPinchFrameRef.current = requestAnimationFrame(() => {
            pointerPinchFrameRef.current = null;
            const pinch = pointerPinchRef.current;
            if (!pinch) return;
            const active = pinch.active || shouldStartPointerPinch(pinch.startDistance, pinch.distance);
            if (!active) return;
            const resolvedPinch = { ...pinch, active };
            pointerPinchRef.current = resolvedPinch;
            zoomTo(
                getGesturePdfScale(resolvedPinch.startScale, resolvedPinch.distance / resolvedPinch.startDistance),
                resolvedPinch
            );
            if (resolvedPinch.ended) pointerPinchRef.current = null;
        });
    }, [zoomTo]);

    useImperativeHandle(
        ref,
        () => ({ goToPage, goToAnnotation, search, renderPageForOcr, zoomTo, flushProgress, pageCount }),
        [flushProgress, goToAnnotation, goToPage, pageCount, renderPageForOcr, search, zoomTo]
    );

    useEffect(
        () => () => {
            flushProgressRef.current?.();
            selectionCommitIdRef.current += 1;
            if (selectionFrameRef.current != null) window.cancelAnimationFrame(selectionFrameRef.current);
            if (gestureZoomFrameRef.current != null) window.cancelAnimationFrame(gestureZoomFrameRef.current);
            if (pointerPinchFrameRef.current != null) window.cancelAnimationFrame(pointerPinchFrameRef.current);
            touchPointersRef.current.clear();
            pointerPinchRef.current = null;
        },
        []
    );

    useEffect(() => {
        cancelPendingSelection(true);
    }, [cancelPendingSelection, interactionMode, paperKey]);

    useEffect(() => {
        if (restoringRef.current || restoredPaperRef.current !== paperKey) return;
        scheduleProgressSave();
    }, [currentPage, paperKey, scale, scheduleProgressSave]);

    useEffect(() => {
        const handleKeyDown = (event) => {
            if (event.code !== 'Space' || event.repeat || isInteractiveElement(event.target)) return;
            event.preventDefault();
            setSpacePressed(true);
        };
        const releaseSpace = (event) => {
            if (!event || event.code === 'Space') setSpacePressed(false);
        };
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', releaseSpace);
        window.addEventListener('blur', releaseSpace);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', releaseSpace);
            window.removeEventListener('blur', releaseSpace);
        };
    }, []);

    const handleVisibility = useCallback(
        (pageNumber, isVisible, ratio) => {
            if (restoringRef.current) return;
            if (isVisible) visibilityRef.current.set(pageNumber, ratio);
            else visibilityRef.current.delete(pageNumber);
            const nextVisible = [...visibilityRef.current.keys()].sort((a, b) => a - b);
            if (nextVisible.length > 0) {
                setVisiblePages((current) =>
                    current.length === nextVisible.length && current.every((page, index) => page === nextVisible[index])
                        ? current
                        : nextVisible
                );
            }

            let bestPage = currentPageRef.current;
            let bestRatio = -1;
            visibilityRef.current.forEach((value, page) => {
                if (value > bestRatio) {
                    bestRatio = value;
                    bestPage = page;
                }
            });
            if (bestPage !== currentPageRef.current) {
                currentPageRef.current = bestPage;
                onPageChange?.(bestPage);
            }
        },
        [onPageChange]
    );

    useEffect(() => {
        const root = scrollRef.current;
        if (!root || loadState !== 'ready') return undefined;
        // 整本书共用一个观察器；数千页时不再为每页创建独立 IntersectionObserver。
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const pageNumber = Number(entry.target?.dataset?.pageNumber);
                    if (pageNumber > 0) handleVisibility(pageNumber, entry.isIntersecting, entry.intersectionRatio);
                }
            },
            { root, rootMargin: '0px', threshold: [0, 0.05, 0.25, 0.55, 0.9] }
        );
        pageObserverRef.current = observer;
        pageElementsRef.current.forEach((element) => observer.observe(element));
        return () => {
            if (pageObserverRef.current === observer) pageObserverRef.current = null;
            observer.disconnect();
        };
    }, [handleVisibility, loadState, paperKey]);

    const handlePageText = useCallback(
        (pageNumber, text) => {
            pageTextRef.current.set(pageNumber, text);
            onPageText?.(pageNumber, text);
        },
        [onPageText]
    );

    const handleScannedPage = useCallback((pageNumber, scanned) => {
        setScannedPages((current) => {
            if (current.has(pageNumber) === scanned) return current;
            const next = new Set(current);
            if (scanned) next.add(pageNumber);
            else next.delete(pageNumber);
            return next;
        });
    }, []);

    const handleScroll = () => {
        scheduleProgressSave();
    };

    const finishPan = (event) => {
        const pan = panGestureRef.current;
        if (!pan || (event.pointerId != null && pan.pointerId !== event.pointerId)) return;
        panGestureRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        setIsPanning(false);
    };

    const trackTouchPointerDown = (event) => {
        if (event.pointerType !== 'touch') return false;
        touchPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
        const geometry = getPointerPinchGeometry(touchPointersRef.current.values());
        if (!geometry) return false;

        // 第二个触点出现后先建立候选手势，但只有间距明显变化才接管；两指同向移动仍交给原生滚动。
        if (!pointerPinchRef.current) {
            cancelPendingSelection(true);
            const pan = panGestureRef.current;
            if (pan && event.currentTarget.hasPointerCapture?.(pan.pointerId)) {
                event.currentTarget.releasePointerCapture(pan.pointerId);
            }
            panGestureRef.current = null;
            setIsPanning(false);
            pointerPinchRef.current = {
                pointerIds: Array.from(touchPointersRef.current.keys()).slice(0, 2),
                startScale: scaleRef.current,
                startDistance: geometry.distance,
                distance: geometry.distance,
                clientX: geometry.clientX,
                clientY: geometry.clientY,
                active: false,
                ended: false,
            };
        }
        return true;
    };

    const updateTouchPointer = (event) => {
        if (!touchPointersRef.current.has(event.pointerId)) return false;
        touchPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
        const pinch = pointerPinchRef.current;
        if (!pinch || !pinch.pointerIds.includes(event.pointerId)) return false;
        const geometry = getPointerPinchGeometry(
            pinch.pointerIds.map((pointerId) => touchPointersRef.current.get(pointerId)).filter(Boolean)
        );
        if (!geometry) return false;
        pointerPinchRef.current = {
            ...pinch,
            ...geometry,
            ended: false,
        };
        schedulePointerPinchZoom();
        if (!pinch.active) return false;
        event.preventDefault();
        return true;
    };

    const finishTouchPointer = (event, cancelled = false) => {
        if (!touchPointersRef.current.has(event.pointerId)) return false;
        touchPointersRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
        const pinch = pointerPinchRef.current;
        const belongsToPinch = Boolean(pinch?.pointerIds.includes(event.pointerId));
        const finalGeometry = belongsToPinch
            ? getPointerPinchGeometry(
                  pinch.pointerIds.map((pointerId) => touchPointersRef.current.get(pointerId)).filter(Boolean)
              )
            : null;
        touchPointersRef.current.delete(event.pointerId);
        if (!belongsToPinch) return false;

        const completedPinch =
            !cancelled &&
            (pinch.active ||
                Boolean(finalGeometry && shouldStartPointerPinch(pinch.startDistance, finalGeometry.distance)));
        if (completedPinch) {
            event.preventDefault();
            pointerPinchRef.current = {
                ...pinch,
                ...(finalGeometry ?? {}),
                active: true,
                ended: true,
            };
            schedulePointerPinchZoom();
        } else {
            if (pointerPinchFrameRef.current != null) cancelAnimationFrame(pointerPinchFrameRef.current);
            pointerPinchFrameRef.current = null;
            pointerPinchRef.current = null;
        }
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        return true;
    };
    finishTouchPointerRef.current = finishTouchPointer;

    const handlePointerDown = (event) => {
        const joinedPointerPinch = trackTouchPointerDown(event);
        if (joinedPointerPinch) return;
        cancelPendingSelection(false);
        const shouldPan =
            !isInteractiveElement(event.target) &&
            (event.button === 1 || (event.button === 0 && (interactionMode === 'pan' || spacePressed)));
        if (shouldPan) {
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
            selectionGestureRef.current = null;
            const root = scrollRef.current;
            panGestureRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startScrollLeft: root.scrollLeft,
                startScrollTop: root.scrollTop,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            event.currentTarget.focus({ preventScroll: true });
            setIsPanning(true);
            return;
        }

        selectionGestureRef.current = null;
        if (event.button !== 0 || interactionMode !== 'select') return;
        const layer = event.target.closest?.('[data-pdf-selection-layer]');
        const pageElement = layer?.closest?.('[data-page-number]');
        const visualLine = capturePdfVisualLine(layer, event.target, event.clientX, event.clientY);
        if (!layer || !pageElement) return;
        selectionGestureRef.current = {
            commitId: selectionCommitIdRef.current,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            lineHeight: visualLine?.lineRect.height || 12,
            layer,
            pageElement,
            visualLine,
        };
    };

    const handlePointerMove = (event) => {
        if (updateTouchPointer(event)) return;
        const pan = panGestureRef.current;
        const root = scrollRef.current;
        if (!pan || !root || pan.pointerId !== event.pointerId) return;
        event.preventDefault();
        const nextScroll = computePanScroll({
            ...pan,
            currentX: event.clientX,
            currentY: event.clientY,
            maxScrollLeft: Math.max(0, root.scrollWidth - root.clientWidth),
            maxScrollTop: Math.max(0, root.scrollHeight - root.clientHeight),
        });
        root.scrollLeft = nextScroll.scrollLeft;
        root.scrollTop = nextScroll.scrollTop;
    };

    const finishSelectionGesture = (event) => {
        const gesture = selectionGestureRef.current;
        if (
            !gesture ||
            (event.pointerId != null && gesture.pointerId !== event.pointerId) ||
            event.button !== 0 ||
            interactionMode !== 'select'
        )
            return;
        selectionGestureRef.current = null;
        const pointerEnd = { x: event.clientX, y: event.clientY };
        const scheduleCommit = (attempt) => {
            selectionFrameRef.current = window.requestAnimationFrame(() => {
                selectionFrameRef.current = null;
                if (gesture.commitId !== selectionCommitIdRef.current) return;
                const browserSelection = window.getSelection();
                if (!browserSelection) return;
                let range = browserSelection.rangeCount === 1 ? browserSelection.getRangeAt(0) : null;
                const retryCommit = () => {
                    if (attempt + 1 < SELECTION_COMMIT_MAX_ATTEMPTS) scheduleCommit(attempt + 1);
                };
                if (
                    gesture.visualLine &&
                    isNearHorizontalPdfGesture(gesture.startY, pointerEnd.y, gesture.lineHeight)
                ) {
                    const resolvedRange = resolvePdfHorizontalRange(gesture.visualLine, pointerEnd.x, range);
                    if (!resolvedRange) {
                        retryCommit();
                        return;
                    }
                    if (resolvedRange !== range) {
                        browserSelection.removeAllRanges();
                        browserSelection.addRange(resolvedRange);
                        range = browserSelection.getRangeAt(0);
                    }
                }
                // WebView2 对多行 Selection 的提交时点并不稳定：某些 PDF 会晚一至两帧。
                // 有界重试只读取同一次手势，下一次按下、缩放或切换交互模式都会通过 commitId 使其失效。
                if (!range || range.collapsed) {
                    retryCommit();
                    return;
                }
                if (
                    selectionLayerForNode(range.startContainer) !== gesture.layer ||
                    selectionLayerForNode(range.endContainer) !== gesture.layer
                ) {
                    retryCommit();
                    return;
                }
                const quote = browserSelection.toString();
                if (!shouldTranslateSelection(quote)) {
                    retryCommit();
                    return;
                }
                const pageElement = gesture.pageElement;
                const pageNumber = Number(pageElement.dataset.pageNumber);
                const pageText =
                    pageTextRef.current.get(pageNumber) || pageElement.dataset.pageText || pageElement.textContent;
                const anchor = createSelectionAnchor({
                    paperId: document?.paper?.id,
                    pageNumber,
                    quote,
                    pageText,
                    pageRect: pageElement.getBoundingClientRect(),
                    rects: [...range.getClientRects()],
                });
                const selectionRects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
                const selectionRect = mergeClientRects(selectionRects) ?? range.getBoundingClientRect();
                const anchorRect =
                    selectionRects.reduce((closest, rect) => {
                        const distance = Math.abs(rect.bottom - pointerEnd.y) + Math.abs(rect.right - pointerEnd.x);
                        if (!closest || distance < closest.distance) return { rect, distance };
                        return closest;
                    }, null)?.rect ?? range.getBoundingClientRect();
                const boundary = scrollRef.current?.getBoundingClientRect();
                onSelection?.(anchor, pageText, {
                    anchorRect: {
                        left: anchorRect.left,
                        right: anchorRect.right,
                        top: anchorRect.top,
                        bottom: anchorRect.bottom,
                        width: anchorRect.width,
                        height: anchorRect.height,
                    },
                    selectionRect: {
                        left: selectionRect.left,
                        right: selectionRect.right,
                        top: selectionRect.top,
                        bottom: selectionRect.bottom,
                        width: selectionRect.width,
                        height: selectionRect.height,
                    },
                    boundaryRect: boundary
                        ? { left: boundary.left, right: boundary.right, top: boundary.top, bottom: boundary.bottom }
                        : undefined,
                    clientX: pointerEnd.x,
                    clientY: pointerEnd.y,
                });
            });
        };
        // PointerUp 比 MouseUp 在 WebView2/触摸板组合下更可靠，但此时默认选区尚未提交，
        // 因而仍从下一帧开始读取，并在必要时进行最多三帧的有界复核。
        scheduleCommit(0);
    };
    finishSelectionGestureRef.current = finishSelectionGesture;

    useEffect(() => {
        // 松手可能发生在阅读区外（例如拖到侧栏或窗口边缘）。全局监听只转发给当前
        // 手势，区域内 PointerUp 已经消费手势后，后续 MouseUp 会因 ref 为空自然去重。
        const finishGlobalSelection = (event) => {
            if (finishTouchPointerRef.current?.(event)) return;
            finishSelectionGestureRef.current?.(event);
        };
        const cancelGlobalSelection = (event) => {
            if (finishTouchPointerRef.current?.(event, true)) return;
            cancelSelectionForPointer(event);
        };
        window.addEventListener('pointerup', finishGlobalSelection);
        window.addEventListener('mouseup', finishGlobalSelection);
        window.addEventListener('pointercancel', cancelGlobalSelection);
        return () => {
            window.removeEventListener('pointerup', finishGlobalSelection);
            window.removeEventListener('mouseup', finishGlobalSelection);
            window.removeEventListener('pointercancel', cancelGlobalSelection);
        };
    }, [cancelSelectionForPointer]);

    const handleContextMenu = (event) => {
        if (!activeSelection?.quote || !event.target.closest?.('[data-pdf-selection-layer]')) return;
        event.preventDefault();
        const boundary = scrollRef.current?.getBoundingClientRect();
        const browserSelection = window.getSelection();
        const selectedRange = browserSelection?.rangeCount === 1 ? browserSelection.getRangeAt(0) : null;
        const selectionRect = selectedRange ? mergeClientRects(selectedRange.getClientRects()) : null;
        onSelectionContextMenu?.({
            clientX: event.clientX,
            clientY: event.clientY,
            selectionRect,
            boundaryRect: boundary
                ? { left: boundary.left, right: boundary.right, top: boundary.top, bottom: boundary.bottom }
                : undefined,
        });
    };

    const annotationsByPage = useMemo(() => {
        const map = new Map();
        annotations.forEach((annotation) => {
            const list = map.get(annotation.pageNumber) ?? [];
            list.push(annotation);
            map.set(annotation.pageNumber, list);
        });
        return map;
    }, [annotations]);

    if (loadState === 'error') {
        return (
            <main className='pdf-workspace pdf-workspace--error'>
                <PiFileMagnifyingGlass />
                <strong>无法打开这篇 PDF</strong>
                <p>{error}</p>
            </main>
        );
    }

    return (
        <main
            className={`pdf-workspace pdf-workspace--${interactionMode} ${spacePressed ? 'is-space-pan' : ''} ${isPanning ? 'is-panning' : ''} ${progressContentHidden ? 'is-restoring-progress' : ''}`}
            ref={scrollRef}
            tabIndex={0}
            aria-busy={loadState === 'loading' || restoringProgress}
            aria-label={textMode ? '文献阅读区' : 'PDF 阅读区'}
            onScroll={handleScroll}
            onAuxClick={(event) => event.preventDefault()}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => {
                if (finishTouchPointer(event)) return;
                if (panGestureRef.current) finishPan(event);
                else finishSelectionGesture(event);
            }}
            onPointerCancel={(event) => {
                if (finishTouchPointer(event, true)) return;
                cancelSelectionForPointer(event);
                finishPan(event);
            }}
            onLostPointerCapture={finishPan}
            onMouseUp={finishSelectionGesture}
            onContextMenu={handleContextMenu}
        >
            {loadState === 'loading' ? (
                <div className='pdf-loading'>
                    <PiSpinnerGap />
                    <span>正在解析 PDF 文本层…</span>
                </div>
            ) : null}
            {progressContentHidden && loadState !== 'loading' ? (
                <div
                    className='pdf-loading pdf-progress-restore'
                    role='status'
                >
                    <PiSpinnerGap />
                    <span>正在恢复上次阅读位置…</span>
                </div>
            ) : null}
            {loadState === 'text' ? (
                <div className='pdf-page-stack'>
                    <TextDocumentPage
                        document={document}
                        scale={scale}
                        pageRef={(element) => registerPage(1, element)}
                    >
                        <div className='pdf-annotation-layer'>
                            <AnnotationMarks
                                annotations={annotationsByPage.get(1) ?? []}
                                onActivate={onAnnotationActivate}
                                onDelete={onAnnotationDelete}
                            />
                        </div>
                    </TextDocumentPage>
                </div>
            ) : loadState === 'demo' ? (
                <DemoPdfPage
                    selection={activeSelection}
                    annotations={annotationsByPage.get(2) ?? []}
                    onAnnotationActivate={onAnnotationActivate}
                    onAnnotationDelete={onAnnotationDelete}
                />
            ) : (
                <div className='pdf-page-stack'>
                    {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
                        <VirtualPdfPage
                            key={pageNumber}
                            pdfDocument={pdfDocument}
                            pageNumber={pageNumber}
                            active={renderPages.has(pageNumber)}
                            scale={scale}
                            annotations={annotationsByPage.get(pageNumber) ?? []}
                            onAnnotationActivate={onAnnotationActivate}
                            onAnnotationDelete={onAnnotationDelete}
                            onText={handlePageText}
                            onScanned={handleScannedPage}
                            registerPage={registerPage}
                        />
                    ))}
                </div>
            )}
            {scannedPages.has(currentPage) ? (
                <div className='scan-page-notice'>
                    <PiFileMagnifyingGlass aria-hidden='true' />
                    <span>当前页没有文本层，可能是扫描页。</span>
                    <button
                        type='button'
                        onClick={() => onScanPage?.(currentPage)}
                    >
                        识别当前页
                    </button>
                    <button
                        type='button'
                        onClick={onScanDocument}
                    >
                        后台识别全文
                    </button>
                </div>
            ) : null}
        </main>
    );
});

export default PdfWorkspace;
