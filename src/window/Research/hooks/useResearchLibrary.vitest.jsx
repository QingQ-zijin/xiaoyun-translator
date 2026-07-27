import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
    archivePapers: vi.fn(),
    createProject: vi.fn(),
    deletePaperPermanently: vi.fn(),
    deleteProject: vi.fn(),
    importPapers: vi.fn(),
    listPapers: vi.fn(),
    listProjects: vi.fn(),
    listTags: vi.fn(),
    movePapersToTrash: vi.fn(),
    movePaperToTrash: vi.fn(),
    restorePapers: vi.fn(),
    restorePaper: vi.fn(),
    setPaperProjects: vi.fn(),
    setPaperTags: vi.fn(),
    unarchivePapers: vi.fn(),
    updateProject: vi.fn(),
}));

vi.mock('../../../domains/research/bridge', () => bridge);

import { useResearchLibrary } from './useResearchLibrary';

describe('论文库项目数据流', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        bridge.listPapers.mockResolvedValue([
            { id: 'paper-1', title: 'Flux', projects: [{ id: 'project-1', name: '代谢' }], tags: [] },
            { id: 'paper-2', title: 'Unsorted', projects: [], tags: [] },
        ]);
        bridge.listTags.mockResolvedValue([]);
        bridge.listProjects.mockResolvedValue([{ id: 'project-1', name: '代谢', color: '#8170df' }]);
        bridge.createProject.mockResolvedValue({ id: 'project-2', name: '蛋白质组学' });
        bridge.importPapers.mockResolvedValue([{ id: 'book-1', title: 'Chaos', contentKind: 'book' }]);
        bridge.archivePapers.mockResolvedValue(['paper-1']);
        bridge.unarchivePapers.mockResolvedValue(['paper-1']);
        bridge.movePapersToTrash.mockResolvedValue(['paper-1']);
        bridge.restorePapers.mockResolvedValue(['paper-1']);
        bridge.updateProject.mockResolvedValue({ id: 'project-1', name: '代谢网络' });
        bridge.setPaperProjects.mockResolvedValue([{ id: 'project-1', name: '代谢', color: '#8170df' }]);
    });

    it('并行加载项目并按项目筛选论文', async () => {
        const { result } = renderHook(() => useResearchLibrary());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.projects).toHaveLength(1);

        act(() => result.current.selectProject('project-1'));
        expect(result.current.visiblePapers.map((paper) => paper.id)).toEqual(['paper-1']);
        expect(result.current.view).toBe('all');
        expect(result.current.activeTagId).toBe('');
    });

    it('调用项目增改删与论文归类接口', async () => {
        const { result } = renderHook(() => useResearchLibrary());
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(() => result.current.addProject({ name: '蛋白质组学', color: '#4f83d8', description: '' }));
        expect(bridge.createProject).toHaveBeenCalledWith({
            name: '蛋白质组学',
            color: '#4f83d8',
            description: '',
        });

        await act(() =>
            result.current.editProject({ projectId: 'project-1', name: '代谢网络', color: '#8170df', description: '' })
        );
        expect(bridge.updateProject).toHaveBeenCalledWith('project-1', {
            name: '代谢网络',
            color: '#8170df',
            description: '',
        });

        await act(() => result.current.updatePaperProjects('paper-2', ['project-1']));
        expect(bridge.setPaperProjects).toHaveBeenCalledWith('paper-2', ['project-1']);
        expect(result.current.papers.find((paper) => paper.id === 'paper-2').projects).toHaveLength(1);

        act(() => result.current.setActiveProjectId('project-1'));
        await act(() => result.current.removeProject('project-1'));
        expect(bridge.deleteProject).toHaveBeenCalledWith('project-1');
        expect(result.current.activeProjectId).toBe('');
    });

    it('把论文或书籍类型原样传给导入 bridge', async () => {
        const { result } = renderHook(() => useResearchLibrary());
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(() => result.current.importPaths(['C:\\Books\\chaos.pdf'], 'book'));

        expect(bridge.importPapers).toHaveBeenCalledWith(['C:\\Books\\chaos.pdf'], 'book');
    });

    it('批量归档、取消归档、移到回收站和恢复均只提交一次并刷新列表', async () => {
        const { result } = renderHook(() => useResearchLibrary());
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(() => result.current.archivePapers(['paper-1']));
        await act(() => result.current.unarchivePapers(['paper-1']));
        await act(() => result.current.movePapersToTrash(['paper-1']));
        await act(() => result.current.restorePapers(['paper-1']));

        expect(bridge.archivePapers).toHaveBeenCalledOnce();
        expect(bridge.archivePapers).toHaveBeenCalledWith(['paper-1']);
        expect(bridge.unarchivePapers).toHaveBeenCalledWith(['paper-1']);
        expect(bridge.movePapersToTrash).toHaveBeenCalledWith(['paper-1']);
        expect(bridge.restorePapers).toHaveBeenCalledWith(['paper-1']);
        expect(bridge.listPapers).toHaveBeenCalledTimes(5);
    });

    it('批量操作失败会保留错误并继续向界面抛出', async () => {
        bridge.archivePapers.mockRejectedValueOnce(new Error('归档事务失败'));
        const { result } = renderHook(() => useResearchLibrary());
        await waitFor(() => expect(result.current.loading).toBe(false));
        let caught;

        await act(async () => {
            try {
                await result.current.archivePapers(['paper-1']);
            } catch (reason) {
                caught = reason;
            }
        });

        expect(caught).toMatchObject({ message: '归档事务失败' });
        expect(result.current.error).toContain('归档事务失败');
        expect(bridge.listPapers).toHaveBeenCalledOnce();
    });
});
