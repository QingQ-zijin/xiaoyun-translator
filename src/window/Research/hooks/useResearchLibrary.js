import { useCallback, useEffect, useMemo, useState } from 'react';

import {
    archivePapers as archivePapersBridge,
    deletePaperPermanently,
    createProject,
    deleteProject,
    importPapers,
    listPapers,
    listProjects,
    listTags,
    movePapersToTrash as movePapersToTrashBridge,
    movePaperToTrash,
    restorePapers as restorePapersBridge,
    restorePaper,
    setPaperTags,
    setPaperProjects,
    unarchivePapers as unarchivePapersBridge,
    updateProject,
} from '../../../domains/research/bridge';
import { DEFAULT_PAPER_SORT, filterPapers, normalizePaperSort, sortPapers } from '../../../domains/research/model';

const PAPER_SORT_STORAGE_KEY = 'xiaoyun.research.paper-sort.v1';

function readPaperSortPreference() {
    try {
        return normalizePaperSort(globalThis.localStorage?.getItem(PAPER_SORT_STORAGE_KEY));
    } catch {
        return DEFAULT_PAPER_SORT;
    }
}

export function useResearchLibrary() {
    const [papers, setPapers] = useState([]);
    const [tags, setTags] = useState([]);
    const [projects, setProjects] = useState([]);
    const [query, setQuery] = useState('');
    const [view, setView] = useState('all');
    const [sortMode, setSortModeState] = useState(readPaperSortPreference);
    const [activeTagId, setActiveTagId] = useState('');
    const [activeProjectId, setActiveProjectId] = useState('');
    const [loading, setLoading] = useState(true);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const [nextPapers, nextTags, nextProjects] = await Promise.all([
                listPapers({ includeTrashed: true }),
                listTags(),
                listProjects(),
            ]);
            setPapers(nextPapers ?? []);
            setTags(nextTags ?? []);
            setProjects(nextProjects ?? []);
        } catch (reason) {
            setError(String(reason));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        try {
            globalThis.localStorage?.setItem(PAPER_SORT_STORAGE_KEY, sortMode);
        } catch {
            // WebView 禁用持久化时仍保留本次会话内的排序，不阻断论文库。
        }
    }, [sortMode]);

    const setSortMode = useCallback((value) => {
        setSortModeState(normalizePaperSort(value));
    }, []);

    const visiblePapers = useMemo(
        () =>
            sortPapers(filterPapers(papers, { query, view, tagId: activeTagId, projectId: activeProjectId }), sortMode),
        [activeProjectId, activeTagId, papers, query, sortMode, view]
    );

    const importPaths = useCallback(
        async (paths, contentKind = 'paper') => {
            if (importing) return [];
            setError('');
            setImporting(true);
            try {
                const imported = await importPapers(paths, contentKind);
                await refresh();
                return imported;
            } catch (reason) {
                await refresh();
                setError(String(reason));
                return [];
            } finally {
                setImporting(false);
            }
        },
        [importing, refresh]
    );

    const moveToTrash = useCallback(
        async (paperId) => {
            await movePaperToTrash(paperId);
            await refresh();
        },
        [refresh]
    );

    const restore = useCallback(
        async (paperId) => {
            await restorePaper(paperId);
            await refresh();
        },
        [refresh]
    );

    const deletePermanently = useCallback(
        async (paperId) => {
            await deletePaperPermanently(paperId);
            await refresh();
        },
        [refresh]
    );

    const runPaperBatch = useCallback(
        async (operation, paperIds) => {
            setError('');
            try {
                const updatedPaperIds = await operation(paperIds);
                await refresh();
                return updatedPaperIds;
            } catch (reason) {
                setError(String(reason));
                throw reason;
            }
        },
        [refresh]
    );

    const archivePapers = useCallback((paperIds) => runPaperBatch(archivePapersBridge, paperIds), [runPaperBatch]);

    const unarchivePapers = useCallback((paperIds) => runPaperBatch(unarchivePapersBridge, paperIds), [runPaperBatch]);

    const movePapersToTrash = useCallback(
        (paperIds) => runPaperBatch(movePapersToTrashBridge, paperIds),
        [runPaperBatch]
    );

    const restorePapers = useCallback((paperIds) => runPaperBatch(restorePapersBridge, paperIds), [runPaperBatch]);

    const updatePaperTags = useCallback(
        async (paperId, tagIds) => {
            await setPaperTags(paperId, tagIds);
            await refresh();
        },
        [refresh]
    );

    const addProject = useCallback(
        async (input) => {
            const created = await createProject(input);
            await refresh();
            return created;
        },
        [refresh]
    );

    const editProject = useCallback(
        async (input) => {
            const { projectId, ...changes } = input;
            const updated = await updateProject(projectId, changes);
            await refresh();
            return updated;
        },
        [refresh]
    );

    const removeProject = useCallback(
        async (projectId) => {
            await deleteProject(projectId);
            setActiveProjectId((current) => (current === projectId ? '' : current));
            await refresh();
        },
        [refresh]
    );

    const updatePaperProjects = useCallback(
        async (paperId, projectIds) => {
            const assignedProjects = await setPaperProjects(paperId, projectIds);
            const nextProjects = await listProjects();
            const selectedIds = new Set(projectIds.map(String));
            setProjects(nextProjects ?? []);
            setPapers((current) =>
                current.map((paper) =>
                    paper.id === paperId
                        ? {
                              ...paper,
                              projects:
                                  assignedProjects ?? projects.filter((project) => selectedIds.has(String(project.id))),
                          }
                        : paper
                )
            );
        },
        [projects]
    );

    const updatePaperProgress = useCallback((paperId, progress) => {
        setPapers((current) =>
            current.map((paper) =>
                paper.id === paperId ? { ...paper, progress: { ...paper.progress, ...progress } } : paper
            )
        );
    }, []);

    const markPaperOpened = useCallback((paperId) => {
        const timestamp = new Date().toISOString();
        setPapers((current) =>
            current.map((paper) => (paper.id === paperId ? { ...paper, lastOpenedAt: timestamp } : paper))
        );
    }, []);

    const selectProject = useCallback((projectId) => {
        setActiveProjectId(projectId);
        setActiveTagId('');
        setView('all');
    }, []);

    return {
        papers,
        visiblePapers,
        tags,
        projects,
        query,
        setQuery,
        view,
        setView,
        sortMode,
        setSortMode,
        activeTagId,
        setActiveTagId,
        activeProjectId,
        setActiveProjectId,
        selectProject,
        loading,
        importing,
        error,
        refresh,
        importPaths,
        moveToTrash,
        restore,
        deletePermanently,
        archivePapers,
        unarchivePapers,
        movePapersToTrash,
        restorePapers,
        updatePaperTags,
        addProject,
        editProject,
        removeProject,
        updatePaperProjects,
        updatePaperProgress,
        markPaperOpened,
    };
}
