import assert from 'node:assert/strict';
import test from 'node:test';

import {
    chooseBestFormulaOcrOutput,
    normalizeFormulaOcrOutput,
    shouldRetryFormulaRecognition,
} from './formula.js';

const FORMULA = 'p_{\\alpha}=0.65,\\quad p_{\\beta}=0.05,\\quad p_{coil}=0.30';

test('只对高度疑似纯公式的通用 OCR 结果启用公式二次识别', () => {
    assert.equal(
        shouldRetryFormulaRecognition(
            '\\(\\mathrm{p}_{\\alpha}=0.65\\), \\(\\mathrm{p}_{\\beta}=0.05\\), \\(p_{coil}=0.30\\)'
        ),
        true
    );
    assert.equal(shouldRetryFormulaRecognition(`The measured result is \\(x_1=0.65\\) in this experiment.`), false);
    assert.equal(shouldRetryFormulaRecognition('普通中文正文包含公式 \\(x_1=0.65\\)。'), false);
    assert.equal(shouldRetryFormulaRecognition('const foo_bar = 0.65;'), false);
    assert.equal(shouldRetryFormulaRecognition('： 0．65，： 0．05，pcoil：0．30'), true);
    assert.equal(shouldRetryFormulaRecognition('=krestore(|——kleakME'), true);
    assert.equal(shouldRetryFormulaRecognition('dE / dt = krestore (1-E) - kleakME'), true);
    assert.equal(shouldRetryFormulaRecognition('x=(y-z)'), true);
    assert.equal(shouldRetryFormulaRecognition('The values are 0.65 and 0.05 in this experiment.'), false);
    assert.equal(shouldRetryFormulaRecognition('status = (ready) -- retry'), false);
    assert.equal(shouldRetryFormulaRecognition('result=(x-y)'), false);
    assert.equal(shouldRetryFormulaRecognition('foo=(bar-baz);'), false);
});

test('修复 Paddle 公式模式缺失的开头定界符并输出完整展示公式', () => {
    assert.equal(normalizeFormulaOcrOutput(`\\\\ ${FORMULA}\\]`), `$$\n${FORMULA}\n$$`);
});

test('公式模式出现短前缀幻觉时提取唯一行内公式', () => {
    assert.equal(normalizeFormulaOcrOutput(`檢例 \\(${FORMULA}\\)`), `$$\n${FORMULA}\n$$`);
});

test('移除公式中的多余右花括号，但不猜测缺失的右花括号', () => {
    assert.equal(normalizeFormulaOcrOutput(`$$${FORMULA}}$$`), `$$\n${FORMULA}\n$$`);
    assert.equal(normalizeFormulaOcrOutput('$$p_{\\alpha=0.65$$'), null);
});

test('普通正文不被包装为公式', () => {
    assert.equal(normalizeFormulaOcrOutput('This is ordinary OCR text.'), null);
});

test('多字符裸下标会补成可正确渲染的 LaTeX 花括号', () => {
    assert.equal(
        normalizeFormulaOcrOutput('\\(\\frac{dE}{dt}=k_restore(1-E)-k_{leak}ME\\)'),
        '$$\n\\frac{dE}{dt}=k_{restore}(1-E)-k_{leak}ME\n$$'
    );
});

test('放大图出现乱码前缀时选择原图的结构化公式', () => {
    const best = chooseBestFormulaOcrOutput([
        {
            variant: 'processed',
            text: '\\\\ ìng_{p\\alpha}=0.65,\\quad{p_\\beta}=0.05,\\quad{p_{\\mathrm{coil}}}=0.30\\]',
        },
        { variant: 'raw', text: `檢例 \\(${FORMULA}\\)` },
    ]);

    assert.deepEqual(best, {
        text: `$$\n${FORMULA}\n$$`,
        index: 1,
        variant: 'raw',
        score: 9,
    });
});

test('候选同分时优先原图以避免放大处理引入视觉幻觉', () => {
    const best = chooseBestFormulaOcrOutput([
        { variant: 'processed', text: `\\\\ ${FORMULA}\\]` },
        { variant: 'raw', text: `\\(${FORMULA}\\)` },
    ]);

    assert.equal(best.variant, 'raw');
});

test('拒绝不成对 LaTeX 环境并清理原图候选末尾的孤立美元符号', () => {
    const rawFormula = '\\frac{dE}{dt}=k_\\text{restore}(1-E)-k_\\text{leak}ME';
    const best = chooseBestFormulaOcrOutput([
        {
            variant: 'processed',
            text: '\\hat{dE}\\;\\frac{dE}{dt}={k}_{\\mathrm{restore}}(1-E)-{k}_{\\mathrm{leak}}ME\\end{array}',
        },
        { variant: 'raw', text: `${rawFormula}$` },
    ]);

    assert.equal(normalizeFormulaOcrOutput('\\frac{x}{y}=1\\end{array}'), null);
    assert.deepEqual(best, {
        text: `$$\n${rawFormula}\n$$`,
        index: 1,
        variant: 'raw',
        score: 6,
    });
});
