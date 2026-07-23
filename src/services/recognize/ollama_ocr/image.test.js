import assert from 'node:assert/strict';
import test from 'node:test';

import { averageCornerColor, getOcrImageLayout } from './image.js';

test('小截图使用两倍放大和同比例边距，避免贴边小字被视觉模型漏掉', () => {
    assert.deepEqual(getOcrImageLayout(440, 286), {
        scale: 2,
        padding: 32,
        width: 944,
        height: 636,
    });
});

test('宽而矮的截图也使用两倍放大，保留反应箭头上下方的小号标签', () => {
    assert.deepEqual(getOcrImageLayout(1152, 244), {
        scale: 2,
        padding: 32,
        width: 2368,
        height: 552,
    });
});

test('大截图不继续放大，只增加轻量边距以限制视觉 token 和延迟', () => {
    assert.deepEqual(getOcrImageLayout(1200, 800), {
        scale: 1,
        padding: 16,
        width: 1232,
        height: 832,
    });
});

test('边距颜色取四角平均值以同时适配亮色与暗色截图', () => {
    assert.equal(
        averageCornerColor([
            [250, 250, 250, 255],
            [246, 248, 250, 255],
            [254, 252, 248, 255],
            [250, 250, 250, 255],
        ]),
        'rgb(250, 250, 250)'
    );
    assert.equal(
        averageCornerColor([
            [12, 12, 12, 255],
            [16, 14, 12, 255],
            [10, 12, 14, 255],
            [14, 14, 14, 255],
        ]),
        'rgb(13, 13, 13)'
    );
});
