import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PiBookmarkSimple, PiCopy, PiHighlighter, PiLightbulb, PiNotePencil } from 'react-icons/pi';

import { writeClipboardText } from '../../../utils/clipboard';
import { computeFloatingPosition } from '../floatingPosition';
import { AnnotationColorPicker } from './annotationColors';
import './selectionOverlays.css';

const FALLBACK_SIZE = { width: 194, height: 210 };

export default function SelectionContextMenu({
    open = true,
    point,
    boundaryRect,
    sourceText = '',
    selectionKind = 'excerpt',
    onOpenNote,
    onHighlight,
    onSaveExcerpt,
    onCopy,
    onExplain,
    onClose,
}) {
    const menuRef = useRef(null);
    const [position, setPosition] = useState(null);
    const [highlightOpen, setHighlightOpen] = useState(false);

    useEffect(() => {
        if (open) setHighlightOpen(false);
    }, [open, sourceText]);

    useEffect(() => {
        if (!open) return undefined;
        const handlePointerDown = (event) => {
            if (!menuRef.current?.contains(event.target)) onClose?.();
        };
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                onClose?.();
                return;
            }
            const buttons = [...(menuRef.current?.querySelectorAll('button:not(:disabled)') ?? [])];
            if (buttons.length === 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const currentIndex = buttons.indexOf(document.activeElement);
            const nextIndex =
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buttons.length - 1
                      : event.key === 'ArrowDown'
                        ? (currentIndex + 1 + buttons.length) % buttons.length
                        : (currentIndex - 1 + buttons.length) % buttons.length;
            buttons[nextIndex]?.focus();
        };
        globalThis.addEventListener?.('pointerdown', handlePointerDown);
        globalThis.addEventListener?.('keydown', handleKeyDown);
        menuRef.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
        return () => {
            globalThis.removeEventListener?.('pointerdown', handlePointerDown);
            globalThis.removeEventListener?.('keydown', handleKeyDown);
        };
    }, [onClose, open]);

    useLayoutEffect(() => {
        if (!open || !point) return undefined;
        const updatePosition = () => {
            const measured = menuRef.current?.getBoundingClientRect?.();
            const x = Number(point.clientX ?? point.x) || 0;
            const y = Number(point.clientY ?? point.y) || 0;
            setPosition(
                computeFloatingPosition({
                    anchorRect: { left: x, right: x, top: y, bottom: y },
                    floatingSize: {
                        width: measured?.width || FALLBACK_SIZE.width,
                        height: measured?.height || FALLBACK_SIZE.height,
                    },
                    viewportWidth: globalThis.innerWidth,
                    viewportHeight: globalThis.innerHeight,
                    boundaryRect,
                    gap: 4,
                    align: 'start',
                })
            );
        };
        updatePosition();
        globalThis.addEventListener?.('resize', updatePosition);
        return () => globalThis.removeEventListener?.('resize', updatePosition);
    }, [boundaryRect, highlightOpen, open, point]);

    if (!open || !point) return null;

    const runAction = (action, value) => {
        onClose?.();
        if (!action) return;
        void Promise.resolve(action(value)).catch(() => {});
    };
    const copySelection = async () => {
        if (!sourceText) return;
        if (onCopy) await onCopy(sourceText);
        else await writeClipboardText(sourceText);
    };
    const excerptLabel = selectionKind === 'vocabulary' ? '摘抄单词' : '摘抄句子';
    const style = position
        ? {
              left: `${position.left}px`,
              top: `${position.top}px`,
              maxWidth: `${position.maxWidth}px`,
              maxHeight: `${position.maxHeight}px`,
          }
        : { visibility: 'hidden' };

    return (
        <div
            ref={menuRef}
            className='selection-context-menu'
            style={style}
            role='menu'
            aria-label='选区操作'
        >
            <button
                type='button'
                role='menuitem'
                disabled={!sourceText || !onOpenNote}
                onClick={() => runAction(onOpenNote)}
            >
                <PiNotePencil aria-hidden='true' />
                <span>添加笔记</span>
            </button>
            <button
                type='button'
                role='menuitem'
                disabled={!sourceText || !onHighlight}
                aria-expanded={highlightOpen}
                aria-controls='selection-context-highlight-colors'
                onClick={() => setHighlightOpen((current) => !current)}
            >
                <PiHighlighter aria-hidden='true' />
                <span>仅高亮</span>
            </button>
            {highlightOpen ? (
                <div id='selection-context-highlight-colors'>
                    <AnnotationColorPicker onSelect={(color) => runAction(onHighlight, { kind: 'highlight', color })} />
                </div>
            ) : null}
            <button
                type='button'
                role='menuitem'
                disabled={!sourceText || !onSaveExcerpt}
                onClick={() => runAction(onSaveExcerpt, { kind: selectionKind })}
            >
                <PiBookmarkSimple aria-hidden='true' />
                <span>{excerptLabel}</span>
            </button>
            <button
                type='button'
                role='menuitem'
                disabled={!sourceText}
                onClick={() => runAction(copySelection)}
            >
                <PiCopy aria-hidden='true' />
                <span>复制选区</span>
            </button>
            <button
                type='button'
                role='menuitem'
                disabled={!sourceText || !onExplain}
                onClick={() => runAction(onExplain)}
            >
                <PiLightbulb aria-hidden='true' />
                <span>AI 解释</span>
            </button>
        </div>
    );
}
