import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DocumentOutlinePanel from './DocumentOutlinePanel';

afterEach(cleanup);

describe('文档章节侧栏', () => {
    it('按层级展示目录、标记当前章节并同时触发跳转与按需选择', () => {
        const onJump = vi.fn();
        const onSelectChapter = vi.fn();
        render(
            <DocumentOutlinePanel
                currentPage={6}
                outline={[
                    { title: '1 Introduction', pageNumber: 2, endPage: 8, level: 1, source: 'native' },
                    { title: '1.1 Background', pageNumber: 5, endPage: 8, level: 2, source: 'native' },
                    { title: '2 Methods', pageNumber: 9, endPage: 15, level: 1, source: 'native' },
                ]}
                onJump={onJump}
                onSelectChapter={onSelectChapter}
            />
        );

        expect(screen.getByText('3 个章节节点')).toBeTruthy();
        expect(screen.getByText('PDF 原生书签')).toBeTruthy();
        expect(screen.getByRole('button', { name: /1\.1 Background/u }).getAttribute('aria-current')).toBe('location');
        fireEvent.click(screen.getByRole('button', { name: /2 Methods/u }));
        expect(onJump).toHaveBeenCalledWith(9);
        expect(onSelectChapter).toHaveBeenCalledWith(
            expect.objectContaining({ title: '2 Methods', pageNumber: 9, endPage: 15 }),
            2
        );
    });

    it('没有可靠目录时说明数字 PDF 与扫描件的降级路径', () => {
        render(<DocumentOutlinePanel outline={[]} />);

        expect(screen.getByText('尚未识别到章节目录')).toBeTruthy();
        expect(screen.getByText(/扫描件需先完成全文 OCR/u)).toBeTruthy();
    });

    it('空的受控选择状态不会误选第一章', () => {
        render(
            <DocumentOutlinePanel
                outline={[{ title: '第一章', pageNumber: 1, endPage: 3, level: 1, source: 'native' }]}
                chapterInsightState={{ selectedIndex: null, status: 'idle', insight: null, error: '' }}
            />
        );

        expect(screen.getByRole('button', { name: /第一章/u }).getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByText(/选择章节后按需生成/u)).toBeTruthy();
    });

    it('只读取完整章节身份匹配的缓存，并显示概要、术语和可跳转页码', () => {
        const onJump = vi.fn();
        const onRegenerateChapter = vi.fn();
        const outline = [{ title: '2 Methods', pageNumber: 9, endPage: 15, level: 1, source: 'native' }];
        render(
            <DocumentOutlinePanel
                outline={outline}
                chapterInsights={[
                    {
                        ordinal: 0,
                        title: '旧目录章节',
                        startPage: 9,
                        endPage: 15,
                        status: 'ready',
                        cached: true,
                        payload: { summary: '不应展示的旧缓存', terms: [] },
                    },
                    {
                        ordinal: 0,
                        title: '2 Methods',
                        startPage: 9,
                        endPage: 15,
                        status: 'ready',
                        cached: true,
                        payload: {
                            summary: '本章介绍约束建模方法。',
                            terms: [
                                {
                                    term: 'flux',
                                    translation: '通量',
                                    annotation: '单位时间内通过反应的物质量。',
                                    pageNumbers: [10],
                                },
                            ],
                        },
                    },
                ]}
                onJump={onJump}
                onRegenerateChapter={onRegenerateChapter}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: /2 Methods/u }));
        expect(screen.getByText('已读取本地缓存')).toBeTruthy();
        expect(screen.getByRole('status').textContent).toContain('已读取本地缓存');
        expect(screen.getByText('本章介绍约束建模方法。')).toBeTruthy();
        expect(screen.queryByText('不应展示的旧缓存')).toBeNull();
        expect(screen.getByText('flux')).toBeTruthy();
        expect(screen.getByText('通量')).toBeTruthy();
        expect(screen.getByText('单位时间内通过反应的物质量。')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: '跳转到第 10 页' }));
        expect(onJump).toHaveBeenLastCalledWith(10);
        fireEvent.click(screen.getByRole('button', { name: '重新生成章节概要：2 Methods' }));
        expect(onRegenerateChapter).toHaveBeenCalledWith(expect.objectContaining({ title: '2 Methods' }), 0);
    });

    it('展示按需生成中的状态与失败重试', () => {
        const onRegenerateChapter = vi.fn();
        const outline = [{ title: '第一章', pageNumber: 1, endPage: 6, level: 1, source: 'text' }];
        const { rerender } = render(
            <DocumentOutlinePanel
                outline={outline}
                chapterInsightState={{ selectedIndex: 0, status: 'generating' }}
                onRegenerateChapter={onRegenerateChapter}
            />
        );

        expect(screen.getByRole('status').textContent).toContain('正在整理本章要点');
        expect(screen.getByText(/永久保存在本地/u)).toBeTruthy();

        rerender(
            <DocumentOutlinePanel
                outline={outline}
                chapterInsightState={{ selectedIndex: 0, status: 'failed', error: '模型响应超时' }}
                onRegenerateChapter={onRegenerateChapter}
            />
        );
        expect(screen.getByRole('alert').textContent).toContain('本章概要生成失败');
        expect(screen.getByText('模型响应超时')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '重试' }));
        expect(onRegenerateChapter).toHaveBeenCalledWith(expect.objectContaining({ title: '第一章' }), 0);
    });

    it('needs_ocr 即使携带错误详情也优先显示扫描页指引', () => {
        render(
            <DocumentOutlinePanel
                outline={[{ title: '扫描章节', pageNumber: 3, endPage: 8, level: 1, source: 'ocr' }]}
                chapterInsightState={{
                    selectedIndex: 0,
                    status: 'needs_ocr',
                    error: '本章没有可用文本，请先执行 OCR',
                }}
                onRegenerateChapter={() => {}}
            />
        );

        expect(screen.getByRole('status').textContent).toContain('本章需要先完成 OCR');
        expect(screen.queryByText('本章概要生成失败')).toBeNull();
        expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    });
});
