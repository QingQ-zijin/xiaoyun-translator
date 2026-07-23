import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
    LEGACY_OLLAMA_TRANSLATION_SYSTEM_PROMPT,
    LEGACY_OLLAMA_TRANSLATION_USER_PROMPT,
    OLLAMA_TRANSLATION_SYSTEM_PROMPT,
    createOllamaTranslationPrompt,
    upgradeOllamaTranslationPrompt,
} from './prompt.js';

test('旧内置提示词指纹保持稳定，确保磁盘配置可以被迁移', () => {
    const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

    assert.equal(
        sha256(LEGACY_OLLAMA_TRANSLATION_SYSTEM_PROMPT),
        'ad0f964e71a8c9c7bf62f353b7be49c9043e532bccd99225c81474086a4fbc70'
    );
    assert.equal(
        sha256(LEGACY_OLLAMA_TRANSLATION_USER_PROMPT),
        'fa6f66c46db6614d50be70c935a980b6070dd2564517b8231f20a1d057678840'
    );
});

test('创建固定顺序的 system 与 user 提示词', () => {
    const promptList = createOllamaTranslationPrompt();

    assert.equal(promptList.length, 2);
    assert.deepEqual(
        promptList.map(({ role }) => role),
        ['system', 'user']
    );
    assert.equal(promptList[0].content, OLLAMA_TRANSLATION_SYSTEM_PROMPT);
});

test('system 提示词约束完整译文与 Markdown 输出', () => {
    const systemPrompt = createOllamaTranslationPrompt()[0].content;

    assert.match(systemPrompt, /only the complete translated text/i);
    assert.match(systemPrompt, /preserve meaningful Markdown/i);
    assert.match(systemPrompt, /wrap the translated emphasized text in exactly two asterisks on each side/i);
    assert.match(systemPrompt, /for example, `\*\*translated text\*\*`/i);
    assert.doesNotMatch(systemPrompt, /always emit exactly `\*\*bold\*\*`/i);
    assert.match(systemPrompt, /never use alternate bold syntax/i);
    assert.match(systemPrompt, /never (?:emit|use) raw HTML/i);
    assert.match(systemPrompt, /inline math as `\$\.\.\.\$`/i);
    assert.match(systemPrompt, /display math as `\$\$\.\.\.\$\$`/i);
    assert.match(systemPrompt, /never add math delimiters, LaTeX commands, bold markers, or other markup/i);
    assert.match(systemPrompt, /do not wrap (?:the )?(?:whole|entire) (?:response|paragraph)/i);
    assert.match(systemPrompt, /fenced code block/i);
});

test('system 提示词保护公式并正确处理货币美元符号', () => {
    const systemPrompt = createOllamaTranslationPrompt()[0].content;

    for (const protectedPart of [
        'variables',
        'operators',
        'subscripts',
        'superscripts',
        'units',
        'citations',
        'references',
        'LaTeX commands',
    ]) {
        assert.match(systemPrompt, new RegExp(protectedPart, 'i'));
    }
    assert.match(systemPrompt, /translate only (?:the )?natural-language text outside math/i);
    assert.match(systemPrompt, /literal currency dollar signs/i);
    assert.ok(systemPrompt.includes('`\\$`'));
});

test('system 提示词禁止臆造额外内容', () => {
    const systemPrompt = createOllamaTranslationPrompt()[0].content;

    assert.match(
        systemPrompt,
        /never invent emphasis, formulas, explanations, alternatives, annotations, comments, or reasoning/i
    );
});

test('system 提示词包含语言、引号内容与片段翻译规则', () => {
    const systemPrompt = createOllamaTranslationPrompt()[0].content;

    for (const preservedPart of ['abbreviations', 'code', 'URLs', 'quotation marks']) {
        assert.match(systemPrompt, new RegExp(preservedPart, 'i'));
    }
    assert.match(systemPrompt, /render proper names in the target language/i);
    assert.match(systemPrompt, /established translated name or an accurate transliteration/i);
    assert.doesNotMatch(systemPrompt, /preserve proper names/i);
    assert.match(systemPrompt, /translate (?:the )?natural-language text inside quotations/i);
    assert.doesNotMatch(systemPrompt, /no Chinese outside quotations/i);
    assert.match(systemPrompt, /method names ending in `-seq`/i);
    assert.match(systemPrompt, /target (?:language )?is Simplified Chinese/i);
    assert.match(systemPrompt, /natural sciences/i);
    assert.match(systemPrompt, /target (?:language )?is English/i);
    assert.match(systemPrompt, /no untranslated Chinese natural-language text/i);
    assert.match(systemPrompt, /including text inside quotation marks/i);
    assert.match(systemPrompt, /code and formulas are the only verbatim exceptions/i);
    assert.match(systemPrompt, /translate incomplete fragments as fragments/i);
    assert.match(systemPrompt, /never invent missing subjects, objects, antecedents, or context/i);
    assert.match(systemPrompt, /use every clue inside the supplied source block/i);
});

test('system 提示词要求按领域和整句语境消解多义词', () => {
    const systemPrompt = createOllamaTranslationPrompt()[0].content;

    assert.match(systemPrompt, /infer the subject domain from the entire supplied source block/i);
    assert.match(systemPrompt, /polysemous words, idioms, collocations, and multiword terms/i);
    assert.match(systemPrompt, /never an isolated dictionary sense/i);
    assert.match(systemPrompt, /life sciences, medicine, chemistry, AI, statistics, mathematics, and physics/i);
    assert.match(systemPrompt, /contextual sense rules, never unconditional substitutions/i);
    assert.match(systemPrompt, /`clinical translation` and `translation into\/to the clinic`/i);
    assert.match(systemPrompt, /`临床转化`, `向临床应用转化`/i);
    assert.match(systemPrompt, /never as linguistic `翻译`/i);
    assert.match(systemPrompt, /in protein synthesis, `translation` means `翻译`/i);
    assert.match(systemPrompt, /in geometry translated into Simplified Chinese, render `translation` as.*`平移`/i);
    assert.match(systemPrompt, /A translation by vector v maps every point x to x \+ v\./i);
    assert.match(systemPrompt, /keep plain variables plain unless the source itself uses math delimiters/i);
    assert.match(systemPrompt, /`cellular penetration` = `细胞穿透能力`/i);
});

test('user 提示词携带全部变量并以清晰边界包围源文', () => {
    const userPrompt = createOllamaTranslationPrompt()[1].content;

    for (const placeholder of ['$to', '$from', '$detect', '$text']) {
        assert.ok(userPrompt.includes(placeholder));
    }
    assert.match(userPrompt, /--- BEGIN SOURCE TEXT ---\n\$text\n--- END SOURCE TEXT ---/);
});

test('每次调用返回互不共享的数组和条目对象', () => {
    const first = createOllamaTranslationPrompt();
    const second = createOllamaTranslationPrompt();

    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first[0], second[0]);
    assert.notStrictEqual(first[1], second[1]);

    first[0].content = '已编辑的 system 提示词';
    first[1].content = '已编辑的 user 提示词';
    first.push({ role: 'assistant', content: '新增条目' });

    assert.equal(second.length, 2);
    assert.equal(second[0].content, OLLAMA_TRANSLATION_SYSTEM_PROMPT);
    assert.ok(second[1].content.includes('$text'));
});

test('仅将旧内置提示词迁移到新版并保留其他消息', () => {
    const legacyPromptList = [
        { role: 'system', content: LEGACY_OLLAMA_TRANSLATION_SYSTEM_PROMPT },
        { role: 'user', content: LEGACY_OLLAMA_TRANSLATION_USER_PROMPT },
        { role: 'assistant', content: '保留的示例译文' },
    ];

    const upgraded = upgradeOllamaTranslationPrompt(legacyPromptList);

    assert.notStrictEqual(upgraded, legacyPromptList);
    assert.equal(upgraded[0].content, OLLAMA_TRANSLATION_SYSTEM_PROMPT);
    assert.equal(upgraded[1].content, createOllamaTranslationPrompt()[1].content);
    assert.strictEqual(upgraded[2], legacyPromptList[2]);
    assert.equal(legacyPromptList[0].content, LEGACY_OLLAMA_TRANSLATION_SYSTEM_PROMPT);
});

test('不覆盖用户自定义提示词，缺失配置时使用新版默认值', () => {
    const customPromptList = [
        { role: 'system', content: '我的领域提示词' },
        { role: 'user', content: '翻译：$text' },
    ];

    assert.strictEqual(upgradeOllamaTranslationPrompt(customPromptList), customPromptList);
    assert.deepEqual(upgradeOllamaTranslationPrompt(null), createOllamaTranslationPrompt());
});

test('插值模板变量但保持源文中的字面占位符', async () => {
    const { interpolateOllamaTranslationPrompt } = await import('./prompt.js');
    assert.equal(typeof interpolateOllamaTranslationPrompt, 'function');

    const promptList = [
        { role: 'system', content: 'Translate from $from to $to (detected: $detect).' },
        { role: 'user', content: '--- BEGIN SOURCE ---\n$text\n--- END SOURCE ---' },
    ];
    const originalPromptList = promptList.map((item) => ({ ...item }));
    const text = 'Keep `$to`, formula $from+x$, and $detect unchanged.';

    const result = interpolateOllamaTranslationPrompt(promptList, {
        text,
        from: 'en',
        to: 'zh_cn',
        detect: 'English',
    });

    assert.deepEqual(result, [
        { role: 'system', content: 'Translate from en to zh_cn (detected: English).' },
        { role: 'user', content: `--- BEGIN SOURCE ---\n${text}\n--- END SOURCE ---` },
    ]);
    assert.deepEqual(promptList, originalPromptList);
    assert.notStrictEqual(result, promptList);
    assert.notStrictEqual(result[0], promptList[0]);
    assert.notStrictEqual(result[1], promptList[1]);
});
