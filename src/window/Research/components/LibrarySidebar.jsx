import { useEffect, useMemo, useState } from 'react';
import {
    PiArrowLeft,
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
import DocumentOutlinePanel from './DocumentOutlinePanel';
import PaperInsightsPanel from './PaperInsightsPanel';
import ProjectSection from './ProjectSection';

const ANNOTATION_KIND_LABELS = {
    vocabulary: '词汇',
    excerpt: '摘抄',
    note: '笔记',
    highlight: '高亮',
};

const READER_TAB_IDS = ['insights', 'outline', 'annotations', 'relations'];

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

function AnnotationRow({ annotation, onJump, onDelete }) {
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
    const deleteLabel = kind === 'highlight' ? '取消高亮' : kind === 'note' ? '删除笔记' : '删除摘录';
    return (
        <div className='recent-annotation'>
            <button
                className='recent-annotation__open'
                type='button'
                onClick={() => onJump?.(annotation)}
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

export default function LibrarySidebar({
    mode,
    paper,
    annotations = [],
    onBack,
    onJump,
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
}) {
    const isBook = paper?.contentKind === 'book';
    const defaultReaderTab = isBook ? 'outline' : 'insights';
    const [readerTab, setReaderTab] = useState(defaultReaderTab);
    const [annotationTag, setAnnotationTag] = useState('');
    const activeReaderTab = isBook && readerTab === 'insights' ? 'outline' : readerTab;
    const annotationSummary = useMemo(() => summarizeAnnotations(annotations), [annotations]);
    const visibleAnnotations = useMemo(
        () =>
            annotationTag
                ? annotations.filter((annotation) =>
                      annotation.tags?.some((tag) => tag.toLocaleLowerCase() === annotationTag.toLocaleLowerCase())
                  )
                : annotations,
        [annotationTag, annotations]
    );

    useEffect(() => {
        setReaderTab(defaultReaderTab);
    }, [defaultReaderTab, paper?.id]);

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
                            onClick={() => setReaderTab('insights')}
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
                        onClick={() => setReaderTab('outline')}
                    >
                        <PiListBullets aria-hidden='true' />
                        <span>{isBook ? '目录' : '章节'}</span>
                    </button>
                    <button
                        type='button'
                        id='reader-sidebar-tab-annotations'
                        role='tab'
                        aria-controls='reader-sidebar-panel'
                        aria-selected={activeReaderTab === 'annotations'}
                        tabIndex={activeReaderTab === 'annotations' ? 0 : -1}
                        className={activeReaderTab === 'annotations' ? 'is-active' : ''}
                        onClick={() => setReaderTab('annotations')}
                    >
                        <PiBookmarkSimple aria-hidden='true' />
                        <span>摘录</span>
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
                        onClick={() => setReaderTab('relations')}
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
                                <span>
                                    <strong>{annotationSummary.vocabulary}</strong>词汇
                                </span>
                                <span>
                                    <strong>{annotationSummary.excerpts}</strong>摘抄
                                </span>
                                <span>
                                    <strong>{annotationSummary.notes}</strong>笔记
                                </span>
                                <span>
                                    <strong>{annotationSummary.highlights}</strong>高亮
                                </span>
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
