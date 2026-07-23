import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ImportKindDialog from './ImportKindDialog';

afterEach(cleanup);

describe('文献导入类型选择', () => {
    it('区分论文与书籍，并把明确类型交给导入流程', () => {
        const onSelect = vi.fn();
        render(
            <ImportKindDialog
                open
                pendingFileCount={2}
                onSelect={onSelect}
                onClose={() => {}}
            />
        );

        expect(screen.getByRole('dialog', { name: '这次导入什么？' })).toBeTruthy();
        expect(screen.getByText('已选择 2 个文件')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /书籍建立独立章节目录/u }));
        expect(onSelect).toHaveBeenCalledWith('book');
    });

    it('支持 Escape 和显式关闭按钮退出，不误触发导入', () => {
        const onClose = vi.fn();
        const onSelect = vi.fn();
        render(
            <ImportKindDialog
                open
                onSelect={onSelect}
                onClose={onClose}
            />
        );

        fireEvent.keyDown(globalThis, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
        expect(onSelect).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: '关闭导入类型选择' }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
