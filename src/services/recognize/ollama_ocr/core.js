import { UNIFIED_OLLAMA_CONTEXT_TOKENS, UNIFIED_OLLAMA_MODEL } from '../../../domains/ollama/runtime.js';

export const DEFAULT_OLLAMA_OCR_HOST = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_OCR_MODEL = UNIFIED_OLLAMA_MODEL;
export const DEFAULT_OLLAMA_OCR_MODE = 'auto';

const OLLAMA_OCR_PROMPTS = Object.freeze({
    formula: 'Formula Recognition:',
    table: 'Table Recognition:',
});

const QWEN3_VL_PROMPTS = Object.freeze({
    auto: [
        'Transcribe the entire image in visual reading order.',
        'Output only the transcription as Markdown; do not explain, translate, summarize, or infer missing content.',
        'Preserve every visible Chinese and English character, heading, paragraph, number, variable, arrow direction, and every label positioned above or below an arrow.',
        'Convert mathematical expressions to valid KaTeX-compatible LaTeX. Use $...$ for inline math and $$...$$ for display math. Preserve subscripts, superscripts, fractions, and reaction structure exactly.',
        'Pay special attention to reaction arrows: distinguish a reversible pair of opposite arrows from a one-way arrow. Encode a reversible arrow as \\xrightleftharpoons[below label]{above label}; never replace it with \\xrightarrow. Keep the visual upper label in the braces and the visual lower label in the brackets.',
        'Do not wrap the answer in a code fence.',
    ].join('\n'),
    formula: [
        'Transcribe only the mathematical expression in the image.',
        'Output valid KaTeX-compatible LaTeX inside one $$...$$ block and nothing else.',
        'Preserve every subscript, superscript, fraction, arrow direction, and every label above or below an arrow exactly.',
        'For a reversible pair of opposite arrows, use \\xrightleftharpoons[below label]{above label}; keep the upper label in braces and the lower label in brackets.',
    ].join('\n'),
    table: [
        'Transcribe the entire table exactly as visible.',
        'Output only a Markdown table. Preserve all row and column order, text, numbers, and mathematical expressions.',
        'Use KaTeX-compatible $...$ for mathematical content. Do not explain, translate, or summarize.',
    ].join('\n'),
});

// Gemma 4 的通用视觉提示不能只写“ OCR: ”，否则容易把“允”误识别成“窗”等近形字。
// 明确要求逐字转录并限制输出格式，可同时覆盖普通文本、表格和学术公式。
const GEMMA4_OCR_PROMPTS = Object.freeze({
    auto: [
        'Perform exact OCR on the entire image in visual reading order.',
        'Transcribe every visible Chinese and English character, heading, paragraph, number, symbol, and punctuation mark without correcting, translating, explaining, or guessing.',
        'Preserve line and paragraph boundaries. Convert mathematical expressions to KaTeX-compatible LaTeX using $...$ or $$...$$, preserving subscripts, superscripts, fractions, arrows, and labels.',
        'Output only the transcription as Markdown, without a code fence.',
    ].join('\n'),
    formula: [
        'Transcribe only the visible mathematical expression exactly.',
        'Return one KaTeX-compatible $$...$$ block and nothing else.',
        'Preserve every variable, subscript, superscript, fraction, operator, arrow direction, and arrow label; never infer cropped content.',
    ].join('\n'),
    table: [
        'Transcribe the complete visible table exactly.',
        'Return only a Markdown table, preserving row and column order, text, numbers, symbols, and mathematical expressions.',
        'Use KaTeX-compatible $...$ for math. Do not explain, translate, summarize, or correct the content.',
    ].join('\n'),
});

/** 根据模型官方接口选择任务提示词，避免把 GLM-OCR 的文字识别误写成 Paddle 的 OCR 指令。 */
export function resolveOllamaOcrPrompt(model, mode = DEFAULT_OLLAMA_OCR_MODE) {
    const normalizedModel = String(model ?? '')
        .trim()
        .toLowerCase();
    const normalizedMode = String(mode ?? DEFAULT_OLLAMA_OCR_MODE)
        .trim()
        .toLowerCase();

    if (normalizedModel.startsWith('qwen3-vl')) {
        return QWEN3_VL_PROMPTS[normalizedMode] ?? QWEN3_VL_PROMPTS.auto;
    }
    if (normalizedModel.startsWith('gemma4')) {
        return GEMMA4_OCR_PROMPTS[normalizedMode] ?? GEMMA4_OCR_PROMPTS.auto;
    }
    if (normalizedMode in OLLAMA_OCR_PROMPTS) return OLLAMA_OCR_PROMPTS[normalizedMode];
    if (normalizedModel.startsWith('glm-ocr')) return 'Text Recognition:';
    return 'OCR:';
}

/** 将用户填写的 Ollama 地址规范化为 SDK 可直接使用的 HTTP(S) 地址。 */
export function normalizeOllamaHost(value) {
    const input = String(value ?? '').trim() || DEFAULT_OLLAMA_OCR_HOST;
    const withProtocol = /^[a-z][a-z\d+.-]*:\/\//iu.test(input) ? input : `http://${input}`;
    const normalized = withProtocol.replace(/\/+$/u, '');
    const url = new URL(normalized);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Ollama 地址仅支持 HTTP 或 HTTPS');
    }

    const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLocaleLowerCase());
    const port = url.port || (url.protocol === 'http:' ? '80' : '443');
    if (isLocal && ['11434', '11435'].includes(port)) return DEFAULT_OLLAMA_OCR_HOST;

    return normalized;
}

/** 为每次截图创建全新请求对象，禁止携带历史消息、context 或旧图片。 */
export function buildOllamaOcrRequest({ model, image, mode = DEFAULT_OLLAMA_OCR_MODE, keepAlive = -1 }) {
    const currentImage = String(image ?? '').trim();
    if (currentImage === '') {
        throw new Error('OCR 图片不能为空');
    }

    // 参数仅为兼容旧调用签名；运行期始终使用统一 Gemma 4，拒绝旧配置重新装载 OCR 模型。
    void model;
    void keepAlive;
    const currentModel = DEFAULT_OLLAMA_OCR_MODEL;

    return {
        model: currentModel,
        prompt: resolveOllamaOcrPrompt(currentModel, mode),
        images: [currentImage],
        stream: true,
        think: false,
        // OCR 与翻译共用同一个 Gemma 4 runner；保留它可避免下一次 Ctrl+D 冷启动。
        keep_alive: -1,
        options: {
            temperature: 0,
            seed: 42,
            // 所有任务固定同一上下文规格，避免 Ollama 在 OCR 与翻译之间重建 runner。
            num_ctx: UNIFIED_OLLAMA_CONTEXT_TOKENS,
            num_predict: 2048,
            repeat_penalty: 1.05,
        },
    };
}
