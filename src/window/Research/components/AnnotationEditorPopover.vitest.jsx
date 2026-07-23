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
});
