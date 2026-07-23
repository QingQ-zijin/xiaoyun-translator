const MAX_OUTLINE_ITEMS = 512;
const MAX_OUTLINE_TITLE_CHARACTERS = 240;
const MAX_CONTENTS_SCAN_PAGES = 40;
const MIN_CONTENTS_ENTRIES = 4;

const CANONICAL_HEADINGS = new Set([
    'abstract',
    'acknowledgements',
    'acknowledgments',
    'appendix',
    'background',
    'bibliography',
    'conclusion',
    'conclusions',
    'discussion',
    'introduction',
    'method',
    'methods',
    'references',
    'results',
    'summary',
    '参考文献',
    '摘要',
    '引言',
    '背景',
    '方法',
    '结果',
    '讨论',
    '结论',
    '附录',
]);

function cleanTitle(value) {
    return String(value ?? '')
        .replace(/[\t\f\v ]+/gu, ' ')
        .replace(/^\s+|\s+$/gu, '')
        .slice(0, MAX_OUTLINE_TITLE_CHARACTERS);
}

function titleKey(value) {
    return cleanTitle(value)
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function headingLevel(title) {
    const value = cleanTitle(title);
    const markdown = value.match(/^(#{1,6})\s+/u);
    if (markdown) return markdown[1].length;
    const latex = value.match(/^\\(part|chapter|section|subsection|subsubsection)\*?\s*\{/u);
    if (latex) return { part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4 }[latex[1]];
    const chinese = value.match(/^第\s*([一二三四五六七八九十百零〇两\d]+)\s*([章节篇部卷])\s*[：:、.\-]?/u);
    if (chinese)
        return chinese[2] === '章' || chinese[2] === '篇' || chinese[2] === '部' || chinese[2] === '卷' ? 1 : 2;

    const englishChapter = value.match(/^(?:chapter|part|book)\s+[\divxlcdm]+\b/iu);
    if (englishChapter) return 1;

    const numbered = value.match(/^(\d+(?:\.\d+){0,4})(?:[.)：:\-]|\s)\s*/u);
    if (numbered) return Math.min(5, numbered[1].split('.').length);
    return 1;
}

function isLikelyHeading(line) {
    const value = cleanTitle(line);
    const characters = [...value];
    if (characters.length < 2 || characters.length > 120) return false;
    if (/^(?:https?:\/\/|doi\s*:)/iu.test(value)) return false;
    if (/^#{1,6}\s+\S/u.test(value)) return true;
    if (/^\\(?:part|chapter|section|subsection|subsubsection)\*?\s*\{[^}]+\}/u.test(value)) return true;
    if (/[。！？!?]$/u.test(value) && characters.length > 28) return false;
    if (/^第\s*[一二三四五六七八九十百零〇两\d]+\s*[章节篇部卷]\b/u.test(value)) return true;
    if (/^(?:chapter|part|book)\s+[\divxlcdm]+\b/iu.test(value)) return true;
    if (/^\d+(?:\.\d+){0,4}(?:[.)：:\-]|\s)\s*\p{L}/u.test(value)) return true;
    if (CANONICAL_HEADINGS.has(titleKey(value))) return true;

    const letters = characters.filter((character) => /\p{L}/u.test(character));
    if (letters.length < 3 || characters.length > 72) return false;
    const latinLetters = letters.filter((character) => /[A-Za-z]/u.test(character));
    return (
        latinLetters.length === letters.length &&
        latinLetters.every((character) => character === character.toUpperCase())
    );
}

function displayHeadingTitle(value) {
    const title = cleanTitle(value);
    const markdown = title.match(/^#{1,6}\s+(.+)$/u);
    if (markdown) return cleanTitle(markdown[1]);
    const latex = title.match(/^\\(?:part|chapter|section|subsection|subsubsection)\*?\s*\{([^}]+)\}/u);
    return cleanTitle(latex?.[1] ?? title);
}

function compactPageDigits(value) {
    const compact = String(value ?? '').replace(/\s+/gu, '');
    return /^\d{1,4}$/u.test(compact) ? Number(compact) : null;
}

function romanPageNumber(value) {
    const symbols = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1_000 };
    const normalized = String(value ?? '')
        .trim()
        .toLocaleLowerCase();
    if (!/^[ivxlcdm]+$/u.test(normalized)) return null;
    let total = 0;
    let previous = 0;
    for (const character of [...normalized].reverse()) {
        const current = symbols[character];
        total += current < previous ? -current : current;
        previous = current;
    }
    return total > 0 ? total : null;
}

function normalizeComparableTitle(value) {
    return titleKey(value)
        .replace(/\b(?:chapter|part|book)\b/gu, '')
        .trim();
}

function compactContentsMarker(value) {
    return cleanTitle(value).replace(/\s+/gu, '').toLocaleLowerCase();
}

function isContentsMarker(value) {
    const compact = compactContentsMarker(value);
    return /^(?:[ivxlcdm]+)?(?:contents|tableofcontents)(?:[ivxlcdm]+)?$/u.test(compact);
}

function parseContentsLine(value) {
    const line = cleanTitle(value);
    if (!line || isContentsMarker(line)) return null;

    // 扫描书籍常把两位章节号拆成“1 1.0”，先恢复为“11.0”。
    const splitSection = line.match(/^(\d)\s+(\d+\s*\.\s*\d+(?:\s*\.\s*\d+)*)\s+(.+?)\s+([\d ]{1,9})$/u);
    if (splitSection) {
        const number = `${splitSection[1]}${splitSection[2]}`.replace(/\s+/gu, '');
        const printedPage = compactPageDigits(splitSection[4]);
        const title = cleanTitle(splitSection[3]);
        if (printedPage && title && !/^exercises?$/iu.test(title)) {
            return { title: `${number}. ${title}`, printedPage, level: 2 };
        }
    }

    const numbered = line.match(/^(\d+(?:\s*\.\s*\d+)*)\s*[.)]?\s+(.+?)\s+([\d ]{1,9})$/u);
    if (numbered) {
        const number = numbered[1].replace(/\s+/gu, '');
        const printedPage = compactPageDigits(numbered[3]);
        const title = cleanTitle(numbered[2]);
        if (printedPage && title && !/^exercises?$/iu.test(title)) {
            return {
                title: `${number}. ${title}`,
                printedPage,
                level: number.includes('.') ? 2 : 1,
            };
        }
    }

    const named = line.match(/^(.{2,100}?)\s+([ivxlcdm]+|[\d ]{1,9})$/iu);
    if (!named) return null;
    const title = cleanTitle(named[1]);
    if (/^(?:contents|table of contents|exercises?)$/iu.test(title)) return null;
    const printedPage = compactPageDigits(named[2]);
    const romanPage = printedPage == null ? romanPageNumber(named[2]) : null;
    if (printedPage == null && romanPage == null) return null;
    return { title, printedPage, romanPage, level: 1 };
}

function contentsPageNumbers(pages) {
    const earlyPages = (Array.isArray(pages) ? pages : [])
        .filter((page) => Number(page?.pageNumber) <= MAX_CONTENTS_SCAN_PAGES)
        .sort((left, right) => Number(left.pageNumber) - Number(right.pageNumber));
    const startIndex = earlyPages.findIndex((page) =>
        String(page?.text ?? '')
            .split(/\n+/u)
            .some((line) => isContentsMarker(line))
    );
    if (startIndex < 0) return new Set();

    const selected = new Set();
    for (let index = startIndex; index < earlyPages.length; index += 1) {
        const page = earlyPages[index];
        const text = String(page?.text ?? '');
        const parsedCount = text.split(/\n+/u).filter((line) => parseContentsLine(line)).length;
        const mentionsContents = text.split(/\n+/u).some((line) => isContentsMarker(line));
        if (index > startIndex && !mentionsContents && parsedCount < MIN_CONTENTS_ENTRIES) break;
        selected.add(Math.max(1, Number(page?.pageNumber) || 1));
    }
    return selected;
}

function findTitlePhysicalPage(pages, contentsPages, entry) {
    const expected = normalizeComparableTitle(entry.title);
    if (!expected || expected.length < 3) return null;
    for (const page of Array.isArray(pages) ? pages : []) {
        const pageNumber = Math.max(1, Number(page?.pageNumber) || 1);
        if (contentsPages.has(pageNumber)) continue;
        // OCR 书页常把章节标题放在上一节尾部（例如页面下半部），不能只检查页首。
        // 这里要求整行标题规范化后完全相等，因此扫描全页也不会把正文中的提及误判为标题。
        const lines = String(page?.text ?? '').split(/\n+/u);
        if (
            lines.some((line) => {
                const candidate = normalizeComparableTitle(line);
                return candidate === expected || (expected.length >= 12 && candidate.includes(expected));
            })
        ) {
            return pageNumber;
        }
    }
    return null;
}

function mostFrequentOffset(offsets) {
    const counts = new Map();
    for (const offset of offsets) {
        if (!Number.isInteger(offset) || offset < -50 || offset > 200) continue;
        counts.set(offset, (counts.get(offset) ?? 0) + 1);
    }
    let best = null;
    let bestCount = 0;
    for (const [offset, count] of counts) {
        if (count > bestCount) {
            best = offset;
            bestCount = count;
        }
    }
    return bestCount >= 2 ? best : null;
}

/**
 * 从书籍前置目录页读取章节及印刷页码，再用正文中可核验的标题计算
 * “印刷页码 → PDF 物理页码”偏移。目录页自身绝不会作为跳转目标。
 */
export function deriveOutlineFromContents(pages, pageCount = 1) {
    const contentsPages = contentsPageNumbers(pages);
    if (!contentsPages.size) return [];

    const entries = [];
    for (const page of Array.isArray(pages) ? pages : []) {
        if (!contentsPages.has(Math.max(1, Number(page?.pageNumber) || 1))) continue;
        const lines = String(page?.text ?? '').split(/\n+/u);
        for (let index = 0; index < lines.length; index += 1) {
            let parsed = parseContentsLine(lines[index]);
            if (!parsed && /^\s*\d+(?:\s*\.\s*\d+)*\s+\S/u.test(lines[index] ?? '') && lines[index + 1]) {
                parsed = parseContentsLine(`${lines[index]} ${lines[index + 1]}`);
                if (parsed) index += 1;
            }
            if (parsed) entries.push(parsed);
        }
    }
    if (entries.length < MIN_CONTENTS_ENTRIES) return [];

    // OCR 偶尔只漏掉章标题前的编号，而紧随其后的“2.0”仍然完整。
    // 同一印刷页上的首节可安全用于恢复章号，不需要让模型猜测。
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.level !== 1 || /^\d+\./u.test(entry.title) || !entry.printedPage) continue;
        const firstSection = entries
            .slice(index + 1)
            .find((candidate) => candidate.level === 2 && candidate.printedPage === entry.printedPage);
        const chapterNumber = firstSection?.title.match(/^(\d+)\.0\./u)?.[1];
        if (chapterNumber) entry.title = `${chapterNumber}. ${entry.title}`;
    }

    const matches = entries.map((entry) => ({
        ...entry,
        matchedPage: findTitlePhysicalPage(pages, contentsPages, entry),
    }));
    const anchors = matches
        .filter((entry) => entry.printedPage && entry.matchedPage && /^\d+\.\d+/u.test(entry.title))
        .map((entry) => ({
            printedPage: entry.printedPage,
            physicalPage: entry.matchedPage,
            offset: entry.matchedPage - entry.printedPage,
        }));
    const offsets = anchors.map((anchor) => anchor.offset);
    const offset = mostFrequentOffset(offsets);
    if (offset == null) return [];
    // 正文页眉、习题和索引可能再次出现章节标题。只保留与全书主偏移接近的
    // 校验点，再做局部最近邻，避免单个远端误匹配污染整章跳转。
    const stableAnchors = anchors.filter((anchor) => Math.abs(anchor.offset - offset) <= 2);
    if (stableAnchors.length < 2) return [];

    const resolved = matches
        .map((entry) => {
            const nearestAnchor = entry.printedPage
                ? stableAnchors.reduce(
                      (best, anchor) =>
                          !best || Math.abs(anchor.printedPage - entry.printedPage) < best.distance
                              ? { ...anchor, distance: Math.abs(anchor.printedPage - entry.printedPage) }
                              : best,
                      null
                  )
                : null;
            const expectedPage = entry.printedPage ? entry.printedPage + (nearestAnchor?.offset ?? offset) : null;
            const matchedPage = entry.matchedPage;
            const verifiedPage =
                matchedPage && (expectedPage == null || Math.abs(matchedPage - expectedPage) <= 2) ? matchedPage : null;
            // 章标题容易在后续偶数页页眉重复；章级目录以相邻小节校准出的起始页为准。
            const numberedChapter = entry.level === 1 && /^\d+\./u.test(entry.title);
            const pageNumber = numberedChapter && expectedPage ? expectedPage : verifiedPage ?? expectedPage;
            if (!pageNumber || contentsPages.has(pageNumber)) return null;
            return {
                title: entry.title,
                pageNumber,
                level: entry.level,
                source: 'contents',
                confidence: verifiedPage ? 0.98 : 0.9,
            };
        })
        .filter(Boolean);
    return resolved.length >= MIN_CONTENTS_ENTRIES ? finalizeOutline(resolved, pageCount) : [];
}

function destinationPageIndex(destination) {
    const reference = Array.isArray(destination) ? destination[0] : null;
    if (Number.isInteger(reference)) return Math.max(0, reference);
    return null;
}

async function resolveDestinationPage(pdfDocument, destination) {
    let explicitDestination = destination;
    if (typeof explicitDestination === 'string') {
        explicitDestination = await pdfDocument.getDestination?.(explicitDestination);
    }
    const directIndex = destinationPageIndex(explicitDestination);
    if (directIndex != null) return directIndex + 1;
    const reference = Array.isArray(explicitDestination) ? explicitDestination[0] : null;
    if (!reference || typeof pdfDocument.getPageIndex !== 'function') return null;
    const pageIndex = await pdfDocument.getPageIndex(reference);
    return Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex + 1 : null;
}

function flattenNativeOutline(nodes, level = 1, output = []) {
    for (const node of Array.isArray(nodes) ? nodes : []) {
        if (output.length >= MAX_OUTLINE_ITEMS) break;
        output.push({ node, level: Math.min(8, Math.max(1, level)) });
        flattenNativeOutline(node?.items, level + 1, output);
    }
    return output;
}

export function finalizeOutline(items, pageCount = 1) {
    const safePageCount = Math.max(1, Math.trunc(Number(pageCount) || 1));
    const normalized = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
        if (normalized.length >= MAX_OUTLINE_ITEMS) break;
        const title = cleanTitle(item?.title);
        const pageNumber = Math.min(safePageCount, Math.max(1, Math.trunc(Number(item?.pageNumber) || 1)));
        const level = Math.min(8, Math.max(1, Math.trunc(Number(item?.level) || 1)));
        if (!title) continue;
        const key = `${titleKey(title)}:${pageNumber}:${level}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push({
            title,
            pageNumber,
            endPage: pageNumber,
            level,
            source: String(item?.source ?? 'text') || 'text',
            confidence: Math.min(1, Math.max(0, Number(item?.confidence) || 0)),
        });
    }

    return normalized.map((item, index) => {
        let endPage = safePageCount;
        for (let nextIndex = index + 1; nextIndex < normalized.length; nextIndex += 1) {
            const next = normalized[nextIndex];
            if (next.level <= item.level && next.pageNumber > item.pageNumber) {
                endPage = next.pageNumber - 1;
                break;
            }
        }
        return { ...item, endPage: Math.max(item.pageNumber, endPage) };
    });
}

/**
 * 读取 PDF 自带书签并把 destination 转为可验证的物理页码。
 * 单个损坏书签只会被跳过，不会让整篇文档目录失效。
 */
export async function extractNativePdfOutline(pdfDocument) {
    if (!pdfDocument || typeof pdfDocument.getOutline !== 'function') return [];
    const tree = await pdfDocument.getOutline().catch(() => null);
    const flattened = flattenNativeOutline(tree);
    const resolved = [];
    for (const { node, level } of flattened) {
        const title = cleanTitle(node?.title);
        if (!title) continue;
        try {
            const pageNumber = await resolveDestinationPage(pdfDocument, node?.dest);
            if (!pageNumber) continue;
            resolved.push({ title, pageNumber, level, source: 'native', confidence: 1 });
        } catch {
            // PDF 中常见局部损坏的 destination；保留其余可验证书签。
        }
    }
    return finalizeOutline(resolved, pdfDocument.numPages);
}

/**
 * 无书签 PDF 的保守降级：只接受章节编号、标准章节名或短全大写标题。
 * 页眉重复项会被过滤，避免生成看似完整但跳转错误的目录。
 */
export function deriveOutlineFromPages(pages, pageCount = 1, source = 'text') {
    const contentsOutline = deriveOutlineFromContents(pages, pageCount);
    if (contentsOutline.length) return contentsOutline;
    const candidates = [];
    const occurrences = new Map();
    for (const page of Array.isArray(pages) ? pages : []) {
        const pageNumber = Math.max(1, Math.trunc(Number(page?.pageNumber) || 1));
        const perPage = new Set();
        for (const line of String(page?.text ?? '').split(/\n+/u)) {
            const rawTitle = cleanTitle(line);
            if (!isLikelyHeading(rawTitle)) continue;
            const title = displayHeadingTitle(rawTitle);
            const key = titleKey(title);
            if (!key || perPage.has(key)) continue;
            perPage.add(key);
            occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
            candidates.push({ title, pageNumber, level: headingLevel(rawTitle), source, confidence: 0.72, key });
        }
    }
    const filtered = candidates.filter((candidate) => {
        const count = occurrences.get(candidate.key) ?? 0;
        return count <= 2 || CANONICAL_HEADINGS.has(candidate.key);
    });
    return finalizeOutline(filtered, pageCount);
}
