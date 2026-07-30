const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const SUPPORTED_NAMED_ACTIONS = new Set(['FirstPage', 'GoBack', 'GoForward', 'LastPage', 'NextPage', 'PrevPage']);

const clampRatio = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

function destinationPageReference(explicitDestination) {
    return Array.isArray(explicitDestination) ? explicitDestination[0] : null;
}

function destinationName(explicitDestination) {
    return String(explicitDestination?.[1]?.name ?? '');
}

function finiteCoordinate(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function viewportPoint(viewport, x, y) {
    if (typeof viewport?.convertToViewportPoint !== 'function') return [0, 0];
    const point = viewport.convertToViewportPoint(x, y);
    return Array.isArray(point) && point.length >= 2 ? point : [0, 0];
}

export function normalizePdfExternalUrl(value) {
    const candidate = String(value ?? '').trim();
    if (!candidate || /[\u0000-\u001f\u007f]/u.test(candidate)) return '';
    try {
        const parsed = new URL(candidate);
        const protocol = parsed.protocol.toLocaleLowerCase();
        if (!ALLOWED_EXTERNAL_PROTOCOLS.has(protocol)) return '';
        if ((protocol === 'http:' || protocol === 'https:') && !parsed.hostname) return '';
        if (protocol === 'mailto:' && !parsed.pathname) return '';
        return parsed.href;
    } catch {
        return '';
    }
}

export async function resolvePdfDestination(pdfDocument, destination) {
    if (!pdfDocument) return null;
    let explicitDestination = destination;
    if (typeof explicitDestination === 'string') {
        explicitDestination = await pdfDocument.getDestination?.(explicitDestination);
    } else {
        explicitDestination = await explicitDestination;
    }
    if (!Array.isArray(explicitDestination) || explicitDestination.length < 2) return null;

    const reference = destinationPageReference(explicitDestination);
    let pageNumber = null;
    if (Number.isInteger(reference)) {
        pageNumber = reference + 1;
    } else if (reference && typeof reference === 'object') {
        const cachedPageNumber = pdfDocument.cachedPageNumber?.(reference);
        if (Number.isInteger(cachedPageNumber) && cachedPageNumber > 0) {
            pageNumber = cachedPageNumber;
        } else if (typeof pdfDocument.getPageIndex === 'function') {
            const pageIndex = await pdfDocument.getPageIndex(reference);
            if (Number.isInteger(pageIndex) && pageIndex >= 0) pageNumber = pageIndex + 1;
        }
    }

    const pageCount = Math.max(0, Number(pdfDocument.numPages) || 0);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || (pageCount > 0 && pageNumber > pageCount)) return null;
    return { pageNumber, explicitDestination };
}

export function getPdfDestinationPosition(pdfPage, explicitDestination) {
    const viewport = pdfPage?.getViewport?.({ scale: 1 });
    const width = Math.max(1, Number(viewport?.width) || 1);
    const height = Math.max(1, Number(viewport?.height) || 1);
    const pageWidth = Math.max(1, Number(viewport?.rawDims?.pageWidth) || width);
    const pageHeight = Math.max(1, Number(viewport?.rawDims?.pageHeight) || height);
    const type = destinationName(explicitDestination);

    let points;
    switch (type) {
        case 'XYZ': {
            const x = finiteCoordinate(explicitDestination[2], 0);
            const y = finiteCoordinate(explicitDestination[3], pageHeight);
            points = [viewportPoint(viewport, x, y)];
            break;
        }
        case 'FitH':
        case 'FitBH': {
            const y = finiteCoordinate(explicitDestination[2], pageHeight);
            points = [viewportPoint(viewport, 0, y)];
            break;
        }
        case 'FitV':
        case 'FitBV': {
            const x = finiteCoordinate(explicitDestination[2], 0);
            points = [viewportPoint(viewport, x, pageHeight)];
            break;
        }
        case 'FitR': {
            const left = finiteCoordinate(explicitDestination[2], 0);
            const bottom = finiteCoordinate(explicitDestination[3], 0);
            const right = finiteCoordinate(explicitDestination[4], pageWidth);
            const top = finiteCoordinate(explicitDestination[5], pageHeight);
            points = [viewportPoint(viewport, left, bottom), viewportPoint(viewport, right, top)];
            break;
        }
        default:
            points = [[0, 0]];
            break;
    }

    const left = Math.min(...points.map((point) => finiteCoordinate(point[0], 0)));
    const top = Math.min(...points.map((point) => finiteCoordinate(point[1], 0)));
    return {
        destinationType: type || 'Fit',
        leftRatio: clampRatio(left / width),
        topRatio: clampRatio(top / height),
    };
}

export function createPdfLinkService({
    pdfDocument,
    onDestination,
    onExternalUrl,
    onNamedAction,
    onOptionalContent,
    onError,
} = {}) {
    let destinationRequestId = 0;
    const reportError = (error) => {
        if (typeof onError === 'function') onError(error);
    };

    const service = {
        eventBus: null,
        externalLinkEnabled: true,
        isInPresentationMode: false,
        addLinkAttributes(link, url, newWindow = false) {
            const safeUrl = normalizePdfExternalUrl(url);
            if (!safeUrl) {
                link.removeAttribute('href');
                link.setAttribute('aria-disabled', 'true');
                link.title = '链接已被安全策略阻止';
                link.onclick = () => false;
                return;
            }
            link.href = safeUrl;
            link.title = safeUrl;
            link.target = newWindow || onExternalUrl ? '_blank' : '';
            link.rel = 'noopener noreferrer nofollow';
            if (typeof onExternalUrl === 'function') {
                link.onclick = (event) => {
                    event?.preventDefault?.();
                    event?.stopPropagation?.();
                    Promise.resolve(onExternalUrl(safeUrl)).catch(reportError);
                    return false;
                };
            }
        },
        getDestinationHash(destination) {
            const serialized = typeof destination === 'string' ? destination : JSON.stringify(destination ?? '');
            return `#pdf-destination=${encodeURIComponent(serialized)}`;
        },
        getAnchorUrl(anchor = '') {
            return String(anchor || '#');
        },
        async goToDestination(destination) {
            const requestId = ++destinationRequestId;
            try {
                const resolved = await resolvePdfDestination(pdfDocument, destination);
                if (!resolved || requestId !== destinationRequestId) return null;
                const pdfPage = await pdfDocument.getPage?.(resolved.pageNumber);
                if (requestId !== destinationRequestId) return null;
                const result = {
                    ...resolved,
                    ...getPdfDestinationPosition(pdfPage, resolved.explicitDestination),
                };
                await onDestination?.(result);
                return requestId === destinationRequestId ? result : null;
            } catch (error) {
                if (requestId === destinationRequestId) reportError(error);
                return null;
            }
        },
        executeNamedAction(action) {
            destinationRequestId += 1;
            const normalizedAction = String(action ?? '');
            if (!SUPPORTED_NAMED_ACTIONS.has(normalizedAction)) return false;
            try {
                onNamedAction?.(normalizedAction);
                return true;
            } catch (error) {
                reportError(error);
                return false;
            }
        },
        async getAttachmentContent(id) {
            try {
                return (await pdfDocument?.getAttachmentContent?.(id)) ?? null;
            } catch (error) {
                reportError(error);
                return null;
            }
        },
        async executeSetOCGState(action) {
            try {
                return (await onOptionalContent?.(action)) ?? null;
            } catch (error) {
                reportError(error);
                return null;
            }
        },
        cancelPendingDestination() {
            destinationRequestId += 1;
        },
    };
    return service;
}
