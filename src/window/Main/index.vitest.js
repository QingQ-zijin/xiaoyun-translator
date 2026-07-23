import { describe, expect, it } from 'vitest';

import { initialMainRoute, normalizeRoute } from './navigation';

describe('主窗口路由', () => {
    it('仅允许三个一级入口', () => {
        expect(normalizeRoute('translate')).toBe('translate');
        expect(normalizeRoute({ route: 'settings' })).toBe('settings');
        expect(normalizeRoute('legacy-service-market')).toBe('research');
        expect(initialMainRoute('?route=translate')).toBe('translate');
        expect(initialMainRoute('')).toBe('research');
    });
});
