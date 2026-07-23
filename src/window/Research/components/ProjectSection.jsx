import { useState } from 'react';
import { PiCheck, PiDotsThreeVertical, PiFolderSimple, PiFolderSimplePlus, PiPlus, PiTrash, PiX } from 'react-icons/pi';

import { UNCLASSIFIED_PROJECT_ID } from '../../../domains/research/model';

export const PROJECT_COLORS = ['#8170df', '#4f83d8', '#3e9a78', '#d28a3d', '#c86679', '#7c8498'];

function ProjectEditor({ project, onCancel, onCreate, onUpdate, onDelete }) {
    const [name, setName] = useState(project?.name ?? '');
    const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const editing = Boolean(project?.id);

    const submit = async (event) => {
        event.preventDefault();
        const normalizedName = name.trim();
        if (!normalizedName || submitting) return;
        setSubmitting(true);
        setError('');
        try {
            if (editing) {
                await onUpdate?.({
                    projectId: project.id,
                    name: normalizedName,
                    color,
                    description: project.description ?? '',
                });
            } else {
                await onCreate?.({ name: normalizedName, color, description: '' });
            }
            onCancel?.();
        } catch (reason) {
            setError(String(reason));
        } finally {
            setSubmitting(false);
        }
    };

    const remove = async () => {
        if (!project?.id || submitting) return;
        const confirmed = window.confirm(`删除项目“${project.name}”？论文不会被删除，只会移出这个项目。`);
        if (!confirmed) return;
        setSubmitting(true);
        setError('');
        try {
            await onDelete?.(project.id);
            onCancel?.();
        } catch (reason) {
            setError(String(reason));
            setSubmitting(false);
        }
    };

    return (
        <form
            className='project-editor'
            aria-label={editing ? `编辑项目 ${project.name}` : '创建项目'}
            onSubmit={submit}
        >
            <label>
                <span className='visually-hidden'>项目名称</span>
                <input
                    autoFocus
                    value={name}
                    maxLength={80}
                    placeholder='项目名称'
                    aria-label='项目名称'
                    onChange={(event) => setName(event.target.value)}
                />
            </label>
            <fieldset className='project-color-picker'>
                <legend className='visually-hidden'>项目颜色</legend>
                {PROJECT_COLORS.map((candidate, index) => (
                    <button
                        key={candidate}
                        type='button'
                        className={color === candidate ? 'is-active' : ''}
                        aria-label={`项目颜色 ${index + 1}`}
                        aria-pressed={color === candidate}
                        style={{ '--project-color': candidate }}
                        onClick={() => setColor(candidate)}
                    />
                ))}
            </fieldset>
            <div className='project-editor__actions'>
                {editing ? (
                    <button
                        className='project-editor__delete'
                        type='button'
                        aria-label={`删除项目 ${project.name}`}
                        disabled={submitting}
                        onClick={remove}
                    >
                        <PiTrash aria-hidden='true' />
                    </button>
                ) : (
                    <span />
                )}
                <button
                    type='button'
                    aria-label='取消'
                    disabled={submitting}
                    onClick={onCancel}
                >
                    <PiX aria-hidden='true' />
                </button>
                <button
                    className='is-primary'
                    type='submit'
                    aria-label={editing ? '保存项目' : '创建项目'}
                    disabled={!name.trim() || submitting}
                >
                    <PiCheck aria-hidden='true' />
                </button>
            </div>
            {error ? (
                <p
                    className='project-editor__error'
                    role='alert'
                >
                    {error}
                </p>
            ) : null}
        </form>
    );
}

export default function ProjectSection({
    projects = [],
    activeProjectId = '',
    unclassifiedCount,
    onProjectChange,
    onCreateProject,
    onUpdateProject,
    onDeleteProject,
}) {
    const [creating, setCreating] = useState(false);
    const [editingProjectId, setEditingProjectId] = useState('');

    return (
        <section className='project-section'>
            <div className='project-section__title'>
                <span>项目</span>
                <button
                    type='button'
                    aria-label='新建项目'
                    title='新建项目'
                    onClick={() => {
                        setEditingProjectId('');
                        setCreating(true);
                    }}
                >
                    <PiPlus aria-hidden='true' />
                </button>
            </div>
            <button
                className={`project-row ${activeProjectId === UNCLASSIFIED_PROJECT_ID ? 'is-active' : ''}`}
                type='button'
                aria-label='未分类'
                onClick={() => onProjectChange?.(UNCLASSIFIED_PROJECT_ID)}
            >
                <PiFolderSimple aria-hidden='true' />
                <span>未分类</span>
                {Number.isFinite(unclassifiedCount) ? <small>{unclassifiedCount}</small> : null}
            </button>
            {projects.map((project) => (
                <div
                    className='project-row-wrap'
                    key={project.id}
                >
                    <button
                        className={`project-row ${activeProjectId === project.id ? 'is-active' : ''}`}
                        type='button'
                        aria-label={project.name}
                        onClick={() => onProjectChange?.(project.id)}
                    >
                        <span
                            className='project-row__dot'
                            style={{ background: project.color || PROJECT_COLORS[0] }}
                        />
                        <span>{project.name}</span>
                        {Number.isFinite(project.paperCount) ? <small>{project.paperCount}</small> : null}
                    </button>
                    <button
                        className='project-row__manage'
                        type='button'
                        aria-label={`管理项目 ${project.name}`}
                        aria-expanded={editingProjectId === project.id}
                        onClick={() => {
                            setCreating(false);
                            setEditingProjectId((current) => (current === project.id ? '' : project.id));
                        }}
                    >
                        <PiDotsThreeVertical aria-hidden='true' />
                    </button>
                    {editingProjectId === project.id ? (
                        <ProjectEditor
                            key={project.id}
                            project={project}
                            onCancel={() => setEditingProjectId('')}
                            onUpdate={onUpdateProject}
                            onDelete={onDeleteProject}
                        />
                    ) : null}
                </div>
            ))}
            {creating ? (
                <ProjectEditor
                    onCancel={() => setCreating(false)}
                    onCreate={onCreateProject}
                />
            ) : (
                <button
                    className='project-section__create'
                    type='button'
                    onClick={() => setCreating(true)}
                >
                    <PiFolderSimplePlus aria-hidden='true' />
                    新建项目
                </button>
            )}
        </section>
    );
}
