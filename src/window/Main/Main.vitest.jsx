import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(),
}));

vi.mock('../Research', async () => {
    const React = await vi.importActual('react');
    return {
        default: function MockResearch({ startInLibrary = false }) {
            const [paperOpen, setPaperOpen] = React.useState(() => !startInLibrary);
            return paperOpen ? (
                <section aria-label='论文阅读器'>正在阅读论文</section>
            ) : (
                <section aria-label='论文库首页'>
                    <button
                        type='button'
                        onClick={() => setPaperOpen(true)}
                    >
                        打开测试论文
                    </button>
                </section>
            );
        },
    };
});

vi.mock('./SettingsPanel', () => ({
    default: () => <section aria-label='设置页'>设置</section>,
}));

vi.mock('./TranslationWorkspace', () => ({
    default: () => <section aria-label='翻译页'>翻译</section>,
}));

import Main from './index';

afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
});

describe('主导航与论文阅读器', () => {
    it('阅读论文时再次点击“论文库”仍默认恢复最近阅读论文', () => {
        render(<Main />);

        expect(screen.getByRole('region', { name: '论文阅读器' })).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: '论文库' }));

        expect(screen.getByRole('region', { name: '论文阅读器' })).toBeTruthy();
        expect(screen.queryByRole('region', { name: '论文库首页' })).toBeNull();
    });
});
