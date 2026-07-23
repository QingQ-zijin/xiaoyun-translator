import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const readProjectFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('用户可见品牌统一为小允翻译并保留原配置目录', () => {
    const tauriConfig = JSON.parse(readProjectFile('src-tauri/tauri.conf.json'));

    assert.equal(tauriConfig.productName, '小允翻译');
    assert.equal(tauriConfig.identifier, 'com.pot-app.desktop');
    assert.equal(tauriConfig.bundle.shortDescription, '小允翻译与 AI 论文阅读器');
    assert.equal(tauriConfig.plugins?.updater, undefined);

    assert.match(readProjectFile('index.html'), /<title>小允翻译<\/title>/u);
    assert.match(readProjectFile('daemon.html'), /<title>小允翻译<\/title>/u);
    assert.match(readProjectFile('src/window/Config/pages/About/index.jsx'), /<h1[^>]*>小允翻译<\/h1>/u);
});

test('界面使用专属图标且不再暴露官方更新入口', () => {
    const configWindow = readProjectFile('src/window/Config/index.jsx');
    const aboutPage = readProjectFile('src/window/Config/pages/About/index.jsx');
    const generalPage = readProjectFile('src/window/Config/pages/General/index.jsx');
    const tray = readProjectFile('src-tauri/src/tray.rs');
    const main = readProjectFile('src-tauri/src/main.rs');
    const cargoManifest = readProjectFile('src-tauri/Cargo.toml');

    assert.match(configWindow, /alt='小允翻译 logo'[\s\S]*src='icon\.png'/u);
    assert.match(tray, /\.tooltip\(format!\("小允翻译 \{\}"/u);
    assert.doesNotMatch(tray, /"check_update"/u);
    assert.doesNotMatch(aboutPage, /invoke\('updater_window'\)/u);
    assert.doesNotMatch(generalPage, /useConfig\('check_update'/u);
    assert.doesNotMatch(main, /check_update\(app\.handle\(\)\)/u);
    assert.doesNotMatch(cargoManifest, /"updater"/u);
});

test('主要窗口标题体现小允翻译品牌', () => {
    const windowSource = readProjectFile('src-tauri/src/window.rs');

    assert.match(windowSource, /"main", WebviewUrl::App\("index\.html"\.into\(\)\)[\s\S]*?\.title\("小允翻译"\)/u);
    assert.match(windowSource, /"translate",[\s\S]*?\.title\("小允翻译"\)/u);
    assert.match(windowSource, /\.title\("小允翻译 - 截图"\)/u);
    assert.doesNotMatch(windowSource, /pub fn updater_window/u);
});

test('论文阅读器允许通过 Tauri 资产协议读取托管 PDF', () => {
    const tauriConfig = JSON.parse(readProjectFile('src-tauri/tauri.conf.json'));
    const csp = tauriConfig.app.security.csp;
    const main = readProjectFile('src-tauri/src/main.rs');

    assert.equal(tauriConfig.app.security.assetProtocol.enable, true);
    assert.match(csp, /connect-src[^;]*asset:/u);
    assert.match(csp, /https:\/\/asset\.localhost/u);
    assert.match(main, /asset_protocol_scope\(\)\.allow_directory\(path, true\)/u);
});
