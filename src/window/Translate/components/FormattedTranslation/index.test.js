import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let FormattedTranslation;

before(async () => {
    server = await createServer({
        appType: 'custom',
        configFile: false,
        logLevel: 'silent',
        root: process.cwd(),
        server: { middlewareMode: true },
    });

    const module = await server.ssrLoadModule('/src/window/Translate/components/FormattedTranslation/index.jsx');
    FormattedTranslation = module.default;
});

after(async () => {
    await server?.close();
});

function render(value, fontSize = 16) {
    return renderToStaticMarkup(React.createElement(FormattedTranslation, { value, fontSize }));
}

test('将 Markdown 粗体渲染为 strong 且不保留字面星号', () => {
    const html = render('**关键结论**');

    assert.match(html, /<strong>关键结论<\/strong>/);
    assert.doesNotMatch(html, /\*\*关键结论\*\*/);
});

test('将单美元符号公式渲染为 KaTeX', () => {
    const html = render('结果满足 $\\le 10$。');

    assert.match(html, /class="katex"/);
    assert.doesNotMatch(html, /\$\\le 10\$/);
});

test('legacy 行内公式保留反斜杠命令并渲染为 KaTeX', () => {
    const html = render('分数为 \\(\\frac{1}{2}\\)。');

    assert.match(html, /class="katex"/);
    assert.match(html, /class="mfrac"/);
    assert.match(html, /<annotation[^>]*>\\frac\{1\}\{2\}<\/annotation>/);
});

test('将 TeX 块公式分隔符渲染为 display math', () => {
    const html = render('公式：\\[x^2\\]');

    assert.match(html, /class="katex-display"/);
    assert.doesNotMatch(html, /\\\[x\^2\\\]/);
});

test('在 blockquote 内保留块公式及前后富文本顺序', () => {
    const html = render('> **引用前** \\[x^2\\] *引用后*');
    const blockquote = html.match(/<blockquote>[\s\S]*?<\/blockquote>/)?.[0] ?? '';

    assert.match(blockquote, /class="katex-display"/);
    assert.match(blockquote, /<strong>引用前<\/strong>[\s\S]*class="katex-display"[\s\S]*<em>引用后<\/em>/);
});

test('在列表项内保留块公式及前后文本顺序', () => {
    const html = render('- 列表前 \\[x^2\\] 列表后');
    const listItem = html.match(/<li>[\s\S]*?<\/li>/)?.[0] ?? '';

    assert.match(listItem, /class="katex-display"/);
    assert.match(listItem, /列表前[\s\S]*class="katex-display"[\s\S]*列表后/);
});

test('多行 legacy 块公式在 blockquote 内安全渲染', () => {
    const html = render(['> \\[', '> x^2', '> \\]'].join('\n'));
    const blockquote = html.match(/<blockquote>[\s\S]*?<\/blockquote>/)?.[0] ?? '';

    assert.match(blockquote, /class="katex-display"/);
    assert.match(blockquote, /<annotation[^>]*>\s*x\^2\s*<\/annotation>/);
});

test('多行 legacy 块公式在列表项内安全渲染', () => {
    const html = render(['- \\[', '  x^2', '  \\]'].join('\n'));
    const listItem = html.match(/<li>[\s\S]*?<\/li>/)?.[0] ?? '';

    assert.match(listItem, /class="katex-display"/);
    assert.match(listItem, /<annotation[^>]*>\s*x\^2\s*<\/annotation>/);
});

test('代码中的 TeX 分隔符保持字面代码', () => {
    const inlineHtml = render('`\\(x\\)`');
    const fencedHtml = render(['```tex', '\\[x^2\\]', '```'].join('\n'));

    assert.match(inlineHtml, /<code>\\\(x\\\)<\/code>/);
    assert.doesNotMatch(inlineHtml, /class="katex/);
    assert.match(fencedHtml, /<pre><code[^>]*>\\\[x\^2\\\]\n<\/code><\/pre>/);
    assert.doesNotMatch(fencedHtml, /class="katex/);
});

test('未闭合 legacy 行内公式分隔符降级为原文', () => {
    const html = render('未闭合 \\(x');

    assert.match(html, /\\\(x/);
    assert.doesNotMatch(html, /class="katex/);
});

test('未闭合 legacy 块公式分隔符降级为原文', () => {
    const html = render('未闭合 \\[y');

    assert.match(html, /\\\[y/);
    assert.doesNotMatch(html, /class="katex/);
});

test('跳过原始 HTML，且不输出可加载或可执行的 img', () => {
    const html = render('<img src="x" onerror="alert(1)">安全文本');

    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /onerror/i);
    assert.match(html, /安全文本/);
});

test('将 Markdown 链接渲染为不可点击的安全文本', () => {
    const html = render('[外部站点](https://example.com/path)');

    assert.doesNotMatch(html, /<a\b/i);
    assert.doesNotMatch(html, /href=/i);
    assert.match(html, /<span>外部站点<\/span>/);
});

test('将 fontSize 写入展示容器的内联样式', () => {
    const html = render('译文', 18);

    assert.match(html, /^<div[^>]*style="[^"]*font-size:18px/);
});

test('使用预格式化换行样式保留纯文本单换行', () => {
    const html = render('第一行\n第二行');

    assert.match(html, /class="[^"]*\bwhitespace-pre-wrap\b/);
    assert.doesNotMatch(html, /class="[^"]*\bwhitespace-normal\b/);
});
