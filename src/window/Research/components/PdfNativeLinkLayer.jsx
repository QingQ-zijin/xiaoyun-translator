import { useEffect, useRef } from 'react';

import { loadPdfAnnotationLayerBuilder } from '../pdfRuntime';
import './PdfNativeLinkLayer.css';

function pixelDimension(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? `${Math.floor(numeric)}px` : undefined;
}

export default function PdfNativeLinkLayer({
    pdfPage,
    viewport,
    linkService,
    annotationStorage = null,
    downloadManager,
    optionalContentConfigPromise = null,
    className = '',
    onReady,
    onRenderError,
}) {
    const hostRef = useRef(null);
    const onReadyRef = useRef(onReady);
    const onRenderErrorRef = useRef(onRenderError);
    onReadyRef.current = onReady;
    onRenderErrorRef.current = onRenderError;

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !pdfPage || !viewport || !linkService) {
            host?.replaceChildren();
            return undefined;
        }

        let cancelled = false;
        let builder = null;
        const render = async () => {
            const AnnotationLayerBuilder = await loadPdfAnnotationLayerBuilder();
            if (cancelled) return;
            builder = new AnnotationLayerBuilder({
                pdfPage,
                linkService,
                downloadManager,
                annotationStorage,
                renderForms: false,
                enableScripting: false,
                onAppend: (layer) => {
                    if (!cancelled) host.replaceChildren(layer);
                },
            });
            await builder.render({
                viewport,
                optionalContentConfigPromise,
            });
            if (cancelled) {
                builder.cancel();
                return;
            }

            // PDF.js 6 会写入 CSS round() 表达式；WebView2 下改回确定像素，避免链接命中区漂移。
            const layer = builder.div;
            const width = pixelDimension(viewport.width);
            const height = pixelDimension(viewport.height);
            if (layer && width) layer.style.width = width;
            if (layer && height) layer.style.height = height;
            onReadyRef.current?.(layer);
        };

        void render().catch((error) => {
            if (!cancelled) onRenderErrorRef.current?.(error);
        });
        return () => {
            cancelled = true;
            builder?.cancel();
            host.replaceChildren();
        };
    }, [annotationStorage, downloadManager, linkService, optionalContentConfigPromise, pdfPage, viewport]);

    const width = pixelDimension(viewport?.width);
    const height = pixelDimension(viewport?.height);
    return (
        <div
            ref={hostRef}
            className={`pdf-native-link-layer ${className}`.trim()}
            data-pdf-native-link-layer='true'
            style={{
                '--total-scale-factor': String(viewport?.scale ?? 1),
                '--scale-round-x': '1px',
                '--scale-round-y': '1px',
                width,
                height,
            }}
        />
    );
}
