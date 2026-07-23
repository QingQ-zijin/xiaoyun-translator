import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readRust = (name) => readFile(new URL(`../../src-tauri/src/${name}`, import.meta.url), 'utf8');
const readFrontend = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('Ctrl+D 先显示预热窗口，再等待异步取词结果', async () => {
    const source = await readRust('window.rs');
    const selectionTranslate = source.slice(
        source.indexOf('pub fn selection_translate()'),
        source.indexOf('fn dispatch_capture_error')
    );

    assert.match(selectionTranslate, /capture_selected_text/);
    assert.match(selectionTranslate, /translate_window\(\)/);
    assert.match(selectionTranslate, /show_without_activating\(&window\)/);
    assert.match(selectionTranslate, /schedule_translate_window_recovery\(generation\)/);
    assert.match(selectionTranslate, /window_receiver\.recv\(\)/);
    assert.ok(
        selectionTranslate.indexOf('capture_selected_text') < selectionTranslate.indexOf('translate_window()'),
        '后台取词必须与窗口准备并行启动'
    );
    assert.equal(selectionTranslate.match(/std::thread::spawn/g)?.length, 1, '每次 Ctrl+D 只允许创建一个等待线程');
    assert.match(selectionTranslate, /SELECTION_REQUEST_GENERATION/);
    assert.doesNotMatch(selectionTranslate, /emit\("new_text",\s*""\)/);
});

test('窗口 ready 握手只派发最后一次缓存请求', async () => {
    const [source, translateSource] = await Promise.all([
        readRust('window.rs'),
        readFrontend('window/Translate/index.jsx'),
    ]);
    assert.match(source, /static TRANSLATE_WINDOW_READY: AtomicBool/);
    assert.match(source, /static PENDING_TRANSLATE_EVENT/);
    assert.match(
        source,
        /pub fn translate_window_ready\([\s\S]*?window: WebviewWindow[\s\S]*?Option<PendingTranslateEvent>/
    );
    assert.match(source, /PENDING_TRANSLATE_EVENT[\s\S]*?\.take\(\)/);
    assert.match(
        source,
        /pending\.filter\(\|event\| translate_request_is_presented\(event\.request_id\)\)/,
        'ready 只能重放当前实际展示会话，关闭后的缓存不得复活'
    );
    assert.match(source, /selection_capture_state/);
    assert.match(
        source,
        /\.on_page_load\([\s\S]*?PageLoadEvent::Started[\s\S]*?TRANSLATE_WINDOW_READY\.store\(false/,
        '每次 WebView 加载都必须废弃旧 ready 状态'
    );

    const listenerSetup = translateSource.slice(
        translateSource.indexOf('const setupEventListeners'),
        translateSource.indexOf('return () =>', translateSource.indexOf('const setupEventListeners'))
    );
    assert.match(listenerSetup, /const requiredUnlisteners = await Promise\.all/);
    assert.ok(
        listenerSetup.indexOf('await Promise.all') < listenerSetup.indexOf("await invoke('translate_window_ready')"),
        '必须先建立全部监听器，再通知 Rust 冲刷缓存'
    );
    assert.match(translateSource, /handleIncomingTextRef\.current/);
    assert.match(translateSource, /bootstrap = await invoke\('translate_window_ready'\)/);
    assert.match(
        translateSource,
        /if \(bootstrap\.text\) await handleIncomingTextRef\.current\(bootstrap\)/,
        'ready 缓存必须保留 requestId，避免关闭后的旧文本重新进入翻译'
    );
});

test('快捷翻译窗口紧凑跟随鼠标、可拖动且新请求废弃旧失焦计时器', async () => {
    const [windowSource, translateSource, capabilitySource] = await Promise.all([
        readRust('window.rs'),
        readFrontend('window/Translate/index.jsx'),
        readFile(new URL('../../src-tauri/capabilities/migrated.json', import.meta.url), 'utf8'),
    ]);

    assert.match(windowSource, /const TRANSLATE_WINDOW_WIDTH: f64 = 420\.0;/);
    assert.match(windowSource, /const TRANSLATE_WINDOW_HEIGHT: f64 = 360\.0;/);
    assert.match(windowSource, /static TRANSLATE_WINDOW_TRANSACTION: Lazy<Mutex<\(\)>>/);
    assert.match(windowSource, /TRANSLATE_WINDOW_RECOVERY_DELAY/);
    assert.match(windowSource, /WebView 超过 1 秒未 ready/);
    assert.match(windowSource, /normalize_translate_window\(&window\)/);
    assert.match(windowSource, /monitor\.work_area\(\)/);
    assert.match(windowSource, /TRANSLATE_WINDOW_CURSOR_GAP/);
    assert.match(windowSource, /window\.unmaximize\(\)/);
    assert.match(windowSource, /window\.set_size/);
    assert.match(translateSource, /data-tauri-drag-region='true'/);
    assert.match(translateSource, /appWindow\.startDragging\(\)/);
    assert.match(translateSource, /const presentationGenerationRef = useRef\(0\);/);
    assert.match(translateSource, /presentationGenerationRef\.current \+= 1;/);
    assert.match(
        translateSource,
        /presentationGeneration === presentationGenerationRef\.current &&[\s\S]*?!busyRef\.current/
    );
    assert.match(capabilitySource, /core:window:allow-start-dragging/);
});

test('取词彻底移除第三方 OLE IDataObject 恢复路径', async () => {
    const source = await readRust('selected_text.rs');
    assert.match(source, /OleInitialize/);
    assert.doesNotMatch(source, /OleGetClipboard/);
    assert.doesNotMatch(source, /OleSetClipboard/);
    assert.doesNotMatch(source, /OleFlushClipboard/);
    assert.doesNotMatch(source, /IDataObject/);
});

test('独立 helper 在唯一 STA worker 中使用 latest-wins 队列和 800ms 上限', async () => {
    const [source, windowSource] = await Promise.all([readRust('selected_text.rs'), readRust('window.rs')]);
    assert.match(source, /selection-helper-sta/);
    assert.match(source, /struct SelectionSidecar/);
    assert.match(source, /request_id: u64/);
    assert.match(source, /pending: Option<CaptureRequest>/);
    assert.match(source, /latest_request: AtomicU64/);
    assert.match(source, /inbox\.pending\.replace\(capture\)/);
    assert.match(source, /SELECTION_TIMEOUT: Duration = Duration::from_millis\(800\)/);
    assert.match(source, /catch_unwind/);
    assert.match(source, /pub fn prewarm_selection_helper\(\)/);
    assert.match(source, /fn prewarm\(&self\)[\s\S]*?ensure_sidecar_running/);
    const windowPrewarm = windowSource.slice(
        windowSource.indexOf('pub fn prewarm_translate_window()'),
        windowSource.indexOf('#[tauri::command]', windowSource.indexOf('pub fn prewarm_translate_window()'))
    );
    assert.ok(
        windowPrewarm.indexOf('prewarm_selection_helper()') < windowPrewarm.indexOf('match translate_window()'),
        '启动时必须先拉起 helper，再预热翻译窗口'
    );
});

test('模拟复制使用短预算优先执行，UIA 只作为兜底', async () => {
    const source = await readRust('selected_text.rs');
    const runtime = source.slice(
        source.indexOf('impl WindowsCaptureRuntime'),
        source.indexOf('fn capture_by_automation', source.indexOf('impl WindowsCaptureRuntime'))
    );
    assert.match(source, /CLIPBOARD_FAST_TIMEOUT: Duration = Duration::from_millis\(420\)/);
    assert.match(runtime, /deadline\.min\(Instant::now\(\) \+ CLIPBOARD_FAST_TIMEOUT\)/);
    assert.ok(
        runtime.indexOf('capture_by_clipboard') < runtime.indexOf('capture_by_automation'),
        '不可取消的 UIA COM 调用不得阻塞模拟复制快速路径'
    );
    assert.match(runtime, /Err\(SelectionError::Cancelled\) => return Err\(SelectionError::Cancelled\)/);
});

test('Ctrl+E 先安装单次成功监听，再由截图解码完成后显示覆盖层', async () => {
    const [windowSource, screenshotSource] = await Promise.all([
        readRust('window.rs'),
        readFrontend('window/Screenshot/index.jsx'),
    ]);
    const ocrTranslate = windowSource.slice(
        windowSource.indexOf('pub fn ocr_translate()'),
        windowSource.indexOf('#[cfg(test)]', windowSource.indexOf('pub fn ocr_translate()'))
    );
    assert.match(ocrTranslate, /window\.once\("success"/);
    assert.match(windowSource, /保持隐藏，直到前端拿到完整截图并完成图片解码/);
    assert.match(screenshotSource, /onLoad={[\s\S]*?appWindow\.show\(\)/);
    assert.match(screenshotSource, /截图失败/);
});

test('剪贴板只恢复进程拥有的标准格式字节', async () => {
    const source = await readRust('selected_text.rs');
    for (const format of ['CF_UNICODETEXT', 'HTML Format', 'Rich Text Format', 'CF_DIB', 'CF_DIBV5', 'CF_HDROP']) {
        assert.match(source, new RegExp(format));
    }
    assert.match(source, /struct OwnedGlobalMemory/);
    assert.match(source, /from_bytes/);
    assert.match(source, /OpenClipboard 有界重试/);
});

test('模拟复制会释放常见修饰键和默认热键主键，随后只发送 Ctrl+C', async () => {
    const source = await readRust('selected_text.rs');
    assert.match(source, /Key::Control,[\s\S]*Key::Alt,[\s\S]*Key::Shift/);
    assert.match(source, /Key::D/);
    assert.match(source, /\.key\(Key::C, Click\)/);
    assert.match(source, /const COPY_RETRY_POLL: usize = 5/);
});
