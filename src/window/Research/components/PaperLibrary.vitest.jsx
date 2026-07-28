import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PaperLibrary from './PaperLibrary';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

const lifecyclePapers = [
    {
        id: 'paper-a',
        title: 'Metabolic Flux',
        pageCount: 10,
        progress: { pageNumber: 2 },
        projects: [],
        tags: [],
    },
    {
        id: 'paper-b',
        title: 'Protein Folding',
        pageCount: 8,
        progress: { pageNumber: 1 },
        projects: [],
        tags: [],
    },
];

function renderLifecycleLibrary(overrides = {}) {
    const props = {
        papers: lifecyclePapers,
        tags: [],
        projects: [],
        view: 'all',
        loading: false,
        sortMode: 'lastOpenedDesc',
        onOpen: vi.fn(),
        onMoveToTrash: vi.fn(),
        onRestore: vi.fn(),
        onDeletePermanently: vi.fn(),
        onArchivePapers: vi.fn().mockResolvedValue(undefined),
        onUnarchivePapers: vi.fn().mockResolvedValue(undefined),
        onMovePapersToTrash: vi.fn().mockResolvedValue(undefined),
        onRestorePapers: vi.fn().mockResolvedValue(undefined),
        onTagChange: vi.fn(),
        onProjectChange: vi.fn(),
        ...overrides,
    };
    return { props, ...render(<PaperLibrary {...props} />) };
}

describe('论文库项目归类', () => {
    it('文件选择器接受 PDF、Markdown、DOCX 与 TeX', () => {
        const { container } = render(
            <PaperLibrary
                papers={[]}
                tags={[]}
                projects={[]}
                view='all'
                loading={false}
                onImport={() => {}}
                onChoose={() => {}}
            />
        );
        const accept = container.querySelector('input[type="file"]')?.getAttribute('accept') ?? '';
        expect(accept).toContain('.pdf');
        expect(accept).toContain('.md');
        expect(accept).toContain('.docx');
        expect(accept).toContain('.tex');
        expect(screen.getByText(/支持 PDF、Markdown、DOCX 与 TeX/u)).toBeTruthy();
    });

    it('显示来源格式和 TeX 编译警告', () => {
        render(
            <PaperLibrary
                papers={[
                    {
                        id: 'tex-paper',
                        title: '模型附录',
                        sourceFormat: 'tex',
                        documentType: 'tex',
                        importWarning: '未找到可用编译器，已按源码导入',
                        pageCount: 1,
                        progress: { pageNumber: 1 },
                    },
                ]}
                tags={[]}
                projects={[]}
                view='all'
                loading={false}
                onOpen={() => {}}
            />
        );
        expect(screen.getByText(/TeX/u)).toBeTruthy();
        expect(screen.getByText('未找到可用编译器，已按源码导入')).toBeTruthy();
    });

    it('书籍使用独立图标并同时保留文件格式提示', () => {
        render(
            <PaperLibrary
                papers={[
                    {
                        id: 'book-1',
                        title: 'Nonlinear Dynamics and Chaos',
                        contentKind: 'book',
                        sourceFormat: 'pdf',
                        documentType: 'pdf',
                        pageCount: 505,
                        progress: { pageNumber: 10 },
                        projects: [],
                        tags: [],
                    },
                ]}
                tags={[]}
                projects={[]}
                view='all'
                loading={false}
                onOpen={() => {}}
            />
        );

        expect(screen.getByRole('img', { name: '书籍' })).toBeTruthy();
        expect(screen.getByText(/书籍 · PDF/u)).toBeTruthy();
    });

    it('展示项目分类并支持为一篇论文分配多个项目', async () => {
        const onProjectChange = vi.fn().mockResolvedValue(undefined);
        const projects = [
            { id: 'project-1', name: '代谢研究', color: '#8170df' },
            { id: 'project-2', name: '蛋白质组学', color: '#4f83d8' },
        ];
        const paper = {
            id: 'paper-1',
            title: 'Thermodynamics-Based Metabolic Flux Analysis',
            pageCount: 14,
            progress: { pageNumber: 2 },
            projects: [projects[0]],
            tags: [],
        };

        render(
            <PaperLibrary
                papers={[paper]}
                tags={[]}
                projects={projects}
                activeProjectId='project-1'
                view='all'
                loading={false}
                onOpen={() => {}}
                onMoveToTrash={() => {}}
                onRestore={() => {}}
                onDeletePermanently={() => {}}
                onTagChange={() => {}}
                onProjectChange={onProjectChange}
            />
        );

        expect(screen.getByRole('heading', { name: '代谢研究' })).toBeTruthy();
        expect(screen.getByText('代谢研究', { selector: '.paper-chip' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /分配《Thermodynamics-Based/u }));
        expect(screen.getByRole('menu', { name: /管理《Thermodynamics-Based/u })).toBeTruthy();
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /蛋白质组学/u }));
        await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith('paper-1', ['project-1', 'project-2']));
    });

    it('没有项目时给出创建引导', () => {
        render(
            <PaperLibrary
                papers={[{ id: 'paper-1', title: 'Paper', pageCount: 1, projects: [], tags: [] }]}
                tags={[]}
                projects={[]}
                view='all'
                loading={false}
                onOpen={() => {}}
                onProjectChange={() => {}}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '分配《Paper》到项目' }));
        expect(screen.getByText('先在左侧创建项目，再把论文归类到这里。')).toBeTruthy();
    });

    it('快速连续勾选会基于最新本地集合并串行提交，旧请求不能覆盖新选择', async () => {
        let resolveFirst;
        const firstRequest = new Promise((resolve) => {
            resolveFirst = resolve;
        });
        const onProjectChange = vi
            .fn()
            .mockImplementationOnce(() => firstRequest)
            .mockResolvedValueOnce(undefined);
        const projects = [
            { id: 'project-1', name: '代谢研究', color: '#8170df' },
            { id: 'project-2', name: '蛋白质组学', color: '#4f83d8' },
            { id: 'project-3', name: '方法验证', color: '#3e9a78' },
        ];

        render(
            <PaperLibrary
                papers={[
                    {
                        id: 'paper-1',
                        title: 'Concurrent Project Assignment',
                        pageCount: 1,
                        projects: [projects[0]],
                        tags: [],
                    },
                ]}
                tags={[]}
                projects={projects}
                view='all'
                loading={false}
                onOpen={() => {}}
                onProjectChange={onProjectChange}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: '分配《Concurrent Project Assignment》到项目' }));
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /蛋白质组学/u }));
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /方法验证/u }));

        await waitFor(() => expect(onProjectChange).toHaveBeenNthCalledWith(1, 'paper-1', ['project-1', 'project-2']));
        expect(onProjectChange).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('menuitemcheckbox', { name: /蛋白质组学/u }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByRole('menuitemcheckbox', { name: /方法验证/u }).getAttribute('aria-checked')).toBe('true');

        resolveFirst();
        await waitFor(() =>
            expect(onProjectChange).toHaveBeenNthCalledWith(2, 'paper-1', ['project-1', 'project-2', 'project-3'])
        );
    });

    it('逐项选择不会打开论文，表头全选会呈现半选并只覆盖当前结果', () => {
        const { props } = renderLifecycleLibrary();
        const selectAll = screen.getByRole('checkbox', { name: '选择当前筛选结果中的全部文献' });
        const firstPaper = screen.getByRole('checkbox', { name: '选择《Metabolic Flux》' });
        const secondPaper = screen.getByRole('checkbox', { name: '选择《Protein Folding》' });

        fireEvent.click(firstPaper);
        expect(props.onOpen).not.toHaveBeenCalled();
        expect(firstPaper.checked).toBe(true);
        expect(selectAll.checked).toBe(false);
        expect(selectAll.indeterminate).toBe(true);

        fireEvent.click(selectAll);
        expect(firstPaper.checked).toBe(true);
        expect(secondPaper.checked).toBe(true);
        expect(selectAll.checked).toBe(true);
        expect(selectAll.indeterminate).toBe(false);

        fireEvent.click(selectAll);
        expect(firstPaper.checked).toBe(false);
        expect(secondPaper.checked).toBe(false);
    });

    it('批量归档忙碌时禁用重复操作，成功后清空选择', async () => {
        let resolveArchive;
        const archiveRequest = new Promise((resolve) => {
            resolveArchive = resolve;
        });
        const onArchivePapers = vi.fn(() => archiveRequest);
        renderLifecycleLibrary({ onArchivePapers });

        fireEvent.click(screen.getByRole('checkbox', { name: '选择当前筛选结果中的全部文献' }));
        const archiveButton = screen.getByRole('button', { name: '归档所选文献' });
        fireEvent.click(archiveButton);
        fireEvent.click(archiveButton);

        expect(onArchivePapers).toHaveBeenCalledOnce();
        expect(onArchivePapers).toHaveBeenCalledWith(['paper-a', 'paper-b']);
        expect(archiveButton.disabled).toBe(true);
        expect(screen.getByRole('checkbox', { name: '选择《Metabolic Flux》' }).disabled).toBe(true);

        resolveArchive();
        await waitFor(() => expect(screen.queryByRole('toolbar', { name: '批量管理文献' })).toBeNull());
        expect(screen.getByRole('checkbox', { name: '选择《Metabolic Flux》' }).checked).toBe(false);
    });

    it('一键归档当前筛选结果，不需要先勾选且会阻止重复提交', async () => {
        let resolveArchive;
        const archiveRequest = new Promise((resolve) => {
            resolveArchive = resolve;
        });
        const onArchivePapers = vi.fn(() => archiveRequest);
        renderLifecycleLibrary({ onArchivePapers });

        const archiveButton = screen.getByRole('button', { name: '一键归档当前结果' });
        fireEvent.click(archiveButton);
        fireEvent.click(archiveButton);

        expect(onArchivePapers).toHaveBeenCalledOnce();
        expect(onArchivePapers).toHaveBeenCalledWith(['paper-a', 'paper-b']);
        expect(archiveButton.disabled).toBe(true);
        resolveArchive();
        await waitFor(() => expect(archiveButton.disabled).toBe(false));
    });

    it('切换最近打开与导入日期排序并显示时间依据', () => {
        const onSortModeChange = vi.fn();
        renderLifecycleLibrary({
            papers: [
                {
                    ...lifecyclePapers[0],
                    createdAt: '2026-07-20T00:00:00Z',
                    lastOpenedAt: '2026-07-27T00:00:00Z',
                },
            ],
            sortMode: 'lastOpenedDesc',
            onSortModeChange,
        });

        fireEvent.change(screen.getByRole('combobox', { name: '文献排序方式' }), {
            target: { value: 'importedAsc' },
        });
        expect(onSortModeChange).toHaveBeenCalledWith('importedAsc');
        expect(screen.getByText('导入 2026-07-20 · 最近打开 2026-07-27')).toBeTruthy();
    });

    it('批量失败时保留选择和错误提示，可重试成功', async () => {
        const onArchivePapers = vi
            .fn()
            .mockRejectedValueOnce(new Error('数据库暂时不可用'))
            .mockResolvedValueOnce(undefined);
        renderLifecycleLibrary({ onArchivePapers });

        const paperCheckbox = screen.getByRole('checkbox', { name: '选择《Metabolic Flux》' });
        fireEvent.click(paperCheckbox);
        fireEvent.click(screen.getByRole('button', { name: '归档所选文献' }));

        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('数据库暂时不可用'));
        expect(paperCheckbox.checked).toBe(true);
        expect(screen.getByRole('toolbar', { name: '批量管理文献' })).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: '归档所选文献' }));
        await waitFor(() => expect(screen.queryByRole('toolbar', { name: '批量管理文献' })).toBeNull());
        expect(onArchivePapers).toHaveBeenCalledTimes(2);
    });

    it('归档视图支持单项与批量取消归档，并突出归档日期', async () => {
        const archivedPaper = {
            ...lifecyclePapers[0],
            archivedAt: '2026-07-27T13:20:00Z',
        };
        const onUnarchivePapers = vi.fn().mockResolvedValue(undefined);
        const { container } = renderLifecycleLibrary({
            papers: [archivedPaper],
            view: 'archive',
            onUnarchivePapers,
        });

        expect(screen.getByRole('heading', { name: '已归档' })).toBeTruthy();
        expect(screen.getByText('已归档 2026-07-27')).toBeTruthy();
        expect(container.querySelector('.paper-row.is-archived')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: '取消归档《Metabolic Flux》' }));
        await waitFor(() => expect(onUnarchivePapers).toHaveBeenCalledWith(['paper-a']));

        fireEvent.click(screen.getByRole('checkbox', { name: '选择《Metabolic Flux》' }));
        const toolbar = screen.getByRole('toolbar', { name: '批量管理文献' });
        expect(within(toolbar).getByRole('button', { name: '取消归档所选文献' })).toBeTruthy();
        expect(within(toolbar).getByRole('button', { name: '移到回收站' })).toBeTruthy();
        expect(within(toolbar).queryByRole('button', { name: /恢复所选/u })).toBeNull();
    });

    it('单项移入回收站与恢复复用防重和错误提示', async () => {
        let rejectTrash;
        const trashRequest = new Promise((_, reject) => {
            rejectTrash = reject;
        });
        const onMovePapersToTrash = vi.fn(() => trashRequest);
        const { rerender } = renderLifecycleLibrary({ onMovePapersToTrash });

        const trashButton = screen.getByRole('button', { name: '移到回收站《Metabolic Flux》' });
        fireEvent.click(trashButton);
        fireEvent.click(trashButton);
        expect(onMovePapersToTrash).toHaveBeenCalledOnce();
        expect(onMovePapersToTrash).toHaveBeenCalledWith(['paper-a']);
        expect(trashButton.disabled).toBe(true);

        rejectTrash(new Error('回收事务失败'));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('回收事务失败'));

        const onRestorePapers = vi.fn().mockResolvedValue(undefined);
        rerender(
            <PaperLibrary
                papers={[{ ...lifecyclePapers[0], trashedAt: '2026-07-27T13:20:00Z' }]}
                tags={[]}
                projects={[]}
                view='trash'
                loading={false}
                onDeletePermanently={vi.fn()}
                onRestorePapers={onRestorePapers}
            />
        );
        fireEvent.click(screen.getByRole('button', { name: '恢复论文' }));
        await waitFor(() => expect(onRestorePapers).toHaveBeenCalledWith(['paper-a']));
    });

    it('归档视图不显示导入入口，避免新文献导入后在当前视图中消失', () => {
        renderLifecycleLibrary({
            papers: [{ ...lifecyclePapers[0], archivedAt: '2026-07-27T13:20:00Z' }],
            view: 'archive',
            onChoose: vi.fn(),
        });
        expect(screen.queryByRole('button', { name: '导入文献' })).toBeNull();
    });

    it('回收站批量工具条只允许恢复，绝不提供永久删除', () => {
        renderLifecycleLibrary({
            papers: [{ ...lifecyclePapers[0], trashedAt: '2026-07-27T13:20:00Z' }],
            view: 'trash',
        });

        fireEvent.click(screen.getByRole('checkbox', { name: '选择《Metabolic Flux》' }));
        const toolbar = screen.getByRole('toolbar', { name: '批量管理文献' });
        expect(within(toolbar).getByRole('button', { name: '恢复所选文献' })).toBeTruthy();
        expect(within(toolbar).queryByRole('button', { name: /永久删除/u })).toBeNull();
        expect(within(toolbar).queryByRole('button', { name: /归档/u })).toBeNull();
    });

    it('筛选结果或视图改变时清理不可见选择，避免跨视图误操作', () => {
        const props = {
            tags: [],
            projects: [],
            loading: false,
            onOpen: vi.fn(),
            onArchivePapers: vi.fn(),
            onUnarchivePapers: vi.fn(),
            onMovePapersToTrash: vi.fn(),
            onRestorePapers: vi.fn(),
        };
        const { rerender } = render(
            <PaperLibrary
                {...props}
                papers={lifecyclePapers}
                view='all'
            />
        );

        fireEvent.click(screen.getByRole('checkbox', { name: '选择《Metabolic Flux》' }));
        rerender(
            <PaperLibrary
                {...props}
                papers={[lifecyclePapers[1]]}
                view='all'
            />
        );
        expect(screen.queryByRole('toolbar', { name: '批量管理文献' })).toBeNull();

        fireEvent.click(screen.getByRole('checkbox', { name: '选择《Protein Folding》' }));
        rerender(
            <PaperLibrary
                {...props}
                papers={[{ ...lifecyclePapers[0], archivedAt: '2026-07-27T13:20:00Z' }]}
                view='archive'
            />
        );
        expect(screen.queryByRole('toolbar', { name: '批量管理文献' })).toBeNull();
        expect(screen.getByRole('checkbox', { name: '选择《Metabolic Flux》' }).checked).toBe(false);
    });
});
