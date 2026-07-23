import { markdownLineEnding } from 'micromark-util-character';

/**
 * 创建 legacy TeX 分隔符的 micromark 语法扩展。
 *
 * @returns {object} micromark 扩展
 */
function legacyTexSyntax() {
    return {
        text: {
            92: {
                name: 'legacyTexMath',
                tokenize: tokenizeLegacyTexMath,
            },
        },
    };
}

/**
 * 识别 `\(...\)` 与 `\[...\]`，并保留公式内容原文。
 *
 * @param {object} effects micromark tokenizer effects
 * @param {Function} ok 成功状态
 * @param {Function} nok 失败状态
 * @returns {Function} 初始状态
 */
function tokenizeLegacyTexMath(effects, ok, nok) {
    let closingCode;
    let mathToken;
    let markerToken;

    return start;

    function start(code) {
        mathToken = effects.enter('legacyTexMath');
        effects.enter('legacyTexMathMarker');
        effects.consume(code);
        return openingMarker;
    }

    function openingMarker(code) {
        if (code !== 40 && code !== 91) {
            return nok(code);
        }

        mathToken.legacyClosed = false;
        mathToken.legacyDisplay = code === 91;
        closingCode = code === 91 ? 93 : 41;
        effects.consume(code);
        effects.exit('legacyTexMathMarker');
        return between;
    }

    function between(code) {
        if (code === null) {
            effects.exit('legacyTexMath');
            return ok(code);
        }

        if (markdownLineEnding(code)) {
            effects.enter('lineEnding');
            effects.consume(code);
            effects.exit('lineEnding');
            return between;
        }

        if (code === 92) {
            markerToken = effects.enter('legacyTexMathMarker');
            effects.consume(code);
            return closingMarker;
        }

        effects.enter('legacyTexMathData');
        return data(code);
    }

    function data(code) {
        if (code === null || markdownLineEnding(code)) {
            effects.exit('legacyTexMathData');
            return between(code);
        }

        if (code === 92) {
            effects.exit('legacyTexMathData');
            return between(code);
        }

        effects.consume(code);
        return data;
    }

    function closingMarker(code) {
        if (code === closingCode) {
            mathToken.legacyClosed = true;
            effects.consume(code);
            effects.exit('legacyTexMathMarker');
            effects.exit('legacyTexMath');
            return ok;
        }

        markerToken.type = 'legacyTexMathData';
        effects.exit('legacyTexMathData');
        return between(code);
    }
}

/**
 * 将 micromark token 转换为 remark-math 兼容的 mdast 节点。
 *
 * @returns {object} from-markdown 扩展
 */
function legacyTexFromMarkdown() {
    return {
        canContainEols: ['legacyTexMath'],
        enter: { legacyTexMath: enterLegacyTexMath },
        exit: { legacyTexMath: exitLegacyTexMath },
    };
}

function enterLegacyTexMath(token) {
    if (!token.legacyClosed) {
        this.enter({ type: 'text', value: this.sliceSerialize(token) }, token);
        return;
    }

    if (token.legacyDisplay) {
        const code = {
            type: 'element',
            tagName: 'code',
            properties: { className: ['language-math', 'math-display'] },
            children: [],
        };
        this.enter(
            {
                type: 'math',
                meta: null,
                value: '',
                data: { hName: 'pre', hChildren: [code] },
            },
            token
        );
    } else {
        this.enter(
            {
                type: 'inlineMath',
                value: '',
                data: {
                    hName: 'code',
                    hProperties: { className: ['language-math', 'math-inline'] },
                    hChildren: [],
                },
            },
            token
        );
    }
}

function exitLegacyTexMath(token) {
    const node = this.stack[this.stack.length - 1];

    if (!token.legacyClosed) {
        this.exit(token);
        return;
    }

    const value = this.sliceSerialize(token).slice(2, -2);
    this.exit(token);
    node.value = value;

    if (node.type === 'math') {
        node.data.hChildren[0].children.push({ type: 'text', value });
    } else {
        node.data.hChildren.push({ type: 'text', value });
    }
}

/**
 * 将 paragraph 中的 display math 提升到原父容器 children 层。
 *
 * @param {object} node mdast 节点
 * @returns {void}
 */
function liftDisplayMath(node) {
    if (!node || !Array.isArray(node.children) || node.type === 'code' || node.type === 'inlineCode') {
        return;
    }

    const children = [];
    for (const child of node.children) {
        if (child.type === 'paragraph' && child.children.some((item) => item.type === 'math')) {
            children.push(...splitParagraph(child));
        } else {
            liftDisplayMath(child);
            children.push(child);
        }
    }
    node.children = children;
}

/**
 * 按 display math 拆分 paragraph，同时保持其他 phrasing 节点顺序。
 *
 * @param {object} paragraph paragraph 节点
 * @returns {Array<object>} 拆分后的 flow 节点
 */
function splitParagraph(paragraph) {
    const result = [];
    let phrasing = [];

    function flushPhrasing() {
        if (phrasing.length > 0) {
            result.push({ type: 'paragraph', children: phrasing });
            phrasing = [];
        }
    }

    for (const child of paragraph.children) {
        if (child.type === 'math') {
            flushPhrasing();
            result.push(child);
        } else {
            phrasing.push(child);
        }
    }
    flushPhrasing();
    return result;
}

/**
 * 在 ReactMarkdown 的单次解析流程中支持 legacy TeX 分隔符。
 *
 * @returns {Function} mdast transformer
 */
export default function remarkLegacyTex() {
    const data = this.data();
    const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
    const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);

    micromarkExtensions.push(legacyTexSyntax());
    fromMarkdownExtensions.push(legacyTexFromMarkdown());
    return liftDisplayMath;
}
