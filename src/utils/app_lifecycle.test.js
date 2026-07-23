import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const readProjectFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('主窗口关闭与托盘退出共用完整退出流程', () => {
    const main = readProjectFile('src-tauri/src/main.rs');
    const tray = readProjectFile('src-tauri/src/tray.rs');

    assert.ok(main.includes('WindowEvent::CloseRequested'));
    assert.ok(main.includes('api.prevent_close()'));
    assert.ok(main.includes('request_app_exit(window.app_handle())'));
    assert.ok(main.includes('pub(crate) fn request_app_exit'));
    assert.ok(main.includes('std::thread::spawn(move || app.exit(0))'));
    assert.ok(!main.includes('api.prevent_exit()'));
    assert.ok(tray.includes('QUIT => request_app_exit(app)'));
    assert.ok(!tray.includes('QUIT => app.exit(0)'));
});

test('退出流程主动停止取词辅助进程', () => {
    const main = readProjectFile('src-tauri/src/main.rs');
    const selectedText = readProjectFile('src-tauri/src/selected_text.rs');

    assert.ok(main.includes('selected_text::shutdown_selection_helper()'));
    assert.ok(selectedText.includes('pub fn shutdown_selection_helper()'));
    assert.ok(selectedText.includes('sidecar.stop_process()'));
});
