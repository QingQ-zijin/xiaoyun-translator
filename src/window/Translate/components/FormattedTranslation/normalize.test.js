import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranslationForDisplay } from './normalize.js';

test('保留 Markdown 与 legacy TeX 原文供 remark 插件解析', () => {
    const value = '**关键结论**：\\(x^2\\) 与 \\[y^2\\]，代码 `\\(code\\)`。';

    assert.equal(normalizeTranslationForDisplay(value), value);
});

test('仅移除末尾的流式光标下划线', () => {
    assert.equal(normalizeTranslationForDisplay('snake_case_'), 'snake_case');
    assert.equal(normalizeTranslationForDisplay('snake_case'), 'snake_case');
    assert.equal(normalizeTranslationForDisplay('snake_case_value'), 'snake_case_value');
    assert.equal(normalizeTranslationForDisplay('snake_case__'), 'snake_case_');
});

test('非字符串值返回空字符串', () => {
    assert.equal(normalizeTranslationForDisplay(null), '');
});
