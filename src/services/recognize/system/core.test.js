import assert from 'node:assert/strict';
import test from 'node:test';

import { recognizeSystemImage, recognizeSystemScreenshot } from './core.js';

test('指定图像识别会把当前 base64 传给独立的原生命令', async () => {
    const calls = [];
    const result = await recognizeSystemImage('current-image-base64', 'zh_cn', {
        osType: 'Windows_NT',
        invokeCommand: async (command, args) => {
            calls.push({ command, args });
            return '中 文';
        },
        detectLanguage: async () => 'zh_cn',
    });

    assert.equal(result, '中文');
    assert.deepEqual(calls, [
        {
            command: 'system_ocr_base64',
            args: { image: 'current-image-base64', lang: 'zh-CN' },
        },
    ]);
});

test('旧的系统截图入口继续调用共享截图命令', async () => {
    const calls = [];
    await recognizeSystemScreenshot('en', {
        osType: 'Linux',
        invokeCommand: async (command, args) => {
            calls.push({ command, args });
            return 'text';
        },
        detectLanguage: async () => 'en',
    });

    assert.deepEqual(calls, [{ command: 'system_ocr', args: { lang: 'eng' } }]);
});

test('葡萄牙语规范键在三平台都映射为有效语言', async () => {
    const expectedLanguages = {
        Linux: 'por',
        Darwin: 'pt-PT',
        Windows_NT: 'pt-PT',
    };

    for (const [osType, expectedLanguage] of Object.entries(expectedLanguages)) {
        const calls = [];
        await recognizeSystemImage('image', 'pt_pt', {
            osType,
            invokeCommand: async (command, args) => {
                calls.push({ command, args });
                return 'texto';
            },
            detectLanguage: async () => 'pt_pt',
        });
        assert.equal(calls[0].args.lang, expectedLanguage);
    }
});
