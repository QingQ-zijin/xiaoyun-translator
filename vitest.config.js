import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['src/**/*.vitest.{js,jsx}'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary'],
            // 对可独立验证的核心纯函数执行严格覆盖率门禁；React/Tauri 集成路径
            // 由桌面 E2E、Rust 集成测试和真实 PDF 交互验收覆盖。
            include: [
                'src/domains/translation/desktopTransport.js',
                'src/domains/translation/language.js',
                'src/domains/research/model.js',
                'src/window/Research/pdfInteractions.js',
                'src/window/Main/navigation.js',
                'src/window/Main/settings.js',
            ],
            thresholds: {
                lines: 90,
                functions: 90,
                statements: 90,
                branches: 80,
            },
        },
    },
});
