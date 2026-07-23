// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { createPdfjsWasmAssetsPlugin, PDFJS_WASM_PUBLIC_PATH, readPdfjsWasmAssets } from '../../vite.config';

function requestDevAsset(middleware, url) {
    const headers = {};
    const next = vi.fn();
    return new Promise((resolve, reject) => {
        const response = {
            statusCode: 0,
            setHeader(name, value) {
                headers[name.toLowerCase()] = value;
            },
            end(body) {
                resolve({ body, headers, next, statusCode: this.statusCode });
            },
        };
        next.mockImplementation((error) => {
            if (error) reject(error);
            else resolve({ body: null, headers, next, statusCode: response.statusCode });
        });
        middleware({ url }, response, next);
    });
}

describe('PDF.js WASM 构建资产', () => {
    it('生产构建会把依赖目录中的全部运行文件写入稳定路径', async () => {
        const sourceAssets = await readPdfjsWasmAssets();
        const emittedAssets = [];
        const plugin = createPdfjsWasmAssetsPlugin();

        await plugin.generateBundle.call({ emitFile: (asset) => emittedAssets.push(asset) });

        expect(sourceAssets.length).toBeGreaterThan(0);
        expect(emittedAssets.map(({ fileName }) => fileName).sort()).toEqual(
            sourceAssets.map(({ fileName }) => `pdfjs-wasm/${fileName}`).sort()
        );
        expect(
            emittedAssets.find(({ fileName }) => fileName === 'pdfjs-wasm/jbig2.wasm')?.source.byteLength
        ).toBeGreaterThan(0);
    });

    it('开发服务器从相同路径返回 JBIG2 解码文件', async () => {
        let middleware;
        const plugin = createPdfjsWasmAssetsPlugin();
        plugin.configureServer({
            middlewares: {
                use(handler) {
                    middleware = handler;
                },
            },
        });

        const result = await requestDevAsset(middleware, `${PDFJS_WASM_PUBLIC_PATH}jbig2.wasm`);

        expect(result.next).not.toHaveBeenCalled();
        expect(result.statusCode).toBe(200);
        expect(result.headers['content-type']).toBe('application/wasm');
        expect(result.body.byteLength).toBeGreaterThan(0);
    });
});
