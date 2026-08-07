import { PDFDocument } from 'pdf-lib';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';

import { isTauriRuntime } from '../../domains/research/bridge';

const CANVAS_WIDTH = 1240;
const CANVAS_HEIGHT = 1754;
const PAGE_MARGIN = 86;
const BODY_TOP = 190;
const BODY_BOTTOM = 1640;
const BODY_FONT_SIZE = 29;
const BODY_LINE_HEIGHT = 46;
const A4_PAGE_SIZE = [595.28, 841.89];
const FORBIDDEN_LINE_START = new Set([...`，。！？；：、,.!?;:)]}）》」』】〉〕…`]);
const FORBIDDEN_LINE_END = new Set([...`([{（《「『【〈〔`]);

export function sanitizeTranslatedPdfFilename(title, targetLanguage = 'zh_cn') {
    const safeTitle = String(title || '文献')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 120);
    return `${safeTitle || '文献'}-${targetLanguage}-全文译文.pdf`;
}

export function plainTranslationForPdf(value) {
    return String(value ?? '')
        .replace(/^#{1,6}\s+/gmu, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1 ($2)')
        .replace(/\*\*([^*]+)\*\*/gu, '$1')
        .replace(/__([^_]+)__/gu, '$1')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, '$1')
        .replace(/`([^`]+)`/gu, '$1')
        .replace(/^\s*[-*+]\s+/gmu, '• ')
        .replace(/\r\n?/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

function tokenPieces(context, token, maxWidth) {
    if (context.measureText(token).width <= maxWidth) return [token];
    const pieces = [];
    let current = '';
    for (const character of token) {
        const candidate = `${current}${character}`;
        if (current && context.measureText(candidate).width > maxWidth) {
            if (FORBIDDEN_LINE_START.has(character)) {
                pieces.push(candidate);
                current = '';
                continue;
            }
            const tail = current.at(-1);
            if (tail && FORBIDDEN_LINE_END.has(tail) && current.length > 1) {
                pieces.push(current.slice(0, -1));
                current = `${tail}${character}`;
                continue;
            }
            pieces.push(current);
            current = character;
        } else {
            current = candidate;
        }
    }
    if (current) pieces.push(current);
    return pieces;
}

export function wrapTranslationLines(context, text, maxWidth) {
    const lines = [];
    const paragraphs = plainTranslationForPdf(text).split('\n');
    for (const paragraph of paragraphs) {
        if (!paragraph.trim()) {
            if (lines.at(-1) !== '') lines.push('');
            continue;
        }
        let current = '';
        const tokens = paragraph.match(/[^\s]+\s*|\s+/gu) ?? [paragraph];
        for (const token of tokens.flatMap((item) => tokenPieces(context, item, maxWidth))) {
            const candidate = `${current}${token}`;
            if (current && context.measureText(candidate).width > maxWidth) {
                lines.push(current.trimEnd());
                current = token.trimStart();
            } else {
                current = candidate;
            }
        }
        if (current.trim()) lines.push(current.trimEnd());
    }
    return lines;
}

function createCanvas() {
    const canvas = globalThis.document?.createElement?.('canvas');
    if (!canvas) throw new Error('当前环境无法创建 PDF 译文页面');
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    return canvas;
}

function renderTranslationCanvas({ title, sourcePageNumber, part, partCount, lines }) {
    const canvas = createCanvas();
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前环境不支持 Canvas，无法导出 PDF');

    context.fillStyle = '#fffdf9';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#735be7';
    context.fillRect(0, 0, 18, canvas.height);
    context.font = "600 34px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    context.fillStyle = '#1d2230';
    context.fillText(`第 ${sourcePageNumber} 页译文${partCount > 1 ? ` · ${part}/${partCount}` : ''}`, PAGE_MARGIN, 82);
    context.font = "24px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    context.fillStyle = '#73798a';
    const safeTitle = String(title ?? '').slice(0, 72);
    context.fillText(safeTitle, PAGE_MARGIN, 132, CANVAS_WIDTH - PAGE_MARGIN * 2);
    context.strokeStyle = '#ded9f2';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(PAGE_MARGIN, 158);
    context.lineTo(CANVAS_WIDTH - PAGE_MARGIN, 158);
    context.stroke();

    context.font = `${BODY_FONT_SIZE}px 'Segoe UI', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`;
    context.fillStyle = '#272b36';
    let y = BODY_TOP;
    for (const line of lines) {
        if (line) context.fillText(line, PAGE_MARGIN, y);
        y += BODY_LINE_HEIGHT;
    }

    context.strokeStyle = '#e4e0ee';
    context.beginPath();
    context.moveTo(PAGE_MARGIN, 1672);
    context.lineTo(CANVAS_WIDTH - PAGE_MARGIN, 1672);
    context.stroke();
    context.font = "22px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    context.fillStyle = '#8b90a0';
    context.fillText('由小允翻译生成 · 本地 Ollama 学术翻译', PAGE_MARGIN, 1714);
    return canvas;
}

function translationCanvases({ title, sourcePageNumber, text }) {
    const measuringCanvas = createCanvas();
    const context = measuringCanvas.getContext('2d');
    if (!context) throw new Error('当前环境不支持 Canvas，无法导出 PDF');
    context.font = `${BODY_FONT_SIZE}px 'Segoe UI', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`;
    const lines = wrapTranslationLines(context, text, CANVAS_WIDTH - PAGE_MARGIN * 2);
    const linesPerPage = Math.max(1, Math.floor((BODY_BOTTOM - BODY_TOP) / BODY_LINE_HEIGHT));
    const partCount = Math.max(1, Math.ceil(lines.length / linesPerPage));
    return Array.from({ length: partCount }, (_, index) =>
        renderTranslationCanvas({
            title,
            sourcePageNumber,
            part: index + 1,
            partCount,
            lines: lines.slice(index * linesPerPage, (index + 1) * linesPerPage),
        })
    );
}

async function loadOriginalPdf(sourceUrl) {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`读取原 PDF 失败（HTTP ${response.status}）`);
    return PDFDocument.load(await response.arrayBuffer(), { updateMetadata: false });
}

/**
 * 双语模式直接在原 PDF 对象末尾追加译文页，原页面、批注和链接对象不被重绘。
 * 仅译文模式创建新 PDF；两种模式均逐页生成，避免把整本书渲染成一张超大画布。
 */
export async function buildTranslatedPdf({ sourceUrl = '', title, pages, includeOriginal = true, onProgress }) {
    const safePages = (Array.isArray(pages) ? pages : [])
        .filter((page) => String(page?.translation ?? '').trim())
        .sort((left, right) => Number(left.pageNumber) - Number(right.pageNumber));
    if (safePages.length === 0) throw new Error('没有可导出的全文译文');

    const canIncludeOriginal = includeOriginal && String(sourceUrl ?? '').trim();
    const pdf = canIncludeOriginal ? await loadOriginalPdf(sourceUrl) : await PDFDocument.create();
    pdf.setTitle(`${String(title || '文献')} - 全文译文`);
    pdf.setSubject(canIncludeOriginal ? '原文与逐页译文附录' : '逐页全文译文');
    pdf.setProducer('小允翻译');
    pdf.setCreator('小允翻译');
    const originalSizes = canIncludeOriginal ? pdf.getPages().map((page) => page.getSize()) : [];

    for (let index = 0; index < safePages.length; index += 1) {
        const item = safePages[index];
        const pageSize = originalSizes[Math.max(0, Number(item.pageNumber) - 1)] ?? {
            width: A4_PAGE_SIZE[0],
            height: A4_PAGE_SIZE[1],
        };
        const canvases = translationCanvases({
            title,
            sourcePageNumber: item.pageNumber,
            text: item.translation,
        });
        for (const canvas of canvases) {
            const image = await pdf.embedJpg(canvas.toDataURL('image/jpeg', 0.9));
            const outputPage = pdf.addPage([pageSize.width, pageSize.height]);
            outputPage.drawImage(image, { x: 0, y: 0, width: pageSize.width, height: pageSize.height });
        }
        onProgress?.({ completed: index + 1, total: safePages.length, pageNumber: item.pageNumber });
        if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return pdf.save({ useObjectStreams: true });
}

export async function saveTranslatedPdf(bytes, suggestedName) {
    const filename = String(suggestedName || '全文译文.pdf');
    if (isTauriRuntime()) {
        const selected = await save({
            title: '保存全文译文 PDF',
            defaultPath: filename,
            filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
        });
        if (!selected) return null;
        const path = /\.pdf$/iu.test(selected) ? selected : `${selected}.pdf`;
        await writeFile(path, bytes);
        return path;
    }

    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        return filename;
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
}
