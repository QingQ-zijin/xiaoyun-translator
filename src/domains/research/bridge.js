import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { synthesizeSpeech } from '../translation';
import { UNIFIED_OLLAMA_MODEL } from '../ollama/runtime';
import { isTauriRuntime as isDesktopTauriRuntime, translateWithDesktopBackend } from '../translation/desktopTransport';
import { resolveAcademicTargetLanguage } from '../translation/language';
import { DEMO_ANNOTATIONS, DEMO_DOCUMENT, DEMO_PAPERS, DEMO_TAGS, DEMO_TRANSLATION } from './demoData';
import { buildAiEvidence, RESEARCH_AI_INTENTS } from './model';

const clone = (value) => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const createId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;

const DOCUMENT_EXTENSIONS = Object.freeze(['pdf', 'md', 'markdown', 'docx', 'tex']);
const DOCUMENT_EXTENSION_PATTERN = /\.(?:pdf|md|markdown|docx|tex)$/iu;
const DOCUMENT_INDEX_BATCH_SIZE = 32;
const MAX_PAPER_BATCH_SIZE = 500;

export function normalizeContentKind(value) {
    return String(value ?? '')
        .trim()
        .toLocaleLowerCase() === 'book'
        ? 'book'
        : 'paper';
}

function documentMetadata(path) {
    const sourcePath = String(path ?? '');
    const extension = sourcePath.match(/\.([^.\\/]+)$/u)?.[1]?.toLocaleLowerCase() ?? '';
    if (extension === 'md' || extension === 'markdown') {
        return { sourceFormat: 'markdown', documentType: 'markdown' };
    }
    if (extension === 'docx') return { sourceFormat: 'docx', documentType: 'text' };
    if (extension === 'tex') return { sourceFormat: 'tex', documentType: 'tex' };
    return { sourceFormat: 'pdf', documentType: 'pdf' };
}

function normalizeDemoPaper(paper) {
    const metadata = documentMetadata(paper?.sourcePath || paper?.path || `${paper?.title ?? 'paper'}.pdf`);
    const createdAt = String(paper?.createdAt ?? paper?.updatedAt ?? now());
    return {
        ...paper,
        contentKind: normalizeContentKind(paper?.contentKind),
        sourceFormat: paper?.sourceFormat || metadata.sourceFormat,
        documentType: paper?.documentType || metadata.documentType,
        textContent: String(paper?.textContent ?? ''),
        importWarning: String(paper?.importWarning ?? ''),
        sourcePath: String(paper?.sourcePath ?? paper?.path ?? ''),
        archivedAt: paper?.archivedAt ?? null,
        trashedAt: paper?.trashedAt ?? null,
        createdAt,
        lastOpenedAt: String(paper?.lastOpenedAt ?? createdAt),
        projects: paper?.projects ?? [],
    };
}

let demoPapers = clone(DEMO_PAPERS).map(normalizeDemoPaper);
let demoTags = clone(DEMO_TAGS);
let demoProjects = [];
let demoAnnotations = clone(DEMO_ANNOTATIONS);

const DEMO_INSIGHTS = Object.freeze({
    status: 'ready',
    summary:
        '本文研究海马体不同亚区在陈述性记忆编码与提取中的分工，并以高分辨率成像比较 DG、CA3、CA1 与下托的功能贡献。',
    researchQuestion: '海马体各亚区是否在记忆编码、模式分离、模式补全和信息输出中承担可区分的作用？',
    methods: ['高分辨率 7T fMRI', '参与者水平建模', '多重比较校正'],
    findings: ['DG 更关联模式分离', 'CA3 更关联模式补全', 'CA1 负责整合并向皮层传递信息'],
    limitations: ['人体亚区的精确功能边界仍需更大样本和纵向研究验证'],
    terms: [
        {
            term: 'pattern separation',
            translation: '模式分离',
            annotation: '把高度相似的输入编码为彼此可区分的记忆表征。',
            pageNumbers: [2],
        },
        {
            term: 'pattern completion',
            translation: '模式补全',
            annotation: '依据部分线索恢复较完整记忆表征的过程。',
            pageNumbers: [2],
        },
    ],
    model: 'gemma4:e4b-it-qat',
    updatedAt: now(),
});

export const isTauriRuntime = isDesktopTauriRuntime;

function isUnknownCommandError(error) {
    return /unknown command|command .* not found|not in the allowlist|missing required key/iu.test(String(error ?? ''));
}

async function invokeResearch(command, args = {}) {
    if (!isTauriRuntime()) throw new Error('DEMO_RUNTIME');
    return invoke(command, args);
}

export async function listPapers({ includeTrashed = true } = {}) {
    if (!isTauriRuntime()) {
        return clone(includeTrashed ? demoPapers : demoPapers.filter((paper) => !paper.trashedAt && !paper.archivedAt));
    }
    return invokeResearch('research_list_papers', { includeTrashed });
}

function normalizePaperIds(paperIds) {
    if (!Array.isArray(paperIds) || paperIds.length === 0) throw new Error('至少选择一篇论文');
    const normalized = [];
    const seen = new Set();
    for (const value of paperIds) {
        const paperId = String(value ?? '').trim();
        if (!paperId) throw new Error('论文 ID 不能为空');
        if (!seen.has(paperId)) {
            seen.add(paperId);
            normalized.push(paperId);
            if (normalized.length > MAX_PAPER_BATCH_SIZE) {
                throw new Error(`每次最多批量处理 ${MAX_PAPER_BATCH_SIZE} 篇论文`);
            }
        }
    }
    return normalized;
}

function updateDemoPaperLifecycle(paperIds, transition) {
    const normalized = normalizePaperIds(paperIds);
    const existingIds = new Set(demoPapers.map((paper) => String(paper.id)));
    const missingId = normalized.find((paperId) => !existingIds.has(paperId));
    if (missingId) throw new Error(`论文不存在：${missingId}`);
    const selectedIds = new Set(normalized);
    const timestamp = now();
    demoPapers = demoPapers.map((paper) => {
        if (!selectedIds.has(String(paper.id))) return paper;
        if (transition === 'archive') return { ...paper, archivedAt: timestamp, trashedAt: null, updatedAt: timestamp };
        if (transition === 'trash') return { ...paper, archivedAt: null, trashedAt: timestamp, updatedAt: timestamp };
        return { ...paper, archivedAt: null, trashedAt: null, updatedAt: timestamp };
    });
    updateDemoProjectCounts();
    return clone(normalized);
}

function validateProjectInput({ name, color = '#7664e9', description = '' }) {
    const safeName = String(name ?? '').trim();
    const safeColor = String(color ?? '')
        .trim()
        .toLowerCase();
    const safeDescription = String(description ?? '')
        .replace(/\r\n?/gu, '\n')
        .trim();
    if (![...safeName].length || [...safeName].length > 80) throw new Error('项目名称需为 1–80 个字符');
    if ([...safeName].some((character) => /\p{Cc}/u.test(character))) {
        throw new Error('项目名称不能包含换行符或控制字符');
    }
    if (!/^#[0-9a-f]{6}$/u.test(safeColor)) throw new Error('项目颜色必须是 #RRGGBB 格式');
    if ([...safeDescription].length > 1_000) throw new Error('项目说明不能超过 1000 个字符');
    if (
        [...safeDescription].some((character) => /\p{Cc}/u.test(character) && character !== '\n' && character !== '\t')
    ) {
        throw new Error('项目说明包含不允许的控制字符');
    }
    return { name: safeName, color: safeColor, description: safeDescription };
}

function updateDemoProjectCounts() {
    demoProjects = demoProjects.map((project) => ({
        ...project,
        paperCount: demoPapers.filter(
            (paper) =>
                !paper.trashedAt &&
                !paper.archivedAt &&
                paper.projects?.some((candidate) => candidate.id === project.id)
        ).length,
    }));
    demoPapers = demoPapers.map((paper) => ({
        ...paper,
        projects: (paper.projects ?? [])
            .map((project) => demoProjects.find((candidate) => candidate.id === project.id))
            .filter(Boolean),
    }));
}

export async function listProjects() {
    if (isTauriRuntime()) return invokeResearch('research_list_projects');
    updateDemoProjectCounts();
    return clone(demoProjects);
}

export async function createProject(input) {
    const project = validateProjectInput(input ?? {});
    if (isTauriRuntime()) return invokeResearch('research_create_project', project);
    const timestamp = now();
    const created = {
        id: createId('project'),
        ...project,
        paperCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    demoProjects = [created, ...demoProjects];
    return clone(created);
}

export async function updateProject(projectId, input) {
    const safeProjectId = String(projectId ?? '').trim();
    if (!safeProjectId) throw new Error('项目 ID 不能为空');
    const project = validateProjectInput(input ?? {});
    if (isTauriRuntime()) return invokeResearch('research_update_project', { projectId: safeProjectId, ...project });
    const existing = demoProjects.find((candidate) => candidate.id === safeProjectId);
    if (!existing) throw new Error('项目不存在');
    const updated = { ...existing, ...project, updatedAt: now() };
    demoProjects = demoProjects.map((candidate) => (candidate.id === safeProjectId ? updated : candidate));
    updateDemoProjectCounts();
    return clone(demoProjects.find((candidate) => candidate.id === safeProjectId));
}

export async function deleteProject(projectId) {
    const safeProjectId = String(projectId ?? '').trim();
    if (!safeProjectId) throw new Error('项目 ID 不能为空');
    if (isTauriRuntime()) return invokeResearch('research_delete_project', { projectId: safeProjectId });
    if (!demoProjects.some((project) => project.id === safeProjectId)) throw new Error('项目不存在');
    demoProjects = demoProjects.filter((project) => project.id !== safeProjectId);
    demoPapers = demoPapers.map((paper) => ({
        ...paper,
        projects: (paper.projects ?? []).filter((project) => project.id !== safeProjectId),
    }));
}

export async function setPaperProjects(paperId, projectIds) {
    const safePaperId = String(paperId ?? '').trim();
    if (!safePaperId) throw new Error('论文 ID 不能为空');
    const rawProjectIds = Array.isArray(projectIds) ? projectIds.map((projectId) => String(projectId).trim()) : [];
    if (rawProjectIds.some((projectId) => !projectId)) throw new Error('项目 ID 不能为空');
    const safeProjectIds = [...new Set(rawProjectIds)];
    if (safeProjectIds.length > 100) throw new Error('每篇论文最多加入 100 个项目');
    if (isTauriRuntime()) {
        return invokeResearch('research_set_paper_projects', { paperId: safePaperId, projectIds: safeProjectIds });
    }
    const paper = demoPapers.find((candidate) => candidate.id === safePaperId);
    if (!paper) throw new Error('论文不存在');
    const projects = safeProjectIds.map((projectId) => {
        const project = demoProjects.find((candidate) => candidate.id === projectId);
        if (!project) throw new Error(`项目不存在：${projectId}`);
        return project;
    });
    demoPapers = demoPapers.map((candidate) =>
        candidate.id === safePaperId ? { ...candidate, projects, updatedAt: now() } : candidate
    );
    updateDemoProjectCounts();
    return clone(demoPapers.find((candidate) => candidate.id === safePaperId)?.projects ?? []);
}

export async function choosePdfPaths(contentKind = 'paper') {
    if (!isTauriRuntime()) return null;
    const safeContentKind = normalizeContentKind(contentKind);
    const selected = await openDialog({
        title: safeContentKind === 'book' ? '导入书籍' : '导入论文',
        multiple: true,
        directory: false,
        filters: [
            { name: safeContentKind === 'book' ? '支持的书籍' : '支持的文献', extensions: [...DOCUMENT_EXTENSIONS] },
        ],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    return [...new Set(paths.map(String).filter((path) => DOCUMENT_EXTENSION_PATTERN.test(path)))];
}

export async function importPapers(paths, contentKind = 'paper') {
    const safePaths = [...new Set((paths ?? []).map(String).filter((path) => DOCUMENT_EXTENSION_PATTERN.test(path)))];
    if (safePaths.length === 0) return [];
    const safeContentKind = normalizeContentKind(contentKind);
    if (isTauriRuntime()) {
        return invokeResearch('research_import_papers', {
            paths: safePaths,
            contentKind: safeContentKind,
        });
    }

    const imported = safePaths.map((path) => {
        const metadata = documentMetadata(path);
        const filename = path.split(/[\\/]/u).at(-1);
        const title = filename.replace(DOCUMENT_EXTENSION_PATTERN, '');
        const textContent =
            metadata.documentType === 'pdf'
                ? ''
                : `# ${title}\n\n这是演示模式中的 ${metadata.sourceFormat.toLocaleUpperCase()} 文献内容。`;
        const timestamp = now();
        return normalizeDemoPaper({
            id: createId('demo-paper'),
            title,
            contentKind: safeContentKind,
            authors: '待补充作者',
            year: new Date().getFullYear(),
            pageCount: 1,
            path: metadata.documentType === 'pdf' ? path : '',
            sourcePath: path,
            ...metadata,
            textContent,
            importWarning: '',
            createdAt: timestamp,
            lastOpenedAt: timestamp,
            updatedAt: timestamp,
            progress: { pageNumber: 1, scale: 1.25, scrollRatio: 0 },
            tags: [],
            projects: [],
        });
    });
    demoPapers = [...imported, ...demoPapers];
    return clone(imported);
}

export async function movePaperToTrash(paperId) {
    if (isTauriRuntime()) return invokeResearch('research_move_to_trash', { paperId });
    updateDemoPaperLifecycle([paperId], 'trash');
}

export async function restorePaper(paperId) {
    if (isTauriRuntime()) return invokeResearch('research_restore_paper', { paperId });
    updateDemoPaperLifecycle([paperId], 'restore');
}

export async function archivePapers(paperIds) {
    const normalized = normalizePaperIds(paperIds);
    if (isTauriRuntime()) return invokeResearch('research_archive_papers', { paperIds: normalized });
    return updateDemoPaperLifecycle(normalized, 'archive');
}

export async function unarchivePapers(paperIds) {
    const normalized = normalizePaperIds(paperIds);
    if (isTauriRuntime()) return invokeResearch('research_unarchive_papers', { paperIds: normalized });
    return updateDemoPaperLifecycle(normalized, 'unarchive');
}

export async function movePapersToTrash(paperIds) {
    const normalized = normalizePaperIds(paperIds);
    if (isTauriRuntime()) return invokeResearch('research_move_papers_to_trash', { paperIds: normalized });
    return updateDemoPaperLifecycle(normalized, 'trash');
}

export async function restorePapers(paperIds) {
    const normalized = normalizePaperIds(paperIds);
    if (isTauriRuntime()) return invokeResearch('research_restore_papers', { paperIds: normalized });
    return updateDemoPaperLifecycle(normalized, 'restore');
}

export async function deletePaperPermanently(paperId) {
    if (isTauriRuntime()) return invokeResearch('research_delete_paper_permanently', { paperId });
    demoPapers = demoPapers.filter((paper) => paper.id !== paperId);
    demoAnnotations = demoAnnotations.filter((annotation) => annotation.paperId !== paperId);
}

export async function listTags() {
    if (isTauriRuntime()) return invokeResearch('research_list_tags');
    return clone(demoTags);
}

export async function setPaperTags(paperId, tagIds) {
    if (isTauriRuntime()) return invokeResearch('research_set_paper_tags', { paperId, tagIds });
    const nextTags = demoTags.filter((tag) => tagIds.includes(tag.id));
    demoPapers = demoPapers.map((paper) => (paper.id === paperId ? { ...paper, tags: nextTags } : paper));
    return clone(nextTags);
}

export async function createTag(name, color = '#7664e9') {
    const trimmedName = String(name ?? '').trim();
    if (!trimmedName) throw new Error('标签名不能为空');
    if (isTauriRuntime()) {
        try {
            return await invokeResearch('research_create_tag', { name: trimmedName, color });
        } catch (error) {
            if (!isUnknownCommandError(error)) throw error;
            throw new Error('当前后端版本尚未开放新建标签命令');
        }
    }
    const tag = { id: createId('tag'), name: trimmedName, color };
    demoTags = [...demoTags, tag];
    return clone(tag);
}

export async function getDocument(paperId) {
    if (isTauriRuntime()) return invokeResearch('research_get_document', { paperId });
    const timestamp = now();
    demoPapers = demoPapers.map((item) => (item.id === paperId ? { ...item, lastOpenedAt: timestamp } : item));
    const paper = demoPapers.find((item) => item.id === paperId) ?? demoPapers[0];
    return clone({
        ...DEMO_DOCUMENT,
        paper,
        contentKind: normalizeContentKind(paper?.contentKind),
        progress: paper?.progress ?? { pageNumber: 1, scale: 1.25, scrollRatio: 0 },
        path: paper?.documentType === 'pdf' ? String(paper?.path ?? '') : '',
        sourcePath: String(paper?.sourcePath ?? ''),
        sourceFormat: paper?.sourceFormat ?? 'pdf',
        documentType: paper?.documentType ?? 'pdf',
        textContent: String(paper?.textContent ?? ''),
        importWarning: String(paper?.importWarning ?? ''),
        texCompiler: String(paper?.texCompiler ?? ''),
        pageCount: paper?.pageCount ?? DEMO_DOCUMENT.pageCount,
        textIndexComplete: Boolean(paper?.textIndexComplete),
    });
}

export function getPdfSource(document) {
    if (document?.documentType !== 'pdf') return '';
    const path = String(document?.path ?? '');
    if (!path) return '';
    if (/^(?:https?:|data:|blob:|asset:)/iu.test(path)) return path;
    return isTauriRuntime() ? convertFileSrc(path) : path;
}

export async function saveReadingProgress(paperId, progress) {
    if (isTauriRuntime()) return invokeResearch('research_save_progress', { paperId, ...progress });
    const timestamp = now();
    demoPapers = demoPapers.map((paper) =>
        paper.id === paperId ? { ...paper, progress, lastOpenedAt: timestamp, updatedAt: timestamp } : paper
    );
}

export async function updateDocumentPageCount(paperId, pageCount) {
    if (!isTauriRuntime()) return;
    return invokeResearch('research_update_page_count', { paperId, pageCount });
}

export async function markDocumentTextIndexComplete(paperId, pageCount) {
    if (!isTauriRuntime()) return;
    return invokeResearch('research_mark_text_index_complete', { paperId, pageCount });
}

function normalizeOutlineItems(outline) {
    return (Array.isArray(outline) ? outline : [])
        .map((item) => ({
            title: String(item?.title ?? '')
                .replace(/[\t\f\v ]+/gu, ' ')
                .trim()
                .slice(0, 240),
            pageNumber: Math.max(1, Math.trunc(Number(item?.pageNumber) || 1)),
            endPage: Math.max(1, Math.trunc(Number(item?.endPage ?? item?.pageNumber) || 1)),
            level: Math.min(8, Math.max(1, Math.trunc(Number(item?.level) || 1))),
            source: String(item?.source ?? 'text').trim() || 'text',
            confidence: Math.min(1, Math.max(0, Number(item?.confidence) || 0)),
        }))
        .filter((item) => item.title)
        .slice(0, 512);
}

export async function replaceDocumentOutline(paperId, outline) {
    const safePaperId = String(paperId ?? '').trim();
    if (!safePaperId) throw new Error('论文 ID 不能为空');
    const safeOutline = normalizeOutlineItems(outline);
    if (!isTauriRuntime()) return clone(safeOutline);
    return invokeResearch('research_replace_document_outline', { paperId: safePaperId, outline: safeOutline });
}

export async function rebuildDocumentOutline(paperId, source = 'ocr') {
    const safePaperId = String(paperId ?? '').trim();
    if (!safePaperId) throw new Error('论文 ID 不能为空');
    const safeSource =
        String(source ?? 'ocr')
            .trim()
            .toLocaleLowerCase() || 'ocr';
    if (!isTauriRuntime()) return [];
    return invokeResearch('research_rebuild_document_outline', { paperId: safePaperId, source: safeSource });
}

export async function indexDocumentPage(paperId, pageNumber, text) {
    const content = String(text ?? '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map((line) => line.replace(/[\t\f\v ]+/gu, ' ').trimEnd())
        .join('\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
    if (!content || !isTauriRuntime()) return 0;
    return invokeResearch('research_index_page', { paperId, pageNumber, text: content });
}

export async function indexDocumentPages(paperId, pages) {
    const safePages = (Array.isArray(pages) ? pages : [])
        .map((page) => ({
            pageNumber: Math.max(1, Number(page?.pageNumber) || 1),
            text: String(page?.text ?? '')
                .replace(/\r\n?/gu, '\n')
                .split('\n')
                .map((line) => line.replace(/[\t\f\v ]+/gu, ' ').trimEnd())
                .join('\n')
                .replace(/\n{3,}/gu, '\n\n')
                .trim(),
        }))
        .filter((page) => page.text);
    if (!paperId || safePages.length === 0 || !isTauriRuntime()) return 0;
    let indexedChunks = 0;
    // 超长文档按 32 页提交，避免一次 IPC 序列化整本电子书并占用双份内存。
    for (let start = 0; start < safePages.length; start += DOCUMENT_INDEX_BATCH_SIZE) {
        indexedChunks += Number(
            await invokeResearch('research_index_pages', {
                paperId,
                pages: safePages.slice(start, start + DOCUMENT_INDEX_BATCH_SIZE),
            })
        );
    }
    return indexedChunks;
}

export async function getPaperInsights(paperId) {
    if (!paperId) return { status: 'waitingForText' };
    if (!isTauriRuntime()) return clone(DEMO_INSIGHTS);
    return invokeResearch('research_get_paper_insights', { paperId });
}

export async function listPendingPaperInsights() {
    if (!isTauriRuntime()) return [];
    return invokeResearch('research_list_pending_paper_insights');
}

export async function isTranslationActive() {
    if (!isTauriRuntime()) return false;
    return invokeResearch('research_is_translation_active');
}

export async function generatePaperInsights(paperId, { force = false } = {}) {
    if (!paperId) throw new Error('论文 ID 不能为空');
    if (!isTauriRuntime()) return clone(DEMO_INSIGHTS);
    return invokeResearch('research_generate_paper_insights', { paperId, force });
}

function normalizeChapterRequest(paperId, chapter) {
    const safePaperId = String(paperId ?? '').trim();
    if (!safePaperId) throw new Error('论文 ID 不能为空');
    const title = String(chapter?.title ?? '')
        .trim()
        .slice(0, 240);
    if (!title) throw new Error('章节标题不能为空');
    const startPage = Math.max(1, Math.trunc(Number(chapter?.startPage ?? chapter?.pageNumber) || 1));
    const endPage = Math.max(startPage, Math.trunc(Number(chapter?.endPage) || startPage));
    const ordinal = Math.max(0, Math.trunc(Number(chapter?.ordinal ?? chapter?.index) || 0));
    return { paperId: safePaperId, ordinal, title, startPage, endPage };
}

export async function listChapterInsights(paperId) {
    const safePaperId = String(paperId ?? '').trim();
    if (!safePaperId) return [];
    if (!isTauriRuntime()) return [];
    return invokeResearch('research_list_chapter_insights', { paperId: safePaperId });
}

export async function getChapterInsights(paperId, chapter) {
    const request = normalizeChapterRequest(paperId, chapter);
    if (!isTauriRuntime()) {
        return { ...request, status: 'not_started', payload: { summary: '', terms: [] }, cached: false };
    }
    return invokeResearch('research_get_chapter_insights', request);
}

export async function generateChapterInsights(paperId, chapter, { force = false } = {}) {
    const request = normalizeChapterRequest(paperId, chapter);
    if (!isTauriRuntime()) {
        return { ...request, status: 'not_started', payload: { summary: '', terms: [] }, cached: false };
    }
    return invokeResearch('research_generate_chapter_insights', { ...request, force });
}

export async function cancelPaperInsights(paperId) {
    if (!paperId || !isTauriRuntime()) return false;
    return invokeResearch('research_cancel_paper_insights', { paperId });
}

function createAbortError() {
    return new DOMException('请求已取消', 'AbortError');
}

export async function defineTerm({ selection, targetLanguage = 'zh_cn', signal }) {
    if (signal?.aborted) throw createAbortError();
    const term = String(selection?.quote ?? '').trim();
    if (!term) throw new Error('词条不能为空');
    if (!isTauriRuntime()) {
        const entry = {
            term,
            phonetics: [{ region: 'UK/US', ipa: '/ˈpætən/' }],
            senses: [
                { partOfSpeech: 'noun', definitions: ['模式；样式', '规律；行为范式'] },
                { partOfSpeech: 'verb', definitions: ['使形成规律或模式'] },
            ],
            contextMeaning: '在本文语境中指神经活动或记忆表征呈现的组织方式。',
            domainNote: '神经科学术语需结合 pattern separation / completion 等搭配理解。',
            model: 'gemma4:e4b-it-qat',
        };
        return entry;
    }
    const requestId = createId('define-term');
    const cancel = () => {
        void invokeResearch('research_cancel_define_term', { requestId }).catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        const result = await invokeResearch('research_define_term', {
            term,
            contextBefore: String(selection?.prefix ?? '').slice(-600),
            contextAfter: String(selection?.suffix ?? '').slice(0, 600),
            targetLanguage,
            requestId,
        });
        if (signal?.aborted) throw createAbortError();
        return result;
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
}

export async function syncPaperReferences(paperId, pages) {
    const safePages = (Array.isArray(pages) ? pages : [])
        .map((page) => ({
            pageNumber: Math.max(1, Number(page?.pageNumber) || 1),
            text: String(page?.text ?? '')
                .replace(/\r\n?/gu, '\n')
                .trim(),
        }))
        .filter((page) => page.text);
    if (!paperId || safePages.length === 0) return [];
    if (!isTauriRuntime()) return [];
    const relations = await invokeResearch('research_sync_paper_references', { paperId, pages: safePages });
    return {
        outbound: (relations ?? []).filter((relation) => relation.direction === 'outgoing'),
        inbound: (relations ?? []).filter((relation) => relation.direction === 'incoming'),
    };
}

export async function listPaperRelations(paperId) {
    if (!paperId) return { outbound: [], inbound: [] };
    if (!isTauriRuntime()) return { outbound: [], inbound: [] };
    const relations = await invokeResearch('research_list_paper_relations', { paperId });
    return {
        outbound: (relations ?? []).filter((relation) => relation.direction === 'outgoing'),
        inbound: (relations ?? []).filter((relation) => relation.direction === 'incoming'),
    };
}

export async function listAnnotations(paperId) {
    if (isTauriRuntime()) return invokeResearch('research_list_annotations', { paperId });
    return clone(demoAnnotations.filter((annotation) => annotation.paperId === paperId));
}

export async function saveAnnotation(annotation) {
    if (isTauriRuntime()) return invokeResearch('research_save_annotation', { annotation });
    const saved = { ...annotation, id: annotation.id ?? createId('annotation'), updatedAt: now() };
    const exists = demoAnnotations.some((item) => item.id === saved.id);
    demoAnnotations = exists
        ? demoAnnotations.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...demoAnnotations];
    return clone(saved);
}

export async function deleteAnnotation(annotationId) {
    if (isTauriRuntime()) return invokeResearch('research_delete_annotation', { annotationId });
    demoAnnotations = demoAnnotations.filter((annotation) => annotation.id !== annotationId);
}

export async function startOcrJob(paperId, scope, totalPages = 1) {
    if (!isTauriRuntime()) {
        return { jobId: createId('demo-ocr'), kind: `ocr-${scope}`, state: 'queued', total: totalPages, completed: 0 };
    }
    return invokeResearch('research_start_ocr_job', { paperId, scope, totalPages });
}

export async function enqueueOcrPage(jobId, paperId, pageNumber, imageDataUrl) {
    if (!imageDataUrl) throw new Error('OCR 页面图像为空');
    if (!isTauriRuntime()) return { jobId, kind: 'ocr-page', state: 'completed', total: 1, completed: 1 };
    return invokeResearch('research_enqueue_ocr_page', { jobId, paperId, pageNumber, imageDataUrl });
}

export async function pauseResearchJob(jobId, paused) {
    if (!isTauriRuntime()) return { jobId, state: paused ? 'paused' : 'queued' };
    return invokeResearch('research_pause_job', { jobId, paused });
}

export async function cancelResearchJob(jobId) {
    if (!isTauriRuntime()) return;
    return invokeResearch('research_cancel_job', { jobId });
}

export async function subscribeToResearchJobs(callback) {
    if (!isTauriRuntime()) return () => {};
    return listen('research://job-progress', (event) => callback(event.payload));
}

export async function getSemanticStatus(paperId) {
    if (!isTauriRuntime()) {
        return {
            model: UNIFIED_OLLAMA_MODEL,
            installed: true,
            confirmationRequired: false,
            installConfirmed: false,
            estimatedDownloadMb: 0,
            chunkCount: 1,
            embeddedChunkCount: 1,
            ready: true,
            retrievalMode: 'lexical',
        };
    }
    return invokeResearch('research_get_semantic_status', { paperId });
}

export async function getTranslationStatus() {
    if (!isTauriRuntime()) {
        return { model: UNIFIED_OLLAMA_MODEL, ready: true, message: 'Gemma 4 E4B 已就绪' };
    }
    return invokeResearch('research_get_translation_status');
}

export async function authorizeEmbeddingInstall() {
    if (!isTauriRuntime()) return true;
    const settings = await invoke('get_settings_v2');
    await invoke('update_settings_v2', {
        settings: {
            ...settings,
            ollama: { ...settings.ollama, embeddingInstallConfirmed: true },
        },
    });
    return true;
}

export async function startEmbeddingIndex(paperId) {
    if (!isTauriRuntime()) return { jobId: '', kind: 'embedding', state: 'completed', total: 1, completed: 1 };
    return invokeResearch('research_start_embedding_index', { paperId });
}

export async function translateSelection({
    selection,
    paperTitle,
    paperInsights,
    sourceLanguage = 'auto',
    targetLanguage = 'zh_cn',
    onDelta,
    onStatus,
    signal,
}) {
    const effectiveTargetLanguage = resolveAcademicTargetLanguage(selection.quote, targetLanguage);
    const insightPayload = paperInsights?.payload ?? paperInsights ?? {};
    const paperSummary = String(insightPayload.summary ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 800);
    const sourceScope =
        `${selection.quote ?? ''} ${selection.prefix ?? ''} ${selection.suffix ?? ''}`.toLocaleLowerCase();
    const paperTerms = (Array.isArray(insightPayload.terms) ? insightPayload.terms : [])
        .map((item) => ({
            term: String(item?.term ?? '')
                .trim()
                .slice(0, 120),
            translation: String(item?.translation ?? '')
                .trim()
                .slice(0, 120),
            annotation: String(item?.annotation ?? '')
                .replace(/\s+/gu, ' ')
                .trim()
                .slice(0, 180),
        }))
        .filter((item) => item.term && item.translation && sourceScope.includes(item.term.toLocaleLowerCase()))
        .slice(0, 12);
    const payload = {
        text: selection.quote,
        pageNumber: selection.pageNumber,
        paperTitle: String(paperTitle ?? '')
            .trim()
            .slice(0, 240),
        paperSummary,
        paperTerms,
        contextBefore: String(selection.prefix ?? '').slice(-600),
        contextAfter: String(selection.suffix ?? '').slice(0, 600),
        sourceLanguage,
        targetLanguage: effectiveTargetLanguage,
    };

    if (!isTauriRuntime()) {
        onDelta?.(DEMO_TRANSLATION);
        return DEMO_TRANSLATION;
    }

    return translateWithDesktopBackend({
        invokeCommand: invokeResearch,
        payload,
        onDelta,
        onStatus,
        signal,
        label: '论文划词翻译',
    });
}

export async function askPaper({
    paperId,
    question,
    paperTitle,
    selection,
    pageText,
    intent = RESEARCH_AI_INTENTS.PAPER_QA,
    signal,
}) {
    const evidence = buildAiEvidence({ paperTitle, selection, pageText, intent });
    if (signal?.aborted) throw new DOMException('论文问答已取消', 'AbortError');
    if (!isTauriRuntime()) {
        const explainsSelection = evidence.intent === RESEARCH_AI_INTENTS.EXPLAIN_SELECTION;
        return {
            answer: explainsSelection
                ? '结合选区上下文，这一术语描述的是不同对象或组成部分在性质、结构或功能上的差异。具体含义应以它在当前学科语境中的修饰对象为准。'
                : '当前证据表明，所选段落强调海马体各亚区在记忆形成与提取中的分工。齿状回主要关联模式分离，CA3 关联模式补全，CA1 则负责整合和向皮层传递信息。',
            citations: explainsSelection ? [] : [{ pageNumber: evidence.pageNumber, quote: evidence.quote }],
            refused: false,
            retrievalMode: explainsSelection ? 'contextual' : 'selection',
        };
    }

    try {
        const result = await invokeResearch('research_ai_query', { paperId, question, evidence });
        if (signal?.aborted) throw new DOMException('论文问答已取消', 'AbortError');
        return result;
    } catch (error) {
        if (!isUnknownCommandError(error)) throw error;
        throw new Error('当前程序后端不支持论文问答，请安装最新版本后重试。');
    }
}

export async function speakText(text, language = 'zh_cn') {
    return synthesizeSpeech({ text, language });
}

export async function subscribeToDocumentDrops(callback) {
    if (!isTauriRuntime()) return () => {};
    return getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        const paths = event.payload.paths ?? [];
        callback(paths.filter((path) => DOCUMENT_EXTENSION_PATTERN.test(path)));
    });
}

// 保留原导出名，避免阅读器调用方在同一版本升级中出现短暂断链。
export const subscribeToPdfDrops = subscribeToDocumentDrops;
