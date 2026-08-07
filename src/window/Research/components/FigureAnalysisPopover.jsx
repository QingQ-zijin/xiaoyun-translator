import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PiChartLineUp, PiCircleNotch, PiX } from 'react-icons/pi';

import FormattedTranslation from '../../Translate/components/FormattedTranslation';
import { computeFloatingPosition } from '../floatingPosition';
import './selectionOverlays.css';

const FALLBACK_SIZE = { width: 450, height: 520 };

export default function FigureAnalysisPopover({
    open,
    point,
    boundaryRect,
    pageNumber,
    loading,
    value,
    model,
    error,
    onClose,
}) {
    const rootRef = useRef(null);
    const [position, setPosition] = useState(null);

    useEffect(() => {
        if (!open) return undefined;
        const handlePointerDown = (event) => {
            if (!rootRef.current?.contains(event.target)) onClose?.();
        };
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') onClose?.();
        };
        globalThis.addEventListener?.('pointerdown', handlePointerDown);
        globalThis.addEventListener?.('keydown', handleKeyDown);
        return () => {
            globalThis.removeEventListener?.('pointerdown', handlePointerDown);
            globalThis.removeEventListener?.('keydown', handleKeyDown);
        };
    }, [onClose, open]);

    useLayoutEffect(() => {
        if (!open || !point) return undefined;
        const updatePosition = () => {
            const measured = rootRef.current?.getBoundingClientRect?.();
            const x = Number(point.x ?? point.clientX) || 0;
            const y = Number(point.y ?? point.clientY) || 0;
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
                    gap: 8,
                    align: 'start',
                })
            );
        };
        updatePosition();
        globalThis.addEventListener?.('resize', updatePosition);
        return () => globalThis.removeEventListener?.('resize', updatePosition);
    }, [boundaryRect, open, point, loading, value]);

    if (!open || !point) return null;
    const style = position
        ? {
              left: `${position.left}px`,
              top: `${position.top}px`,
              maxWidth: `${position.maxWidth}px`,
              maxHeight: `${position.maxHeight}px`,
          }
        : { visibility: 'hidden' };

    return (
        <aside
            ref={rootRef}
            className='figure-analysis-popover'
            style={style}
            aria-label={`第 ${pageNumber} 页图像解读`}
            aria-live='polite'
        >
            <header>
                <span className='figure-analysis-popover__icon'>
                    <PiChartLineUp aria-hidden='true' />
                </span>
                <div>
                    <strong>图像解读</strong>
                    <small>第 {pageNumber} 页 · 结合正文上下文</small>
                </div>
                <button
                    type='button'
                    aria-label='关闭图像解读'
                    onClick={onClose}
                >
                    <PiX aria-hidden='true' />
                </button>
            </header>
            <div className='figure-analysis-popover__body'>
                {loading ? (
                    <div className='figure-analysis-popover__loading'>
                        <PiCircleNotch aria-hidden='true' />
                        <strong>Gemma 正在观察图像细节</strong>
                        <span>正在结合图注、变量、公式与所在段落。</span>
                    </div>
                ) : null}
                {error ? <p className='figure-analysis-popover__error'>{error}</p> : null}
                {!loading && !error && value ? (
                    <FormattedTranslation
                        value={value}
                        fontSize={14}
                    />
                ) : null}
            </div>
            {model ? <footer>视觉模型：{model}</footer> : null}
        </aside>
    );
}
