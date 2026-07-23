import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cancel: vi.fn(),
    invoke: vi.fn(),
    recognize: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../services/recognize/ollama_ocr', () => ({
    cancelOllamaOcrRecognition: mocks.cancel,
    recognize: mocks.recognize,
}));

import { extractText } from './index';

describe('截图 OCR 领域接口', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.invoke.mockResolvedValue({
            ollama: {
                vision: {
                    requestPath: 'http://127.0.0.1:11434',
                    model: 'gemma4:e4b-it-qat',
                },
            },
        });
    });

    it('把当前截图与配置交给唯一的视觉识别管线', async () => {
        mocks.recognize.mockResolvedValue('当前截图文字');

        await expect(extractText({ image: 'CURRENT_IMAGE', mode: 'formula' })).resolves.toBe('当前截图文字');
        expect(mocks.recognize).toHaveBeenCalledWith('CURRENT_IMAGE', 'auto', {
            config: expect.objectContaining({
                mode: 'formula',
                fallbackToSystem: false,
                model: 'gemma4:e4b-it-qat',
            }),
            onResultMetadata: undefined,
        });
    });

    it('忽略旧视觉模型配置，始终交给统一 Gemma 4', async () => {
        mocks.invoke.mockResolvedValue({
            ollama: {
                vision: {
                    requestPath: 'http://127.0.0.1:11434',
                    model: 'qwen3-vl:4b-instruct-q4_K_M',
                },
            },
        });
        mocks.recognize.mockResolvedValue('统一模型结果');

        await extractText({ image: 'CURRENT_IMAGE' });

        expect(mocks.recognize).toHaveBeenCalledWith(
            'CURRENT_IMAGE',
            'auto',
            expect.objectContaining({
                config: expect.objectContaining({ model: 'gemma4:e4b-it-qat' }),
            })
        );
    });

    it('取消信号会停止实际 OCR 请求，旧结果不能继续提交', async () => {
        let finishRecognition;
        let notifyStarted;
        const started = new Promise((resolve) => {
            notifyStarted = resolve;
        });
        mocks.recognize.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finishRecognition = resolve;
                    notifyStarted();
                })
        );
        const controller = new AbortController();
        const pending = extractText({ image: 'CURRENT_IMAGE', signal: controller.signal });

        await started;
        controller.abort();
        finishRecognition('不应展示的旧截图');

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.cancel).toHaveBeenCalledTimes(1);
    });

    it('请求开始前已经取消时不启动视觉模型', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(extractText({ image: 'CURRENT_IMAGE', signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(mocks.recognize).not.toHaveBeenCalled();
    });
});
