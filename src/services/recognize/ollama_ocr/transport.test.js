import assert from 'node:assert/strict';
import test from 'node:test';

import { createOllamaGenerateTransport } from './transport.js';

test('等待 Ollama 首个 HTTP 响应期间也能立即取消旧请求', async () => {
    let capturedSignal;
    let notifyFetchStarted;
    const fetchStarted = new Promise((resolve) => {
        notifyFetchStarted = resolve;
    });
    const fetchImpl = (_url, options) => {
        capturedSignal = options.signal;
        notifyFetchStarted();
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')));
        });
    };
    const transport = createOllamaGenerateTransport({ fetchImpl });
    const pending = transport.generate({ model: 'glm-ocr:latest', stream: true }, { host: 'localhost:11434' });

    await fetchStarted;
    transport.abort();

    await assert.rejects(pending, (error) => error.name === 'AbortError');
    assert.equal(capturedSignal.aborted, true);
});

test('按 NDJSON 边界解析 Ollama generate 流并保留分块响应', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode('{"response":"第一段","done":false}\n{"res'));
            controller.enqueue(encoder.encode('ponse":"第二段","done":false}\n'));
            controller.enqueue(encoder.encode('{"response":"","done":true,"done_reason":"stop"}\n'));
            controller.close();
        },
    });
    const calls = [];
    const transport = createOllamaGenerateTransport({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
        },
    });

    const request = { model: 'glm-ocr:latest', prompt: 'OCR:', images: ['CURRENT'], stream: true };
    const stream = await transport.generate(request, { host: 'http://localhost:11434/' });
    const parts = [];
    for await (const part of stream) parts.push(part);

    assert.deepEqual(parts, [
        { response: '第一段', done: false },
        { response: '第二段', done: false },
        { response: '', done: true, done_reason: 'stop' },
    ]);
    assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/generate');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), request);
});

test('Ollama HTTP 错误包含服务端错误信息', async () => {
    const transport = createOllamaGenerateTransport({
        fetchImpl: async () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }),
    });

    await assert.rejects(
        transport.generate({ model: 'missing', stream: true }, { host: 'http://localhost:11434' }),
        /model not found/u
    );
});

test('桌面生产环境通过 Tauri 后端发送视觉请求，避免 WebView 跨域', async () => {
    const calls = [];
    const request = { model: 'qwen3-vl:4b-instruct-q4_K_M', images: ['CURRENT'], stream: true };
    const transport = createOllamaGenerateTransport({
        desktopRuntime: true,
        fetchImpl: () => assert.fail('桌面 OCR 不得直接使用 WebView fetch'),
        requestIdFactory: () => 'vision-fixed-id',
        invokeImpl: async (command, payload) => {
            calls.push({ command, payload });
            return { response: '当前截图', done: true, done_reason: 'stop' };
        },
    });

    const stream = await transport.generate(request, { host: 'http://localhost:11435' });
    const parts = [];
    for await (const part of stream) parts.push(part);

    assert.deepEqual(parts, [{ response: '当前截图', done: true, done_reason: 'stop' }]);
    assert.deepEqual(calls, [
        {
            command: 'ollama_vision_generate',
            payload: { requestId: 'vision-fixed-id', request },
        },
    ]);
});

test('桌面视觉请求等待后端时可取消，并通知 Rust 丢弃正在等待的 HTTP 请求', async () => {
    let finishGenerate;
    const calls = [];
    const transport = createOllamaGenerateTransport({
        desktopRuntime: true,
        requestIdFactory: () => 'vision-cancel-id',
        invokeImpl: (command, payload) => {
            calls.push({ command, payload });
            if (command === 'ollama_vision_generate') {
                return new Promise((resolve) => {
                    finishGenerate = resolve;
                });
            }
            return Promise.resolve(true);
        },
    });

    const pending = transport.generate({ images: ['CURRENT'] }, { host: 'unused' });
    transport.abort();
    finishGenerate({ response: '不应展示的旧截图', done: true });

    await assert.rejects(pending, (error) => error.name === 'AbortError');
    assert.deepEqual(calls[1], {
        command: 'cancel_ollama_vision_request',
        payload: { requestId: 'vision-cancel-id' },
    });
});

test('桌面后端网络错误转换为可理解的中文提示', async () => {
    const transport = createOllamaGenerateTransport({
        desktopRuntime: true,
        invokeImpl: async () => {
            throw new TypeError('Failed to fetch');
        },
    });

    await assert.rejects(transport.generate({ images: ['CURRENT'] }, { host: 'unused' }), /无法连接本地 Ollama/u);
});
