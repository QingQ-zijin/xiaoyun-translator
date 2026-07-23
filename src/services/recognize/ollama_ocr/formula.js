const EXPLICIT_MATH_PATTERN =
    /(?:\$\$|\\\(|\\\[|\\(?:frac|sqrt|sum|prod|int|lim|alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega)\b)/iu;
const MATH_SIGNAL_PATTERN =
    /(?:[_^=]|\\(?:frac|sqrt|sum|prod|int|lim|alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega)\b)/giu;
const CODE_LIKE_PATTERN =
    /(?:===?|!==?|=>|&&|\|\||;|:\/\/|\b(?:const|let|var|if|else|return|function|class|import|from)\b)/iu;

function isFlattenedSymbolicEquation(value) {
    if (value.length > 160 || /[\r\n]/u.test(value) || CODE_LIKE_PATTERN.test(value)) return false;

    const compact = value.replace(/\s+/gu, '').replace(/[−–—]/gu, '-');
    const relationCount = (compact.match(/[=＝≈≃≅≤≥]/gu) ?? []).length;
    const groupCount = (compact.match(/[()[\]{}|]/gu) ?? []).length;
    const arithmeticCount = (compact.match(/[+\-×÷*/]/gu) ?? []).length;
    if (relationCount < 1 || groupCount < 1 || arithmeticCount < 1) return false;

    const lexicalValue = compact.replace(/([a-z])_+(?=[a-z])/giu, '$1');
    const tokens = lexicalValue.match(/[a-z]+/giu) ?? [];
    if (tokens.length < 2) return false;

    const isKParameter = (token) => /^k(?:[a-z]{2,}(?:[A-Z][A-Za-z]*)?|[A-Z]{1,3})$/u.test(token);
    const isDifferential = (token) => /^d[a-z]$/iu.test(token);
    const isMixedCase = (token) => /[a-z][A-Z]/u.test(token);
    const isSymbolicToken = (token) =>
        token.length === 1 ||
        isKParameter(token) ||
        isDifferential(token) ||
        isMixedCase(token) ||
        /^[A-Z]{2,3}$/u.test(token);
    const proseTokens = tokens.filter((token) => !isSymbolicToken(token));
    const singleLetterCount = tokens.filter((token) => token.length === 1).length;
    const kParameterCount = tokens.filter(isKParameter).length;
    const differentialCount = tokens.filter(isDifferential).length;
    const mixedCaseCount = tokens.filter(isMixedCase).length;
    const variableEvidence =
        singleLetterCount >= 2 ||
        kParameterCount >= 2 ||
        (mixedCaseCount >= 1 && (kParameterCount >= 1 || differentialCount >= 1));

    return proseTokens.length === 0 && variableEvidence;
}

/** 仅对高度疑似纯公式的通用 OCR 结果启用第二次公式识别，避免把正文或代码误路由。 */
export function shouldRetryFormulaRecognition(text) {
    if (typeof text !== 'string') return false;
    const value = text.trim();
    if (value === '' || value.length > 2000 || /[\p{Script=Han}]/u.test(value)) {
        return false;
    }

    if (!EXPLICIT_MATH_PATTERN.test(value)) {
        const decimalCount = (value.match(/[.．]\s*\d/gu) ?? []).length;
        const separatorCount = (value.match(/[=：:+\-×÷/]/gu) ?? []).length;
        const wordCount = (value.match(/[a-z]{2,}/giu) ?? []).length;
        return (
            (decimalCount >= 2 && separatorCount >= 2 && wordCount <= 2) || isFlattenedSymbolicEquation(value)
        );
    }

    const signalCount = (value.match(MATH_SIGNAL_PATTERN) ?? []).length;
    if (signalCount < 2) return false;

    const proseCandidate = value
        .replace(/\\[a-z]+/giu, ' ')
        .replace(/\\[()[\]]/gu, ' ')
        .replace(/[\d\s{}_$^=+\-*/.,:;()[\]]+/gu, ' ');
    const multiLetterWords = proseCandidate.match(/[a-z]{2,}/giu) ?? [];
    return multiLetterWords.length <= 2;
}

function removeUnmatchedClosingBraces(text) {
    let depth = 0;
    let result = '';

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '\\' && (text[index + 1] === '{' || text[index + 1] === '}')) {
            result += character + text[index + 1];
            index += 1;
            continue;
        }
        if (character === '{') depth += 1;
        if (character === '}') {
            if (depth === 0) continue;
            depth -= 1;
        }
        result += character;
    }

    return depth === 0 ? result : null;
}

function wrapBareMultiLetterScripts(text) {
    return text.replace(/([_^])([a-z][a-z\d]{1,})(?=$|[^a-z\d])/giu, '$1{$2}');
}

function stripSingleDollarEdges(text) {
    let result = text.trim();
    if (result.startsWith('$') && !result.startsWith('$$')) result = result.slice(1).trimStart();
    if (result.endsWith('$') && !result.endsWith('$$')) result = result.slice(0, -1).trimEnd();
    return result;
}

function hasBalancedLatexEnvironments(text) {
    const stack = [];
    for (const match of text.matchAll(/\\(begin|end)\{([^{}]+)\}/gu)) {
        const [, action, environment] = match;
        if (action === 'begin') {
            stack.push(environment);
        } else if (stack.pop() !== environment) {
            return false;
        }
    }
    return stack.length === 0;
}

/** 将公式专用模型的常见残缺定界符规范为可被 Markdown/KaTeX 稳定渲染的展示公式。 */
export function normalizeFormulaOcrOutput(text) {
    if (typeof text !== 'string') return null;
    const value = text.trim();
    if (value === '') return null;

    const inlineFormula = value.match(/\\\(([\s\S]*?)\\\)/u);
    let body;
    if (/^\$\$[\s\S]*\$\$$/u.test(value)) {
        body = value.slice(2, -2);
    } else if (/^\\\[[\s\S]*\\\]$/u.test(value)) {
        body = value.replace(/^\\\[\s*/u, '').replace(/\s*\\\]$/u, '');
    } else if (inlineFormula) {
        body = inlineFormula[1];
    } else {
        body = value.replace(/^\\\\\s*/u, '').replace(/\s*\\\]$/u, '');
    }

    body = stripSingleDollarEdges(body);
    if ((body.match(MATH_SIGNAL_PATTERN) ?? []).length < 2 || !hasBalancedLatexEnvironments(body)) return null;
    const balanced = removeUnmatchedClosingBraces(body);
    if (balanced === null || balanced === '') return null;
    return `$$\n${wrapBareMultiLetterScripts(balanced)}\n$$`;
}

const UNBRACED_GREEK_PATTERN =
    /[a-z]\\(?:alpha|beta|gamma|delta|theta|lambda|mu|sigma|omega)\b/giu;

function scoreNormalizedFormula(text) {
    const body = text.replace(/^\$\$\s*/u, '').replace(/\s*\$\$$/u, '');
    const structuredScripts = (body.match(/[_^]\s*(?:\{|\\(?:text|mathrm|mathsf)\s*\{)/gu) ?? []).length;
    const suspiciousUnicode = (body.match(/[^\x00-\x7f]/gu) ?? []).length;
    const unbracedGreek = (body.match(UNBRACED_GREEK_PATTERN) ?? []).length;
    const firstMathSignal = body.search(/[_^=\\]/u);
    const leadingText = firstMathSignal < 0 ? body : body.slice(0, firstMathSignal);
    const prosePrefix = /[a-z]{2,}/iu.test(leadingText) ? 1 : 0;

    return structuredScripts * 3 - suspiciousUnicode * 4 - unbracedGreek * 6 - prosePrefix * 6;
}

/**
 * 对放大图与原图的公式识别结果做保守择优。Paddle 偶尔只在其中一个尺度上产生乱码前缀，
 * 因此优先选择结构化上下标更多、且没有可疑 Unicode/未加花括号希腊字母的候选；
 * 质量同分时优先原图，避免放大锐化放大视觉模型幻觉。
 */
export function chooseBestFormulaOcrOutput(candidates) {
    if (!Array.isArray(candidates)) return null;

    const ranked = candidates
        .map((candidate, index) => {
            const text = normalizeFormulaOcrOutput(candidate?.text ?? candidate);
            if (text === null) return null;
            return {
                text,
                index,
                variant: candidate?.variant,
                score: scoreNormalizedFormula(text),
            };
        })
        .filter(Boolean)
        .sort(
            (left, right) =>
                right.score - left.score ||
                Number(right.variant === 'raw') - Number(left.variant === 'raw') ||
                left.index - right.index
        );

    return ranked[0] ?? null;
}
