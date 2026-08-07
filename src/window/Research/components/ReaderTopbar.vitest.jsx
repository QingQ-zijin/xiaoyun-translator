import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ReaderTopbar, { groupPapersByProject } from './ReaderTopbar';

afterEach(cleanup);

const renderTopbar = (translationStatus, overrides = {}) =>
    render(
        <ReaderTopbar
            paper={{ id: 'paper-a', title: 'Test Paper' }}
            papers={[
                { id: 'paper-a', title: 'Test Paper', projects: [{ id: 'project-a', name: '代谢网络' }] },
                { id: 'paper-b', title: 'Second Paper' },
            ]}
            projects={[{ id: 'project-a', name: '代谢网络' }]}
            activePaperId='paper-a'
            currentPage={1}
            pageCount={2}
            scale={1.25}
            onPageChange={() => {}}
            onPaperChange={() => {}}
            translationStatus={translationStatus}
            {...overrides}
        />
    );

describe('论文阅读器翻译模型状态', () => {
    it('真实检查失败时显示红色不可用，而不是绿色就绪', () => {
        renderTopbar({ model: 'translategemma:4b', ready: false, message: '无法连接本地 Ollama' });

        const status = screen.getByTitle('无法连接本地 Ollama');
        expect(status.dataset.state).toBe('unavailable');
        expect(status.textContent).toContain('TranslateGemma · 不可用');
        expect(status.querySelector('i').style.background).toBe('rgb(212, 93, 102)');
    });

    it('只有后端确认模型可用时才显示就绪', () => {
        renderTopbar({ model: 'translategemma:4b', ready: true, message: 'TranslateGemma 已就绪' });

        const status = screen.getByTitle('TranslateGemma 已就绪');
        expect(status.dataset.state).toBe('ready');
        expect(status.textContent).toContain('TranslateGemma · 就绪');
        expect(status.querySelector('i').style.background).toBe('rgb(85, 190, 114)');
    });

    it('通过论文切换器打开另一篇论文，并将缩放改为只读状态提示', () => {
        const onPaperChange = vi.fn();
        renderTopbar({ ready: true, message: 'TranslateGemma 已就绪' }, { onPaperChange });

        fireEvent.change(screen.getByRole('combobox', { name: '切换论文' }), {
            target: { value: 'paper-b' },
        });

        expect(onPaperChange).toHaveBeenCalledWith('paper-b');
        expect(screen.getByLabelText('当前缩放比例').textContent).toContain('125%');
        expect(screen.getByTitle(/(Ctrl|⌘) \+ 鼠标滚轮/)).not.toBeNull();
        expect(screen.queryByRole('button', { name: /放大|缩小/ })).toBeNull();
    });

    it('从顶部入口打开全文翻译，并持续显示断点页数', () => {
        const onDocumentTranslate = vi.fn();
        renderTopbar(
            { ready: true, message: '已就绪' },
            {
                onDocumentTranslate,
                documentTranslationTask: { status: 'paused', completedPages: 3, totalPages: 12 },
            }
        );

        const button = screen.getByRole('button', { name: '全文翻译' });
        expect(button.textContent).toContain('3/12');
        fireEvent.click(button);
        expect(onDocumentTranslate).toHaveBeenCalledOnce();
    });

    it('按项目分组论文，并把未加入项目的论文放入未分类', () => {
        const groups = groupPapersByProject(
            [
                { id: 'paper-a', title: '项目论文', projects: [{ id: 'project-a', name: '代谢网络' }] },
                { id: 'paper-b', title: '未分类论文', projects: [] },
                { id: 'paper-c', title: '归档论文', archivedAt: '2026-07-27T00:00:00Z', projects: [] },
                { id: 'paper-d', title: '回收站论文', trashedAt: '2026-07-27T00:00:00Z', projects: [] },
            ],
            [{ id: 'project-a', name: '代谢网络' }]
        );

        expect(groups.map(({ id, label, papers }) => ({ id, label, papers: papers.map((paper) => paper.id) }))).toEqual(
            [
                { id: 'project-a', label: '项目 · 代谢网络', papers: ['paper-a'] },
                { id: '__unclassified__', label: '未分类', papers: ['paper-b'] },
            ]
        );

        renderTopbar(
            { ready: true, message: '已就绪' },
            {
                papers: [
                    { id: 'paper-a', title: '项目论文', projects: [{ id: 'project-a', name: '代谢网络' }] },
                    { id: 'paper-b', title: '未分类论文', projects: [] },
                    { id: 'paper-c', title: '归档论文', archivedAt: '2026-07-27T00:00:00Z', projects: [] },
                    { id: 'paper-d', title: '回收站论文', trashedAt: '2026-07-27T00:00:00Z', projects: [] },
                ],
            }
        );
        const labels = [...document.querySelectorAll('.reader-paper-switcher optgroup')].map((group) => group.label);
        expect(labels).toEqual(['项目 · 代谢网络', '未分类']);
        expect(screen.queryByRole('option', { name: '归档论文' })).toBeNull();
        expect(screen.queryByRole('option', { name: '回收站论文' })).toBeNull();
    });

    it('阅读当前归档文献时在切换器中保留只针对当前项的归档分组', () => {
        const archivedPaper = {
            id: 'paper-c',
            title: '归档论文',
            archivedAt: '2026-07-27T00:00:00Z',
            projects: [],
        };
        renderTopbar(
            { ready: true, message: '已就绪' },
            {
                paper: archivedPaper,
                activePaperId: 'paper-c',
                papers: [{ id: 'paper-a', title: '活动论文', projects: [] }],
            }
        );

        const switcher = screen.getByRole('combobox', { name: '切换论文' });
        expect(switcher.value).toBe('paper-c');
        expect(screen.getByRole('option', { name: '归档论文' })).toBeTruthy();
        expect(document.querySelector('.reader-paper-switcher optgroup')?.label).toBe('当前归档文献');
    });

    it('可以隐藏并重新显示阅读侧栏', () => {
        const onSidebarToggle = vi.fn();
        const { rerender } = renderTopbar(
            { ready: true, message: '已就绪' },
            { sidebarCollapsed: false, onSidebarToggle }
        );

        fireEvent.click(screen.getByRole('button', { name: '隐藏阅读侧栏' }));
        expect(onSidebarToggle).toHaveBeenCalledOnce();

        rerender(
            <ReaderTopbar
                paper={{ id: 'paper-a', title: 'Test Paper' }}
                papers={[{ id: 'paper-a', title: 'Test Paper', projects: [] }]}
                activePaperId='paper-a'
                currentPage={1}
                pageCount={2}
                scale={1.25}
                onPageChange={() => {}}
                sidebarCollapsed
                onSidebarToggle={onSidebarToggle}
                translationStatus={{ ready: true, message: '已就绪' }}
            />
        );
        expect(screen.getByRole('button', { name: '显示阅读侧栏' }).getAttribute('aria-pressed')).toBe('false');
    });

    it('多位页码只在回车或失焦后提交一次，不会输入一位就跳一页', () => {
        const onPageChange = vi.fn();
        renderTopbar({ ready: true, message: '已就绪' }, { currentPage: 1, pageCount: 120, onPageChange });
        const input = screen.getByRole('textbox', { name: '当前页码' });

        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: '2' } });
        fireEvent.change(input, { target: { value: '20' } });
        expect(onPageChange).not.toHaveBeenCalled();

        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onPageChange).toHaveBeenCalledOnce();
        expect(onPageChange).toHaveBeenCalledWith(20);
    });

    it('顶部文字工具可以切换到任意位置插入模式', () => {
        const onInteractionModeChange = vi.fn();
        renderTopbar({ ready: true, message: '已就绪' }, { interactionMode: 'select', onInteractionModeChange });

        const textTool = screen.getByRole('button', { name: '插入文字工具' });
        expect(textTool.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(textTool);
        expect(onInteractionModeChange).toHaveBeenCalledWith('text');
    });
});
