import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    buildOllamaOcrRequest,
    DEFAULT_OLLAMA_OCR_MODEL,
    normalizeOllamaHost,
    resolveOllamaOcrPrompt,
} from './core.js';

test('Ollama 本机地址统一到原生回环端口，并保留自定义远程地址', () => {
    assert.equal(normalizeOllamaHost(' localhost:11434/// '), 'http://127.0.0.1:11434');
    assert.equal(normalizeOllamaHost('http://localhost:11435/'), 'http://127.0.0.1:11434');
    assert.equal(normalizeOllamaHost('https://127.0.0.1:11435'), 'http://127.0.0.1:11434');
    assert.equal(normalizeOllamaHost('http://[::1]:11434/'), 'http://127.0.0.1:11434');
    assert.equal(normalizeOllamaHost('https://ocr.example.test/api/'), 'https://ocr.example.test/api');
    assert.equal(normalizeOllamaHost('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
});

test('每次请求只包含当前图片并强制统一 Gemma 4，不携带历史消息或 context', () => {
    const first = buildOllamaOcrRequest({
        model: 'paddleocr-vl:1.6',
        image: 'FIRST_IMAGE_BASE64',
    });
    const firstSnapshot = structuredClone(first);
    const second = buildOllamaOcrRequest({
        model: 'paddleocr-vl:1.6',
        image: 'SECOND_IMAGE_BASE64',
    });

    assert.deepEqual(first, firstSnapshot, '构造下一次请求不得修改上一次请求');
    assert.notStrictEqual(first.images, second.images, '两次请求不得共享 images 数组');
    assert.equal(second.model, DEFAULT_OLLAMA_OCR_MODEL);
    assert.match(second.prompt, /Perform exact OCR/u);
    assert.deepEqual(second.images, ['SECOND_IMAGE_BASE64']);
    assert.equal(Object.hasOwn(second, 'messages'), false);
    assert.equal(Object.hasOwn(second, 'context'), false);
    assert.equal(JSON.stringify(second).includes('FIRST_IMAGE_BASE64'), false);
    assert.equal(JSON.stringify(first).includes('SECOND_IMAGE_BASE64'), false);
});

test('OCR 请求固定采用可中止流、受限上下文和确定性生成参数', () => {
    const request = buildOllamaOcrRequest({
        model: DEFAULT_OLLAMA_OCR_MODEL,
        image: 'CURRENT_IMAGE_BASE64',
    });

    assert.equal(request.model, DEFAULT_OLLAMA_OCR_MODEL);
    assert.equal(request.stream, true);
    assert.equal(request.think, false);
    assert.equal(request.keep_alive, -1);
    assert.match(request.prompt, /Perform exact OCR on the entire image in visual reading order/u);
    assert.match(request.prompt, /without correcting, translating, explaining, or guessing/u);
    assert.deepEqual(request.images, ['CURRENT_IMAGE_BASE64']);
    assert.equal(request.options?.temperature, 0);
    assert.equal(request.options?.seed, 42);
    assert.equal(request.options?.num_ctx, 8192);
    assert.equal(request.options?.num_predict, 2048);
    assert.ok(request.options?.repeat_penalty > 1, '必须降低模型从头重复整段 OCR 的概率');

    const intermediateFormulaRequest = buildOllamaOcrRequest({
        model: DEFAULT_OLLAMA_OCR_MODEL,
        image: 'FORMULA_IMAGE_BASE64',
        mode: 'formula',
        keepAlive: '5s',
    });
    assert.equal(intermediateFormulaRequest.keep_alive, -1);
    assert.equal(request.keep_alive, -1, '公式候选的覆盖值不得污染其他请求');
});

test('默认使用统一 Gemma 4，并按模型与任务选择适配提示词', () => {
    assert.equal(DEFAULT_OLLAMA_OCR_MODEL, 'gemma4:e4b-it-qat');
    assert.match(resolveOllamaOcrPrompt(DEFAULT_OLLAMA_OCR_MODEL, 'auto'), /exact OCR/u);
    assert.match(
        resolveOllamaOcrPrompt(DEFAULT_OLLAMA_OCR_MODEL, 'formula'),
        /one KaTeX-compatible \$\$\.\.\.\$\$ block/u
    );
    assert.match(resolveOllamaOcrPrompt(DEFAULT_OLLAMA_OCR_MODEL, 'table'), /Markdown table/u);
    assert.equal(resolveOllamaOcrPrompt('paddleocr-vl:1.6', 'auto'), 'OCR:');
    assert.equal(resolveOllamaOcrPrompt('paddleocr-vl:1.6', 'formula'), 'Formula Recognition:');
    assert.equal(resolveOllamaOcrPrompt('paddleocr-vl:1.6', 'table'), 'Table Recognition:');
    assert.equal(resolveOllamaOcrPrompt('glm-ocr:latest', 'auto'), 'Text Recognition:');
    assert.equal(resolveOllamaOcrPrompt('glm-ocr:latest', 'formula'), 'Formula Recognition:');
    assert.equal(resolveOllamaOcrPrompt('unknown-vision-model', 'auto'), 'OCR:');
});
