import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const readProjectFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

const readRule = (css, selector) => {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return css.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[\\s\\S]*?)\\}`, 'u'))?.groups?.body ?? '';
};

test('主界面与论文阅读器共享同一组侧栏尺寸', () => {
    const mainCss = readProjectFile('src/window/Main/main.css');
    const researchCss = readProjectFile('src/window/Research/research.css');

    for (const css of [mainCss, researchCss]) {
        assert.match(css, /--app-rail-width:\s*92px/u);
        assert.match(css, /--app-context-sidebar-width:\s*274px/u);
        assert.match(css, /@media \(max-width:\s*880px\)[\s\S]*--app-rail-width:\s*78px/u);
        assert.match(css, /@media \(max-width:\s*880px\)[\s\S]*--app-context-sidebar-width:\s*240px/u);
    }
});

test('论文阅读器主栅格只保留导航、上下文侧栏与 PDF 三栏', () => {
    const css = readProjectFile('src/window/Research/research.css');
    const readerRule = readRule(css, '.research-shell.is-reader');
    const topbarRule = readRule(css, '.reader-topbar,\n.library-topbar');
    const workspaceRule = readRule(css, '.pdf-workspace');

    assert.match(
        readerRule,
        /grid-template-columns:\s*var\(--research-rail-width\)\s+var\(--app-context-sidebar-width\)\s+minmax\(430px,\s*1fr\)/u
    );
    assert.match(topbarRule, /grid-column:\s*3/u);
    assert.match(workspaceRule, /grid-column:\s*3/u);
});

test('论文切换、只读缩放、批注引用汇总与任务浮层均有布局样式', () => {
    const css = readProjectFile('src/window/Research/research.css');

    for (const selector of ['.reader-paper-switcher', '.zoom-status', '.reader-sidebar-tabs', '.research-job-float']) {
        assert.notEqual(readRule(css, selector), '', `${selector} 缺少样式`);
    }
    assert.match(css, /\.annotation-summary,\s*\.paper-relations\s*\{/u);
    assert.notEqual(readRule(css, '.annotation-summary__counts'), '', '批注汇总缺少样式');
    assert.notEqual(readRule(css, '.paper-relations > button'), '', '引用记录缺少样式');
});

test('文内删除操作只在批注标签菜单内出现，并可接收真实指针操作', () => {
    const css = readProjectFile('src/window/Research/research.css');
    const controlRule = readRule(css, '.pdf-annotation-control');
    const menuRule = readRule(css, '.pdf-annotation-menu');

    assert.match(css, /\.pdf-annotation-layer\s*\{[^}]*pointer-events:\s*none/u);
    assert.match(controlRule, /position:\s*absolute/u);
    assert.match(controlRule, /pointer-events:\s*auto/u);
    assert.match(menuRule, /position:\s*absolute/u);
    assert.match(css, /\.pdf-annotation-menu\s*>\s*button\s*\{[^}]*cursor:\s*pointer/u);
    assert.doesNotMatch(css, /\.pdf-annotation-delete\s*\{/u);
});

test('摘录标签与列表在最小侧栏宽度下仍保持横排且正文不被操作列挤压', () => {
    const css = readProjectFile('src/window/Research/research.css');
    const tabButtonRule = readRule(css, '.reader-sidebar-tabs button');
    const rowRule = readRule(css, '.recent-annotation');
    const openRule = readRule(css, '.recent-annotation__open');
    const deleteRule = readRule(css, '.recent-annotation__delete');

    assert.match(tabButtonRule, /white-space:\s*nowrap/u);
    assert.match(rowRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+28px/u);
    assert.match(openRule, /width:\s*100%/u);
    assert.match(openRule, /min-width:\s*0/u);
    assert.match(openRule, /grid-template-columns:\s*13px\s+minmax\(0,\s*1fr\)\s+16px/u);
    assert.match(deleteRule, /width:\s*28px/u);
});
