import { describe, expect, it } from 'vitest';

import {
    DESKTOP_PLATFORM,
    detectDesktopPlatform,
    formatShortcutForPlatform,
    getPlatformPresentation,
} from './platform';

describe('桌面平台检测', () => {
    it.each([
        [{ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' }, DESKTOP_PLATFORM.WINDOWS],
        [{ platform: 'Win32' }, DESKTOP_PLATFORM.WINDOWS],
        [{ platform: 'MacIntel' }, DESKTOP_PLATFORM.MACOS],
        [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)' }, DESKTOP_PLATFORM.MACOS],
        [{ userAgentData: { platform: 'Linux' } }, DESKTOP_PLATFORM.LINUX],
        [{ platform: 'X11; Linux x86_64' }, DESKTOP_PLATFORM.LINUX],
    ])('按可靠性顺序把 WebView navigator 归一化：%o', (navigatorLike, expected) => {
        expect(detectDesktopPlatform(navigatorLike)).toBe(expected);
    });

    it('无法识别或缺少 navigator 时安全回退到 unknown', () => {
        expect(detectDesktopPlatform(null)).toBe(DESKTOP_PLATFORM.UNKNOWN);
        expect(detectDesktopPlatform({ platform: 'iPhone', userAgent: 'Mobile Safari' })).toBe(
            DESKTOP_PLATFORM.UNKNOWN
        );
        expect(
            detectDesktopPlatform({
                userAgentData: { platform: 'Android' },
                platform: 'Linux armv8l',
                userAgent: 'Mozilla/5.0 (Linux; Android 15)',
            })
        ).toBe(DESKTOP_PLATFORM.UNKNOWN);
        expect(getPlatformPresentation('unexpected')).toEqual(
            expect.objectContaining({
                name: '当前系统',
                canStartOllamaService: false,
            })
        );
    });
});

describe('平台文案', () => {
    it('macOS 将 CommandOrControl 显示为 ⌘', () => {
        expect(formatShortcutForPlatform('CommandOrControl+D', DESKTOP_PLATFORM.MACOS)).toBe('⌘+D');
        expect(formatShortcutForPlatform('CommandOrControl+Shift+Enter', DESKTOP_PLATFORM.MACOS)).toBe('⌘+Shift+Enter');
    });

    it.each([DESKTOP_PLATFORM.WINDOWS, DESKTOP_PLATFORM.LINUX, DESKTOP_PLATFORM.UNKNOWN])(
        '%s 将 CommandOrControl 显示为 Ctrl',
        (platform) => {
            expect(formatShortcutForPlatform('CommandOrControl+E', platform)).toBe('Ctrl+E');
        }
    );

    it('为三个桌面系统提供准确的系统朗读与 Ollama 能力提示', () => {
        expect(getPlatformPresentation(DESKTOP_PLATFORM.WINDOWS)).toEqual(
            expect.objectContaining({
                speechTitle: 'Windows 本地朗读',
                ollamaInstallDetail: '官方安装程序',
                canStartOllamaService: true,
            })
        );
        expect(getPlatformPresentation(DESKTOP_PLATFORM.MACOS)).toEqual(
            expect.objectContaining({
                speechTitle: 'macOS 本地朗读',
                ollamaInstallDetail: '官方 macOS 应用',
                canStartOllamaService: true,
            })
        );
        expect(getPlatformPresentation(DESKTOP_PLATFORM.LINUX)).toEqual(
            expect.objectContaining({
                speechTitle: 'Linux 本地朗读',
                ollamaServiceGuidance: '请在终端运行 ollama serve，然后重新检测。',
                canStartOllamaService: false,
            })
        );
    });
});
