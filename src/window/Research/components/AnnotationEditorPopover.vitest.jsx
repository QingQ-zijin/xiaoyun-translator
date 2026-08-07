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

    it('点击纯高亮后可以在同一浮窗直接取消，并保留撤销所需的原记录', async () => {
        const onDelete = vi.fn().mockResolvedValue(true);
        const onClose = vi.fn();
        const highlight = {
            id: 'highlight-1',
            paperId: 'paper-1',
            pageNumber: 6,
            kind: 'highlight',
            quote: 'highlighted sentence',
            note: '',
            rects: [{ x: 0.2, y: 0.3, width: 0.4, height: 0.03 }],
        };
        render(
            <AnnotationEditorPopover
                open
                selection={highlight}
                onSave={() => {}}
                onDelete={onDelete}
                onClose={onClose}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '取消高亮' }));
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith(highlight));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('页内文字不能为空，保存和再次编辑时同步更新 note 与 quote', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        const onClose = vi.fn();
        const draft = {
            paperId: 'paper-1',
            pageNumber: 20,
            kind: 'text',
            quote: '',
            note: '',
            rects: [{ x: 0.5, y: 0.4, width: 0.3, height: 0.06 }],
        };
        render(
            <AnnotationEditorPopover
                open
                selection={draft}
                onSave={onSave}
                onClose={onClose}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        expect(await screen.findByText('请输入要插入的文字')).toBeTruthy();
        expect(onSave).not.toHaveBeenCalled();

        fireEvent.change(screen.getByPlaceholderText('输入要放在 PDF 页面上的文字…'), {
            target: { value: '这里是一条页内文字' },
        });
        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith({
                ...draft,
                kind: 'text',
                quote: '这里是一条页内文字',
                note: '这里是一条页内文字',
                color: 'violet',
                tags: [],
            })
        );
    });

    it('可以拖动标题栏移动笔记窗口，并限制在阅读工作区内', async () => {
        render(
            <AnnotationEditorPopover
                open
                selection={{ paperId: 'paper-1', pageNumber: 2, quote: 'selected sentence', rects: [] }}
                anchorRect={{ left: 300, top: 180, right: 420, bottom: 202 }}
                boundaryRect={{ left: 200, top: 100, right: 900, bottom: 700 }}
                onSave={() => {}}
                onClose={() => {}}
            />
        );

        const dialog = screen.getByRole('dialog', { name: '添加论文笔记' });
        await waitFor(() => expect(dialog.style.left).not.toBe(''));
        const header = dialog.querySelector('.annotation-editor-popover__drag-handle');
        const left = Number.parseFloat(dialog.style.left);
        const top = Number.parseFloat(dialog.style.top);

        fireEvent.pointerDown(header, {
            button: 0,
            pointerId: 9,
            clientX: left + 20,
            clientY: top + 12,
        });
        fireEvent.pointerMove(window, { pointerId: 9, clientX: -100, clientY: 900 });

        await waitFor(() => {
            expect(dialog.style.left).toBe('212px');
            expect(dialog.style.top).toBe('348px');
        });
        expect(dialog.classList.contains('is-dragging')).toBe(true);
        fireEvent.pointerUp(window, { pointerId: 9, clientX: -100, clientY: 900 });
        await waitFor(() => expect(dialog.classList.contains('is-dragging')).toBe(false));
    });
});
