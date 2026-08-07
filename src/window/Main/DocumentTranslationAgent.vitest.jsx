import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    choose: vi.fn(),
    importPapers: vi.fn(),
    getDocument: vi.fn(),
    show: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    reset: vi.fn(),
    exportPdf: vi.fn(),
    setTargetLanguage: vi.fn(),
    setIncludeOriginal: vi.fn(),
}));

vi.mock('../../domains/research/bridge', () => ({
    chooseDocumentTranslationPath: mocks.choose,
    importPapers: mocks.importPapers,
    getDocument: mocks.getDocument,
    subscribeToDocumentDrops: vi.fn(async () => () => {}),
}));

vi.mock('../Research/hooks/useDocumentTranslationTask', () => ({
    useDocumentTranslationTask: () => ({
        task: { status: 'idle', totalPages: 0, completedPages: 0, partialText: '', error: '' },
        targetLanguage: 'zh_cn',
        includeOriginal: true,
        show: mocks.show,
        start: mocks.start,
        pause: mocks.pause,
        reset: mocks.reset,
        exportPdf: mocks.exportPdf,
        setTargetLanguage: mocks.setTargetLanguage,
        setIncludeOriginal: mocks.setIncludeOriginal,
    }),
}));

import DocumentTranslationAgent from './DocumentTranslationAgent';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.choose.mockResolvedValue('C:\\Papers\\example.pdf');
    mocks.importPapers.mockResolvedValue([{ id: 'paper-agent' }]);
    mocks.getDocument.mockResolvedValue({
        documentType: 'pdf',
        sourceFormat: 'pdf',
        pageCount: 18,
        paper: { id: 'paper-agent', title: 'Agent Paper', pageCount: 18 },
    });
});

afterEach(cleanup);

describe('翻译主页文档 Agent', () => {
    it('从醒目的拖放界面导入文件，并展示保真输出和开始按钮', async () => {
        render(
            <DocumentTranslationAgent
                modelName='gemma4:e4b'
                desktop={false}
            />
        );

        expect(screen.getByText('拖入整篇文件，得到完整译文 PDF')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '选择文件' }));

        expect(await screen.findByText('Agent Paper')).toBeTruthy();
        expect(screen.getByText('原版保真 + 译文')).toBeTruthy();
        expect(screen.getByText(/原页面、图片、链接全部保留/u)).toBeTruthy();
        expect(mocks.importPapers).toHaveBeenCalledWith(['C:\\Papers\\example.pdf'], 'paper');
        await waitFor(() => expect(mocks.show).toHaveBeenCalled());

        fireEvent.click(screen.getByRole('button', { name: '开始完整翻译' }));
        expect(mocks.start).toHaveBeenCalledOnce();
    });
});
