import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const readProjectFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('PDF 页面在窄阅读区保持原始渲染宽度并允许横向滚动', () => {
    const css = readProjectFile('src/window/Research/research.css');
    const pageStackRule = css.match(/\.pdf-page-stack\s*\{(?<body>[\s\S]*?)\}/u)?.groups?.body ?? '';
    const pageRule = css.match(/\.pdf-page\s*\{(?<body>[\s\S]*?)\}/u)?.groups?.body ?? '';
    const workspaceRule = css.match(/\.pdf-workspace\s*\{(?<body>[\s\S]*?)\}/u)?.groups?.body ?? '';

    assert.match(pageStackRule, /width:\s*max-content/u);
    assert.match(pageStackRule, /min-width:\s*100%/u);
    assert.match(pageRule, /max-width:\s*none/u);
    assert.doesNotMatch(pageRule, /max-width:\s*calc/u);
    assert.match(workspaceRule, /overflow:\s*auto/u);
});

test('PDF.js 官方文字层与画布共享完整缩放、尺寸和选区边界契约', () => {
    const css = readProjectFile('src/window/Research/research.css');
    const workspace = readProjectFile('src/window/Research/components/PdfWorkspace.jsx');

    assert.match(workspace, /loadPdfTextLayerBuilder/u);
    assert.match(workspace, /new TextLayerBuilder/u);
    assert.match(workspace, /textLayer\.dataset\.pdfSelectionLayer/u);
    assert.match(workspace, /textLayer\.style\.setProperty\('--total-scale-factor', String\(cssScale\)\)/u);
    assert.match(workspace, /textLayer\.style\.width = textLayerWidth/u);
    assert.match(workspace, /textLayer\.style\.height = textLayerHeight/u);
    assert.match(css, /--text-scale-factor:\s*calc\(var\(--total-scale-factor\)/u);
    assert.match(css, /font-size:\s*calc\(var\(--text-scale-factor\) \* var\(--font-height\)\)/u);
    assert.match(css, /scaleX\(var\(--scale-x\)\)/u);
    assert.match(css, /\.textLayer \.markedContent\s*\{\s*display:\s*contents/u);
    assert.match(css, /\.textLayer \.endOfContent/u);
    assert.match(css, /\.textLayer\.selecting \.endOfContent/u);
    assert.match(css, /\.textLayer br::selection/u);
});

test('PDF 阅读区声明平移、锚点缩放和按视觉行重建的选区保护', () => {
    const workspace = readProjectFile('src/window/Research/components/PdfWorkspace.jsx');
    const selection = readProjectFile('src/window/Research/pdfSelection.js');

    assert.match(workspace, /computePanScroll/u);
    assert.match(workspace, /computeAnchoredScroll/u);
    assert.match(workspace, /selectionGestureRef/u);
    assert.match(workspace, /selectionLayerForNode\(range\.startContainer\)/u);
    assert.match(workspace, /selectionLayerForNode\(range\.endContainer\)/u);
    assert.match(workspace, /capturePdfVisualLine/u);
    assert.match(workspace, /resolvePdfHorizontalRange/u);
    assert.match(selection, /rebuildPdfSingleLineRange/u);
    assert.match(workspace, /browserSelection\.removeAllRanges\(\)/u);
    assert.doesNotMatch(workspace, /caretAtPoint/u);
    assert.match(selection, /clusterSelectionRects\(rects\)\.length !== 1/u);
    assert.match(selection, /sameNodeFallbackRange/u);
    assert.match(workspace, /selectionFrameRef\.current = window\.requestAnimationFrame/u);
});

test('虚拟页卸载时取消渲染并释放 PDFPageProxy 资源', () => {
    const workspace = readProjectFile('src/window/Research/components/PdfWorkspace.jsx');

    assert.match(workspace, /renderTask\?\.cancel\?\.\(\)/u);
    assert.match(workspace, /pageProxy\?\.cleanup\?\.\(\)/u);
    assert.match(workspace, /pendingRender[\s\S]*finally\(releasePage\)/u);
});

test('已完成全文索引的 PDF 重开时跳过重复扫描，切换论文会取消当前订阅', () => {
    const workspace = readProjectFile('src/window/Research/components/PdfWorkspace.jsx');

    assert.match(workspace, /document\?\.textIndexComplete/u);
    assert.match(workspace, /extractSharedPdfText\(paperKey, source, \{ signal: controller\.signal \}\)/u);
    assert.match(workspace, /controller\.abort\(\)/u);
});
