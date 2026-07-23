import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Ollama OCR 注册到前端识别服务与 Rust 重启白名单', async () => {
    const [registry, rustConfig] = await Promise.all([
        read('../index.jsx'),
        read('../../../../src-tauri/src/config.rs'),
    ]);

    assert.match(registry, /import \* as _ollama_ocr from ['"]\.\/ollama_ocr['"]/u);
    assert.match(registry, /export const ollama_ocr = _ollama_ocr;/u);
    assert.match(rustConfig, /"ollama_ocr"/u);
});

test('服务声明结构化输出、Ollama 图标和全部全局语言', async () => {
    const info = await read('./info.ts');
    const languages = [
        'auto',
        'zh_cn',
        'zh_tw',
        'mn_mo',
        'en',
        'ja',
        'ko',
        'fr',
        'es',
        'ru',
        'de',
        'it',
        'tr',
        'pt_pt',
        'pt_br',
        'vi',
        'id',
        'th',
        'ms',
        'ar',
        'hi',
        'km',
        'mn_cy',
        'nb_no',
        'nn_no',
        'fa',
        'sv',
        'pl',
        'nl',
        'uk',
        'he',
    ];

    assert.match(info, /name:\s*['"]ollama_ocr['"]/u);
    assert.match(info, /icon:\s*['"]logo\/ollama\.png['"]/u);
    assert.match(info, /structuredOutput:\s*true/u);
    for (const language of languages) {
        assert.match(info, new RegExp(`\\b${language}\\s*=\\s*['"]${language}['"]`, 'u'), language);
    }
});

test('配置页默认统一 Gemma 4 多模态模型并暴露地址、模型、识别模式和系统回退', async () => {
    const config = await read('./Config.jsx');

    assert.match(config, /model:\s*DEFAULT_OLLAMA_OCR_MODEL/u);
    assert.match(config, /mode:\s*DEFAULT_OLLAMA_OCR_MODE/u);
    assert.match(config, /requestPath:\s*DEFAULT_OLLAMA_OCR_HOST/u);
    assert.match(config, /fallbackToSystem:\s*true/u);
    assert.match(config, /checkOllamaOcrModel/u);
    assert.match(config, /gemma4:e4b-it-qat/u);
    assert.doesNotMatch(config, /\.pull\(/u, '配置页不得隐式下载大模型');
});

test('运行服务使用 generate 单图管线而不是带历史的 chat', async () => {
    const service = await read('./index.jsx');

    assert.match(service, /buildOllamaOcrRequest/u);
    assert.match(service, /preprocessOcrImage/u);
    assert.match(service, /createOllamaOcrPipeline/u);
    assert.match(service, /generate:\s*transport\.generate/u);
    assert.doesNotMatch(service, /\.chat\(/u);
    assert.match(service, /document_multimodal/u);
    assert.doesNotMatch(service, /route:\s*['"]auto_text['"]/u);
});

test('运行服务使用可在首响应前取消的传输层，配置检查不与入口循环依赖', async () => {
    const [service, config] = await Promise.all([read('./index.jsx'), read('./Config.jsx')]);

    assert.match(service, /createOllamaGenerateTransport/u);
    assert.doesNotMatch(service, /activeClient/u);
    assert.match(config, /from ['"]\.\/client['"]/u);
    assert.doesNotMatch(config, /from ['"]\.\/index['"]/u);
});

test('识别窗口监听实例配置变更，保存模型或地址后无需重启窗口', async () => {
    const recognizeWindow = await read('../../../window/Recognize/index.jsx');

    assert.match(recognizeWindow, /createServiceInstanceConfigLifecycle/u);
    assert.match(recognizeWindow, /serviceConfigGenerationRef/u);
    assert.match(recognizeWindow, /listenEvent:\s*listen/u);
    assert.match(recognizeWindow, /return lifecycle\.cleanup/u);
});

test('截图翻译与识别窗口都保留结构化 OCR 的 Markdown 和 LaTeX 换行', async () => {
    const [sourceArea, recognizeTextArea] = await Promise.all([
        read('../../../window/Translate/components/SourceArea/index.jsx'),
        read('../../../window/Recognize/TextArea/index.jsx'),
    ]);

    assert.match(sourceArea, /structuredOutput/u);
    assert.match(sourceArea, /deleteNewline\s*&&\s*!preserveStructure/u);
    assert.match(recognizeTextArea, /structuredOutput/u);
    assert.match(recognizeTextArea, /deleteNewline\s*&&\s*!preserveStructure/u);
});
