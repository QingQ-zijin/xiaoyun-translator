import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import * as translationFlow from './translation_flow.js';
import { syncAndDetect } from './translation_flow.js';

let server;
let detectFast;
let detectByScript;

before(async () => {
    Object.defineProperty(globalThis.navigator, 'appVersion', { value: 'Win', configurable: true });
    globalThis.window = {
        __TAURI_METADATA__: {
            __windows: [{ label: 'main' }],
            __currentWindow: { label: 'main' },
        },
    };
    server = await createServer({
        appType: 'custom',
        configFile: false,
        logLevel: 'silent',
        root: process.cwd(),
        server: { middlewareMode: true },
    });
    ({ detectFast, detectByScript } = await server.ssrLoadModule('/src/utils/lang_detect.js'));
});

after(async () => {
    await server?.close();
});

test('划词取词与窗口准备并行，窗口先无激活展示且成功后才提升到前台', async () => {
    const [rustSource, translateSource] = await Promise.all([
        readFile(new URL('../../src-tauri/src/window.rs', import.meta.url), 'utf8'),
        readFile(new URL('../window/Translate/index.jsx', import.meta.url), 'utf8'),
    ]);
    const source = rustSource.replaceAll('\r\n', '\n');
    const selectionTranslate = source.slice(
        source.indexOf('pub fn selection_translate()'),
        source.indexOf('fn dispatch_capture_error')
    );
    const windowsHelper = source.slice(
        source.indexOf('#[cfg(target_os = "windows")]\nfn show_without_activating'),
        source.indexOf('#[cfg(not(target_os = "windows"))]\nfn show_without_activating')
    );
    const nonWindowsHelper = source.slice(
        source.indexOf('#[cfg(not(target_os = "windows"))]\nfn show_without_activating'),
        source.indexOf('fn update_text_state')
    );
    const normalizeHelper = source.slice(
        source.indexOf('fn normalize_translate_window'),
        source.indexOf('fn calculate_translate_window_position')
    );
    const createIndex = selectionTranslate.indexOf('translate_window()');
    const showIndex = selectionTranslate.indexOf('show_without_activating(&window)');
    const captureSpawnIndex = selectionTranslate.indexOf('std::thread::spawn');
    const getTextIndex = selectionTranslate.indexOf('capture_selected_text(');
    const captureResultIndex = source.indexOf('fn handle_selection_capture_result');
    const activateIndex = source.indexOf('activate_translate_window(&window)', captureResultIndex);
    const handleIndex = windowsHelper.indexOf('window.hwnd()');
    const nativeShowIndex = windowsHelper.indexOf('ShowWindow(HWND(hwnd.0 as _), SW_SHOWNOACTIVATE)');
    const handleErrorIndex = windowsHelper.indexOf('Err(');
    const fallbackShowIndex = windowsHelper.indexOf('window.show()');

    assert.ok(createIndex >= 0, '必须创建或复用已经预热的翻译 WebView');
    assert.ok(captureSpawnIndex < createIndex, '后台取词必须在窗口准备前启动');
    assert.ok(getTextIndex > captureSpawnIndex && getTextIndex < createIndex, '取词与窗口准备必须并行');
    assert.ok(showIndex > createIndex, '窗口必须通过专用 helper 无激活显示');
    assert.ok(captureResultIndex >= 0 && activateIndex > captureResultIndex, '取词完成前不得抢占焦点');
    assert.match(
        selectionTranslate,
        /state: "capturing"[\s\S]*show_without_activating\(&window\)/,
        'Ctrl+D 后必须先发布取词状态并立即展示窗口'
    );
    assert.match(
        source.slice(captureResultIndex, source.indexOf('fn show_marker')),
        /Ok\(text\) if !text\.trim\(\)\.is_empty\(\)[\s\S]*?activate_translate_window\(&window\)/,
        '只有非空选区捕获成功后才将窗口提升到前台'
    );
    assert.doesNotMatch(selectionTranslate, /window\.show\(\)/, '划词流程不得直接调用可能激活窗口的 show');
    assert.doesNotMatch(translateSource, /appWindow\.setFocus\(\)/, '前端 new_text 监听器不得重复抢焦点');
    assert.doesNotMatch(
        source,
        /should_present_translation_window|translate_hide_window/,
        '4.x 已删除隐藏式后台翻译分支'
    );
    assert.ok(handleIndex >= 0, 'Windows helper 必须读取原生窗口句柄');
    assert.ok(nativeShowIndex > handleIndex, 'Windows helper 必须使用 SW_SHOWNOACTIVATE');
    assert.ok(handleErrorIndex >= 0 && fallbackShowIndex > handleErrorIndex, '只有句柄获取失败时才能回退 show');
    assert.doesNotMatch(
        normalizeHelper,
        /unmaximize\(|unminimize\(/,
        '窗口准备阶段不得通过恢复窗口状态隐式显示已经关闭的浮窗'
    );
    assert.match(windowsHelper, /unmaximize\(\)[\s\S]*unminimize\(\)/, 'Windows 恢复状态必须留在展示 helper 内');
    assert.match(nonWindowsHelper, /window\.show\(\)/, '非 Windows 平台继续使用普通 show');
});

test('mouse 模式复用时跨屏重定位，pre_state 模式保留已有窗口位置', async () => {
    const source = (await readFile(new URL('../../src-tauri/src/window.rs', import.meta.url), 'utf8')).replaceAll(
        '\r\n',
        '\n'
    );
    const translateWindow = source.slice(
        source.indexOf('fn translate_window()'),
        source.indexOf('fn position_translate_window')
    );
    const positionWindow = source.slice(
        source.indexOf('fn position_translate_window'),
        source.indexOf('#[cfg(target_os = "windows")]\nfn show_without_activating')
    );

    assert.match(
        translateWindow,
        /if let Some\(window\) = app\.get_webview_window\("translate"\)[\s\S]*?position_translate_window\(&window, mouse_x, mouse_y\);[\s\S]*?return Ok\(window\)/,
        '复用窗口时必须根据当前鼠标重新定位'
    );
    assert.match(translateWindow, /\.skip_taskbar\(true\)/, '任务栏属性只在新建窗口时设置');
    assert.match(translateWindow, /\.focused\(false\)/, '窗口准备阶段必须保持未激活');
    assert.doesNotMatch(translateWindow, /set_focus\(|\.focused\(focus\)/, '展示事务提交前不得聚焦快捷翻译窗口');
    assert.match(
        positionWindow,
        /if position_mode == "pre_state"\s*\{\s*return;\s*\}/,
        'pre_state 复用窗口不得按鼠标屏幕 DPI 重算坐标或尺寸'
    );
    assert.match(positionWindow, /current_monitor\(mouse_x, mouse_y\)/, '必须使用鼠标所在显示器');
    assert.match(positionWindow, /window\.set_position/, 'mouse 模式必须更新窗口位置');
    assert.doesNotMatch(positionWindow, /window\.current_monitor\(\)/, '不得沿用窗口原先所在屏幕');
});

test('过期 OCR 请求不能提交文本覆盖较新的选区', async () => {
    assert.equal(typeof translationFlow.commitIfCurrentRequest, 'function');

    const committedText = [];
    const currentRequestId = 2;
    let resolveA;
    let resolveB;
    const requestA = new Promise((resolve) => {
        resolveA = resolve;
    });
    const requestB = new Promise((resolve) => {
        resolveB = resolve;
    });
    const pendingA = requestA.then((text) =>
        translationFlow.commitIfCurrentRequest({
            requestId: 1,
            currentRequestId,
            commit: () => committedText.push(text),
        })
    );
    const pendingB = requestB.then((text) =>
        translationFlow.commitIfCurrentRequest({
            requestId: 2,
            currentRequestId,
            commit: () => committedText.push(text),
        })
    );

    resolveB('B');
    assert.equal(await pendingB, true);
    resolveA('A');
    assert.equal(await pendingA, false);
    assert.deepEqual(committedText, ['B']);
});

test('SourceArea 的划词和 OCR 只提交当前请求文本', async () => {
    const source = (
        await readFile(new URL('../window/Translate/components/SourceArea/index.jsx', import.meta.url), 'utf8')
    ).replaceAll('\r\n', '\n');
    const handleNewText = source.slice(
        source.indexOf('const handleNewText ='),
        source.indexOf('handleNewTextRef.current =')
    );
    const imageBranchStart = handleNewText.indexOf("text === '[IMAGE_TRANSLATE]'");
    const selectionBranchStart = handleNewText.indexOf("setWindowType('[SELECTION_TRANSLATE]')");
    const imageBranch = handleNewText.slice(imageBranchStart, selectionBranchStart);
    const selectionBranch = handleNewText.slice(selectionBranchStart);
    const pluginBranchStart = imageBranch.indexOf('await invoke_plugin');
    const builtinBranchStart = imageBranch.indexOf('recognizeServices[getServiceName(serviceInstanceKey)]');
    const pluginBranch = imageBranch.slice(pluginBranchStart, builtinBranchStart);
    const builtinBranch = imageBranch.slice(builtinBranchStart);
    const clearSyncedSourceIndex = handleNewText.indexOf("syncSourceText('');");
    const clearDetectedLanguageIndex = handleNewText.indexOf("setDetectLanguage('');");
    const recognizeSuccess = source.slice(
        source.indexOf('const handleRecognizedText ='),
        source.indexOf('const handleRecognizeError =')
    );
    const recognizeError = source.slice(
        source.indexOf('const handleRecognizeError ='),
        source.indexOf('const handleNewText =')
    );

    assert.doesNotMatch(imageBranch, /setSourceText\(\s*\(old\)/, 'OCR 不得把本次结果追加到旧状态');
    assert.doesNotMatch(imageBranch, /\bold\s*\+\s*['"] ['"]\s*\+\s*newText/, '不得拼接旧源文');
    assert.match(source, /const commitSourceText = \(newText\) =>/);
    assert.match(source, /const commitSourceTextIfCurrent = \(newText, requestId\) =>/);
    assert.match(
        recognizeSuccess,
        /commitSourceTextIfCurrent\(newText, requestId\)[\s\S]*syncAndDetect\([\s\S]*isCurrent: \(\) => detectRequestRef\.current === requestId/
    );
    assert.match(recognizeError, /commitSourceTextIfCurrent\(error\.toString\(\), requestId\)/);
    assert.ok(
        clearSyncedSourceIndex >= 0 && clearSyncedSourceIndex < clearDetectedLanguageIndex,
        '每次请求必须先清空已同步旧源文，再清空检测语言'
    );
    assert.equal(
        pluginBranch.match(/\(value\) => handleRecognizedText\(value, requestId\)/g)?.length,
        1,
        '插件 OCR 成功出口必须进入当前请求守卫'
    );
    assert.equal(
        pluginBranch.match(/\(error\) => handleRecognizeError\(error, requestId\)/g)?.length,
        1,
        '插件 OCR 失败出口必须进入当前请求守卫'
    );
    assert.match(
        pluginBranch,
        /await invoke_plugin\('recognize', getServiceName\(serviceInstanceKey\)\);\s*if \(detectRequestRef\.current !== requestId\) \{\s*return;\s*\}\s*func\(/,
        '插件初始化完成后必须在启动 OCR 前再次校验请求'
    );
    assert.equal(
        builtinBranch.match(/\(value\) => handleRecognizedText\(value, requestId\)/g)?.length,
        1,
        '内置 OCR 成功出口必须进入当前请求守卫'
    );
    assert.equal(
        builtinBranch.match(/\(error\) => handleRecognizeError\(error, requestId\)/g)?.length,
        1,
        '内置 OCR 失败出口必须进入当前请求守卫'
    );
    assert.match(
        imageBranch,
        /const base64 = await invoke\('get_base64'\);\s*if \(detectRequestRef\.current !== requestId\) \{\s*return;\s*\}/,
        '截图读取完成后必须在启动 OCR 前再次校验请求'
    );
    assert.match(
        imageBranch,
        /text === '\[IMAGE_TRANSLATE\]'[\s\S]*commitSourceText\(''\)/,
        'OCR 等待期间必须提交空源文'
    );
    assert.match(
        selectionBranch,
        /if \(newText === ''\)[\s\S]*commitSourceText\(''\)[\s\S]*return;/,
        '空选区必须提交空源文并停止语言检测'
    );
    assert.match(
        selectionBranch,
        /const nextSourceText = commitSourceText\(newText\);\s*void syncAndDetect\(/,
        '非空选区必须提交本次文本后进入检测'
    );
});

test('4.x 截图翻译开始和失败时都清空上一轮原文与译文', async () => {
    const source = (await readFile(new URL('../window/Translate/index.jsx', import.meta.url), 'utf8')).replaceAll(
        '\r\n',
        '\n'
    );
    const screenshotFlow = source.slice(
        source.indexOf('const handleScreenshot ='),
        source.indexOf('const handleIncomingText =')
    );
    const requestStart = screenshotFlow.slice(0, screenshotFlow.indexOf('try {'));
    const failureBranch = screenshotFlow.slice(screenshotFlow.indexOf('} catch (cause)'));

    assert.match(requestStart, /sourceTextRef\.current = '';\s*setSourceText\(''\);/u);
    assert.match(requestStart, /setError\(''\);\s*setResult\(''\);\s*setState\('recognizing'\);/u);
    assert.match(failureBranch, /sourceTextRef\.current = '';\s*setSourceText\(''\);\s*setResult\(''\);\s*setError/u);
});

test('配置界面不再提供已失效的增量追加设置', async () => {
    const [sourceArea, configPage] = await Promise.all([
        readFile(new URL('../window/Translate/components/SourceArea/index.jsx', import.meta.url), 'utf8'),
        readFile(new URL('../window/Config/pages/Translate/index.jsx', import.meta.url), 'utf8'),
    ]);
    const incrementalConfigHook = /useConfig\(\s*['"]incremental_translate['"]/;

    assert.doesNotMatch(sourceArea, incrementalConfigHook);
    assert.doesNotMatch(configPage, incrementalConfigHook);
    assert.doesNotMatch(sourceArea, /incremental_translate/);
    assert.doesNotMatch(configPage, /incremental_translate/);
});

test('隐藏窗口配置禁止前台展示但允许普通模式展示', () => {
    assert.equal(typeof translationFlow.shouldPresentTranslationWindow, 'function');
    assert.equal(translationFlow.shouldPresentTranslationWindow(true), false);
    assert.equal(translationFlow.shouldPresentTranslationWindow(false), true);
    assert.equal(translationFlow.shouldPresentTranslationWindow(null), true);
});

test('原子关闭 IPC 明确失败时才本地隐藏', async () => {
    const { TRANSLATION_WINDOW_HIDE_EVENT, acceptSelectionRequestId, hideTranslationWindow } = translationFlow;
    assert.equal(typeof TRANSLATION_WINDOW_HIDE_EVENT, 'string');
    assert.equal(typeof hideTranslationWindow, 'function');

    const events = [];
    const target = new EventTarget();
    target.addEventListener(TRANSLATION_WINDOW_HIDE_EVENT, (event) => {
        events.push(`cancel:${event.detail.requestId}`);
    });
    acceptSelectionRequestId(41);
    const dismissed = await hideTranslationWindow(
        {
            hide: async () => {
                events.push('hide');
            },
        },
        target,
        async (requestId) => {
            events.push(`dismiss:${requestId}`);
            throw new Error('IPC unavailable');
        }
    );

    assert.equal(dismissed, true);
    assert.deepEqual(events, ['cancel:41', 'dismiss:41', 'hide']);
});

test('原子关闭成功后在完整点击末尾确认隐藏当前 WebView', async () => {
    const { TRANSLATION_WINDOW_HIDE_EVENT, acceptSelectionRequestId, hideTranslationWindow } = translationFlow;
    const events = [];
    const target = new EventTarget();
    target.addEventListener(TRANSLATION_WINDOW_HIDE_EVENT, (event) => {
        events.push(`cancel:${event.detail.requestId}`);
    });
    acceptSelectionRequestId(44);

    const dismissed = await hideTranslationWindow(
        { hide: async () => events.push('confirm-hide') },
        target,
        async (requestId) => {
            events.push(`dismiss:${requestId}`);
            return true;
        }
    );

    assert.equal(dismissed, true);
    assert.deepEqual(events, ['cancel:44', 'dismiss:44', 'confirm-hide']);
});

test('原生会话已清空但前端仍显示时，本地关闭孤儿窗口', async () => {
    const { acceptSelectionRequestId, hideTranslationWindow } = translationFlow;
    const events = [];
    acceptSelectionRequestId(45);

    const dismissed = await hideTranslationWindow(
        { hide: async () => events.push('hide-orphan') },
        new EventTarget(),
        async () => false
    );

    assert.equal(dismissed, true);
    assert.deepEqual(events, ['hide-orphan']);
});

test('原生关闭 IPC 挂起时在时限内隐藏仍属于当前请求的窗口', async () => {
    const { acceptSelectionRequestId, hideTranslationWindow } = translationFlow;
    const events = [];
    acceptSelectionRequestId(46);

    const dismissed = await hideTranslationWindow(
        { hide: async () => events.push('timeout-hide') },
        new EventTarget(),
        () => new Promise(() => {}),
        5
    );

    assert.equal(dismissed, true);
    assert.deepEqual(events, ['timeout-hide']);
});

test('旧关闭 IPC 挂起时不会通过本地计时器隐藏下一次 Ctrl+D', async () => {
    const { acceptSelectionRequestId, hideTranslationWindow } = translationFlow;
    const events = [];
    let resolveDismiss;
    acceptSelectionRequestId(47);
    const pending = hideTranslationWindow(
        { hide: async () => events.push('hide') },
        new EventTarget(),
        () =>
            new Promise((resolve) => {
                resolveDismiss = resolve;
            })
    );
    await Promise.resolve();
    acceptSelectionRequestId(48);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(events, [], '原生关闭未返回时不得无条件本地隐藏窗口');
    resolveDismiss(false);
    assert.equal(await pending, false);
    assert.deepEqual(events, []);
});

test('失焦自动隐藏不会取消下一次原生取词或后台翻译', async () => {
    const { TRANSLATION_WINDOW_HIDE_EVENT, hideTranslationWindowOnBlur } = translationFlow;
    const events = [];
    const target = new EventTarget();
    target.addEventListener(TRANSLATION_WINDOW_HIDE_EVENT, () => events.push('cancel'));

    await hideTranslationWindowOnBlur({
        hide: async () => {
            events.push('hide');
        },
    });

    assert.deepEqual(events, ['hide']);
});

test('用户主动隐藏链路取消目标翻译而自动隐藏继续后台请求', async () => {
    const [
        appSource,
        flowSource,
        translateSource,
        sourceAreaSource,
        targetAreaSource,
        nativeWindowSource,
        nativeMainSource,
    ] = await Promise.all([
        readFile(new URL('../App.jsx', import.meta.url), 'utf8'),
        readFile(new URL('./translation_flow.js', import.meta.url), 'utf8'),
        readFile(new URL('../window/Translate/index.jsx', import.meta.url), 'utf8'),
        readFile(new URL('../window/Translate/components/SourceArea/index.jsx', import.meta.url), 'utf8'),
        readFile(new URL('../window/Translate/components/TargetArea/index.jsx', import.meta.url), 'utf8'),
        readFile(new URL('../../src-tauri/src/window.rs', import.meta.url), 'utf8'),
        readFile(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8'),
    ]);
    const escapeHandler = sourceAreaSource.slice(
        sourceAreaSource.indexOf('const keyDown ='),
        sourceAreaSource.indexOf('const handleSpeak =')
    );

    assert.equal(translateSource.match(/hideTranslationWindow\(appWindow\)/g)?.length, 1, '关闭按钮必须派发取消事件');
    assert.match(
        translateSource,
        /window\.addEventListener\(TRANSLATION_WINDOW_HIDE_EVENT, handleTranslationWindowHide\)/,
        '当前快捷翻译组件必须监听主动关闭事件'
    );
    assert.match(
        translateSource,
        /handleTranslationWindowHide[\s\S]*?requestGenerationRef\.current \+= 1[\s\S]*?translateAbortRef\.current\?\.abort\(\)/,
        '主动关闭必须使当前请求失效并取消模型生成'
    );
    assert.match(
        translateSource,
        /handleIncomingTextRef\.current\(bootstrap\)/,
        'ready 缓存文本必须连同 requestId 一起交付，不能降级成裸字符串'
    );
    assert.match(
        translateSource,
        /aria-label='关闭翻译窗口'[\s\S]*?onClick=[\s\S]*?requestWindowDismiss\(\)/,
        '关闭按钮必须等待完整 click，再调用原生隐藏'
    );
    assert.doesNotMatch(
        translateSource,
        /aria-label='关闭翻译窗口'[\s\S]{0,400}onPointerDownCapture=/,
        '关闭按钮不得在 pointerdown 捕获阶段隐藏原生窗口'
    );
    assert.match(
        translateSource,
        /hideTranslationWindowOnBlur\(appWindow\)/,
        '失焦自动隐藏不得取消刚开始的下一次原生取词'
    );
    assert.match(escapeHandler, /void hideTranslationWindow\(appWindow\);/);
    assert.equal(
        appSource.match(/label === 'translate'[\s\S]*?hideTranslationWindow\(appWindow\)/g)?.length,
        1,
        '全局 Esc 处理必须隐藏并复用翻译 WebView，不能销毁预热窗口'
    );
    assert.match(appSource, /removeEventListener\('keydown', handleKeyDown\)/, '配置重载不得累积全局按键监听器');
    assert.match(
        flowSource,
        /invoke\('dismiss_translate_window', \{ requestId \}\)/,
        '关闭必须使用带请求 ID 的原子命令'
    );
    assert.match(
        nativeWindowSource,
        /static TRANSLATE_PRESENTED_REQUEST_ID: AtomicU64/,
        '当前展示会话必须与后台取词代次独立记录'
    );
    assert.match(
        nativeWindowSource,
        /pub fn dismiss_translate_window\([\s\S]*?dismiss_presented_request\([\s\S]*?hide_translate_window_verified\(&window\)[\s\S]*?cancel_selection_generation/,
        '关闭必须先验证展示会话已经隐藏，再尽力取消仍属于该会话的取词'
    );
    assert.match(
        nativeWindowSource,
        /fn hide_translate_window_verified\([\s\S]*?ShowWindow\(hwnd, SW_HIDE\)[\s\S]*?IsWindowVisible\(hwnd\)/,
        'Windows 关闭必须以 HWND 可见性为准，不能只相信 WebView hide 返回值'
    );
    assert.match(
        nativeWindowSource,
        /fn schedule_translate_window_recovery\([\s\S]*?TRANSLATE_PRESENTATION_TRANSACTION[\s\S]*?translate_request_is_presented\(generation\)[\s\S]*?show_without_activating/,
        'WebView 恢复的最终校验与显示必须和主动关闭串行'
    );
    assert.match(nativeMainSource, /dismiss_translate_window,/);
    assert.match(
        sourceAreaSource,
        /if \(!shouldPresentTranslationWindow\(hideWindow\)\) \{\s*appWindow\.hide\(\);/,
        '配置驱动的自动隐藏不得取消后台翻译'
    );
    assert.match(
        targetAreaSource,
        /window\.addEventListener\(TRANSLATION_WINDOW_HIDE_EVENT, cancelPendingTranslation\);/
    );
    assert.match(
        targetAreaSource,
        /translateID\[index\] = nanoid\(\);\s*cancelActiveTranslation\(\);\s*setIsLoading\(false\);/
    );
    assert.match(targetAreaSource, /cancelTranslationRef\.current\?\.\(\);/);
    assert.match(targetAreaSource, /registerCancel,/);
    assert.match(
        targetAreaSource,
        /window\.removeEventListener\(TRANSLATION_WINDOW_HIDE_EVENT, cancelPendingTranslation\);/
    );
});

test('SourceArea 在用户主动隐藏时同步使待定语言检测失效', async () => {
    const source = await readFile(
        new URL('../window/Translate/components/SourceArea/index.jsx', import.meta.url),
        'utf8'
    );
    const cancellationEffectStart = source.indexOf('const cancelPendingDetection =');
    const cancellationEffectEnd = source.indexOf('useEffect(() => {', cancellationEffectStart);
    const cancellationEffect = source.slice(cancellationEffectStart, cancellationEffectEnd);

    assert.ok(cancellationEffectStart >= 0, 'SourceArea 必须声明语言检测取消监听器');
    assert.match(
        cancellationEffect,
        /const cancelPendingDetection = \(\) => \{\s*detectRequestRef\.current\+\+;\s*\};/
    );
    assert.match(
        cancellationEffect,
        /window\.addEventListener\(TRANSLATION_WINDOW_HIDE_EVENT, cancelPendingDetection\);/
    );
    assert.match(
        cancellationEffect,
        /window\.removeEventListener\(TRANSLATION_WINDOW_HIDE_EVENT, cancelPendingDetection\);/
    );
});

test('快速检测只把较长且具有多个明确简体特征和功能标记的中文识别为简中', () => {
    assert.equal(detectFast('这是一个关于代谢研究的详细说明，我们将在实验中进行验证。'), 'zh_cn');
    assert.equal(detectFast('这些学生正在学习现代科学，他们会进行实验并验证结果。'), 'zh_cn');
    for (const text of [
        '你好',
        '這是一個關於代謝研究的詳細說明，我們會在實驗中進行驗證。',
        '皇后是國王的妻子，也是王室的重要成員。',
        '這個社區的里長也是居民的重要代表。',
        '古書云這是重要的記錄，也是後人的共同記憶。',
        '這是王室的重要说明，也是成員的共同記錄。',
        '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏',
    ]) {
        assert.equal(detectFast(text), '', text);
    }
});

test('快速检测优先通过假名和谚文识别日文与韩文', () => {
    assert.equal(detectFast('これは代謝研究です'), 'ja');
    assert.equal(detectFast('이것은 대사 연구입니다'), 'ko');
});

test('快速检测立即识别 ASCII 科研英文与带 Unicode 破折号的短术语', () => {
    assert.equal(detectFast('This is a useful test for the translation window.'), 'en');
    assert.equal(detectFast('translation into the clinic has been slow'), 'en');
    assert.equal(detectFast('Michaelis–Menten'), 'en');
    assert.equal(detectFast('alpha bravo charlie delta echo foxtrot'), '');
});

test('只即时识别明确英文短词，其他拉丁短词留给后台检测校正', () => {
    assert.equal(detectFast('hello'), 'en');
    assert.equal(detectFast('steady state'), 'en');
    assert.equal(detectFast('translation'), '');
    assert.equal(detectFast('hola'), '');
    assert.equal(detectFast('bonjour'), '');
    assert.equal(detectFast('esto es un test a escala'), '');
    assert.equal(detectFast('il a un role important'), '');
    assert.equal(detectFast('café déjà vu'), '');
    assert.equal(detectFast('rendez-vous'), '');
    assert.equal(detectFast('Kosten-Nutzen'), '');
    assert.equal(detectFast('estado-estable'), '');
});

test('网络失败时按文字系统提供保守语言回退', () => {
    assert.equal(detectByScript('你好'), 'zh_cn');
    assert.equal(detectByScript('Michaelis–Menten'), 'en');
    assert.equal(detectByScript('Привет'), 'ru');
    assert.equal(detectByScript('こんにちは'), 'ja');
});

test('无可靠快速结果时只等待一次检测，再以正确语言启动翻译', async () => {
    const events = [];
    let resolveDetection;
    const detection = new Promise((resolve) => {
        resolveDetection = resolve;
    });

    const pending = syncAndDetect({
        text: 'hello',
        sync: (value) => events.push(`sync:${value ?? 'current'}`),
        detect: async () => detection,
        setDetected: (language) => events.push(`detected:${language}`),
    });

    assert.deepEqual(events, []);
    resolveDetection('en');
    await pending;
    assert.deepEqual(events, ['detected:en', 'sync:current']);
});

test('优先使用本地快速语言结果启动翻译', async () => {
    const events = [];
    const pending = syncAndDetect({
        text: 'hello',
        sync: () => events.push('sync'),
        detectFast: () => 'en',
        detect: async () => 'en',
        setDetected: (language) => events.push(`detected:${language}`),
    });

    assert.deepEqual(events, ['detected:en', 'sync']);
    await pending;
    assert.deepEqual(events, ['detected:en', 'sync']);
});

test('快速检测结果会被仍有效的不同后台结果校正', async () => {
    const events = [];

    await syncAndDetect({
        text: 'This is a useful translation example.',
        sync: () => events.push('sync'),
        detectFast: () => 'en',
        detect: async () => 'es',
        setDetected: (language) => events.push(`detected:${language}`),
        isCurrent: () => true,
    });

    assert.deepEqual(events, ['detected:en', 'sync', 'detected:es']);
});

test('用户隐藏后无快速结果不得再启动翻译或写入语言', async () => {
    const events = [];
    const target = new EventTarget();
    let currentRequest = 1;
    const requestId = currentRequest;
    let resolveDetection;
    const detection = new Promise((resolve) => {
        resolveDetection = resolve;
    });
    target.addEventListener(translationFlow.TRANSLATION_WINDOW_HIDE_EVENT, () => {
        currentRequest++;
    });

    const pending = syncAndDetect({
        text: 'hola',
        sync: () => events.push('sync'),
        detectFast: () => '',
        detect: async () => detection,
        setDetected: (language) => events.push(`detected:${language}`),
        isCurrent: () => currentRequest === requestId,
    });
    target.dispatchEvent(new Event(translationFlow.TRANSLATION_WINDOW_HIDE_EVENT));
    resolveDetection('es');
    await pending;

    assert.deepEqual(events, []);
});

test('用户隐藏后快速结果的后台校正不再覆盖已启动的翻译', async () => {
    const events = [];
    const target = new EventTarget();
    let currentRequest = 1;
    const requestId = currentRequest;
    let resolveDetection;
    const detection = new Promise((resolve) => {
        resolveDetection = resolve;
    });
    target.addEventListener(translationFlow.TRANSLATION_WINDOW_HIDE_EVENT, () => {
        currentRequest++;
    });

    const pending = syncAndDetect({
        text: 'This is a useful translation example.',
        sync: () => events.push('sync'),
        detectFast: () => 'en',
        detect: async () => detection,
        setDetected: (language) => events.push(`detected:${language}`),
        isCurrent: () => currentRequest === requestId,
    });
    assert.deepEqual(events, ['detected:en', 'sync']);
    target.dispatchEvent(new Event(translationFlow.TRANSLATION_WINDOW_HIDE_EVENT));
    resolveDetection('es');
    await pending;

    assert.deepEqual(events, ['detected:en', 'sync']);
});

test('A 慢 B 快时只有当前 B 在检测完成后启动翻译', async () => {
    const events = [];
    let currentRequest = 1;
    let resolveA;
    const detectionA = new Promise((resolve) => {
        resolveA = resolve;
    });
    const pendingA = syncAndDetect({
        text: 'A',
        sync: () => events.push('sync:A'),
        detect: async () => detectionA,
        setDetected: (language) => events.push(`detected:A:${language}`),
        isCurrent: () => currentRequest === 1,
    });

    currentRequest = 2;
    await syncAndDetect({
        text: 'B',
        sync: () => events.push('sync:B'),
        detect: async () => 'es',
        setDetected: (language) => events.push(`detected:B:${language}`),
        isCurrent: () => currentRequest === 2,
    });
    resolveA('en');
    await pendingA;

    assert.deepEqual(events, ['detected:B:es', 'sync:B']);
});

test('无快速结果且检测失败时先设置脚本回退语言再同步', async () => {
    const events = [];
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        await syncAndDetect({
            text: 'hola',
            sync: () => events.push('sync'),
            detectFast: () => '',
            detectFallback: () => 'zh_cn',
            detect: async () => {
                throw new Error('network unavailable');
            },
            setDetected: (language) => events.push(`detected:${language}`),
            isCurrent: () => true,
        });
    } finally {
        console.warn = originalWarn;
    }

    assert.deepEqual(events, ['detected:zh_cn', 'sync']);
});

test('SourceArea 的长期监听器通过请求状态和运行期配置处理新文本', async () => {
    const source = await readFile(
        new URL('../window/Translate/components/SourceArea/index.jsx', import.meta.url),
        'utf8'
    );
    const listenerEffectStart = source.indexOf("listen('new_text'");
    const listenerEffectEnd = source.indexOf('useEffect(() => {', listenerEffectStart);
    const listenerEffect = source.slice(listenerEffectStart, listenerEffectEnd);

    assert.match(source, /const detectRequestRef = useRef\(0\);/);
    assert.match(source, /const handleNewTextRef = useRef\(\);/);
    assert.match(source, /const requestId = \+\+detectRequestRef\.current;/);
    assert.match(
        source,
        /const commitSourceText = \(newText\) => \{\s*setSourceText\(newText\);\s*return newText;\s*\};/
    );
    assert.match(source, /const commitSourceTextIfCurrent = \(newText, requestId\) =>/);
    assert.doesNotMatch(source, /incrementalTranslate/);
    assert.doesNotMatch(source, /sourceTextRef/);
    assert.match(
        source,
        /const nextSourceText = commitSourceText\(newText\);[\s\S]*sync: \(\) => syncSourceText\(nextSourceText\),[\s\S]*isCurrent: \(\) => detectRequestRef\.current === requestId,/
    );
    assert.match(source, /handleNewTextRef\.current = handleNewText;/);
    assert.match(listenerEffect, /handleNewTextRef\.current\(event\.payload\?\.text \?\? event\.payload\);/);
    assert.doesNotMatch(listenerEffect, /\bhandleNewText\(event\.payload\);/);
    assert.match(listenerEffect, /\}, \[hideWindow\]\);/);
    assert.doesNotMatch(listenerEffect, /\[[^\]]*sourceText[^\]]*\]/);
});

test('TargetArea 在后台语言校正后重新启动受 translateID 保护的翻译', async () => {
    const source = await readFile(
        new URL('../window/Translate/components/TargetArea/index.jsx', import.meta.url),
        'utf8'
    );
    const translationEffect = source.slice(
        source.indexOf('// listen to translation'),
        source.indexOf('// todo: history panel')
    );
    const dependencies = translationEffect.slice(translationEffect.lastIndexOf('}, ['));

    assert.match(dependencies, /\bdetectLanguage\b/);
    assert.match(source, /translateID\[index\] = id;/);
});

test('TargetArea 在源文变化时立即使旧翻译请求失效', async () => {
    const source = await readFile(
        new URL('../window/Translate/components/TargetArea/index.jsx', import.meta.url),
        'utf8'
    );
    const translationEffect = source.slice(
        source.indexOf('// listen to translation'),
        source.indexOf('// todo: history panel')
    );
    const invalidateIndex = translationEffect.indexOf('translateID[index] = nanoid();');
    const sourceBranchIndex = translationEffect.indexOf("sourceText.trim() !== ''");

    assert.ok(invalidateIndex >= 0, '每次源文变化都必须生成失效 ID');
    assert.ok(invalidateIndex < sourceBranchIndex, '空源文判断前必须先使旧请求失效');
    assert.match(
        translationEffect,
        /translateID\[index\] = nanoid\(\);\s*cancelActiveTranslation\(\);\s*setIsLoading\(false\);/,
        '清空源文时必须同时停止旧请求的加载状态'
    );
});

test('TargetArea 回译使用独立 translateID 保护插件和内置服务的全部异步出口', async () => {
    const source = await readFile(
        new URL('../window/Translate/components/TargetArea/index.jsx', import.meta.url),
        'utf8'
    );
    const translateBack = source.slice(
        source.indexOf('{/* translate back button */}'),
        source.indexOf('{/* error retry button */}')
    );
    const pluginStart = translateBack.indexOf('if (whetherPluginService(currentTranslateServiceInstanceKey))');
    const builtinStart = translateBack.indexOf('const LanguageEnum =');
    const pluginBranch = translateBack.slice(pluginStart, builtinStart);
    const builtinBranch = translateBack.slice(builtinStart);
    const requestAssignmentIndex = translateBack.indexOf('const id = nanoid();');

    assert.ok(requestAssignmentIndex >= 0, '每次回译点击必须生成独立请求 ID');
    assert.ok(
        translateBack.indexOf('cancelActiveTranslation();') < requestAssignmentIndex,
        '回译开始前必须取消仍在运行的正向翻译'
    );
    assert.ok(
        translateBack.indexOf('translateID[index] = id;', requestAssignmentIndex) > requestAssignmentIndex,
        '回译请求必须立即写入当前槽位，使旧正向或回译请求失效'
    );
    assert.ok(pluginStart > requestAssignmentIndex, '请求 ID 必须在选择服务分支前写入');

    for (const [name, branch] of [
        ['插件', pluginBranch],
        ['内置', builtinBranch],
    ]) {
        assert.equal(
            branch.match(/if \(translateID\[index\] !== id\) return;/g)?.length,
            3,
            `${name}回译的流式写入、resolve、reject 必须分别校验请求 ID`
        );
        assert.match(
            branch,
            /setResult: \(v\) => \{\s*if \(translateID\[index\] !== id\) return;\s*setResult\(v\);/,
            `${name}回译的流式结果必须先校验请求 ID`
        );
        assert.match(
            branch,
            /\.then\(\s*\(v\) => \{\s*if \(translateID\[index\] !== id\) return;/,
            `${name}回译 resolve 必须先校验请求 ID`
        );
        assert.match(
            branch,
            /\(e\) => \{\s*if \(translateID\[index\] !== id\) return;\s*registerBackCancel\(null\);\s*setError\(e\.toString\(\)\);/,
            `${name}回译 reject 必须先校验请求 ID`
        );
        assert.match(branch, /registerCancel: registerBackCancel/, `${name}回译必须接入停止按钮的取消生命周期`);
    }
});

test('源文与译文朗读共享同一请求闸门，跨组件旧响应不能覆盖新播放', async () => {
    const [sourceArea, targetArea, voiceHook] = await Promise.all([
        readFile(new URL('../window/Translate/components/SourceArea/index.jsx', import.meta.url), 'utf8'),
        readFile(new URL('../window/Translate/components/TargetArea/index.jsx', import.meta.url), 'utf8'),
        readFile(new URL('../hooks/useVoice.jsx', import.meta.url), 'utf8'),
    ]);

    assert.match(sourceArea, /useSpeechRequest/);
    assert.match(targetArea, /useSpeechRequest/);
    assert.doesNotMatch(sourceArea, /createSpeechRequestGate/);
    assert.doesNotMatch(targetArea, /createSpeechRequestGate/);
    assert.match(voiceHook, /const sharedSpeechRequestGate = createSpeechRequestGate\(playOrStop\)/);
    assert.match(voiceHook, /export const useSpeechRequest/);
});
