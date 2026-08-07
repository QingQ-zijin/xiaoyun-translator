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

test('设置页与其他主模块占满同一工作区高度，并使用统一进入过渡', () => {
    const css = readProjectFile('src/window/Main/main.css');
    const mainSource = readProjectFile('src/window/Main/index.jsx');
    const mainShell = readRule(css, '.main-shell');
    const settingsPage = readRule(css, '.main-page--settings');
    const settingsLayout = readRule(css, '.settings-layout');
    const settingsContent = readRule(css, '.settings-content');
    const settingsSection = readRule(css, '.settings-section');

    assert.match(css, /\.main-shell > :is\(\.main-page, \.research-shell\)\s*\{[^}]*height:\s*100%/u);
    assert.match(css, /\.main-shell > :is\(\.main-page, \.research-shell\)\s*\{[^}]*main-surface-enter/u);
    assert.match(mainShell, /grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
    assert.doesNotMatch(mainSource, /MainRail/u);
    assert.doesNotMatch(css, /\.main-rail(?:__|\s*\{)/u);
    assert.match(settingsPage, /height:\s*100%/u);
    assert.match(settingsPage, /overflow:\s*hidden/u);
    assert.match(settingsLayout, /height:\s*100%/u);
    assert.match(settingsContent, /display:\s*flex/u);
    assert.match(settingsContent, /height:\s*100%/u);
    assert.match(settingsSection, /flex:\s*1 0 auto/u);
    assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-duration:\s*0\.01ms/u);
});
