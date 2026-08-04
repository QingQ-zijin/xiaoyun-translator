import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PiCheck, PiTag, PiTrash, PiX } from 'react-icons/pi';

import { normalizeAnnotationTags } from '../../../domains/research/model';
import { computeFloatingPosition } from '../floatingPosition';
import { AnnotationColorPicker } from './annotationColors';
import './selectionOverlays.css';

export default function AnnotationEditorPopover({
    open,
    selection,
    anchorRect,
    boundaryRect,
    tagSuggestions = [],
    onSave,
    onDelete,
    onClose,
}) {
    const panelRef = useRef(null);
    const onCloseRef = useRef(onClose);
    const [position, setPosition] = useState(null);
    const [note, setNote] = useState('');
    const [tagText, setTagText] = useState('');
    const [color, setColor] = useState('violet');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const suggestions = useMemo(
        () => normalizeAnnotationTags(tagSuggestions.map((tag) => (typeof tag === 'string' ? tag : tag?.name))),
        [tagSuggestions]
    );
    const isEditing = Boolean(selection?.id);
    const isTextAnnotation = selection?.kind === 'text';
    const dialogLabel = isTextAnnotation
        ? isEditing
            ? '编辑插入文字'
            : '插入文字'
        : isEditing
          ? '编辑论文笔记'
          : '添加论文笔记';

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!open) return;
        setNote(String(selection?.note ?? ''));
        setTagText(normalizeAnnotationTags(selection?.tags).join(', '));
        setColor(selection?.color ?? 'violet');
        setSaving(false);
        setError('');
    }, [open, selection?.id, selection?.updatedAt]);

    useEffect(() => {
        if (!open) return undefined;
        const closeOnEscape = (event) => event.key === 'Escape' && onCloseRef.current?.();
        globalThis.addEventListener?.('keydown', closeOnEscape);
        return () => globalThis.removeEventListener?.('keydown', closeOnEscape);
    }, [open]);

    useLayoutEffect(() => {
        if (!open) return undefined;
        const update = () => {
            const measured = panelRef.current?.getBoundingClientRect?.();
            const viewportWidth = globalThis.innerWidth;
            const viewportHeight = globalThis.innerHeight;
            const resolvedAnchor = anchorRect ?? {
                left: viewportWidth / 2,
                right: viewportWidth / 2,
                top: viewportHeight / 2,
                bottom: viewportHeight / 2,
            };
            setPosition(
                computeFloatingPosition({
                    anchorRect: resolvedAnchor,
                    floatingSize: { width: measured?.width || 390, height: measured?.height || 340 },
                    viewportWidth,
                    viewportHeight,
                    boundaryRect,
                })
            );
        };
        update();
        const observer = globalThis.ResizeObserver ? new ResizeObserver(update) : null;
        if (panelRef.current) observer?.observe(panelRef.current);
        globalThis.addEventListener?.('resize', update);
        return () => {
            observer?.disconnect();
            globalThis.removeEventListener?.('resize', update);
        };
    }, [anchorRect, boundaryRect, open]);

    if (!open || !selection) return null;

    const submit = async (event) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        try {
            const normalizedNote = note.trim();
            if (isTextAnnotation && !normalizedNote) throw new Error('请输入要插入的文字');
            await onSave?.({
                ...selection,
                kind: isTextAnnotation ? 'text' : normalizedNote ? 'note' : selection.kind || 'highlight',
                quote: isTextAnnotation ? normalizedNote : selection.quote,
                note: normalizedNote,
                color,
                tags: normalizeAnnotationTags(tagText.split(/[,，]/u)),
            });
            onClose?.();
        } catch (reason) {
            setError(String(reason?.message ?? reason));
        } finally {
            setSaving(false);
        }
    };

    const removeAnnotation = async () => {
        if (!selection?.id || !onDelete) return;
        setSaving(true);
        setError('');
        try {
            const removed = await onDelete(selection);
            if (removed !== false) onClose?.();
        } catch (reason) {
            setError(String(reason?.message ?? reason));
        } finally {
            setSaving(false);
        }
    };

    const appendTag = (tag) => {
        const next = normalizeAnnotationTags([...tagText.split(/[,，]/u), tag]);
        setTagText(next.join(', '));
    };

    return (
        <form
            ref={panelRef}
            className='annotation-editor-popover'
            style={
                position
                    ? {
                          left: `${position.left}px`,
                          top: `${position.top}px`,
                          maxWidth: `${position.maxWidth}px`,
                          maxHeight: `${position.maxHeight}px`,
                      }
                    : { visibility: 'hidden' }
            }
            onSubmit={submit}
            role='dialog'
            aria-label={dialogLabel}
        >
            <header>
                <div>
                    <strong>
                        {isTextAnnotation
                            ? isEditing
                                ? '编辑插入文字'
                                : '在此处插入文字'
                            : isEditing
                              ? '编辑笔记与高亮'
                              : '添加笔记与标签'}
                    </strong>
                    <span>第 {selection.pageNumber} 页</span>
                </div>
                <button
                    type='button'
                    aria-label='关闭笔记'
                    onClick={onClose}
                >
                    <PiX aria-hidden='true' />
                </button>
            </header>
            {selection.quote && !isTextAnnotation ? <blockquote>{selection.quote}</blockquote> : null}
            <label>
                <span>{isTextAnnotation ? '文字内容' : '笔记'}</span>
                <textarea
                    autoFocus
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={isTextAnnotation ? '输入要放在 PDF 页面上的文字…' : '记录你的理解、疑问或实验想法…'}
                />
            </label>
            <label>
                <span>标签（使用逗号分隔）</span>
                <div className='annotation-editor-popover__tag-input'>
                    <PiTag aria-hidden='true' />
                    <input
                        value={tagText}
                        onChange={(event) => setTagText(event.target.value)}
                        placeholder='机制, 方法学'
                    />
                </div>
            </label>
            {suggestions.length > 0 ? (
                <div
                    className='annotation-editor-popover__suggestions'
                    aria-label='已有标签'
                >
                    {suggestions.slice(0, 8).map((tag) => (
                        <button
                            type='button'
                            key={tag}
                            onClick={() => appendTag(tag)}
                        >
                            {tag}
                        </button>
                    ))}
                </div>
            ) : null}
            <div className='annotation-editor-popover__footer'>
                {isEditing && onDelete ? (
                    <button
                        className='annotation-editor-popover__delete'
                        type='button'
                        disabled={saving}
                        onClick={removeAnnotation}
                    >
                        <PiTrash aria-hidden='true' />
                        {selection.kind === 'highlight' ? '取消高亮' : '删除'}
                    </button>
                ) : null}
                <fieldset aria-label='高亮颜色'>
                    <AnnotationColorPicker
                        value={color}
                        onSelect={setColor}
                        ariaLabel='选择笔记颜色'
                        purpose='笔记'
                    />
                </fieldset>
                {error ? <span className='annotation-editor-popover__error'>{error}</span> : null}
                <button
                    className='annotation-editor-popover__save'
                    type='submit'
                    disabled={saving}
                >
                    <PiCheck aria-hidden='true' />
                    {saving ? '保存中' : '保存'}
                </button>
            </div>
        </form>
    );
}
