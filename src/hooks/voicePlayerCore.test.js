import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeechRequestGate, createVoicePlayer } from './voicePlayerCore.js';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

const createAudioContext = () => {
    const decodes = [];
    const sources = [];
    return {
        state: 'running',
        destination: {},
        decodes,
        sources,
        decodeAudioData() {
            const operation = deferred();
            decodes.push(operation);
            return operation.promise;
        },
        createBufferSource() {
            const source = {
                started: false,
                stopped: false,
                connect() {},
                disconnect() {},
                start() {
                    this.started = true;
                },
                stop() {
                    this.stopped = true;
                },
                onended: null,
            };
            sources.push(source);
            return source;
        },
    };
};

test('解码未完成时再次点击会取消旧请求，旧音频不得迟到播放', async () => {
    const context = createAudioContext();
    const playOrStop = createVoicePlayer(() => context);

    const first = playOrStop([1, 2, 3]);
    const second = await playOrStop([1, 2, 3]);
    context.decodes[0].resolve({ decoded: true });

    assert.equal(await first, false);
    assert.equal(second, false);
    assert.equal(context.sources.length, 0);
});

test('播放中再次点击会停止当前音频，之后仍可重新播放', async () => {
    const context = createAudioContext();
    const playOrStop = createVoicePlayer(() => context);

    const first = playOrStop(new Uint8Array([1, 2, 3]));
    context.decodes[0].resolve({ decoded: true });
    assert.equal(await first, true);
    assert.equal(context.sources[0].started, true);

    assert.equal(await playOrStop([1, 2, 3]), false);
    assert.equal(context.sources[0].stopped, true);

    const third = playOrStop([1, 2, 3]);
    context.decodes[1].resolve({ decodedAgain: true });
    assert.equal(await third, true);
    assert.equal(context.sources[1].started, true);
});

test('A 请求慢、B 请求快时，只允许较新的 B 响应进入播放器', async () => {
    const played = [];
    const gate = createSpeechRequestGate((audio) => played.push(audio));
    const slowA = deferred();
    const fastB = deferred();

    const requestA = gate.run(() => slowA.promise);
    const requestB = gate.run(() => fastB.promise);
    fastB.resolve('B');
    assert.equal(await requestB, true);
    slowA.resolve('A');
    assert.equal(await requestA, false);

    assert.deepEqual(played, ['B']);
});

test('已经过期的朗读请求即使稍后失败，也不再弹出错误', async () => {
    const played = [];
    const gate = createSpeechRequestGate((audio) => played.push(audio));
    const slowA = deferred();

    const requestA = gate.run(() => slowA.promise);
    const requestB = gate.run(async () => 'B');
    assert.equal(await requestB, true);
    slowA.reject(new Error('旧请求失败'));

    assert.equal(await requestA, false);
    assert.deepEqual(played, ['B']);
});

test('词典即时发音会废弃仍在等待的源文或译文朗读', async () => {
    const played = [];
    const gate = createSpeechRequestGate((audio) => played.push(audio));
    const slowRequest = deferred();

    const pending = gate.run(() => slowRequest.promise);
    await gate.play('dictionary');
    slowRequest.resolve('stale-translation');

    assert.equal(await pending, false);
    assert.deepEqual(played, ['dictionary']);
});
