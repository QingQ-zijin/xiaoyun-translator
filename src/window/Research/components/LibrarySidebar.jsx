import { useEffect, useMemo, useState } from 'react';
import {
    PiArrowLeft,
    PiArchive,
    PiBookmarkSimple,
    PiBooks,
    PiCaretRight,
    PiListBullets,
    PiMagnifyingGlass,
    PiPlus,
    PiShareNetwork,
    PiSparkle,
    PiTag,
    PiTrash,
} from 'react-icons/pi';
import { annotationKind, summarizeAnnotations } from '../../../domains/research/model';
import FormattedTranslation from '../../Translate/components/FormattedTranslation';
import DocumentOutlinePanel from './DocumentOutlinePanel';
import PaperInsightsPanel from './PaperInsightsPanel';
import ProjectSection from './ProjectSection';

const ANNOTATION_KIND_LABELS = {
    vocabulary: '词汇',
    excerpt: '摘抄',
    note: '笔记',
    highlight: '高亮',
    text: '文字',
};

const ANNOTATION_KIND_FILTERS = [
    { id: 'vocabulary', countKey: 'vocabulary', label: '词汇' },
    { id: 'excerpt', countKey: 'excerpts', label: '摘抄' },
    { id: 'note', countKey: 'notes', label: '笔记' },
    { id: 'highlight', countKey: 'highlights', label: '高亮' },
    { id: 'text', countKey: 'texts', label: '文字' },
];

const READER_TAB_IDS = ['insights', 'outline', 'glossary', 'annotations', 'relations'];

function handleReaderTabKeyDown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll('[role=tab]')];
    const currentIndex = tabs.indexOf(event.target.closest('[role=tab]'));
    if (currentIndex < 0 || !tabs.length) return;
    event.preventDefault();
    const nextIndex =
        event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
}

function AnnotationRow({ annotation, onJump, onOpen, onDelete }) {
    const colorMap = {
        violet: '#c9bff7',
        amber: '#f5dc91',
        blue: '#b8cbf8',
        green: '#a9dfbf',
        rose: '#f2b2c2',
    };
    const kind = annotationKind(annotation);
    const lexicon = annotation.lexicon ?? annotation.payload?.lexicon ?? null;
    const phonetics = (lexicon?.phonetics ?? []).filter((item) => item?.ipa);
    const deleteLabel =
        kind === 'highlight' ? '取消高亮' : kind === 'note' ? '删除笔记' : kind === 'text' ? '删除文字' : '删除摘录';
    return (
        <div className='recent-annotation'>
            <button
                className='recent-annotation__open'
                type='button'
                onClick={() => {
                    if (['note', 'highlight', 'text'].includes(kind) && onOpen) onOpen(annotation);
                    else onJump?.(annotation);
                }}
            >
                <span
                    className='recent-annotation__swatch'
                    style={{ background: colorMap[annotation.color] ?? colorMap.violet }}
                />
                <span className='recent-annotation__body'>
                    <span className='recent-annotation__heading'>
                        <strong>{annotation.quote || annotation.note || '未命名摘录'}</strong>
                        <em>{ANNOTATION_KIND_LABELS[kind]}</em>
                    </span>
                    <small>
                        第 {annotation.pageNumber} 页
                        {phonetics.length
                            ? ` · ${phonetics.map((item) => `${item.region ? `${item.region} ` : ''}${item.ipa}`).join(' / ')}`
                            : ''}
                    </small>
                    {lexicon?.contextMeaning ? (
                        <span className='recent-annotation__meaning'>{lexicon.contextMeaning}</span>
                    ) : annotation.note ? (
                        <span className='recent-annotation__meaning'>{annotation.note}</span>
                    ) : null}
                    {annotation.tags?.length ? (
                        <span className='recent-annotation__tags'>
                            {annotation.tags.map((tag) => `#${tag}`).join(' ')}
                        </span>
                    ) : null}
                </span>
                <PiCaretRight aria-hidden='true' />
            </button>
            <button
                className='recent-annotation__delete'
                type='button'
                aria-label={`${deleteLabel}：${annotation.quote || annotation.note || `第 ${annotation.pageNumber} 页批注`}`}
                title={deleteLabel}
                onClick={() => onDelete?.(annotation)}
            >
                <PiTrash aria-hidden='true' />
            </button>
        </div>
    );
}

function GlossaryPanel({ entries = [], onJump, onDelete }) {
    const [query, setQuery] = useState('');
    const visibleEntries = useMemo(() => {
        const normalized = query.trim().toLocaleLowerCase();
        if (!normalized) return entries;
        return entries.filter((entry) =>
            [entry.term, entry.translation, entry.definition].join(' ').toLocaleLowerCase().includes(normalized)
        );
    }, [entries, query]);

    return (
        <section className='glossary-panel'>
            <label className='glossary-panel__search'>
                <PiMagnifyingGlass aria-hidden='true' />
                <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder='搜索术语、译名或解释'
                />
            </label>
            <p className='glossary-panel__hint'>从全文解读选择收录，或在正文中划词后选择“摘抄单词”。</p>
            <div className='glossary-panel__list'>
                {visibleEntries.map((entry) => (
                    <article key={entry.id}>
                        <header>
                            <button
                                type='button'
                                className='glossary-panel__term'
                                onClick={() => onJump?.(entry.pageNumber)}
                            >
                                <strong>{entry.term}</strong>
                                {entry.translation ? <em>{entry.translation}</em> : null}
                            </button>
                            <button
                                type='button'
                                className='glossary-panel__delete'
                                aria-label={`从词库删除：${entry.term}`}
                                onClick={() => onDelete?.(entry)}
                            >
                                <PiTrash aria-hidden='true' />
                            </button>
                        </header>
                        {entry.definition ? (
                            <FormattedTranslation
                                value={entry.definition}
                                fontSize={13}
                            />
                        ) : null}
                        <footer>
                            第 {entry.pageNumber} 页 · {entry.sourceType === 'insight' ? '全文解读' : '划词收录'}
                        </footer>
                    </article>
                ))}
            </div>
            {visibleEntries.length === 0 ? <p className='sidebar-empty'>词库中还没有匹配的术语。</p> : null}
        </section>
    );
}

export default function LibrarySidebar({
    mode,
    paper,
    annotations = [],
    onBack,
    onJump,
    onOpenAnnotation,
    onDeleteAnnotation,
    query,
    onQueryChange,
    view,
    onViewChange,
    tags = [],
    activeTagId,
    onTagChange,
    paperCounts,
    projects = [],
    activeProjectId = '',
    onProjectChange,
    onCreateProject,
    onUpdateProject,
    onDeleteProject,
    onImport,
    importing = false,
    relations = { outbound: [], inbound: [] },
    onOpenPaper,
    insights,
    insightsError = '',
    onRegenerate,
    outline = [],
    currentPage = 1,
    chapterInsights = [],
    chapterInsightState,
    onSelectChapter,
    onRegenerateChapter,
    readerTab: controlledReaderTab,
    onReaderTabChange,
    annotationKindFilter: controlledAnnotationKindFilter,
    onAnnotationKindFilterChange,
    glossaryEntries = [],
    onAddGlossaryTerm,
    onDeleteGlossaryEntry,
}) {
    const isBook = paper?.contentKind === 'book';
    const defaultReaderTab = isBook ? 'outline' : 'insights';
    const [localReaderTab, setLocalReaderTab] = useState(defaultReaderTab);
    const [localAnnotationKindFilter, setLocalAnnotationKindFilter] = useState('');
    const [annotationTag, setAnnotationTag] = useState('');
    const readerTab = controlledReaderTab ?? localReaderTab;
    const annotationKindFilter = controlledAnnotationKindFilter ?? localAnnotationKindFilter;
    const activeReaderTab = isBook && readerTab === 'insights' ? 'outline' : readerTab;
    const annotationSummary = useMemo(() => summarizeAnnotations(annotations), [annotations]);
    const visibleAnnotations = useMemo(
        () =>
            annotations.filter((annotation) => {
                const matchesKind = !annotationKindFilter || annotationKind(annotation) === annotationKindFilter;
                const matchesTag =
                    !annotationTag ||
                    annotation.tags?.some((tag) => tag.toLocaleLowerCase() === annotationTag.toLocaleLowerCase());
                return matchesKind && matchesTag;
            }),
        [annotationKindFilter, annotationTag, annotations]
    );
    const selectReaderTab = (nextTab) => {
        if (controlledReaderTab == null) setLocalReaderTab(nextTab);
        onReaderTabChange?.(nextTab);
    };
    const selectAnnotationKind = (kind) => {
        const nextKind = annotationKindFilter === kind ? '' : kind;
        if (controlledAnnotationKindFilter == null) setLocalAnnotationKindFilter(nextKind);
        onAnnotationKindFilterChange?.(nextKind);
    };

    useEffect(() => {
        if (controlledReaderTab == null) setLocalReaderTab(defaultReaderTab);
        if (controlledAnnotationKindFilter == null) setLocalAnnotationKindFilter('');
        setAnnotationTag('');
    }, [controlledAnnotationKindFilter, controlledReaderTab, defaultReaderTab, paper?.id]);

    if (mode === 'reader') {
        return (
            <aside
                className='research-sidebar research-sidebar--assistant'
                aria-label='小允论文阅读器'
            >
                <header className='research-sidebar__header'>
                    <button
                        className='icon-button'
                        type='button'
                        aria-label='返回论文库'
                        onClick={onBack}
                    >
                        <PiArrowLeft />
                    </button>
                    <div>
                        <strong>小允论文阅读器</strong>
                        <span title={paper?.title}>{paper?.title}</span>
                    </div>
                </header>
                <nav
                    className={`reader-sidebar-tabs ${isBook ? 'reader-sidebar-tabs--book' : ''}`}
                    aria-label='阅读侧栏'
                    role='tablist'
                    onKeyDown={handleReaderTabKeyDown}
                >
                    {!isBook ? (
                        <button
                            type='button'
                            id='reader-sidebar-tab-insights'
                            role='tab'
                            aria-controls='reader-sidebar-panel'
                            aria-selected={activeReaderTab === 'insights'}
                            tabIndex={activeReaderTab === 'insights' ? 0 : -1}
                            className={activeReaderTab === 'insights' ? 'is-active' : ''}
                            onClick={() => selectReaderTab('insights')}
                        >
                            <PiSparkle aria-hidden='true' />
                            <span>概要</span>
                        </button>
                    ) : null}
                    <button
                        type='button'
                        id='reader-sidebar-tab-outline'
                        role='tab'
                        aria-controls='reader-sidebar-panel'
                        aria-selected={activeReaderTab === 'outline'}
                        tabIndex={activeReaderTab === 'outline' ? 0 : -1}
                        className={activeReaderTab === 'outline' ? 'is-active' : ''}
                        onClick={() => selectReaderTab('outline')}
                    >
                        <PiListBullets aria-hidden='true' />
                        <span>{isBook ? '目录' : '章节'}</span>
                    </button>
                    <button
                        type='button'
                        id='reader-sidebar-tab-glossary'
                        role='tab'
                        aria-controls='reader-sidebar-panel'
                        aria-selected={activeReaderTab === 'glossary'}
                        tabIndex={activeReaderTab === 'glossary' ? 0 : -1}
                        className={activeReaderTab === 'glossary' ? 'is-active' : ''}
                        onClick={() => selectReaderTab('glossary')}
                    >
                        <PiBooks aria-hidden='true' />
                        <span>词库</span>
                        {glossaryEntries.length ? <small>{glossaryEntries.length}</small> : null}
                    </button>
                    <button
                        type='button'
                        id='reader-sidebar-tab-annotations'
                        role='tab'
                        aria-label='笔记与摘录'
                        aria-controls='reader-sidebar-panel'
                        aria-selected={activeReaderTab === 'annotations'}
                        tabIndex={activeReaderTab === 'annotations' ? 0 : -1}
                        className={activeReaderTab === 'annotations' ? 'is-active' : ''}
                        onClick={() => selectReaderTab('annotations')}
                    >
                        <PiBookmarkSimple aria-hidden='true' />
                        <span>笔记</span>
                        {annotationSummary.total ? <small>{annotationSummary.total}</small> : null}
                    </button>
                    <button
                        type='button'
                        id='reader-sidebar-tab-relations'
                        role='tab'
                        aria-controls='reader-sidebar-panel'
                        aria-selected={activeReaderTab === 'relations'}
                        tabIndex={activeReaderTab === 'relations' ? 0 : -1}
                        className={activeReaderTab === 'relations' ? 'is-active' : ''}
                        onClick={() => selectReaderTab('relations')}
                    >
                        <PiShareNetwork aria-hidden='true' />
                        <span>引用</span>
                    </button>
                </nav>
                <div
                    className='reader-sidebar-content'
                    id='reader-sidebar-panel'
                    role='tabpanel'
                    tabIndex={0}
                    aria-labelledby={`reader-sidebar-tab-${READER_TAB_IDS.includes(activeReaderTab) ? activeReaderTab : defaultReaderTab}`}
                >
                    {activeReaderTab === 'insights' ? (
                        <PaperInsightsPanel
                            insights={insights}
                            error={insightsError}
                            onJump={onJump}
                            onRegenerate={onRegenerate}
                            glossaryEntries={glossaryEntries}
                            onAddTerm={onAddGlossaryTerm}
                        />
                    ) : null}
                    {activeReaderTab === 'glossary' ? (
                        <GlossaryPanel
                            entries={glossaryEntries}
                            onJump={onJump}
                            onDelete={onDeleteGlossaryEntry}
                        />
                    ) : null}
                    {activeReaderTab === 'outline' ? (
                        <DocumentOutlinePanel
                            outline={outline}
                            currentPage={currentPage}
                            onJump={onJump}
                            chapterInsights={chapterInsights}
                            chapterInsightState={chapterInsightState}
                            onSelectChapter={onSelectChapter}
                            onRegenerateChapter={onRegenerateChapter}
                        />
                    ) : null}
                    {activeReaderTab === 'annotations' ? (
                        <section className='annotation-summary'>
                            <div className='annotation-summary__counts'>
                                {ANNOTATION_KIND_FILTERS.map((filter) => (
                                    <button
                                        type='button'
                                        key={filter.id}
                                        className={annotationKindFilter === filter.id ? 'is-active' : ''}
                                        aria-pressed={annotationKindFilter === filter.id}
                                        onClick={() => selectAnnotationKind(filter.id)}
                                    >
                                        <strong>{annotationSummary[filter.countKey]}</strong>
                                        {filter.label}
                                    </button>
                                ))}
                            </div>
                            <div
                                className='annotation-summary__tags'
                                aria-label='摘录标签汇总'
                            >
                                <button
                                    type='button'
                                    className={!annotationTag ? 'is-active' : ''}
                                    onClick={() => setAnnotationTag('')}
                                >
                                    全部
                                </button>
                                {annotationSummary.tags.map((tag) => (
                                    <button
                                        type='button'
                                        className={annotationTag === tag.name ? 'is-active' : ''}
                                        key={tag.name}
                                        onClick={() => setAnnotationTag(tag.name)}
                                    >
                                        #{tag.name}
                                        <small>{tag.count}</small>
                                    </button>
                                ))}
                            </div>
                            <div className='recent-section__list'>
                                {visibleAnnotations.map((annotation) => (
                                    <AnnotationRow
                                        key={annotation.id}
                                        annotation={annotation}
                                        onJump={onJump}
                                        onOpen={onOpenAnnotation}
                                        onDelete={onDeleteAnnotation}
                                    />
                                ))}
                                {visibleAnnotations.length === 0 ? (
                                    <p className='sidebar-empty'>
                                        划词或选中句子后，右键可摘词、摘抄、记笔记或添加标签。
                                    </p>
                                ) : null}
                            </div>
                        </section>
                    ) : null}
                    {activeReaderTab === 'relations' ? (
                        <section className='paper-relations'>
                            <p className='paper-relations__hint'>
                                只显示 DOI 或完整题名确认的库内引用，低置信结果不会猜测。
                            </p>
                            <strong>本文引用</strong>
                            {(relations.outbound ?? []).map((relation) => (
                                <button
                                    type='button'
                                    key={`out-${relation.referenceId}`}
                                    onClick={() => onOpenPaper?.(relation.targetPaperId)}
                                >
                                    <span>{relation.targetTitle || relation.citedTitle || relation.rawText}</span>
                                    <small>
                                        {relation.matchKind === 'doi' ? 'DOI 匹配' : '完整题名'} · 第{' '}
                                        {relation.pageNumber} 页
                                    </small>
                                </button>
                            ))}
                            {(relations.outbound ?? []).length === 0 ? (
                                <p className='sidebar-empty'>尚未发现可确认的库内被引论文。</p>
                            ) : null}
                            <strong>谁引用了本文</strong>
                            {(relations.inbound ?? []).map((relation) => (
                                <button
                                    type='button'
                                    key={`in-${relation.referenceId}`}
                                    onClick={() => onOpenPaper?.(relation.sourcePaperId)}
                                >
                                    <span>{relation.sourceTitle}</span>
                                    <small>
                                        {relation.matchKind === 'doi' ? 'DOI 匹配' : '完整题名'} · 第{' '}
                                        {relation.pageNumber} 页
                                    </small>
                                </button>
                            ))}
                            {(relations.inbound ?? []).length === 0 ? (
                                <p className='sidebar-empty'>库内尚无论文明确引用本文。</p>
                            ) : null}
                        </section>
                    ) : null}
                </div>
            </aside>
        );
    }

    return (
        <aside
            className='research-sidebar research-sidebar--library'
            aria-label='论文库筛选'
        >
            <header className='research-sidebar__header research-sidebar__header--library'>
                <div>
                    <strong>小允翻译</strong>
                    <span>本地 Ollama 学术阅读</span>
                </div>
                <button
                    className='icon-button'
                    type='button'
                    aria-label='导入论文'
                    onClick={onImport}
                    disabled={importing}
                >
                    <PiPlus />
                </button>
            </header>
            <label className='sidebar-search'>
                <PiMagnifyingGlass aria-hidden='true' />
                <input
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    placeholder='搜索标题、作者、项目或标签'
                />
            </label>
            <nav
                className='library-filter-list'
                aria-label='论文筛选'
            >
                <button
                    className={view === 'all' ? 'is-active' : ''}
                    type='button'
                    onClick={() => onViewChange('all')}
                >
                    <PiBooks aria-hidden='true' />
                    <span>全部论文</span>
                    <small>{paperCounts.all}</small>
                </button>
                <button
                    className={view === 'tagged' ? 'is-active' : ''}
                    type='button'
                    onClick={() => onViewChange('tagged')}
                >
                    <PiTag aria-hidden='true' />
                    <span>已加标签</span>
                    <small>{paperCounts.tagged}</small>
                </button>
                <button
                    className={view === 'archive' ? 'is-active' : ''}
                    type='button'
                    onClick={() => onViewChange('archive')}
                >
                    <PiArchive aria-hidden='true' />
                    <span>已归档</span>
                    <small>{paperCounts.archive}</small>
                </button>
                <button
                    className={view === 'trash' ? 'is-active' : ''}
                    type='button'
                    onClick={() => onViewChange('trash')}
                >
                    <PiTrash aria-hidden='true' />
                    <span>回收站</span>
                    <small>{paperCounts.trash}</small>
                </button>
            </nav>
            <ProjectSection
                projects={projects}
                activeProjectId={activeProjectId}
                unclassifiedCount={paperCounts?.unclassified}
                onProjectChange={onProjectChange}
                onCreateProject={onCreateProject}
                onUpdateProject={onUpdateProject}
                onDeleteProject={onDeleteProject}
            />
            <section className='tag-filter'>
                <div className='tag-filter__title'>标签</div>
                <button
                    className={!activeTagId ? 'is-active' : ''}
                    type='button'
                    onClick={() => onTagChange('')}
                >
                    <span className='tag-filter__dot tag-filter__dot--all' />
                    全部标签
                </button>
                {tags.map((tag) => (
                    <button
                        className={activeTagId === tag.id ? 'is-active' : ''}
                        type='button'
                        key={tag.id}
                        onClick={() => onTagChange(tag.id)}
                    >
                        <span
                            className='tag-filter__dot'
                            style={{ background: tag.color }}
                        />
                        {tag.name}
                    </button>
                ))}
            </section>
        </aside>
    );
}
