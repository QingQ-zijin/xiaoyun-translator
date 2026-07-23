import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    PiArrowClockwise,
    PiBookmarkSimple,
    PiCopy,
    PiHighlighter,
    PiLightbulb,
    PiNotePencil,
    PiPushPin,
    PiPushPinSlash,
    PiSpeakerHigh,
    PiX,
} from 'react-icons/pi';

import { writeClipboardText } from '../../../utils/clipboard';
import FormattedTranslation from '../../Translate/components/FormattedTranslation';
import { clampFloatingPosition, computeFloatingPosition } from '../floatingPosition';
import { AnnotationColorPicker } from './annotationColors';
import './selectionOverlays.css';

const LANGUAGE_OPTIONS = [
    { value: 'zh_cn', label: '简体中文' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
];

const FALLBACK_SIZE = { width: 430, height: 420 };

function LexiconEntry({ state }) {
    const entry = state?.entry;
    if (state?.loading) {
        return (
            <div
                className='selection-translation-popover__lexicon-loading'
                role='status'
            >
                <i aria-hidden='true' />
                正在解析音标、词性与语境义…
            </div>
        );
    }
    if (state?.error) {
        return <div className='selection-translation-popover__lexicon-error'>词汇解析暂不可用：{state.error}</div>;
    }
    if (!entry) return null;

    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
    const senses = Array.isArray(entry.senses) ? entry.senses : [];
    return (
        <section
            className='selection-translation-popover__lexicon'
            aria-label='词汇解析结果'
        >
            <div className='selection-translation-popover__term-row'>
                <strong>{entry.term}</strong>
                {phonetics.map((phonetic, index) => (
                    <span key={`${phonetic.region}-${phonetic.ipa}-${index}`}>
                        {phonetic.region ? `${phonetic.region} ` : ''}
                        {phonetic.ipa}
                    </span>
                ))}
            </div>
            {entry.contextMeaning ? (
                <div className='selection-translation-popover__context-meaning'>
                    <span>本文语境</span>
                    <p>{entry.contextMeaning}</p>
                </div>
            ) : null}
            {senses.length > 0 ? (
                <div className='selection-translation-popover__senses'>
                    {senses.map((sense, index) => (
                        <div
                            className='selection-translation-popover__sense'
                            key={`${sense.partOfSpeech}-${index}`}
                        >
                            <span>{sense.partOfSpeech || '释义'}</span>
                            <ol>
                                {(sense.definitions ?? []).map((definition, definitionIndex) => (
                                    <li key={`${definition}-${definitionIndex}`}>{definition}</li>
                                ))}
                            </ol>
                        </div>
                    ))}
                </div>
            ) : null}
            {entry.domainNote ? (
                <p className='selection-translation-popover__domain-note'>
                    <strong>领域注释</strong>
                    {entry.domainNote}
                </p>
            ) : null}
        </section>
    );
}

export default function SelectionTranslationPopover({
    open = true,
    anchorRect,
    selectionRect,
    boundaryRect,
    value = '',
    sourceText = '',
    selectionKind = 'excerpt',
    lexiconState,
    loading = false,
    error = '',
    targetLanguage = 'zh_cn',
    languageOptions = LANGUAGE_OPTIONS,
    onTargetLanguageChange,
    onCopy,
    onSpeak,
    onHighlight,
    onSaveExcerpt,
    onOpenNote,
    onExplain,
    onRetry,
    aiState,
    onJump,
    onClose,
}) {
    const panelRef = useRef(null);
    const positionRef = useRef(null);
    const dragRef = useRef(null);
    const [position, setPosition] = useState(null);
    const [pinned, setPinned] = useState(false);
    const [userPositioned, setUserPositioned] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [copyState, setCopyState] = useState('');
    const [highlightOpen, setHighlightOpen] = useState(false);

    useEffect(() => {
        positionRef.current = position;
    }, [position]);

    useEffect(() => {
        if (!open) return undefined;
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') onClose?.();
        };
        const handleOutsidePointerDown = (event) => {
            if (panelRef.current?.contains(event.target)) return;
            onClose?.();
        };
        globalThis.addEventListener?.('keydown', handleKeyDown);
        globalThis.document?.addEventListener?.('pointerdown', handleOutsidePointerDown, true);
        return () => {
            globalThis.removeEventListener?.('keydown', handleKeyDown);
            globalThis.document?.removeEventListener?.('pointerdown', handleOutsidePointerDown, true);
        };
    }, [onClose, open]);

    useEffect(() => {
        setCopyState('');
    }, [value]);

    useEffect(() => {
        if (open) setHighlightOpen(false);
    }, [open, sourceText]);

    useEffect(() => {
        if (!open) {
            dragRef.current = null;
            setPinned(false);
            setUserPositioned(false);
            setDragging(false);
            return;
        }
        if (!pinned) setUserPositioned(false);
    }, [open, pinned, sourceText]);

    useLayoutEffect(() => {
        if (!open || !anchorRect) return undefined;
        const updatePosition = () => {
            const measured = panelRef.current?.getBoundingClientRect?.();
            const floatingSize = {
                width: measured?.width || FALLBACK_SIZE.width,
                height: measured?.height || FALLBACK_SIZE.height,
            };
            const current = positionRef.current;
            const next =
                (pinned || userPositioned) && current
                    ? {
                          ...clampFloatingPosition({
                              left: current.left,
                              top: current.top,
                              floatingSize,
                              viewportWidth: globalThis.innerWidth,
                              viewportHeight: globalThis.innerHeight,
                              boundaryRect,
                          }),
                          placement: 'manual',
                      }
                    : computeFloatingPosition({
                          anchorRect,
                          avoidRect: selectionRect,
                          floatingSize,
                          viewportWidth: globalThis.innerWidth,
                          viewportHeight: globalThis.innerHeight,
                          boundaryRect,
                      });
            setPosition((previous) => {
                if (
                    previous &&
                    previous.left === next.left &&
                    previous.top === next.top &&
                    previous.maxWidth === next.maxWidth &&
                    previous.maxHeight === next.maxHeight &&
                    previous.placement === next.placement
                ) {
                    return previous;
                }
                positionRef.current = next;
                return next;
            });
        };
        updatePosition();
        globalThis.addEventListener?.('resize', updatePosition);
        const observer = globalThis.ResizeObserver ? new ResizeObserver(updatePosition) : null;
        if (panelRef.current) observer?.observe(panelRef.current);
        return () => {
            globalThis.removeEventListener?.('resize', updatePosition);
            observer?.disconnect();
        };
    }, [anchorRect, boundaryRect, open, pinned, selectionRect, userPositioned]);

    useEffect(() => {
        if (!dragging) return undefined;
        const handlePointerMove = (event) => {
            const drag = dragRef.current;
            if (!drag || event.pointerId !== drag.pointerId) return;
            event.preventDefault?.();
            const next = clampFloatingPosition({
                left: event.clientX - drag.offsetX,
                top: event.clientY - drag.offsetY,
                floatingSize: { width: drag.width, height: drag.height },
                viewportWidth: globalThis.innerWidth,
                viewportHeight: globalThis.innerHeight,
                boundaryRect,
            });
            const manualPosition = { ...next, placement: 'manual' };
            positionRef.current = manualPosition;
            setPosition(manualPosition);
        };
        const finishDrag = (event) => {
            const drag = dragRef.current;
            if (!drag || event.pointerId !== drag.pointerId) return;
            try {
                drag.captureTarget?.releasePointerCapture?.(drag.pointerId);
            } catch {
                // 指针已经释放时无需额外处理。
            }
            dragRef.current = null;
            setDragging(false);
        };
        globalThis.addEventListener?.('pointermove', handlePointerMove);
        globalThis.addEventListener?.('pointerup', finishDrag);
        globalThis.addEventListener?.('pointercancel', finishDrag);
        return () => {
            globalThis.removeEventListener?.('pointermove', handlePointerMove);
            globalThis.removeEventListener?.('pointerup', finishDrag);
            globalThis.removeEventListener?.('pointercancel', finishDrag);
        };
    }, [boundaryRect, dragging]);

    const handleHeaderPointerDown = (event) => {
        if (event.button !== 0 || event.target.closest?.('button, select, option, input')) return;
        const measured = panelRef.current?.getBoundingClientRect?.();
        const current = positionRef.current;
        if (!measured || !current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - current.left,
            offsetY: event.clientY - current.top,
            width: measured.width || FALLBACK_SIZE.width,
            height: measured.height || FALLBACK_SIZE.height,
            captureTarget: event.currentTarget,
        };
        setUserPositioned(true);
        setDragging(true);
    };

    const handlePinnedChange = () => {
        if (!pinned && positionRef.current) setUserPositioned(true);
        if (pinned) setUserPositioned(false);
        setPinned((current) => !current);
    };

    if (!open || !anchorRect) return null;

    const copyText = String(value || sourceText).trim();
    const speechText = String(selectionKind === 'vocabulary' ? sourceText : copyText).trim();
    const handleCopy = async () => {
        if (!copyText) return;
        try {
            if (onCopy) await onCopy(copyText);
            else await writeClipboardText(copyText);
            setCopyState('已复制');
        } catch {
            setCopyState('复制失败');
        }
    };

    const style = position
        ? {
              left: `${position.left}px`,
              top: `${position.top}px`,
              maxWidth: `${position.maxWidth}px`,
              maxHeight: `${position.maxHeight}px`,
          }
        : { visibility: 'hidden' };

    return (
        <section
            ref={panelRef}
            className={`selection-translation-popover ${dragging ? 'is-dragging' : ''}`}
            style={style}
            data-placement={position?.placement ?? 'bottom'}
            role='dialog'
            aria-label='划词翻译'
            aria-busy={loading}
        >
            <header
                className='selection-translation-popover__header'
                onPointerDown={handleHeaderPointerDown}
            >
                <strong>{selectionKind === 'vocabulary' ? '词汇解析' : '划词翻译'}</strong>
                <select
                    className='selection-translation-popover__language'
                    aria-label='目标语言'
                    value={targetLanguage}
                    onChange={(event) => onTargetLanguageChange?.(event.target.value)}
                >
                    {languageOptions.map((language) => (
                        <option
                            key={language.value}
                            value={language.value}
                        >
                            {language.label}
                        </option>
                    ))}
                </select>
                <button
                    className={`selection-translation-popover__pin ${pinned ? 'is-active' : ''}`}
                    type='button'
                    aria-label={pinned ? '取消固定翻译窗' : '固定翻译窗'}
                    aria-pressed={pinned}
                    title={pinned ? '取消固定；新选区将重新定位' : '固定位置；继续划词时不移动'}
                    onClick={handlePinnedChange}
                >
                    {pinned ? <PiPushPinSlash aria-hidden='true' /> : <PiPushPin aria-hidden='true' />}
                </button>
                <button
                    className='selection-translation-popover__close'
                    type='button'
                    aria-label='关闭翻译'
                    onClick={onClose}
                >
                    <PiX aria-hidden='true' />
                </button>
            </header>
            <div className='selection-translation-popover__body'>
                {selectionKind === 'vocabulary' ? <LexiconEntry state={lexiconState} /> : null}
                {error ? (
                    <div className='selection-translation-popover__error'>
                        <span role='alert'>{error}</span>
                        {onRetry ? (
                            <button
                                type='button'
                                onClick={onRetry}
                            >
                                <PiArrowClockwise aria-hidden='true' />
                                重试
                            </button>
                        ) : null}
                    </div>
                ) : null}
                {!error && value ? (
                    <div className={selectionKind === 'vocabulary' ? 'selection-translation-popover__translation' : ''}>
                        {selectionKind === 'vocabulary' ? <strong>选区翻译</strong> : null}
                        <FormattedTranslation
                            value={value}
                            fontSize={15}
                        />
                        {loading ? (
                            <i
                                className='selection-translation-popover__streaming-dot'
                                aria-hidden='true'
                            />
                        ) : null}
                    </div>
                ) : null}
                {!error && loading && !value ? (
                    <div
                        className='selection-translation-popover__loading'
                        role='status'
                    >
                        <i aria-hidden='true' />
                        正在翻译…
                    </div>
                ) : null}
                {!error && !loading && !value ? (
                    <p className='selection-translation-popover__empty'>暂无译文。</p>
                ) : null}
                {aiState?.loading ? (
                    <div className='selection-translation-popover__ai'>正在检索论文证据并解释…</div>
                ) : null}
                {aiState?.error ? (
                    <div className='selection-translation-popover__ai is-error'>{aiState.error}</div>
                ) : null}
                {aiState?.answer ? (
                    <section className='selection-translation-popover__ai'>
                        <strong>AI 解释</strong>
                        <FormattedTranslation
                            value={aiState.answer}
                            fontSize={13}
                        />
                        <div className='selection-translation-popover__citations'>
                            {(aiState.citations ?? []).map((citation, index) => (
                                <button
                                    type='button'
                                    key={`${citation.pageNumber}-${index}`}
                                    onClick={() => onJump?.(citation.pageNumber)}
                                >
                                    第 {citation.pageNumber} 页
                                </button>
                            ))}
                        </div>
                    </section>
                ) : null}
            </div>
            <footer className='selection-translation-popover__actions'>
                <button
                    className='selection-translation-popover__action'
                    type='button'
                    disabled={!copyText}
                    onClick={() => void handleCopy()}
                >
                    <PiCopy aria-hidden='true' />
                    <span>复制</span>
                </button>
                <button
                    className='selection-translation-popover__action'
                    type='button'
                    disabled={!speechText || !onSpeak}
                    onClick={() =>
                        selectionKind === 'vocabulary' ? onSpeak?.(speechText, { source: true }) : onSpeak?.(speechText)
                    }
                >
                    <PiSpeakerHigh aria-hidden='true' />
                    <span>{selectionKind === 'vocabulary' ? '原词' : '朗读'}</span>
                </button>
                <button
                    className='selection-translation-popover__action'
                    type='button'
                    disabled={!sourceText || !onHighlight}
                    aria-expanded={highlightOpen}
                    aria-controls='selection-translation-highlight-colors'
                    onClick={() => setHighlightOpen((current) => !current)}
                >
                    <PiHighlighter aria-hidden='true' />
                    <span>高亮</span>
                </button>
                {highlightOpen ? (
                    <div
                        className='selection-translation-popover__highlight-colors'
                        id='selection-translation-highlight-colors'
                    >
                        <AnnotationColorPicker
                            onSelect={(color) => {
                                onHighlight?.({ kind: 'highlight', color });
                                setHighlightOpen(false);
                            }}
                        />
                    </div>
                ) : null}
                <button
                    className='selection-translation-popover__action'
                    type='button'
                    disabled={!sourceText || !onSaveExcerpt}
                    onClick={() =>
                        onSaveExcerpt?.({
                            kind: selectionKind,
                            lexicon: lexiconState?.entry ?? null,
                        })
                    }
                >
                    <PiBookmarkSimple aria-hidden='true' />
                    <span>{selectionKind === 'vocabulary' ? '摘词' : '摘抄'}</span>
                </button>
                <button
                    className='selection-translation-popover__action'
                    type='button'
                    disabled={!sourceText || !onOpenNote}
                    onClick={onOpenNote}
                >
                    <PiNotePencil aria-hidden='true' />
                    <span>笔记</span>
                </button>
                <button
                    className='selection-translation-popover__action'
                    type='button'
                    disabled={!sourceText || !onExplain}
                    onClick={onExplain}
                >
                    <PiLightbulb aria-hidden='true' />
                    <span>解释</span>
                </button>
                {copyState ? (
                    <span
                        className='selection-translation-popover__copy-state'
                        role='status'
                    >
                        {copyState}
                    </span>
                ) : null}
            </footer>
        </section>
    );
}
