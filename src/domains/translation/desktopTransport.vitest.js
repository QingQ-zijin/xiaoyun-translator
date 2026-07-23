import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isTauriRuntime, normalizeDesktopTranslationError, translateWithDesktopBackend } from './desktopTransport';

const TAURI_MARKERS = ['__TAURI__', '__TAURI_METADATA__', '__TAURI_INTERNALS__'];

function clearTauriMarkers() {
    for (const marker of TAURI_MARKERS) delete window[marker];
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

function createChannelHarness() {
    const channel = { onmessage: undefined };
    return {
        channel,
        createChannel: vi.fn(() => channel),
        send(message) {
            channel.onmessage?.(message);
        },
    };
}

beforeEach(clearTauriMarkers);
afterEach(() => {
    vi.useRealTimers();
    clearTauriMarkers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('桌面翻译运行环境', () => {
    it('只存在 Tauri 2 的 __TAURI_INTERNALS__ 时仍识别为桌面运行环境', () => {
        expect(isTauriRuntime()).toBe(false);
        window.__TAURI_INTERNALS__ = {};
        expect(isTauriRuntime()).toBe(true);
    });

    it.each(['__TAURI__', '__TAURI_METADATA__'])('%s 标记同样可识别', (marker) => {
        window[marker] = {};
        expect(isTauriRuntime()).toBe(true);
    });
});

describe('桌面翻译错误文案', () => {
    it('把浏览器网络错误转换为可操作的中文提示', () => {
        expect(normalizeDesktopTranslationError(new TypeError('Failed to fetch'), '论文划词翻译')).toBe(
            '论文划词翻译失败：无法连接本地翻译服务，请确认 Ollama 正在运行。'
        );
        expect(normalizeDesktopTranslationError('NetworkError when attempting to fetch resource', '学术翻译')).toBe(
            '学术翻译失败：无法连接本地翻译服务，请确认 Ollama 正在运行。'
        );
    });

    it('把未知命令转换为明确的升级提示', () => {
        expect(
            normalizeDesktopTranslationError(
                new Error('Command research_translate_selection not found'),
                '论文划词翻译'
            )
        ).toBe('当前程序后端不支持论文划词翻译，请安装最新版本后重试。');
    });

    it('保留后端详情，同时去掉技术错误前缀和重复业务前缀', () => {
        expect(normalizeDesktopTranslationError(new Error('论文划词翻译失败：HTTP 500'), '论文划词翻译')).toBe(
            '论文划词翻译失败：HTTP 500'
        );
        expect(normalizeDesktopTranslationError(new Error('model is unavailable'), '学术翻译')).toBe(
            '学术翻译失败：model is unavailable'
        );
        expect(normalizeDesktopTranslationError(null, '学术翻译')).toBe('学术翻译失败：本地翻译服务没有返回错误详情。');
    });
});

describe('桌面翻译调用', () => {
    const payload = {
        text: 'translation into the clinic',
        pageNumber: 3,
        paperTitle: 'Drug Delivery',
        contextBefore: 'before',
        contextAfter: 'after',
        sourceLanguage: 'auto',
        targetLanguage: 'zh_cn',
    };

    it('在 Tauri 宿主中默认创建真实 Channel 并接收流事件', async () => {
        const deferred = createDeferred();
        const invokeCommand = vi.fn().mockReturnValue(deferred.promise);
        const onDelta = vi.fn();
        let tauriCallback;
        window.__TAURI_INTERNALS__ = {
            transformCallback: vi.fn((callback) => {
                tauriCallback = callback;
                return 7;
            }),
            unregisterCallback: vi.fn(),
        };

        const pending = translateWithDesktopBackend({ invokeCommand, payload, onDelta });
        const [, request] = invokeCommand.mock.calls[0];
        tauriCallback({
            index: 0,
            message: { requestId: request.requestId, event: 'delta', text: '流式译文' },
        });
        deferred.resolve({ text: '流式译文' });

        await expect(pending).resolves.toBe('流式译文');
        expect(onDelta).toHaveBeenCalledWith('流式译文');
        expect(request.onEvent.id).toBe(7);
    });

    it('通过 Channel 立即上报多次增量，并用最终结果补齐译文', async () => {
        vi.useFakeTimers();
        const deferred = createDeferred();
        const invokeCommand = vi.fn().mockReturnValue(deferred.promise);
        const onDelta = vi.fn();
        const stream = createChannelHarness();

        const pending = translateWithDesktopBackend({
            invokeCommand,
            payload,
            onDelta,
            label: '论文划词翻译',
            createChannel: stream.createChannel,
        });
        expect(invokeCommand).toHaveBeenCalledOnce();
        const [, request] = invokeCommand.mock.calls[0];
        expect(request).toMatchObject(payload);
        expect(request.requestId).toMatch(/^translation-/u);
        expect(request.onEvent).toBe(stream.channel);

        stream.send({ requestId: request.requestId, event: 'delta', delta: '临', text: '临' });
        stream.send({ requestId: request.requestId, event: 'delta', delta: '床', text: '临床' });
        expect(onDelta.mock.calls).toEqual([['临']]);
        await vi.advanceTimersByTimeAsync(24);
        expect(onDelta.mock.calls).toEqual([['临'], ['临床']]);

        deferred.resolve({ text: '临床转化' });
        await expect(pending).resolves.toBe('临床转化');
        expect(onDelta.mock.calls).toEqual([['临'], ['临床'], ['临床转化']]);
    });

    it('兼容后端直接返回字符串', async () => {
        const invokeCommand = vi.fn().mockResolvedValue('直接译文');
        const stream = createChannelHarness();
        await expect(
            translateWithDesktopBackend({ invokeCommand, payload, createChannel: stream.createChannel })
        ).resolves.toBe('直接译文');
    });

    it('请求开始前已取消时不调用后端', async () => {
        const controller = new AbortController();
        const invokeCommand = vi.fn();
        const stream = createChannelHarness();
        controller.abort();

        await expect(
            translateWithDesktopBackend({
                invokeCommand,
                payload,
                signal: controller.signal,
                createChannel: stream.createChannel,
            })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(invokeCommand).not.toHaveBeenCalled();
        expect(stream.createChannel).not.toHaveBeenCalled();
    });

    it('缺少 DOMException 的宿主仍返回标准 AbortError', async () => {
        const controller = new AbortController();
        const invokeCommand = vi.fn();
        const stream = createChannelHarness();
        controller.abort();
        vi.stubGlobal('DOMException', undefined);

        await expect(
            translateWithDesktopBackend({
                invokeCommand,
                payload,
                signal: controller.signal,
                createChannel: stream.createChannel,
            })
        ).rejects.toMatchObject({ name: 'AbortError', message: 'Translation cancelled' });
        expect(invokeCommand).not.toHaveBeenCalled();
    });

    it('请求发出后取消时通知 Rust，并丢弃迟到的流事件与最终结果', async () => {
        const deferred = createDeferred();
        const invokeCommand = vi.fn((command) => {
            if (command === 'research_translate_selection') return deferred.promise;
            return Promise.resolve();
        });
        const onDelta = vi.fn();
        const controller = new AbortController();
        const stream = createChannelHarness();
        const pending = translateWithDesktopBackend({
            invokeCommand,
            payload,
            onDelta,
            signal: controller.signal,
            createChannel: stream.createChannel,
        });

        expect(invokeCommand).toHaveBeenCalledOnce();
        const [, request] = invokeCommand.mock.calls[0];
        controller.abort();
        expect(invokeCommand).toHaveBeenCalledWith('research_cancel_translation', {
            requestId: request.requestId,
        });
        stream.send({ requestId: request.requestId, event: 'delta', text: '过期流译文' });
        deferred.resolve({ text: '过期译文' });

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        stream.send({ requestId: request.requestId, event: 'delta', text: '更晚的译文' });
        expect(onDelta).not.toHaveBeenCalled();
    });

    it('忽略其他请求的事件，并在完成后隔离迟到消息', async () => {
        const deferred = createDeferred();
        const invokeCommand = vi.fn().mockReturnValue(deferred.promise);
        const onDelta = vi.fn();
        const stream = createChannelHarness();
        const pending = translateWithDesktopBackend({
            invokeCommand,
            payload,
            onDelta,
            createChannel: stream.createChannel,
        });
        const [, request] = invokeCommand.mock.calls[0];

        stream.send({ requestId: 'translation-obsolete', event: 'delta', text: '不应出现' });
        stream.send({ requestId: request.requestId, event: 'delta', text: '正确译文' });
        deferred.resolve({ text: '正确译文' });

        await expect(pending).resolves.toBe('正确译文');
        stream.send({ requestId: request.requestId, event: 'delta', text: '完成后的迟到译文' });
        expect(onDelta.mock.calls).toEqual([['正确译文']]);
    });

    it('保留后端 AbortError，不把主动取消显示为失败', async () => {
        const abortError = new DOMException('Translation cancelled', 'AbortError');
        const invokeCommand = vi.fn().mockRejectedValue(abortError);
        const stream = createChannelHarness();
        await expect(
            translateWithDesktopBackend({ invokeCommand, payload, createChannel: stream.createChannel })
        ).rejects.toBe(abortError);
    });

    it('拒绝空译文并返回业务化错误', async () => {
        const invokeCommand = vi.fn().mockResolvedValue({ text: '   ' });
        const stream = createChannelHarness();
        await expect(
            translateWithDesktopBackend({
                invokeCommand,
                payload,
                label: '论文划词翻译',
                createChannel: stream.createChannel,
            })
        ).rejects.toThrow('论文划词翻译失败：Gemma 4 E4B 返回了空译文');
    });

    it('把 invoke 的网络失败和未知命令转换为中文错误', async () => {
        const networkInvoke = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
        const networkStream = createChannelHarness();
        await expect(
            translateWithDesktopBackend({
                invokeCommand: networkInvoke,
                payload,
                label: '论文划词翻译',
                createChannel: networkStream.createChannel,
            })
        ).rejects.toThrow('论文划词翻译失败：无法连接本地翻译服务，请确认 Ollama 正在运行。');

        const missingCommandInvoke = vi
            .fn()
            .mockRejectedValue(new Error('unknown command research_translate_selection'));
        const missingCommandStream = createChannelHarness();
        await expect(
            translateWithDesktopBackend({
                invokeCommand: missingCommandInvoke,
                payload,
                label: '论文划词翻译',
                createChannel: missingCommandStream.createChannel,
            })
        ).rejects.toThrow('当前程序后端不支持论文划词翻译，请安装最新版本后重试。');
    });
});
