import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOllamaOcrPipeline, SupersededOcrError } from './pipeline.js';

const request = {
    model: 'glm-ocr:latest',
    stream: true,
    prompt: 'OCR:',
    images: ['CURRENT_IMAGE_BASE64'],
};

function response(content, { done = false, doneReason } = {}) {
    return {
        response: content,
        done,
        ...(doneReason ? { done_reason: doneReason } : {}),
    };
}

function makeStream(responses, onAbort = () => {}) {
    let aborted = false;
    return {
        abort() {
            aborted = true;
            onAbort();
        },
        async *[Symbol.asyncIterator]() {
            for (const item of responses) {
                if (aborted) {
                    throw new DOMException('请求已取消', 'AbortError');
                }
                yield item;
            }
        },
    };
}

function recognizeOptions(overrides = {}) {
    return {
        request,
        image: 'CURRENT_IMAGE_BASE64',
        language: 'zh_cn',
        fallbackToSystem: true,
        ...overrides,
    };
}

test('有效的 Markdown 与 LaTeX 输出直接返回，不调用系统 OCR', async () => {
    const expected = '**化学计量矩阵**\n\n代谢物净贡献为 $S_{ij}v_j$。';
    let fallbackCalls = 0;
    const pipeline = createOllamaOcrPipeline({
        generate: async () => makeStream([response(expected), response('', { done: true, doneReason: 'stop' })]),
        systemRecognize: async () => {
            fallbackCalls++;
            return '不应使用的系统 OCR';
        },
    });

    assert.equal(await pipeline.recognize(recognizeOptions()), expected);
    assert.equal(fallbackCalls, 0);
});

test('模型生成失败时按配置回退，并把当前图片与语言传给系统 OCR', async () => {
    const modelError = new Error('Ollama 无法连接');
    const fallbackCalls = [];
    const pipeline = createOllamaOcrPipeline({
        generate: async () => {
            throw modelError;
        },
        systemRecognize: async (input) => {
            fallbackCalls.push(input);
            return '系统 OCR 当前结果';
        },
    });

    assert.equal(await pipeline.recognize(recognizeOptions()), '系统 OCR 当前结果');
    assert.deepEqual(fallbackCalls, [
        {
            image: 'CURRENT_IMAGE_BASE64',
            language: 'zh_cn',
        },
    ]);
});

test('模型只生成空白内容时按配置回退系统 OCR', async () => {
    let fallbackCalls = 0;
    const pipeline = createOllamaOcrPipeline({
        generate: async () => makeStream([response('  \n\t'), response('', { done: true, doneReason: 'stop' })]),
        systemRecognize: async () => {
            fallbackCalls++;
            return '空输出回退结果';
        },
    });

    assert.equal(await pipeline.recognize(recognizeOptions()), '空输出回退结果');
    assert.equal(fallbackCalls, 1);
});

test('达到输出上限且没有可靠收敛证据时按配置回退系统 OCR', async () => {
    const unfinished = '这是未完成且没有出现可确认重复前缀的唯一正文。'.repeat(20);
    let fallbackCalls = 0;
    const pipeline = createOllamaOcrPipeline({
        generate: async () => makeStream([response(unfinished, { done: true, doneReason: 'length' })]),
        systemRecognize: async () => {
            fallbackCalls++;
            return '长度上限回退结果';
        },
    });

    assert.equal(await pipeline.recognize(recognizeOptions()), '长度上限回退结果');
    assert.equal(fallbackCalls, 1);
});

test('关闭系统回退时保留模型生成的原始错误', async () => {
    const modelError = new Error('模型文件损坏');
    let fallbackCalls = 0;
    const pipeline = createOllamaOcrPipeline({
        generate: async () => {
            throw modelError;
        },
        systemRecognize: async () => {
            fallbackCalls++;
            return '不应回退';
        },
    });

    await assert.rejects(
        pipeline.recognize(recognizeOptions({ fallbackToSystem: false })),
        (error) => error === modelError
    );
    assert.equal(fallbackCalls, 0);
});

test('模型与系统 OCR 都失败时抛出包含两条原因的 AggregateError', async () => {
    const modelError = new Error('模型失败');
    const systemError = new Error('系统 OCR 失败');
    const pipeline = createOllamaOcrPipeline({
        generate: async () => {
            throw modelError;
        },
        systemRecognize: async () => {
            throw systemError;
        },
    });

    await assert.rejects(pipeline.recognize(recognizeOptions()), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [modelError, systemError]);
        assert.match(error.message, /Ollama OCR.*系统 OCR/u);
        return true;
    });
});

test('新截图取代旧请求时中止旧流，旧请求不触发系统回退', async () => {
    let resolveFirstChunk;
    const firstChunkReceived = new Promise((resolve) => {
        resolveFirstChunk = resolve;
    });
    let releaseFirstStream;
    const firstStreamReleased = new Promise((resolve) => {
        releaseFirstStream = resolve;
    });
    let firstAbortCalls = 0;
    const firstStream = {
        abort() {
            firstAbortCalls++;
            releaseFirstStream();
        },
        async *[Symbol.asyncIterator]() {
            yield response('旧截图的部分结果');
            resolveFirstChunk();
            await firstStreamReleased;
            throw new DOMException('旧请求已取消', 'AbortError');
        },
    };
    const secondText = '新截图的完整结果';
    let generationCalls = 0;
    let fallbackCalls = 0;
    const pipeline = createOllamaOcrPipeline({
        generate: async () => {
            generationCalls++;
            return generationCalls === 1
                ? firstStream
                : makeStream([response(secondText), response('', { done: true, doneReason: 'stop' })]);
        },
        systemRecognize: async () => {
            fallbackCalls++;
            return '不应回退';
        },
    });

    const firstResult = pipeline.recognize(
        recognizeOptions({ request: { ...request, requestMarker: 'first' }, image: 'FIRST_IMAGE_BASE64' })
    );
    const firstRejection = assert.rejects(firstResult, (error) => error instanceof SupersededOcrError);
    await firstChunkReceived;
    const secondResult = pipeline.recognize(
        recognizeOptions({ request: { ...request, requestMarker: 'second' }, image: 'SECOND_IMAGE_BASE64' })
    );

    assert.equal(await secondResult, secondText);
    await firstRejection;
    assert.equal(firstAbortCalls, 1);
    assert.equal(fallbackCalls, 0);
});

test('确认模型从头重复正文时主动中止生成并返回第一次完整正文', async () => {
    const firstPass = '# 化学计量矩阵\n\n对于代谢物 $i$，反应 $j$ 的净贡献为 $S_{ij}v_j$。';
    let abortCalls = 0;
    const pipeline = createOllamaOcrPipeline({
        generate: async () =>
            makeStream(
                [
                    response(firstPass),
                    response('\n```markdown\n'),
                    response(firstPass),
                    response('', { done: true, doneReason: 'stop' }),
                ],
                () => {
                    abortCalls++;
                }
            ),
        systemRecognize: async () => '不应回退',
    });

    assert.equal(await pipeline.recognize(recognizeOptions()), firstPass);
    assert.equal(abortCalls, 1, '确认重复后必须调用流的 abort，立即释放模型生成');
});

test('连续生成第三份等价公式时主动中止，并且不回退系统 OCR', async () => {
    const first = '$$p_{\\alpha}=0.65,\\quad p_{\\beta}=0.05,\\quad p_{\\mathrm{coil}}=0.30$$';
    const second = '$$ p_{\\alpha} = 0.65, p_{\\beta} = 0.05, p_{\\mathrm{coil}} = 0.30 $$';
    const third = '$$p_{\\alpha}=0.65,p_{\\beta}=0.05,p_{\\mathrm{coil}}=0.30$$';
    let abortCalls = 0;
    let fallbackCalls = 0;
    const pipeline = createOllamaOcrPipeline({
        generate: async () =>
            makeStream([response(first), response(`\n${second}`), response(`\n${third}`)], () => {
                abortCalls++;
            }),
        systemRecognize: async () => {
            fallbackCalls++;
            return '不应回退';
        },
    });

    assert.equal(await pipeline.recognize(recognizeOptions()), first);
    assert.equal(abortCalls, 1);
    assert.equal(fallbackCalls, 0);
});

test('系统 OCR 回退等待期间被新截图取代时，旧回退结果必须作废', async () => {
    let resolveOldFallback;
    const oldFallback = new Promise((resolve) => {
        resolveOldFallback = resolve;
    });
    let generationCalls = 0;
    const pipeline = createOllamaOcrPipeline({
        generate: async () => {
            generationCalls++;
            if (generationCalls === 1) throw new Error('旧请求模型失败');
            return makeStream([response('新截图结果'), response('', { done: true, doneReason: 'stop' })]);
        },
        systemRecognize: async ({ image }) => {
            if (image === 'FIRST_IMAGE_BASE64') return oldFallback;
            return '不应使用的新请求回退';
        },
    });

    const firstResult = pipeline.recognize(
        recognizeOptions({ request: { ...request, requestMarker: 'first' }, image: 'FIRST_IMAGE_BASE64' })
    );
    const firstRejection = assert.rejects(firstResult, (error) => error instanceof SupersededOcrError);
    await Promise.resolve();

    assert.equal(
        await pipeline.recognize(
            recognizeOptions({ request: { ...request, requestMarker: 'second' }, image: 'SECOND_IMAGE_BASE64' })
        ),
        '新截图结果'
    );
    resolveOldFallback('旧截图的系统 OCR 结果');
    await firstRejection;
});

test('只有 Markdown 围栏而没有正文时视为无效输出并回退', async () => {
    let fallbackCalls = 0;
    const pipeline = createOllamaOcrPipeline({
        generate: async () =>
            makeStream([response('```markdown\n```'), response('', { done: true, doneReason: 'stop' })]),
        systemRecognize: async () => {
            fallbackCalls++;
            return '围栏空输出的系统回退';
        },
    });

    assert.equal(await pipeline.recognize(recognizeOptions()), '围栏空输出的系统回退');
    assert.equal(fallbackCalls, 1);
});

test('本次结果元数据区分模型结构化输出与系统 OCR 普通文本', async () => {
    const modelMetadata = [];
    const modelPipeline = createOllamaOcrPipeline({
        generate: async () =>
            makeStream([response('**结构化结果**'), response('', { done: true, doneReason: 'stop' })]),
        systemRecognize: async () => '不应回退',
    });
    await modelPipeline.recognize(
        recognizeOptions({
            onResultMetadata: (metadata) => modelMetadata.push(metadata),
        })
    );

    const fallbackMetadata = [];
    const fallbackPipeline = createOllamaOcrPipeline({
        generate: async () => {
            throw new Error('模型失败');
        },
        systemRecognize: async () => '系统 OCR 普通文本',
    });
    await fallbackPipeline.recognize(
        recognizeOptions({
            onResultMetadata: (metadata) => fallbackMetadata.push(metadata),
        })
    );

    assert.deepEqual(modelMetadata, [{ source: 'model', structured: true }]);
    assert.deepEqual(fallbackMetadata, [
        {
            source: 'system',
            structured: false,
            fallbackReason: 'model_request_failed',
            fallbackDetail: '模型失败',
        },
    ]);
});

test('输出达到长度上限后回退时提供可诊断的回退原因', async () => {
    const metadata = [];
    const pipeline = createOllamaOcrPipeline({
        generate: async () => makeStream([response('未收敛的长输出', { done: true, doneReason: 'length' })]),
        systemRecognize: async () => '系统 OCR 结果',
    });

    assert.equal(
        await pipeline.recognize(recognizeOptions({ onResultMetadata: (value) => metadata.push(value) })),
        '系统 OCR 结果'
    );
    assert.equal(metadata[0].fallbackReason, 'length_limit');
    assert.match(metadata[0].fallbackDetail, /输出上限/u);
});
