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
        expect(screen.getByTitle(/Ctrl \+ 鼠标滚轮/)).not.toBeNull();
        expect(screen.queryByRole('button', { name: /放大|缩小/ })).toBeNull();
    });

    it('按项目分组论文，并把未加入项目的论文放入未分类', () => {
        const groups = groupPapersByProject(
            [
                { id: 'paper-a', title: '项目论文', projects: [{ id: 'project-a', name: '代谢网络' }] },
                { id: 'paper-b', title: '未分类论文', projects: [] },
            ],
            [{ id: 'project-a', name: '代谢网络' }]
        );

        expect(groups.map(({ id, label, papers }) => ({ id, label, papers: papers.map((paper) => paper.id) }))).toEqual(
            [
                { id: 'project-a', label: '项目 · 代谢网络', papers: ['paper-a'] },
                { id: '__unclassified__', label: '未分类', papers: ['paper-b'] },
            ]
        );

        renderTopbar({ ready: true, message: '已就绪' });
        const labels = [...document.querySelectorAll('.reader-paper-switcher optgroup')].map((group) => group.label);
        expect(labels).toEqual(['项目 · 代谢网络', '未分类']);
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
});
