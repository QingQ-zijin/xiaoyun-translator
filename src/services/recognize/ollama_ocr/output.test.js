import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanOcrOutput, findRepeatedMathLoop, findReopenedMarkdownLoop, stripOuterOcrFence } from './output.js';

const MARKDOWN_LATEX_BODY = [
    '## Stoichiometric matrix, $S$',
    '',
    '**结论**：对于代谢物 $i$，反应 $j$ 的净贡献保持不变，并满足下列质量守恒关系。',
    '',
    '$$',
    'S_{ij}v_j = v_i^{\\mathrm{in}} - v_i^{\\mathrm{out}}',
    '$$',
].join('\n');

const REPEATED_UNIT = ['**通量守恒关系**', '$$', 'S_{ij}v_j = v_i^{\\mathrm{in}} - v_i^{\\mathrm{out}}', '$$'].join(
    '\n'
);

test('检测重新打开的 Markdown 围栏及正文前缀并保留唯一正确首段', () => {
    const raw = `${MARKDOWN_LATEX_BODY}\n\`\`\`markdown\n\n${MARKDOWN_LATEX_BODY}`;

    const loop = findReopenedMarkdownLoop(raw);
    const result = cleanOcrOutput(raw, { doneReason: 'length' });

    assert.equal(loop.cutIndex, raw.indexOf('```markdown'));
    assert.equal(loop.reason, 'reopened_markdown_prefix');
    assert.equal(result.text, MARKDOWN_LATEX_BODY);
    assert.equal(result.changed, true);
    assert.equal(result.reason, 'reopened_markdown_prefix');
});

test('围栏后的可比较前缀不足 32 个字符时不提前截断', () => {
    const raw = `${MARKDOWN_LATEX_BODY}\n\`\`\`markdown\n${MARKDOWN_LATEX_BODY.slice(0, 12)}`;

    assert.equal(findReopenedMarkdownLoop(raw), null);
    assert.equal(cleanOcrOutput(raw, { doneReason: 'stop' }).text, raw);
});

test('围栏后正文前缀存在实质差异时不截断', () => {
    const differentBody = ['## 这是一段不同的 Markdown 示例，不是 OCR 正文的重复输出', '', '$$x_2 + y_2 = z_2$$'].join(
        '\n'
    );
    const raw = `${MARKDOWN_LATEX_BODY}\n\`\`\`markdown\n${differentBody}`;

    assert.equal(findReopenedMarkdownLoop(raw), null);
    assert.equal(cleanOcrOutput(raw, { doneReason: 'stop' }).text, raw);
});

test('合法代码围栏和内容不同的 Markdown 围栏保持原样', () => {
    const raw = [
        MARKDOWN_LATEX_BODY,
        '',
        '```javascript',
        'const formula = String.raw`S_{ij}v_j`;',
        '```',
        '',
        '```markdown',
        '这是一段独立示例，其内容并不重复前面的 OCR 正文，因此必须完整保留。',
        '```',
    ].join('\n');

    const result = cleanOcrOutput(raw, { doneReason: 'stop' });

    assert.equal(result.text, raw);
    assert.equal(result.changed, false);
    assert.equal(result.reason, null);
});

test('仅移除包裹整个回答的单层 Markdown 围栏并保留内部语法', () => {
    const wrapped = `\`\`\`markdown\n${MARKDOWN_LATEX_BODY}\n\`\`\``;

    assert.equal(stripOuterOcrFence(wrapped), MARKDOWN_LATEX_BODY);
    assert.deepEqual(cleanOcrOutput(wrapped, { doneReason: 'stop' }), {
        text: MARKDOWN_LATEX_BODY,
        changed: true,
        reason: 'outer_fence',
        repetition: null,
    });
});

test('普通 Markdown 与 LaTeX 不做空白或语法改写', () => {
    const source = [
        '**黑体保持原样**，行内公式为 $x_i^2$。',
        '',
        '$$',
        '\\frac{dB}{dt} = v_{\\mathrm{in},B} - v_{\\mathrm{out},B}',
        '$$',
        '',
        '> 引用中的 `code_value` 也必须保留。',
    ].join('\n');

    assert.deepEqual(cleanOcrOutput(source, { doneReason: 'stop' }), {
        text: source,
        changed: false,
        reason: null,
        repetition: null,
    });
});

test('length 结束时截断精确的多行尾部循环并只保留第一份', () => {
    const prefix = 'OCR 识别结果如下：';
    const raw = `${prefix}\n\n${[REPEATED_UNIT, REPEATED_UNIT, REPEATED_UNIT].join('\n\n')}`;

    const result = cleanOcrOutput(raw, { doneReason: 'length' });

    assert.equal(result.text, `${prefix}\n\n${REPEATED_UNIT}`);
    assert.equal(result.changed, true);
    assert.equal(result.reason, 'repeated_line_suffix');
    assert.equal(result.repetition.repeatCount, 3);
});

test('正常 stop 结束时不自动删除可能属于原图的重复内容', () => {
    const raw = [REPEATED_UNIT, REPEATED_UNIT, REPEATED_UNIT].join('\n\n');

    const result = cleanOcrOutput(raw, { doneReason: 'stop' });

    assert.equal(result.text, raw);
    assert.equal(result.changed, false);
});

test('length 结束但只有两份或公式存在差异时不截断', () => {
    const twoCopies = [REPEATED_UNIT, REPEATED_UNIT].join('\n\n');
    const changedFormula = REPEATED_UNIT.replace('S_{ij}', 'S_{ik}');
    const nearCopies = [REPEATED_UNIT, changedFormula, REPEATED_UNIT].join('\n\n');

    assert.equal(cleanOcrOutput(twoCopies, { doneReason: 'length' }).text, twoCopies);
    assert.equal(cleanOcrOutput(nearCopies, { doneReason: 'length' }).text, nearCopies);
});

test('连续三份仅空白与 LaTeX 间距不同的展示公式只保留第一份', () => {
    const first = '$$\np_{\\alpha}=0.65,\\quad p_{\\beta}=0.05,\\quad p_{\\mathrm{coil}}=0.30\n$$';
    const second = '$$ p_{\\alpha} = 0.65, p_{\\beta} = 0.05, p_{\\mathrm{coil}} = 0.30 $$';
    const third = '$$\n p_{\\alpha}=0.65, p_{\\beta}=0.05, p_{\\mathrm{coil}}=0.30\n$$';
    const raw = [first, second, third].join('\n\n');

    const loop = findRepeatedMathLoop(raw);
    const result = cleanOcrOutput(raw, { doneReason: 'stop' });

    assert.equal(loop.cutIndex, raw.indexOf(second));
    assert.equal(loop.reason, 'repeated_math_block');
    assert.equal(result.text, first);
    assert.equal(result.repetition.repeatCount, 3);
});

test('正文已经给出同一公式时删除随后循环的全部展示公式块', () => {
    const formula = 'p_{\\alpha}=0.65,p_{\\beta}=0.05,p_{\\mathrm{coil}}=0.30';
    const block = `$$${formula}$$`;
    const raw = `${formula}\n${block}\n${block}\n${block}`;

    assert.equal(cleanOcrOutput(raw, { doneReason: 'length' }).text, formula);
});

test('两份相同公式或三份不同公式不视为模型循环', () => {
    const formula = '$$S_{ij}v_j=v_i^{\\mathrm{in}}-v_i^{\\mathrm{out}}$$';
    const twoCopies = `${formula}\n${formula}`;
    const different = [formula, formula.replace('S_{ij}', 'S_{ik}'), formula].join('\n');

    assert.equal(findRepeatedMathLoop(twoCopies), null);
    assert.equal(findRepeatedMathLoop(different), null);
});
