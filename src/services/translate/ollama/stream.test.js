import test from 'node:test';
import assert from 'node:assert/strict';

import { createThrottledStreamWriter } from './stream.js';

test('流式首块立即显示，密集后续块合并到下一次刷新', () => {
    const values = [];
    const timers = [];
    let clock = 100;
    const writer = createThrottledStreamWriter((value) => values.push(value), {
        intervalMs: 32,
        now: () => clock,
        setTimer: (callback, delay) => {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimer: () => {},
    });

    writer.push('首');
    writer.push('首块');
    writer.push('首块译文');
    assert.deepEqual(values, ['首_']);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 32);

    clock += 32;
    timers[0].callback();
    assert.deepEqual(values, ['首_', '首块译文_']);
});

test('完成时取消待刷新并立即提交无光标的最终结果', () => {
    const values = [];
    const cleared = [];
    const writer = createThrottledStreamWriter((value) => values.push(value), {
        now: () => 100,
        setTimer: () => 7,
        clearTimer: (timer) => cleared.push(timer),
    });

    writer.push('a');
    writer.push('ab');
    writer.finish('ab');

    assert.deepEqual(values, ['a_', 'ab']);
    assert.deepEqual(cleared, [7]);
});

test('桌面流可以关闭中间光标装饰并保留首块立即显示', () => {
    const values = [];
    const writer = createThrottledStreamWriter((value) => values.push(value), {
        decorateIntermediate: false,
        setTimer: () => 1,
        clearTimer: () => {},
        now: () => 100,
    });

    writer.push('通');
    writer.push('通量');
    writer.finish('通量');

    assert.deepEqual(values, ['通', '通量']);
});
