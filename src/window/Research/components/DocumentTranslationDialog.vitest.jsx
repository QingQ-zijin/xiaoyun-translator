import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DocumentTranslationDialog from './DocumentTranslationDialog';

afterEach(cleanup);

const paper = { id: 'paper-1', title: 'Thermodynamic Flux Analysis', pageCount: 12 };
const idleTask = {
    status: 'idle',
    totalPages: 0,
    completedPages: 0,
    currentPage: 0,
    partialText: '',
    error: '',
};

function renderDialog(overrides = {}) {
    const handlers = {
        onTargetLanguageChange: vi.fn(),
        onIncludeOriginalChange: vi.fn(),
        onStart: vi.fn(),
        onPause: vi.fn(),
        onReset: vi.fn(),
        onExport: vi.fn(),
        onClose: vi.fn(),
    };
    render(
        <DocumentTranslationDialog
            open
            paper={paper}
            task={idleTask}
            targetLanguage='zh_cn'
            includeOriginal
            {...handlers}
            {...overrides}
        />
    );
    return handlers;
}

describe('全文翻译对话框', () => {
    it('明确配置目标语言和双语输出，并启动翻译', () => {
        const handlers = renderDialog();

        expect(screen.queryByRole('option', { name: '自动检测' })).toBeNull();
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'en' } });
        fireEvent.click(screen.getByLabelText('仅译文 PDF'));
        fireEvent.click(screen.getByRole('button', { name: '开始翻译' }));

        expect(handlers.onTargetLanguageChange).toHaveBeenCalledWith('en');
        expect(handlers.onIncludeOriginalChange).toHaveBeenCalledWith(false);
        expect(handlers.onStart).toHaveBeenCalledOnce();
    });

    it('显示逐页流式进度，运行时只允许暂停', () => {
        const handlers = renderDialog({
            task: {
                ...idleTask,
                status: 'translating',
                totalPages: 12,
                completedPages: 4,
                currentPage: 5,
                partialText: '正在流式输出的页面译文',
            },
        });

        expect(screen.getByText('正在翻译第 5 页')).toBeTruthy();
        expect(screen.getByLabelText('当前页流式译文').textContent).toContain('流式输出');
        expect(screen.getByRole('progressbar').value).toBe(4);
        fireEvent.click(screen.getByRole('button', { name: '暂停' }));
        expect(handlers.onPause).toHaveBeenCalledOnce();
        expect(screen.getByRole('button', { name: '导出完整 PDF' }).disabled).toBe(true);
    });

    it('全部页面完成后允许导出，并可从右上角立即关闭', () => {
        const handlers = renderDialog({
            task: { ...idleTask, status: 'complete', totalPages: 12, completedPages: 12 },
        });

        fireEvent.click(screen.getByRole('button', { name: '导出完整 PDF' }));
        fireEvent.click(screen.getByRole('button', { name: '关闭全文翻译' }));
        expect(handlers.onExport).toHaveBeenCalledOnce();
        expect(handlers.onClose).toHaveBeenCalledOnce();
        expect(screen.queryByRole('button', { name: '继续翻译' })).toBeNull();
    });
});
