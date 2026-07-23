import { useRef, useState } from 'react';
import {
    PiArrowClockwise,
    PiArrowSquareIn,
    PiBookOpenText,
    PiDotsThree,
    PiFileCode,
    PiFileDoc,
    PiFilePdf,
    PiFileText,
    PiFolderOpen,
    PiFolders,
    PiTag,
    PiTrash,
    PiUploadSimple,
} from 'react-icons/pi';

import { UNCLASSIFIED_PROJECT_ID } from '../../../domains/research/model';

const IMPORT_ACCEPT =
    'application/pdf,.pdf,text/markdown,.md,.markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/x-tex,.tex';

function documentAppearance(paper) {
    const format = String(paper?.sourceFormat || paper?.documentType || 'pdf').toLocaleLowerCase();
    const formatAppearance =
        format === 'markdown' || format === 'md'
            ? { Icon: PiFileText, label: 'Markdown' }
            : format === 'docx'
              ? { Icon: PiFileDoc, label: 'DOCX' }
              : format === 'tex'
                ? { Icon: PiFileCode, label: 'TeX' }
                : { Icon: PiFilePdf, label: format === 'pdf' ? 'PDF' : format.toLocaleUpperCase() };
    if (paper?.contentKind === 'book') {
        return { Icon: PiBookOpenText, label: `书籍 · ${formatAppearance.label}`, kindLabel: '书籍' };
    }
    return { ...formatAppearance, kindLabel: '论文' };
}

function PaperTagMenu({ paper, tags, onChange, onClose }) {
    const selectedIds = new Set((paper.tags ?? []).map((tag) => tag.id));
    const toggle = async (tagId) => {
        const nextIds = selectedIds.has(tagId)
            ? [...selectedIds].filter((id) => id !== tagId)
            : [...selectedIds, tagId];
        await onChange(paper.id, nextIds);
        onClose();
    };

    return (
        <div
            className='paper-tag-menu'
            role='menu'
            aria-label='设置论文标签'
        >
            <strong>论文标签</strong>
            {tags.map((tag) => (
                <button
                    type='button'
                    role='menuitemcheckbox'
                    aria-checked={selectedIds.has(tag.id)}
                    key={tag.id}
                    onClick={() => toggle(tag.id)}
                >
                    <span
                        className='tag-dot'
                        style={{ background: tag.color }}
                    />
                    {tag.name}
                    <span className={`tag-check ${selectedIds.has(tag.id) ? 'is-checked' : ''}`} />
                </button>
            ))}
        </div>
    );
}

function PaperProjectMenu({ paper, projects, onChange, onClose }) {
    const [selectedIds, setSelectedIds] = useState(() => new Set((paper.projects ?? []).map((project) => project.id)));
    const selectedIdsRef = useRef(selectedIds);
    const persistenceQueueRef = useRef(Promise.resolve());

    const toggle = (projectId) => {
        const nextSelectedIds = new Set(selectedIdsRef.current);
        if (nextSelectedIds.has(projectId)) nextSelectedIds.delete(projectId);
        else nextSelectedIds.add(projectId);
        selectedIdsRef.current = nextSelectedIds;
        setSelectedIds(nextSelectedIds);

        const nextIds = [...nextSelectedIds];
        const persistence = persistenceQueueRef.current.then(() => onChange(paper.id, nextIds));
        // 整表替换必须串行：下一次勾选只能在上一次提交落库后继续，避免旧响应覆盖新选择。
        persistenceQueueRef.current = persistence.catch(() => undefined);
    };

    return (
        <div
            className='paper-tag-menu paper-project-menu'
            role='menu'
            aria-label={`管理《${paper.title}》的项目`}
        >
            <div className='paper-tag-menu__heading'>
                <strong>分配到项目</strong>
                <button
                    type='button'
                    aria-label='关闭项目菜单'
                    onClick={onClose}
                >
                    完成
                </button>
            </div>
            {projects.length ? (
                projects.map((project) => (
                    <button
                        type='button'
                        role='menuitemcheckbox'
                        aria-checked={selectedIds.has(project.id)}
                        key={project.id}
                        onClick={() => toggle(project.id)}
                    >
                        <span
                            className='tag-dot'
                            style={{ background: project.color }}
                        />
                        {project.name}
                        <span className={`tag-check ${selectedIds.has(project.id) ? 'is-checked' : ''}`} />
                    </button>
                ))
            ) : (
                <p className='paper-project-menu__empty'>先在左侧创建项目，再把论文归类到这里。</p>
            )}
        </div>
    );
}

export default function PaperLibrary({
    papers,
    tags,
    projects = [],
    activeProjectId = '',
    view,
    loading,
    importing = false,
    error,
    isDragging,
    onImport,
    onChoose,
    onOpen,
    onMoveToTrash,
    onRestore,
    onDeletePermanently,
    onTagChange,
    onProjectChange,
}) {
    const [tagMenuPaperId, setTagMenuPaperId] = useState('');
    const [projectMenuPaperId, setProjectMenuPaperId] = useState('');
    const activeProject = projects.find((project) => project.id === activeProjectId);

    const handleFileChange = (event) => {
        const paths = [...event.target.files].map((file) => file.name);
        void onImport(paths);
        event.target.value = '';
    };

    const permanentlyDelete = async (paper) => {
        const confirmed = window.confirm(`永久删除《${paper.title}》及其批注？此操作无法撤销。`);
        if (confirmed) await onDeletePermanently(paper.id);
    };

    return (
        <main className={`paper-library ${isDragging ? 'is-dragging' : ''}`}>
            <input
                id='research-browser-file-input'
                className='visually-hidden'
                type='file'
                accept={IMPORT_ACCEPT}
                multiple
                onChange={handleFileChange}
            />
            <header className='paper-library__header'>
                <div>
                    <h1>
                        {view === 'trash'
                            ? '回收站'
                            : activeProjectId === UNCLASSIFIED_PROJECT_ID
                              ? '未分类'
                              : activeProject?.name || '文献库'}
                    </h1>
                    <p>
                        {view === 'trash'
                            ? '论文会保留在这里，直到你永久删除。'
                            : '本地保存、阅读并用 Ollama 理解你的论文与书籍。'}
                    </p>
                </div>
                {view !== 'trash' ? (
                    <button
                        className='primary-button'
                        type='button'
                        onClick={onChoose}
                        disabled={importing}
                    >
                        <PiUploadSimple aria-hidden='true' />
                        {importing ? '正在导入…' : '导入文献'}
                    </button>
                ) : null}
            </header>

            {error ? (
                <div
                    className='research-error'
                    role='alert'
                >
                    {error}
                </div>
            ) : null}

            {loading ? (
                <div className='library-loading'>
                    <span />
                    正在读取本地论文库…
                </div>
            ) : papers.length === 0 ? (
                <button
                    className='library-empty'
                    type='button'
                    disabled={importing}
                    onClick={() => view !== 'trash' && onChoose?.()}
                >
                    {view === 'trash' ? <PiTrash aria-hidden='true' /> : <PiFolderOpen aria-hidden='true' />}
                    <strong>{view === 'trash' ? '回收站是空的' : '把第一份文献放进来'}</strong>
                    <span>
                        {view === 'trash'
                            ? '删除的论文会先来到这里。'
                            : '支持 PDF、Markdown、DOCX 与 TeX，也可以直接拖到窗口。'}
                    </span>
                </button>
            ) : (
                <section
                    className='paper-list'
                    aria-label='文献列表'
                >
                    <div
                        className='paper-list__head'
                        aria-hidden='true'
                    >
                        <span>文献</span>
                        <span>分类</span>
                        <span>阅读进度</span>
                        <span>操作</span>
                    </div>
                    {papers.map((paper) => {
                        const { Icon: DocumentIcon, label: formatLabel, kindLabel } = documentAppearance(paper);
                        const progress = Math.round(
                            ((paper.progress?.pageNumber ?? 1) / Math.max(1, paper.pageCount ?? 1)) * 100
                        );
                        const projectPreview = (paper.projects ?? []).slice(0, 2);
                        const tagPreview = (paper.tags ?? []).slice(0, Math.max(0, 2 - projectPreview.length));
                        const hiddenClassifications =
                            (paper.projects?.length ?? 0) +
                            (paper.tags?.length ?? 0) -
                            projectPreview.length -
                            tagPreview.length;
                        return (
                            <article
                                className='paper-row'
                                key={paper.id}
                            >
                                <button
                                    className='paper-row__main'
                                    type='button'
                                    onClick={() => view !== 'trash' && onOpen(paper.id)}
                                >
                                    <span
                                        className='paper-row__icon'
                                        role='img'
                                        aria-label={kindLabel}
                                        title={kindLabel}
                                    >
                                        <DocumentIcon aria-hidden='true' />
                                    </span>
                                    <span className='paper-row__identity'>
                                        <strong>{paper.title}</strong>
                                        <small>
                                            {[formatLabel, paper.authors, paper.journal, paper.year]
                                                .filter(Boolean)
                                                .join(' · ')}
                                        </small>
                                        {paper.importWarning ? (
                                            <em className='paper-row__warning'>{paper.importWarning}</em>
                                        ) : null}
                                    </span>
                                </button>
                                <div className='paper-row__tags'>
                                    {projectPreview.map((project) => (
                                        <span
                                            className='paper-chip paper-chip--project'
                                            key={`project-${project.id}`}
                                        >
                                            <i style={{ background: project.color }} />
                                            {project.name}
                                        </span>
                                    ))}
                                    {tagPreview.map((tag) => (
                                        <span
                                            className='paper-chip'
                                            key={tag.id}
                                        >
                                            <i style={{ background: tag.color }} />
                                            {tag.name}
                                        </span>
                                    ))}
                                    {hiddenClassifications > 0 ? <small>+{hiddenClassifications}</small> : null}
                                </div>
                                <div className='paper-row__progress'>
                                    <span>
                                        <i style={{ width: `${progress}%` }} />
                                    </span>
                                    <small>
                                        第 {paper.progress?.pageNumber ?? 1} / {paper.pageCount ?? 1} 页
                                    </small>
                                </div>
                                <div className='paper-row__actions'>
                                    {view === 'trash' ? (
                                        <>
                                            <button
                                                className='icon-button'
                                                type='button'
                                                aria-label='恢复论文'
                                                onClick={() => onRestore(paper.id)}
                                            >
                                                <PiArrowClockwise />
                                            </button>
                                            <button
                                                className='icon-button is-danger'
                                                type='button'
                                                aria-label='永久删除'
                                                onClick={() => permanentlyDelete(paper)}
                                            >
                                                <PiTrash />
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <div className='paper-row__project-control'>
                                                <button
                                                    className='icon-button'
                                                    type='button'
                                                    aria-label={`分配《${paper.title}》到项目`}
                                                    aria-haspopup='menu'
                                                    aria-expanded={projectMenuPaperId === paper.id}
                                                    onClick={() => {
                                                        setTagMenuPaperId('');
                                                        setProjectMenuPaperId((current) =>
                                                            current === paper.id ? '' : paper.id
                                                        );
                                                    }}
                                                >
                                                    <PiFolders />
                                                </button>
                                                {projectMenuPaperId === paper.id ? (
                                                    <PaperProjectMenu
                                                        paper={paper}
                                                        projects={projects}
                                                        onChange={onProjectChange}
                                                        onClose={() => setProjectMenuPaperId('')}
                                                    />
                                                ) : null}
                                            </div>
                                            <div className='paper-row__tag-control'>
                                                <button
                                                    className='icon-button'
                                                    type='button'
                                                    aria-label='设置标签'
                                                    aria-expanded={tagMenuPaperId === paper.id}
                                                    onClick={() => {
                                                        setProjectMenuPaperId('');
                                                        setTagMenuPaperId((current) =>
                                                            current === paper.id ? '' : paper.id
                                                        );
                                                    }}
                                                >
                                                    <PiTag />
                                                </button>
                                                {tagMenuPaperId === paper.id ? (
                                                    <PaperTagMenu
                                                        paper={paper}
                                                        tags={tags}
                                                        onChange={onTagChange}
                                                        onClose={() => setTagMenuPaperId('')}
                                                    />
                                                ) : null}
                                            </div>
                                            <button
                                                className='icon-button'
                                                type='button'
                                                aria-label='打开论文'
                                                onClick={() => onOpen(paper.id)}
                                            >
                                                <PiArrowSquareIn />
                                            </button>
                                            <button
                                                className='icon-button is-danger'
                                                type='button'
                                                aria-label='移到回收站'
                                                onClick={() => onMoveToTrash(paper.id)}
                                            >
                                                <PiTrash />
                                            </button>
                                        </>
                                    )}
                                    <button
                                        className='icon-button paper-row__more'
                                        type='button'
                                        aria-label='更多操作'
                                    >
                                        <PiDotsThree />
                                    </button>
                                </div>
                            </article>
                        );
                    })}
                </section>
            )}

            {isDragging ? (
                <div className='paper-drop-overlay'>
                    <PiUploadSimple aria-hidden='true' />
                    <strong>松开以导入文献</strong>
                    <span>支持 PDF、Markdown、DOCX 与 TeX，文件会复制到本地文献库。</span>
                </div>
            ) : null}
        </main>
    );
}
