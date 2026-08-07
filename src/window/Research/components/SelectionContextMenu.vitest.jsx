import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SelectionContextMenu from './SelectionContextMenu';

afterEach(cleanup);

describe('论文选区右键菜单', () => {
    it('提供笔记、高亮、摘抄、复制和 AI 解释操作', () => {
        const handlers = {
            onOpenNote: vi.fn(),
            onHighlight: vi.fn(),
            onSaveExcerpt: vi.fn(),
            onCopy: vi.fn(),
            onExplain: vi.fn(),
            onClose: vi.fn(),
        };
        render(
            <SelectionContextMenu
                point={{ clientX: 260, clientY: 200 }}
                sourceText='selected text'
                selectionKind='excerpt'
                {...handlers}
            />
        );

        fireEvent.click(screen.getByRole('menuitem', { name: '添加笔记' }));
        fireEvent.click(screen.getByRole('menuitem', { name: '高亮并保存译文' }));
        expect(screen.getByRole('group', { name: '选择高亮颜色' }).querySelectorAll('button')).toHaveLength(5);
        fireEvent.click(screen.getByRole('button', { name: '玫红色高亮' }));
        fireEvent.click(screen.getByRole('menuitem', { name: '摘抄句子' }));
        fireEvent.click(screen.getByRole('menuitem', { name: '复制选区' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'AI 解释' }));

        expect(handlers.onOpenNote).toHaveBeenCalledOnce();
        expect(handlers.onHighlight).toHaveBeenCalledOnce();
        expect(handlers.onHighlight).toHaveBeenCalledWith({ kind: 'highlight', color: 'rose' });
        expect(handlers.onSaveExcerpt).toHaveBeenCalledWith({ kind: 'excerpt' });
        expect(handlers.onCopy).toHaveBeenCalledWith('selected text');
        expect(handlers.onExplain).toHaveBeenCalledOnce();
        expect(handlers.onClose).toHaveBeenCalledTimes(5);
    });

    it('词汇选区使用摘抄单词动作并传出明确类型', () => {
        const onSaveExcerpt = vi.fn();
        render(
            <SelectionContextMenu
                point={{ x: 260, y: 200 }}
                sourceText='Michaelis–Menten'
                selectionKind='vocabulary'
                onSaveExcerpt={onSaveExcerpt}
                onClose={() => {}}
            />
        );

        fireEvent.click(screen.getByRole('menuitem', { name: '摘抄单词' }));
        expect(onSaveExcerpt).toHaveBeenCalledWith({ kind: 'vocabulary' });
    });

    it('支持方向键切换焦点并用 Esc 关闭', () => {
        const onClose = vi.fn();
        render(
            <SelectionContextMenu
                point={{ x: 260, y: 200 }}
                sourceText='selected text'
                onOpenNote={() => {}}
                onHighlight={() => {}}
                onExplain={() => {}}
                onClose={onClose}
            />
        );

        const note = screen.getByRole('menuitem', { name: '添加笔记' });
        const highlight = screen.getByRole('menuitem', { name: '高亮并保存译文' });
        expect(document.activeElement).toBe(note);
        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(highlight);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
