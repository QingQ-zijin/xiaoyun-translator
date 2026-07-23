import test from 'node:test';
import assert from 'node:assert/strict';

import { createAbortableFetch } from './abort.js';

test('组件取消可在首 token 前中止 Ollama fetch', async () => {
    const requestController = new AbortController();
    const sdkController = new AbortController();
    let combinedSignal;
    const fetch = createAbortableFetch(requestController, async (_input, init) => {
        combinedSignal = init.signal;
        return { ok: true };
    });

    await fetch('http://localhost', { signal: sdkController.signal });
    assert.equal(combinedSignal.aborted, false);
    requestController.abort();
    assert.equal(combinedSignal.aborted, true);
});

test('Ollama SDK 的流取消仍能穿透组合信号', async () => {
    const requestController = new AbortController();
    const sdkController = new AbortController();
    let combinedSignal;
    const fetch = createAbortableFetch(requestController, async (_input, init) => {
        combinedSignal = init.signal;
        return { ok: true };
    });

    await fetch('http://localhost', { signal: sdkController.signal });
    sdkController.abort();
    assert.equal(combinedSignal.aborted, true);
});
