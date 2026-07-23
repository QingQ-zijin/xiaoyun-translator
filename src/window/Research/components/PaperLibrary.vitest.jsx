import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PaperLibrary from './PaperLibrary';

afterEach(cleanup);

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
});
