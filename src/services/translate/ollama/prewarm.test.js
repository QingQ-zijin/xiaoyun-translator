import test from 'node:test';
import assert from 'node:assert/strict';

import { prewarmOllamaTranslation } from './prewarm.js';

test('预热忽略旧配置模型，只让统一 Gemma 4 生成一个 token 并永久驻留', async () => {
    const calls = [];
    const result = await prewarmOllamaTranslation(
        {
            requestPath: 'http://127.0.0.1:11435/',
            model: 'translategemma:test-prewarm',
        },
        {
            createClient: (host) => ({
                chat: async (request) => calls.push({ host, request }),
            }),
        }
    );

    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].host, 'http://127.0.0.1:11435');
    assert.equal(calls[0].request.model, 'gemma4:e4b-it-qat');
    assert.deepEqual(calls[0].request.messages, [{ role: 'user', content: '.' }]);
    assert.equal(calls[0].request.stream, false);
    assert.equal(calls[0].request.think, false);
    assert.equal(calls[0].request.keep_alive, -1);
    assert.equal(calls[0].request.options.num_ctx, 8192);
    assert.equal(calls[0].request.options.num_predict, 1);
});

test('同一地址与模型的并发预热合并为一次请求', async () => {
    let calls = 0;
    let resolveRequest;
    const request = new Promise((resolve) => {
        resolveRequest = resolve;
    });
    const config = { requestPath: '127.0.0.1:11434', model: 'qwen3-vl:4b' };
    const options = {
        createClient: () => ({
            chat: (payload) => {
                calls++;
                assert.equal(payload.model, 'gemma4:e4b-it-qat');
                return request;
            },
        }),
    };

    const first = prewarmOllamaTranslation(config, options);
    const second = prewarmOllamaTranslation(config, options);
    assert.equal(calls, 1);
    assert.equal(first, second);
    resolveRequest({ done: true });
    assert.equal(await first, true);
});
