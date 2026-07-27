import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LibrarySidebar from './LibrarySidebar';

afterEach(cleanup);

const insight = {
    status: 'ready',
    summary: '这是自动生成的全文概要。',
    researchQuestion: '论文需要解决什么问题？',
    methods: [],
    findings: [],
    limitations: [],
    terms: [],
};

describe('小允论文阅读器侧栏', () => {
    it('在论文库中创建、筛选、编辑并删除项目', async () => {
        const onViewChange = vi.fn();
        const onProjectChange = vi.fn();
        const onCreateProject = vi.fn().mockResolvedValue({ id: 'new-project' });
        const onUpdateProject = vi.fn().mockResolvedValue(undefined);
        const onDeleteProject = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(
            <LibrarySidebar
                mode='library'
                query=''
                onQueryChange={() => {}}
                view='all'
                onViewChange={onViewChange}
                tags={[]}
                activeTagId=''
                onTagChange={() => {}}
                paperCounts={{ all: 3, tagged: 1, archive: 2, trash: 0, unclassified: 1 }}
                projects={[{ id: 'project-1', name: '代谢组学', color: '#8170df', paperCount: 2 }]}
                activeProjectId='project-1'
                onProjectChange={onProjectChange}
                onCreateProject={onCreateProject}
                onUpdateProject={onUpdateProject}
                onDeleteProject={onDeleteProject}
            />
        );

        expect(screen.getByRole('button', { name: '代谢组学' }).getAttribute('class')).toContain('is-active');
        fireEvent.click(screen.getByRole('button', { name: /已归档/u }));
        expect(onViewChange).toHaveBeenCalledWith('archive');
        expect(screen.getByRole('button', { name: /已归档/u }).textContent).toContain('2');
        fireEvent.click(screen.getByRole('button', { name: '未分类' }));
        expect(onProjectChange).toHaveBeenCalledWith('__unclassified__');

        fireEvent.click(screen.getAllByRole('button', { name: '新建项目' })[0]);
        fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '蛋白质组学' } });
        fireEvent.click(screen.getByRole('button', { name: '项目颜色 2' }));
        fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
        await waitFor(() =>
            expect(onCreateProject).toHaveBeenCalledWith({
                name: '蛋白质组学',
                color: '#4f83d8',
                description: '',
            })
        );

        fireEvent.click(screen.getByRole('button', { name: '管理项目 代谢组学' }));
        fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: '代谢网络' } });
        fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
        await waitFor(() =>
            expect(onUpdateProject).toHaveBeenCalledWith({
                projectId: 'project-1',
                name: '代谢网络',
                color: '#8170df',
                description: '',
            })
        );

        fireEvent.click(screen.getByRole('button', { name: '管理项目 代谢组学' }));
        fireEvent.click(screen.getByRole('button', { name: '删除项目 代谢组学' }));
        await waitFor(() => expect(onDeleteProject).toHaveBeenCalledWith('project-1'));
    });

    it('默认展示论文概要，并提供独立章节入口', () => {
        render(
            <LibrarySidebar
                mode='reader'
                paper={{ id: 'paper-1', title: 'TMFA', contentKind: 'paper' }}
                insights={insight}
                onBack={() => {}}
            />
        );

        expect(screen.getByText('小允论文阅读器')).toBeTruthy();
        expect(screen.getByRole('tablist', { name: '阅读侧栏' })).toBeTruthy();
        expect(screen.getByRole('tab', { name: '章节' })).toBeTruthy();
        expect(screen.getByText(insight.summary)).toBeTruthy();
        expect(screen.getByRole('tab', { name: '概要' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('reader-sidebar-tab-insights');
    });

    it('书籍默认进入独立目录页，并从本地缓存展示章节概要与术语', () => {
        const onJump = vi.fn();
        const onSelectChapter = vi.fn();
        const outline = [{ title: '第一章 长文档阅读', pageNumber: 12, endPage: 35, level: 1, source: 'native' }];
        render(
            <LibrarySidebar
                mode='reader'
                paper={{ id: 'book-1', title: '系统生物学教材', contentKind: 'book' }}
                outline={outline}
                currentPage={14}
                chapterInsights={[
                    {
                        ordinal: 0,
                        title: '第一章 长文档阅读',
                        startPage: 12,
                        endPage: 35,
                        status: 'ready',
                        cached: true,
                        payload: {
                            summary: '本章介绍长文档的分章阅读方法。',
                            terms: [
                                {
                                    term: 'document outline',
                                    translation: '文档目录',
                                    annotation: '用于按章节导航长篇内容。',
                                    pageNumbers: [12],
                                },
                            ],
                        },
                    },
                ]}
                onBack={() => {}}
                onJump={onJump}
                onSelectChapter={onSelectChapter}
            />
        );

        expect(screen.queryByRole('tab', { name: '概要' })).toBeNull();
        expect(screen.getByRole('tab', { name: '目录' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('reader-sidebar-tab-outline');

        fireEvent.click(screen.getByRole('button', { name: /第一章 长文档阅读/u }));
        expect(onJump).toHaveBeenCalledWith(12);
        expect(onSelectChapter).toHaveBeenCalledWith(expect.objectContaining({ title: '第一章 长文档阅读' }), 0);
        expect(screen.getByText('已读取本地缓存')).toBeTruthy();
        expect(screen.getByText('本章介绍长文档的分章阅读方法。')).toBeTruthy();
        expect(screen.getByText('文档目录')).toBeTruthy();
    });

    it('阅读侧栏支持方向键切换并移动键盘焦点', () => {
        render(
            <LibrarySidebar
                mode='reader'
                paper={{ title: '键盘阅读测试' }}
                insights={insight}
                outline={[{ title: '第一章', pageNumber: 1, endPage: 3, level: 1, source: 'native' }]}
                onBack={() => {}}
            />
        );

        const overviewTab = screen.getByRole('tab', { name: '概要' });
        overviewTab.focus();
        fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });

        const outlineTab = screen.getByRole('tab', { name: '章节' });
        expect(outlineTab.getAttribute('aria-selected')).toBe('true');
        expect(outlineTab.getAttribute('tabindex')).toBe('0');
        expect(document.activeElement).toBe(outlineTab);
        expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('reader-sidebar-tab-outline');
        expect(screen.getByText('第一章')).toBeTruthy();
    });

    it('章节页签标记当前章节并把点击页码交给阅读器跳转', () => {
        const onJump = vi.fn();
        const onSelectChapter = vi.fn();
        render(
            <LibrarySidebar
                mode='reader'
                paper={{ title: '长篇论文' }}
                insights={insight}
                outline={[
                    { title: '第一章 绪论', pageNumber: 2, endPage: 8, level: 1, source: 'native' },
                    { title: '1.1 研究背景', pageNumber: 4, endPage: 8, level: 2, source: 'native' },
                    { title: '第二章 方法', pageNumber: 9, endPage: 16, level: 1, source: 'native' },
                ]}
                currentPage={6}
                onBack={() => {}}
                onJump={onJump}
                onSelectChapter={onSelectChapter}
            />
        );

        fireEvent.click(screen.getByRole('tab', { name: '章节' }));
        expect(screen.getByRole('button', { name: /1\.1 研究背景/u }).getAttribute('aria-current')).toBe('location');
        fireEvent.click(screen.getByRole('button', { name: /第二章 方法/u }));
        expect(onJump).toHaveBeenCalledWith(9);
        expect(onSelectChapter).toHaveBeenCalledWith(
            expect.objectContaining({ title: '第二章 方法', pageNumber: 9 }),
            2
        );
    });

    it('摘录区区分词汇、摘抄、笔记与高亮，并显示音标和标签', () => {
        const onJump = vi.fn();
        const onDeleteAnnotation = vi.fn();
        const annotations = [
            {
                id: 'vocabulary-1',
                kind: 'vocabulary',
                quote: 'flux',
                pageNumber: 3,
                color: 'blue',
                tags: ['代谢'],
                lexicon: {
                    phonetics: [{ region: 'UK', ipa: '/flʌks/' }],
                    contextMeaning: '本文语境中指代谢通量。',
                },
            },
            { id: 'excerpt-1', kind: 'excerpt', quote: 'a useful sentence', pageNumber: 4 },
            { id: 'note-1', kind: 'note', quote: 'note quote', note: '记录方法', pageNumber: 5 },
            { id: 'highlight-1', kind: 'highlight', quote: 'highlight quote', pageNumber: 6 },
        ];
        render(
            <LibrarySidebar
                mode='reader'
                paper={{ title: 'TMFA' }}
                insights={insight}
                annotations={annotations}
                onBack={() => {}}
                onJump={onJump}
                onDeleteAnnotation={onDeleteAnnotation}
            />
        );

        fireEvent.click(screen.getByRole('tab', { name: /\u6458\u5f55/u }));
        expect(screen.getAllByText('词汇').length).toBeGreaterThan(0);
        expect(screen.getAllByText('摘抄').length).toBeGreaterThan(0);
        expect(screen.getAllByText('笔记').length).toBeGreaterThan(0);
        expect(screen.getAllByText('高亮').length).toBeGreaterThan(0);
        expect(screen.getByText(/\/flʌks\//u)).toBeTruthy();
        expect(screen.getAllByText('#代谢').length).toBeGreaterThan(0);

        fireEvent.click(screen.getByRole('button', { name: /^flux/u }));
        expect(onJump).toHaveBeenCalledWith(annotations[0]);

        fireEvent.click(screen.getByRole('button', { name: '取消高亮：highlight quote' }));
        expect(onDeleteAnnotation).toHaveBeenCalledWith(annotations[3]);
    });
});
