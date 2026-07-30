import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AnnotationEditorPopover from './AnnotationEditorPopover';

afterEach(cleanup);

describe('论文笔记浮窗', () => {
    it('保存时显式标记为笔记，并保留锚点、颜色和去重标签', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        const selection = {
            paperId: 'paper-1',
            pageNumber: 3,
            quote: 'selected sentence',
            prefix: 'before',
            suffix: 'after',
            rects: [],
        };
        render(
            <AnnotationEditorPopover
                open
                selection={selection}
                anchorRect={{ left: 300, top: 180, right: 420, bottom: 202 }}
                tagSuggestions={['方法学']}
                onSave={onSave}
                onClose={() => {}}
            />
        );

        fireEvent.change(screen.getByPlaceholderText('记录你的理解、疑问或实验想法…'), {
            target: { value: '这是一条笔记' },
        });
        fireEvent.change(screen.getByPlaceholderText('机制, 方法学'), {
            target: { value: '方法学, 方法学, 重点' },
        });
        expect(screen.getByRole('group', { name: '选择笔记颜色' }).querySelectorAll('button')).toHaveLength(5);
        fireEvent.click(screen.getByRole('button', { name: '绿色笔记' }));
        fireEvent.click(screen.getByRole('button', { name: '保存' }));

        await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
        expect(onSave).toHaveBeenCalledWith({
            ...selection,
            kind: 'note',
            note: '这是一条笔记',
            color: 'green',
            tags: ['方法学', '重点'],
        });
    });

    it('打开已有笔记时预填内容并使用同一 ID 更新，父组件重渲染不会清空草稿', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        const firstClose = vi.fn();
        const secondClose = vi.fn();
        const selection = {
            id: 'note-1',
            paperId: 'paper-1',
            pageNumber: 8,
            quote: 'existing note quote',
            prefix: 'before',
            suffix: 'after',
            rects: [{ x: 0.2, y: 0.3, width: 0.4, height: 0.04 }],
            kind: 'note',
            note: '原有笔记',
            color: 'green',
            tags: ['方法学', '重点'],
            updatedAt: '2026-07-29T10:00:00Z',
        };
        const { rerender } = render(
            <AnnotationEditorPopover
                open
                selection={selection}
                tagSuggestions={[]}
                onSave={onSave}
                onClose={firstClose}
            />
        );

        expect(screen.getByRole('dialog', { name: '编辑论文笔记' })).toBeTruthy();
        expect(screen.getByPlaceholderText('记录你的理解、疑问或实验想法…').value).toBe('原有笔记');
        expect(screen.getByPlaceholderText('机制, 方法学').value).toBe('方法学, 重点');
        expect(screen.getByRole('button', { name: '绿色笔记' }).getAttribute('aria-pressed')).toBe('true');

        fireEvent.change(screen.getByPlaceholderText('记录你的理解、疑问或实验想法…'), {
            target: { value: '尚未保存的修改' },
        });
        rerender(
            <AnnotationEditorPopover
                open
                selection={selection}
                tagSuggestions={[]}
                onSave={onSave}
                onClose={secondClose}
            />
        );
        expect(screen.getByPlaceholderText('记录你的理解、疑问或实验想法…').value).toBe('尚未保存的修改');

        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith({
                ...selection,
                kind: 'note',
                note: '尚未保存的修改',
                color: 'green',
                tags: ['方法学', '重点'],
            })
        );
        expect(secondClose).toHaveBeenCalledOnce();
        expect(firstClose).not.toHaveBeenCalled();
    });
});
