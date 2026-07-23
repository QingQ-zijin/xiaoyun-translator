export const DESKTOP_PLATFORM = Object.freeze({
    WINDOWS: 'windows',
    MACOS: 'macos',
    LINUX: 'linux',
    UNKNOWN: 'unknown',
});

const PLATFORM_PRESENTATIONS = Object.freeze({
    [DESKTOP_PLATFORM.WINDOWS]: Object.freeze({
        name: 'Windows',
        primaryModifier: 'Ctrl',
        speechTitle: 'Windows 本地朗读',
        speechStatus: 'Windows 本地语音',
        speechDescription: '使用系统 SpeechSynthesizer，不再连接 Lingva 或其他网络语音。',
        speechVoicePlaceholder: '自动选择 Windows 声音',
        ollamaInstallDetail: '官方安装程序',
        ollamaDownloadAction: '打开 Ollama 官方下载页',
        ollamaServiceDetail: '本地端口 11434',
        ollamaServiceGuidance: '',
        canStartOllamaService: true,
    }),
    [DESKTOP_PLATFORM.MACOS]: Object.freeze({
        name: 'macOS',
        primaryModifier: '⌘',
        speechTitle: 'macOS 本地朗读',
        speechStatus: 'macOS 本地语音',
        speechDescription: '使用 macOS 系统 say 语音，不再连接 Lingva 或其他网络语音。',
        speechVoicePlaceholder: '自动选择 macOS 声音',
        ollamaInstallDetail: '官方 macOS 应用',
        ollamaDownloadAction: '打开 Ollama macOS 下载页',
        ollamaServiceDetail: '本地端口 11434',
        ollamaServiceGuidance: '',
        canStartOllamaService: true,
    }),
    [DESKTOP_PLATFORM.LINUX]: Object.freeze({
        name: 'Linux',
        primaryModifier: 'Ctrl',
        speechTitle: 'Linux 本地朗读',
        speechStatus: 'Linux 本地语音',
        speechDescription: '使用系统 espeak-ng（兼容 espeak），不再连接 Lingva 或其他网络语音。',
        speechVoicePlaceholder: '自动选择 Linux 声音（需安装 espeak-ng）',
        ollamaInstallDetail: '官方安装脚本或软件包',
        ollamaDownloadAction: '打开 Ollama Linux 安装说明',
        ollamaServiceDetail: '在终端运行 ollama serve',
        ollamaServiceGuidance: '请在终端运行 ollama serve，然后重新检测。',
        canStartOllamaService: false,
    }),
    [DESKTOP_PLATFORM.UNKNOWN]: Object.freeze({
        name: '当前系统',
        primaryModifier: 'Ctrl',
        speechTitle: '系统本地朗读',
        speechStatus: '系统本地语音',
        speechDescription: '使用当前系统可用的本地语音服务，不再连接 Lingva 或其他网络语音。',
        speechVoicePlaceholder: '自动选择系统声音',
        ollamaInstallDetail: 'Ollama 官方安装说明',
        ollamaDownloadAction: '打开 Ollama 官方安装说明',
        ollamaServiceDetail: '按官方说明启动服务',
        ollamaServiceGuidance: '请按 Ollama 官方说明启动服务，然后重新检测。',
        canStartOllamaService: false,
    }),
});

function classifyPlatform(value) {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase();
    if (!normalized) return DESKTOP_PLATFORM.UNKNOWN;
    if (/windows|win32|win64|wince|winnt/u.test(normalized)) return DESKTOP_PLATFORM.WINDOWS;
    if (/macos|macintosh|macintel|macppc|darwin/u.test(normalized)) return DESKTOP_PLATFORM.MACOS;
    if (/android|cros/u.test(normalized)) return DESKTOP_PLATFORM.UNKNOWN;
    if (/linux|x11/u.test(normalized)) return DESKTOP_PLATFORM.LINUX;
    return DESKTOP_PLATFORM.UNKNOWN;
}

/**
 * WebView 中优先使用 User-Agent Client Hints，再回退到传统 platform 与 UA。
 * 函数接受一个 navigator-like 对象，便于在无浏览器的测试环境中稳定验证。
 */
export function detectDesktopPlatform(navigatorLike = globalThis.navigator) {
    const mobileSignature =
        `${navigatorLike?.userAgentData?.platform ?? ''} ${navigatorLike?.userAgent ?? ''}`.toLowerCase();
    if (/android|iphone|ipad|ipod|cros/u.test(mobileSignature)) return DESKTOP_PLATFORM.UNKNOWN;
    const candidates = [navigatorLike?.userAgentData?.platform, navigatorLike?.platform, navigatorLike?.userAgent];
    for (const candidate of candidates) {
        const platform = classifyPlatform(candidate);
        if (platform !== DESKTOP_PLATFORM.UNKNOWN) return platform;
    }
    return DESKTOP_PLATFORM.UNKNOWN;
}

// 每个 WebView 的平台在生命周期内不变；模块级快照避免组件重复解析 UA。
export const desktopPlatform = detectDesktopPlatform();

export function getPlatformPresentation(platform = desktopPlatform) {
    return PLATFORM_PRESENTATIONS[platform] ?? PLATFORM_PRESENTATIONS[DESKTOP_PLATFORM.UNKNOWN];
}

export function formatShortcutForPlatform(shortcut, platform = desktopPlatform) {
    const modifier = getPlatformPresentation(platform).primaryModifier;
    return String(shortcut ?? '')
        .split('+')
        .map((part) => (part.trim().toLowerCase() === 'commandorcontrol' ? modifier : part.trim()))
        .filter(Boolean)
        .join('+');
}
