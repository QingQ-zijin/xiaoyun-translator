export const DEMO_TAGS = Object.freeze([
    { id: 'neuroscience', name: '神经科学', color: '#7664e9' },
    { id: 'methods', name: '方法学', color: '#e1ad42' },
    { id: 'reading', name: '待读', color: '#5c8ee6' },
]);

export const DEMO_PAPERS = Object.freeze([
    {
        id: 'demo-memory',
        title: 'Hippocampal Subfield Contributions to Memory',
        authors: 'Zhang, Chen & Wilson',
        year: 2021,
        journal: 'Nature Neuroscience',
        pageCount: 16,
        updatedAt: '2026-07-19T07:20:00Z',
        progress: { pageNumber: 2, scale: 1.25, scrollRatio: 0.08 },
        tags: [DEMO_TAGS[0]],
    },
    {
        id: 'demo-metabolism',
        title: 'Dynamic Isotope Tracing Resolves Cellular Metabolic Flux',
        authors: 'Liu et al.',
        year: 2025,
        journal: 'Cell Metabolism',
        pageCount: 22,
        updatedAt: '2026-07-18T12:10:00Z',
        progress: { pageNumber: 7, scale: 1.1, scrollRatio: 0.31 },
        tags: [DEMO_TAGS[1], DEMO_TAGS[2]],
    },
    {
        id: 'demo-protein',
        title: 'Protein Design with Compact Multimodal Models',
        authors: 'Park et al.',
        year: 2026,
        journal: 'Nature Methods',
        pageCount: 11,
        updatedAt: '2026-07-12T03:42:00Z',
        progress: { pageNumber: 1, scale: 1.25, scrollRatio: 0 },
        tags: [],
    },
]);

export const DEMO_DOCUMENT = Object.freeze({
    paper: DEMO_PAPERS[0],
    path: '',
    pageCount: 16,
    progress: DEMO_PAPERS[0].progress,
    outline: [
        { title: '摘要', pageNumber: 1, level: 0 },
        { title: '1. Introduction', pageNumber: 2, level: 0 },
        { title: '2. Methods', pageNumber: 4, level: 0 },
        { title: '2.1 Participants', pageNumber: 4, level: 1 },
        { title: '2.2 fMRI Acquisition', pageNumber: 5, level: 1 },
        { title: '2.3 Data Analysis', pageNumber: 6, level: 1 },
        { title: '3. Results', pageNumber: 8, level: 0 },
        { title: '4. Discussion', pageNumber: 12, level: 0 },
        { title: 'References', pageNumber: 16, level: 0 },
    ],
});

export const DEMO_PAGE = Object.freeze({
    heading: '1. Introduction',
    before: 'The hippocampus is essential for episodic memory and spatial navigation. Recent evidence suggests that its subfields—dentate gyrus (DG), CA3, CA1, and subiculum—play distinct roles in the encoding, storage, and retrieval of memories.',
    selected:
        'The hippocampus plays a critical role in forming and retrieving declarative memories. Emerging findings indicate that its subfields contribute differentially to these processes. In particular, the dentate gyrus (DG) is thought to support pattern separation, whereas CA3 is implicated in pattern completion. CA1 is proposed to integrate input from CA3 and convey information to cortical regions, and the subiculum serves as a primary output structure of the hippocampus. However, the precise functional contributions of these subfields in humans remain incompletely understood.',
    after: 'In the present study, we used high-resolution 7T fMRI and advanced analysis techniques to examine activity patterns of hippocampal subfields during memory encoding and retrieval tasks in healthy adults. We hypothesized that DG would show greater activity during encoding of novel items, whereas CA3 would exhibit greater activity during retrieval of previously learned associations.',
});

export const DEMO_ANNOTATIONS = Object.freeze([
    {
        id: 'demo-annotation-1',
        paperId: 'demo-memory',
        pageNumber: 2,
        quote: 'The hippocampus plays a critical role in forming and retrieving declarative memories.',
        color: 'violet',
        note: '',
        createdAt: '2026-07-19T07:22:00Z',
    },
    {
        id: 'demo-annotation-2',
        paperId: 'demo-memory',
        pageNumber: 3,
        quote: 'Figure 1: Hippocampal subfields segmented on a 7T T2-weighted image.',
        color: 'amber',
        note: '与方法部分的分区标准对照阅读。',
        createdAt: '2026-07-19T07:14:00Z',
    },
    {
        id: 'demo-annotation-3',
        paperId: 'demo-memory',
        pageNumber: 2,
        quote: 'pattern separation',
        color: 'blue',
        note: '',
        createdAt: '2026-07-19T07:07:00Z',
    },
]);

export const DEMO_TRANSLATION =
    '海马体在陈述性记忆的形成与提取中发挥关键作用。越来越多的研究发现，其不同亚区在这些过程中承担着不同功能。具体而言，齿状回（DG）被认为支持模式分离，而 CA3 参与模式补全。CA1 整合来自 CA3 的输入，并将信息传递至皮层区域；海马下托则是海马体的主要输出结构。然而，人们对这些亚区在人体中的精确功能贡献仍缺乏完整认识。';
