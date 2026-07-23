const ROUTES = new Set(['translate', 'research', 'settings']);

export function normalizeRoute(payload) {
    const value = typeof payload === 'string' ? payload : payload?.route;
    return ROUTES.has(value) ? value : 'research';
}

export function initialMainRoute(search = '') {
    const route = new URLSearchParams(search).get('route');
    return ROUTES.has(route) ? route : 'research';
}
