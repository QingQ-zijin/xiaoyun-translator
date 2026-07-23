const SMALL_IMAGE_THRESHOLD = 900;
const WIDE_SHORT_HEIGHT_THRESHOLD = 360;
const WIDE_SHORT_WIDTH_LIMIT = 1800;
const BASE_PADDING = 16;

export function getOcrImageLayout(sourceWidth, sourceHeight) {
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
        throw new Error('OCR 图片尺寸无效');
    }

    const isSmallImage = Math.max(sourceWidth, sourceHeight) < SMALL_IMAGE_THRESHOLD;
    const isWideShortScreenshot =
        sourceHeight < WIDE_SHORT_HEIGHT_THRESHOLD && sourceWidth <= WIDE_SHORT_WIDTH_LIMIT;
    const scale = isSmallImage || isWideShortScreenshot ? 2 : 1;
    const padding = BASE_PADDING * scale;
    return {
        scale,
        padding,
        width: Math.round(sourceWidth * scale) + padding * 2,
        height: Math.round(sourceHeight * scale) + padding * 2,
    };
}

/** 计算截图四角的平均背景色；透明像素按白色底合成。 */
export function averageCornerColor(corners) {
    if (!Array.isArray(corners) || corners.length === 0) return 'rgb(255, 255, 255)';

    const total = corners.reduce(
        (sum, color) => {
            const alpha = (color[3] ?? 255) / 255;
            return [
                sum[0] + color[0] * alpha + 255 * (1 - alpha),
                sum[1] + color[1] * alpha + 255 * (1 - alpha),
                sum[2] + color[2] * alpha + 255 * (1 - alpha),
            ];
        },
        [0, 0, 0]
    );
    const channels = total.map((value) => Math.round(value / corners.length));
    return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

function waitForImage(image) {
    if (typeof image.decode === 'function') return image.decode();
    return new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('OCR 图片解码失败'));
    });
}

/**
 * 给贴边小截图增加同背景边距并适度放大。任何 Canvas 兼容性异常都回退原图。
 */
export async function preprocessOcrImage(base64, environment = {}) {
    const documentObject = environment.document ?? globalThis.document;
    const ImageConstructor = environment.Image ?? globalThis.Image;
    if (!documentObject || !ImageConstructor || typeof base64 !== 'string' || base64 === '') return base64;

    try {
        const image = new ImageConstructor();
        image.src = `data:image/png;base64,${base64}`;
        await waitForImage(image);

        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        const layout = getOcrImageLayout(sourceWidth, sourceHeight);

        const sampleCanvas = documentObject.createElement('canvas');
        sampleCanvas.width = sourceWidth;
        sampleCanvas.height = sourceHeight;
        const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
        if (!sampleContext) throw new Error('无法创建 OCR 图片采样画布');
        sampleContext.drawImage(image, 0, 0);

        const cornerPoints = [
            [0, 0],
            [Math.max(0, sourceWidth - 1), 0],
            [0, Math.max(0, sourceHeight - 1)],
            [Math.max(0, sourceWidth - 1), Math.max(0, sourceHeight - 1)],
        ];
        const corners = cornerPoints.map(([x, y]) => Array.from(sampleContext.getImageData(x, y, 1, 1).data));

        const canvas = documentObject.createElement('canvas');
        canvas.width = layout.width;
        canvas.height = layout.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建 OCR 图片处理画布');
        context.fillStyle = averageCornerColor(corners);
        context.fillRect(0, 0, layout.width, layout.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(
            image,
            layout.padding,
            layout.padding,
            Math.round(sourceWidth * layout.scale),
            Math.round(sourceHeight * layout.scale)
        );

        return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/u, '');
    } catch {
        return base64;
    }
}
