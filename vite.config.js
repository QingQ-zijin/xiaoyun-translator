import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url));

export const PDFJS_WASM_PUBLIC_PATH = '/pdfjs-wasm/';
export const PDFJS_WASM_DIRECTORY = resolve(PROJECT_ROOT, 'node_modules/pdfjs-dist/wasm');

async function readAssetDirectory(directory, prefix = '') {
    const assets = [];
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolutePath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            assets.push(...(await readAssetDirectory(absolutePath, relativePath)));
        } else if (entry.isFile()) {
            assets.push({ fileName: relativePath, source: await readFile(absolutePath) });
        }
    }

    return assets;
}

export function readPdfjsWasmAssets(directory = PDFJS_WASM_DIRECTORY) {
    return readAssetDirectory(directory);
}

function getAssetContentType(fileName) {
    if (extname(fileName).toLowerCase() === '.wasm') return 'application/wasm';
    if (extname(fileName).toLowerCase() === '.js') return 'text/javascript; charset=utf-8';
    return 'text/plain; charset=utf-8';
}

/**
 * 开发服务器直接提供 PDF.js 解码文件，生产构建则把同一批文件写入固定目录。
 */
export function createPdfjsWasmAssetsPlugin({
    directory = PDFJS_WASM_DIRECTORY,
    publicPath = PDFJS_WASM_PUBLIC_PATH,
} = {}) {
    const normalizedPublicPath = `/${String(publicPath).replace(/^\/+|\/+$/gu, '')}/`;
    const outputPrefix = normalizedPublicPath.slice(1);
    let assetsPromise;
    const getAssets = () => {
        assetsPromise ??= readPdfjsWasmAssets(directory);
        return assetsPromise;
    };

    return {
        name: 'xiaoyun-pdfjs-wasm-assets',
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                let pathname;
                try {
                    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
                } catch {
                    next();
                    return;
                }
                if (!pathname.startsWith(normalizedPublicPath)) {
                    next();
                    return;
                }

                const requestedFile = pathname.slice(normalizedPublicPath.length);
                void getAssets()
                    .then((assets) => {
                        const asset = assets.find(({ fileName }) => fileName === requestedFile);
                        if (!asset) {
                            next();
                            return;
                        }
                        response.statusCode = 200;
                        response.setHeader('Content-Type', getAssetContentType(asset.fileName));
                        response.setHeader('Cache-Control', 'no-cache');
                        response.end(asset.source);
                    })
                    .catch(next);
            });
        },
        async generateBundle() {
            const assets = await getAssets();
            for (const asset of assets) {
                this.emitFile({
                    type: 'asset',
                    fileName: `${outputPrefix}${asset.fileName}`,
                    source: asset.source,
                });
            }
        },
    };
}

// https://vitejs.dev/config/
export default defineConfig(async () => ({
    plugins: [react(), createPdfjsWasmAssetsPlugin()],

    // PDF.js 自带 ESM worker；让浏览器按需加载，避免开发服务器预打包整套 PDF 引擎。
    optimizeDeps: {
        exclude: ['pdfjs-dist', 'pdfjs-dist/build/pdf.mjs'],
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    // prevent vite from obscuring rust errors
    clearScreen: false,
    // tauri expects a fixed port, fail if that port is not available
    server: {
        port: 1420,
        strictPort: true,
    },
    // to make use of `TAURI_DEBUG` and other env variables
    // https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
        rollupOptions: {
            input: {
                index: resolve(PROJECT_ROOT, 'index.html'),
                daemon: resolve(PROJECT_ROOT, 'daemon.html'),
            },
        },
        // 当前产品只面向 Windows。直接锁定 WebView2 的 Chromium 目标，避免在
        // 手工执行 `pnpm build` 时因 TAURI_PLATFORM 未注入而错误降级到 Safari 11。
        target: 'chrome105',
        // don't minify for debug builds
        minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
        // produce sourcemaps for debug builds
        sourcemap: !!process.env.TAURI_DEBUG,
    },
}));
