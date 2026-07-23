import { useState } from 'react';
import {
    PiArrowsOut,
    PiCaretLeft,
    PiCaretRight,
    PiCursorClick,
    PiFilePdf,
    PiHand,
    PiMagnifyingGlass,
    PiSidebarSimple,
    PiSpeakerHigh,
} from 'react-icons/pi';

import { formatShortcutForPlatform, getPlatformPresentation } from '../../../utils/platform';

const PLATFORM_PRESENTATION = getPlatformPresentation();
const ZOOM_SHORTCUT = formatShortcutForPlatform('CommandOrControl');

export function getTranslationStatusPresentation(translationStatus) {
    if (translationStatus?.enabled === false) {
        return { state: 'disabled', label: '已关闭', color: '#9aa0aa' };
    }
    const ready = translationStatus?.ready === true;
    const checking = !translationStatus?.message || /正在检查/u.test(translationStatus.message);
    return {
        state: ready ? 'ready' : checking ? 'checking' : 'unavailable',
        label: ready ? '就绪' : checking ? '检测中' : '不可用',
        color: ready ? '#55be72' : checking ? '#d99b35' : '#d45d66',
    };
}

export function getOllamaModelDisplayName(model) {
    const value = String(model ?? '').trim();
    if (/^translategemma(?::|$)/iu.test(value)) return 'TranslateGemma';
    if (/^gemma4:e4b/iu.test(value)) return 'Gemma 4 E4B';
    if (/^qwen3\.5:4b/iu.test(value)) return 'Qwen3.5 4B';
    if (/^qwen3\.5:9b/iu.test(value)) return 'Qwen3.5 9B';
    return value || 'Ollama';
}

export function groupPapersByProject(papers = [], projects = []) {
    const availablePapers = papers.filter((paper) => paper && !paper.trashedAt);
    const projectMap = new Map();
    for (const project of projects) {
        if (project?.id) projectMap.set(String(project.id), project);
    }
    for (const paper of availablePapers) {
        for (const project of paper.projects ?? []) {
            if (project?.id && !projectMap.has(String(project.id))) {
                projectMap.set(String(project.id), project);
            }
        }
    }

    const groups = [...projectMap.values()].map((project) => ({
        id: String(project.id),
        label: `项目 · ${project.name}`,
        papers: availablePapers.filter((paper) =>
            (paper.projects ?? []).some((item) => String(item?.id ?? item) === String(project.id))
        ),
    }));
    const unclassified = availablePapers.filter((paper) => !(paper.projects?.length > 0));
    if (unclassified.length > 0 || groups.every((group) => group.papers.length === 0)) {
        groups.push({ id: '__unclassified__', label: '未分类', papers: unclassified });
    }
    return groups.filter((group) => group.papers.length > 0);
}

export default function ReaderTopbar({
    paper,
    papers = [],
    projects = [],
    activePaperId,
    onPaperChange,
    currentPage,
    pageCount,
    scale,
    onPageChange,
    interactionMode,
    onInteractionModeChange,
    onSearch,
    translationStatus,
    sidebarCollapsed = false,
    onSidebarToggle,
}) {
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchValue, setSearchValue] = useState('');
    const modelStatus = getTranslationStatusPresentation(translationStatus);
    const paperGroups = groupPapersByProject(papers, projects);

    const submitSearch = (event) => {
        event.preventDefault();
        onSearch?.(searchValue);
    };

    const toggleFullscreen = async () => {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen?.();
    };

    return (
        <header className='reader-topbar'>
            <div className='reader-topbar__paper-area'>
                <button
                    className='icon-button reader-sidebar-toggle'
                    type='button'
                    aria-label={sidebarCollapsed ? '显示阅读侧栏' : '隐藏阅读侧栏'}
                    aria-pressed={!sidebarCollapsed}
                    title={sidebarCollapsed ? '显示概要、摘录与引用' : '隐藏概要、摘录与引用'}
                    onClick={onSidebarToggle}
                >
                    <PiSidebarSimple aria-hidden='true' />
                </button>
                <label
                    className='reader-paper-switcher'
                    title='按项目切换当前论文'
                >
                    <PiFilePdf aria-hidden='true' />
                    <span className='visually-hidden'>切换论文</span>
                    <select
                        aria-label='切换论文'
                        value={activePaperId || paper?.id || ''}
                        onChange={(event) => onPaperChange?.(event.target.value)}
                    >
                        {paperGroups.map((group) => (
                            <optgroup
                                key={group.id}
                                label={group.label}
                            >
                                {group.papers.map((item) => (
                                    <option
                                        key={`${group.id}-${item.id}`}
                                        value={item.id}
                                    >
                                        {item.title}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                </label>
            </div>
            <div
                className='reader-toolbar'
                aria-label='PDF 工具栏'
            >
                <button
                    className='icon-button'
                    type='button'
                    aria-label='上一页'
                    onClick={() => onPageChange(currentPage - 1)}
                >
                    <PiCaretLeft />
                </button>
                <label className='page-field'>
                    <input
                        aria-label='当前页码'
                        inputMode='numeric'
                        value={currentPage}
                        onChange={(event) => onPageChange(Number(event.target.value))}
                    />
                </label>
                <span className='reader-toolbar__page-count'>/ {pageCount || 1}</span>
                <button
                    className='icon-button'
                    type='button'
                    aria-label='下一页'
                    onClick={() => onPageChange(currentPage + 1)}
                >
                    <PiCaretRight />
                </button>
                <form
                    className={`reader-search ${searchOpen ? 'is-open' : ''}`}
                    onSubmit={submitSearch}
                >
                    {searchOpen ? (
                        <input
                            autoFocus
                            value={searchValue}
                            onChange={(event) => setSearchValue(event.target.value)}
                            onBlur={() => !searchValue && setSearchOpen(false)}
                            placeholder='在论文中查找'
                        />
                    ) : null}
                    <button
                        className='icon-button'
                        type='button'
                        aria-label='搜索'
                        onClick={() => setSearchOpen(true)}
                    >
                        <PiMagnifyingGlass />
                    </button>
                </form>
                <div
                    className='reader-tool-mode'
                    role='group'
                    aria-label='鼠标工具'
                >
                    <button
                        type='button'
                        aria-label='划词工具'
                        aria-pressed={interactionMode === 'select'}
                        title='划词工具（S）'
                        onClick={() => onInteractionModeChange?.('select')}
                    >
                        <PiCursorClick />
                    </button>
                    <button
                        type='button'
                        aria-label='平移工具'
                        aria-pressed={interactionMode === 'pan'}
                        title='平移工具（H）；划词模式下也可按住空格拖动'
                        onClick={() => onInteractionModeChange?.('pan')}
                    >
                        <PiHand />
                    </button>
                </div>
                <output
                    className='zoom-status'
                    aria-label='当前缩放比例'
                    title={`${ZOOM_SHORTCUT} + 鼠标滚轮，或触摸板双指捏合缩放`}
                >
                    {Math.round(scale * 100)}%
                </output>
                <button
                    className='icon-button'
                    type='button'
                    aria-label='全屏阅读'
                    onClick={toggleFullscreen}
                >
                    <PiArrowsOut />
                </button>
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
