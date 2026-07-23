const REOPENED_FENCE_LANGUAGES = new Set(['markdown', 'md', 'text']);
const REOPENED_PREFIX_LENGTH = 32;
const MIN_REOPENED_HEAD_LENGTH = REOPENED_PREFIX_LENGTH;
const MIN_REPEATED_UNIT_LENGTH = 48;
const MIN_REPEATED_MATH_LENGTH = 12;
const MATH_BLOCK_PATTERN = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/gu;

function comparableCharacters(text) {
    return Array.from(text.normalize('NFC').replace(/\s/gu, ''));
}

function lineRecords(text) {
    const records = [];
    const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
    let match;

    while ((match = pattern.exec(text)) !== null) {
        if (match[0] === '') break;
        records.push({
            content: match[1],
            start: match.index,
            end: match.index + match[0].length,
        });
    }

    return records;
}

/**
 * 检测模型在完整正文后重新打开 Markdown 围栏并从头重复正文的情况。
 * 比较时只忽略空白，返回内容始终从原字符串切取，不改写 Markdown 或 LaTeX。
 */
export function findReopenedMarkdownLoop(text) {
    if (typeof text !== 'string' || text === '') return null;

    let openFence = null;
    for (const line of lineRecords(text)) {
        const fence = line.content.match(/^\s*```([\w-]*)\s*$/u);
        if (!fence) continue;

        if (openFence !== null) {
            if (fence[1] === '') openFence = null;
            continue;
        }

        const language = fence[1].toLowerCase();
        if (REOPENED_FENCE_LANGUAGES.has(language)) {
            const head = text.slice(0, line.start).trimEnd();
            const repeated = text.slice(line.end);
            const headComparable = comparableCharacters(head);
            const repeatedComparable = comparableCharacters(repeated);

            if (
                headComparable.length >= MIN_REOPENED_HEAD_LENGTH &&
                repeatedComparable.length >= REOPENED_PREFIX_LENGTH &&
                headComparable.slice(0, REOPENED_PREFIX_LENGTH).join('') ===
                    repeatedComparable.slice(0, REOPENED_PREFIX_LENGTH).join('')
            ) {
                return {
                    cutIndex: line.start,
                    reason: 'reopened_markdown_prefix',
                };
            }
        }

        openFence = language || 'plain';
    }

    return null;
}

function comparableMathBlock(text) {
    return String(text ?? '')
        .normalize('NFC')
        .replace(/\\(?:quad|qquad|,|;|:|!)/gu, '')
        .replace(/(?:\$\$|\\\[|\\\])/gu, '')
        .replace(/\s/gu, '');
}

/**
 * 检测视觉模型连续生成三份等价的展示公式。只比较公式块，最终仍从原字符串截取，
 * 因而不会改写 LaTeX。要求公式块之间只有空白，避免误删正文中再次引用的公式。
 */
export function findRepeatedMathLoop(text) {
    if (typeof text !== 'string' || text === '') return null;

    const blocks = [];
    MATH_BLOCK_PATTERN.lastIndex = 0;
    let match;
    while ((match = MATH_BLOCK_PATTERN.exec(text)) !== null) {
        const comparable = comparableMathBlock(match[1] ?? match[2] ?? '');
        if (comparable.length < MIN_REPEATED_MATH_LENGTH) continue;
        blocks.push({
            comparable,
            start: match.index,
            end: MATH_BLOCK_PATTERN.lastIndex,
        });
    }

    for (let index = 2; index < blocks.length; index += 1) {
        const first = blocks[index - 2];
        const second = blocks[index - 1];
        const third = blocks[index];
        const consecutive =
            text.slice(first.end, second.start).trim() === '' && text.slice(second.end, third.start).trim() === '';

        if (!consecutive || first.comparable !== second.comparable || second.comparable !== third.comparable) {
            continue;
        }

        const prefixAlreadyContainsFormula = comparableMathBlock(text.slice(0, first.start)).endsWith(first.comparable);
        return {
            cutIndex: prefixAlreadyContainsFormula ? first.start : second.start,
            reason: 'repeated_math_block',
            repeatCount: 3,
        };
    }

    return null;
}

/** 返回当前流中最早能被严格确认的循环。 */
export function findOcrOutputLoop(text) {
    const candidates = [findReopenedMarkdownLoop(text), findRepeatedMathLoop(text)].filter(Boolean);
    if (candidates.length === 0) return null;
    return candidates.reduce((earliest, candidate) => (candidate.cutIndex < earliest.cutIndex ? candidate : earliest));
}

/** 仅移除包裹整个 OCR 回答的单层 Markdown/text 围栏。 */
export function stripOuterOcrFence(text) {
    if (typeof text !== 'string') return text;

    const trimmed = text.trim();
    const match = trimmed.match(/^```(?:markdown|md|text)\s*\r?\n([\s\S]*?)\r?\n```$/iu);
    return match ? match[1] : text;
}

function sameLines(left, right) {
    return (
        left.length === right.length &&
        left.every((line, index) => comparableCharacters(line).join('') === comparableCharacters(right[index]).join(''))
    );
}

function findRepeatedLineSuffix(text) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const detectionText = text.replace(/(?:\r\n|\n|\r)+$/u, '');
    const lines = detectionText.split(/\r\n|\n|\r/u);
    const totalComparableLength = comparableCharacters(detectionText).length;

    for (let unitLength = 2; unitLength <= Math.floor(lines.length / 3); unitLength += 1) {
        const unitStart = lines.length - unitLength;
        const unit = lines.slice(unitStart);
        const nonEmptyLines = unit.filter((line) => line.trim() !== '').length;
        const unitComparableLength = comparableCharacters(unit.join('\n')).length;
        if (nonEmptyLines < 2 || unitComparableLength < MIN_REPEATED_UNIT_LENGTH) continue;

        let repeatCount = 1;
        let repeatedStart = unitStart;
        while (repeatedStart - unitLength >= 0) {
            const previous = lines.slice(repeatedStart - unitLength, repeatedStart);
            if (!sameLines(previous, unit)) break;
            repeatCount += 1;
            repeatedStart -= unitLength;
        }

        if (repeatCount < 3) continue;
        if ((unitComparableLength * repeatCount) / Math.max(totalComparableLength, 1) < 0.5) continue;

        return {
            text: lines
                .slice(0, repeatedStart + unitLength)
                .join(newline)
                .trimEnd(),
            cutIndex: lines.slice(0, repeatedStart + unitLength).join(newline).length,
            repeatCount,
        };
    }

    return null;
}

/**
 * 清理可被严格证明为模型循环的尾部。正常 stop 输出不做猜测性去重。
 */
export function cleanOcrOutput(raw, metadata = {}) {
    if (typeof raw !== 'string') {
        return { text: raw, changed: false, reason: null, repetition: null };
    }

    const outputLoop = findOcrOutputLoop(raw);
    if (outputLoop) {
        return {
            text: raw.slice(0, outputLoop.cutIndex).trimEnd(),
            changed: true,
            reason: outputLoop.reason,
            repetition: {
                cutIndex: outputLoop.cutIndex,
                repeatCount: outputLoop.repeatCount ?? 2,
            },
        };
    }

    const unwrapped = stripOuterOcrFence(raw);
    const outerFenceRemoved = unwrapped !== raw;

    if (metadata.doneReason === 'length') {
        const repeatedSuffix = findRepeatedLineSuffix(unwrapped);
        if (repeatedSuffix) {
            return {
                text: repeatedSuffix.text,
                changed: true,
                reason: 'repeated_line_suffix',
                repetition: {
                    cutIndex: repeatedSuffix.cutIndex,
                    repeatCount: repeatedSuffix.repeatCount,
                },
            };
        }
    }

    return {
        text: unwrapped,
        changed: outerFenceRemoved,
        reason: outerFenceRemoved ? 'outer_fence' : null,
        repetition: null,
    };
}
