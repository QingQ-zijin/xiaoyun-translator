import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('论文划词翻译统一通过桌面 transport 和已注册的 Rust 命令访问 Ollama', async () => {
    const [bridge, main] = await Promise.all([readSource('./bridge.js'), readSource('../../../src-tauri/src/main.rs')]);
    const translationFlow = bridge.slice(
        bridge.indexOf('export async function translateSelection'),
        bridge.indexOf('export async function askPaper')
    );

    assert.match(bridge, /translateWithDesktopBackend/u);
    assert.match(translationFlow, /translateWithDesktopBackend\(\{/u);
    assert.match(translationFlow, /invokeCommand: invokeResearch/u);
    assert.doesNotMatch(translationFlow, /translateAcademic|\bfetch\s*\(/u);
    assert.match(main, /research_get_translation_status,/u);
    assert.match(main, /research_translate_selection,/u);
});

test('桌面 transport 统一生成升级和网络错误提示，bridge 不再包含浏览器回退', async () => {
    const [bridge, transport] = await Promise.all([
        readSource('./bridge.js'),
        readSource('../translation/desktopTransport.js'),
    ]);
    const translationFlow = bridge.slice(
        bridge.indexOf('export async function translateSelection'),
        bridge.indexOf('export async function askPaper')
    );

    assert.match(transport, /当前程序后端不支持\$\{label\}，请安装最新版本后重试/u);
    assert.match(transport, /无法连接本地翻译服务，请确认 Ollama 正在运行/u);
    assert.doesNotMatch(translationFlow, /\bfetch\s*\(/u);
});
