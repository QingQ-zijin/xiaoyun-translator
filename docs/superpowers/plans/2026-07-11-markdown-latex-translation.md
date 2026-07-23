# Pot 译文 Markdown 与 LaTeX 渲染 Implementation Plan

> **最终实现说明：** 本文保留原始 TDD 步骤作为实施记录。最终代码不再用字符串替换改写 legacy TeX，而是用 remark/micromark 扩展在单次 Markdown 解析中生成数学节点；以实际源码与本说明为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Pot 的字符串译文结果安全渲染 Markdown 强调和 KaTeX 数学公式，同时保持复制、历史、朗读与回译使用原始文本。

**Architecture:** 新增只移除流式光标的展示归一化函数、单次 AST legacy TeX 扩展和独立 `FormattedTranslation` React 组件；`TargetArea` 只把字符串结果的展示从 `textarea` 替换为该组件，业务状态 `result` 不变。Ollama 默认 prompt 与当前用户 prompt 统一约束 Markdown/LaTeX 输出格式。

**Tech Stack:** React 18、react-markdown 9、remark-math 6.0.0、rehype-katex 7.0.1、KaTeX 0.16.47、micromark-util-character 2.1.1、Node `node:test`、Vite 5、Tauri 1/Rust。

---

## 文件结构

- Create: `src/window/Translate/components/FormattedTranslation/normalize.js` — 纯展示文本规范化。
- Create: `src/window/Translate/components/FormattedTranslation/normalize.test.js` — 规范化回归测试。
- Create: `src/window/Translate/components/FormattedTranslation/index.jsx` — Markdown/KaTeX 安全渲染组件。
- Modify: `src/window/Translate/components/TargetArea/index.jsx` — 字符串译文改用格式化组件，移除 textarea 高度逻辑。
- Create: `src/services/translate/ollama/prompt.js` — Ollama 默认格式化 prompt 的唯一来源。
- Create: `src/services/translate/ollama/prompt.test.js` — Prompt 合同测试。
- Modify: `src/services/translate/ollama/Config.jsx` — 新 Ollama 实例复用默认 prompt。
- Modify: `package.json`、`pnpm-lock.yaml` — 数学渲染依赖。
- Runtime: `%APPDATA%/com.pot-app.desktop/config.json` — 备份后更新当前 `ollama@9hbmw4nfafo` 的 system/user prompt。

### Task 1: 展示文本规范化

**Files:**
- Create: `src/window/Translate/components/FormattedTranslation/normalize.test.js`
- Create: `src/window/Translate/components/FormattedTranslation/normalize.js`

- [ ] **Step 1: 写入失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranslationForDisplay } from './normalize.js';

test('保留 Markdown 粗体与标准行内公式', () => {
    const input = '**关键结论**：在 $\\le 10$ 分钟内完成。';
    assert.equal(normalizeTranslationForDisplay(input), input);
});

test('规范化 TeX 行内与块级分隔符', () => {
    assert.equal(normalizeTranslationForDisplay('值为 \\(x^2\\)。'), '值为 $x^2$。');
    assert.equal(normalizeTranslationForDisplay('公式：\\[x^2 + y^2\\]'), '公式：\n$$\nx^2 + y^2\n$$');
});

test('只移除流式结果末尾的光标下划线', () => {
    assert.equal(normalizeTranslationForDisplay('snake_case_'), 'snake_case');
    assert.equal(normalizeTranslationForDisplay('snake_case'), 'snake_case');
});

test('保留未闭合公式供渲染器降级显示', () => {
    assert.equal(normalizeTranslationForDisplay('未完成 $x^2'), '未完成 $x^2');
});

test('非字符串输入返回空展示文本', () => {
    assert.equal(normalizeTranslationForDisplay(null), '');
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test src/window/Translate/components/FormattedTranslation/normalize.test.js`

Expected: FAIL，原因是 `normalize.js` 尚不存在。

- [ ] **Step 3: 实现最小规范化函数**

```js
export function normalizeTranslationForDisplay(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const withoutStreamCursor = value.endsWith('_') ? value.slice(0, -1) : value;

    return withoutStreamCursor
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => `\n$$\n${formula.trim()}\n$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_, formula) => `$${formula.trim()}$`);
}
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `node --test src/window/Translate/components/FormattedTranslation/normalize.test.js`

Expected: 5 tests PASS，0 FAIL。

- [ ] **Step 5: 提交规范化逻辑**

```powershell
git add src/window/Translate/components/FormattedTranslation/normalize.js src/window/Translate/components/FormattedTranslation/normalize.test.js
git commit -m "feat: 规范化译文 Markdown 与 TeX 分隔符"
```

### Task 2: 安装数学渲染依赖

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 安装锁定版本**

Run: `pnpm add remark-math@6.0.0 rehype-katex@7.0.1 katex@0.16.47`

Expected: `package.json` 新增三项依赖，lockfile 更新，无安装错误。

- [ ] **Step 2: 确认依赖解析**

Run: `pnpm list remark-math rehype-katex katex --depth 0`

Expected: 输出 `remark-math 6.0.0`、`rehype-katex 7.0.1`、`katex 0.16.47`。

- [ ] **Step 3: 提交依赖**

```powershell
git add package.json pnpm-lock.yaml
git commit -m "build: 添加 Markdown 数学渲染依赖"
```

### Task 3: 新增安全格式化译文组件

**Files:**
- Create: `src/window/Translate/components/FormattedTranslation/index.jsx`
- Modify: `src/window/Translate/components/TargetArea/index.jsx:1-40, 80-90, 319-327, 497-507`

- [ ] **Step 1: 创建独立渲染组件**

```jsx
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

import { normalizeTranslationForDisplay } from './normalize';

const markdownComponents = {
    a: ({ children, href }) => (
        <span className='text-primary underline decoration-dotted' title={href}>
            {children}
        </span>
    ),
};

export default function FormattedTranslation({ value, fontSize }) {
    return (
        <div
            className='select-text break-words whitespace-pre-wrap [&_p]:mb-2 [&_p:last-child]:mb-0 [&_strong]:font-bold [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:mb-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-default-100 [&_pre]:p-2 [&_code]:font-mono [&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-error]:text-danger'
            data-testid='formatted-translation'
            style={{ fontSize: `${fontSize}px` }}
        >
            <ReactMarkdown
                remarkPlugins={[[remarkMath, { singleDollarTextMath: true }]]}
                rehypePlugins={[
                    [rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }],
                ]}
                skipHtml
                components={markdownComponents}
            >
                {normalizeTranslationForDisplay(value)}
            </ReactMarkdown>
        </div>
    );
}
```

- [ ] **Step 2: 集成到 TargetArea**

在 imports 中移除 `useRef`，新增：

```jsx
import FormattedTranslation from '../FormattedTranslation';
```

删除 `const textAreaRef = useRef();` 以及“hide empty textarea”的整个 `useEffect`。把字符串结果分支替换为：

```jsx
{typeof result === 'string' ? (
    <FormattedTranslation value={result} fontSize={appFontSize} />
) : (
    // 保留原结构化词典结果分支
)}
```

- [ ] **Step 3: 验证前端构建**

Run: `pnpm build`

Expected: Vite 构建退出码 0；只允许项目既有的 browserslist、eval 和 chunk-size 警告。

- [ ] **Step 4: 运行规范化回归测试**

Run: `node --test src/window/Translate/components/FormattedTranslation/normalize.test.js`

Expected: 5 tests PASS。

- [ ] **Step 5: 提交渲染组件**

```powershell
git add src/window/Translate/components/FormattedTranslation/index.jsx src/window/Translate/components/TargetArea/index.jsx
git commit -m "feat: 渲染译文 Markdown 与 KaTeX"
```

### Task 4: 固化 Ollama 格式化 Prompt

**Files:**
- Create: `src/services/translate/ollama/prompt.test.js`
- Create: `src/services/translate/ollama/prompt.js`
- Modify: `src/services/translate/ollama/Config.jsx:20-34`

- [ ] **Step 1: 写 Prompt 合同失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaTranslationPrompt } from './prompt.js';

test('Prompt 规定 Markdown 与 LaTeX 输出合同', () => {
    const prompts = createOllamaTranslationPrompt();
    assert.equal(prompts.length, 2);
    assert.match(prompts[0].content, /\*\*bold\*\*/);
    assert.match(prompts[0].content, /inline formulas.*\$\.\.\.\$/s);
    assert.match(prompts[0].content, /display formulas.*\$\$\.\.\.\$\$/s);
    assert.match(prompts[0].content, /never output raw HTML/i);
    assert.match(prompts[1].content, /\$to/);
    assert.match(prompts[1].content, /\$from/);
    assert.match(prompts[1].content, /\$detect/);
    assert.match(prompts[1].content, /\$text/);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test src/services/translate/ollama/prompt.test.js`

Expected: FAIL，原因是 `prompt.js` 尚不存在。

- [ ] **Step 3: 实现 Prompt 单一来源**

```js
export const OLLAMA_TRANSLATION_SYSTEM_PROMPT = `Strict bidirectional translator for Pot. Translate the entire source text into the target language and output only the translation.

Formatting contract:
- Preserve the source's meaningful Markdown emphasis and structure. Use **bold** for emphasis; never output raw HTML.
- Use $...$ for inline formulas and $$...$$ for display formulas. Never wrap the whole translation in a Markdown code fence.
- Preserve variables, operators, subscripts, superscripts, units, citations, and LaTeX commands inside formulas. Translate only natural-language prose outside formulas.
- Escape literal currency dollar signs as \\$ so they are not parsed as formulas.
- Do not invent emphasis, formulas, explanations, alternatives, notes, quotes, or reasoning.

Language contract:
- Preserve proper names, abbreviations, code, URLs, citations, and coined method names such as names ending in -seq.
- For Simplified Chinese, use natural scientific Chinese without unnecessary source-language fragments.
- For English, use fluent English and leave no Chinese characters unless they are quoted source text, code, or formulas.
- Translate fragments faithfully without guessing.`;

export function createOllamaTranslationPrompt() {
    return [
        { role: 'system', content: OLLAMA_TRANSLATION_SYSTEM_PROMPT },
        {
            role: 'user',
            content: 'Target language: $to\nSource language: $from\nDetected language: $detect\n\nSource text:\n"""\n$text\n"""',
        },
    ];
}
```

- [ ] **Step 4: 让 Config 复用默认 Prompt**

新增 import：

```jsx
import { createOllamaTranslationPrompt } from './prompt';
```

把默认配置中的内联 `promptList` 替换为：

```jsx
promptList: createOllamaTranslationPrompt(),
```

- [ ] **Step 5: 运行 Prompt 测试与构建**

Run: `node --test src/services/translate/ollama/prompt.test.js`

Expected: 1 test PASS。

Run: `pnpm build`

Expected: Vite 构建退出码 0。

- [ ] **Step 6: 提交 Prompt 源码**

```powershell
git add src/services/translate/ollama/prompt.js src/services/translate/ollama/prompt.test.js src/services/translate/ollama/Config.jsx
git commit -m "feat: 约束 Ollama Markdown 与 LaTeX 输出"
```

### Task 5: 更新当前用户的 Ollama Prompt

**Files:**
- Runtime: `%APPDATA%/com.pot-app.desktop/config.json`
- Backup: `%APPDATA%/com.pot-app.desktop/config.json.bak-markdown-latex-<timestamp>`

- [ ] **Step 1: 备份当前配置**

```powershell
$configPath = Join-Path $env:APPDATA 'com.pot-app.desktop\config.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$configPath.bak-markdown-latex-$stamp"
Copy-Item -LiteralPath $configPath -Destination $backupPath
```

Expected: 备份文件存在且长度与原配置相同。

- [ ] **Step 2: 仅更新目标 Ollama 实例的 promptList**

```powershell
$configPath = Join-Path $env:APPDATA 'com.pot-app.desktop\config.json'
$serviceKey = 'ollama@9hbmw4nfafo'
$systemPrompt = @'
Strict bidirectional translator for Pot. Translate the entire source text into the target language and output only the translation.

Formatting contract:
- Preserve the source's meaningful Markdown emphasis and structure. Use **bold** for emphasis; never output raw HTML.
- Use $...$ for inline formulas and $$...$$ for display formulas. Never wrap the whole translation in a Markdown code fence.
- Preserve variables, operators, subscripts, superscripts, units, citations, and LaTeX commands inside formulas. Translate only natural-language prose outside formulas.
- Escape literal currency dollar signs as \$ so they are not parsed as formulas.
- Do not invent emphasis, formulas, explanations, alternatives, notes, quotes, or reasoning.

Language contract:
- Preserve proper names, abbreviations, code, URLs, citations, and coined method names such as names ending in -seq.
- For Simplified Chinese, use natural scientific Chinese without unnecessary source-language fragments.
- For English, use fluent English and leave no Chinese characters unless they are quoted source text, code, or formulas.
- Translate fragments faithfully without guessing.
'@
$userPrompt = @'
Target language: $to
Source language: $from
Detected language: $detect

Source text:
"""
$text
"""
'@

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$service = $config.PSObject.Properties[$serviceKey].Value
if ($null -eq $service) {
    throw "未找到 Ollama 服务实例：$serviceKey"
}
$service.promptList = @(
    [PSCustomObject]@{ role = 'system'; content = $systemPrompt.Trim() },
    [PSCustomObject]@{ role = 'user'; content = $userPrompt.Trim() }
)
$json = $config | ConvertTo-Json -Depth 100
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)
```

不得输出 API key、token 或完整配置。

- [ ] **Step 3: 验证配置而不泄露密钥**

```powershell
$configPath = Join-Path $env:APPDATA 'com.pot-app.desktop\config.json'
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$prompt = $config.'ollama@9hbmw4nfafo'.promptList
[PSCustomObject]@{
    Count = $prompt.Count
    HasBold = $prompt[0].content.Contains('**bold**')
    HasInlineMath = $prompt[0].content.Contains('$...$')
    HasDisplayMath = $prompt[0].content.Contains('$$...$$')
    HasTextVariable = $prompt[1].content.Contains('$text')
}
```

Expected: `Count=2`，四个布尔值均为 `True`。

### Task 6: 完整验证与桌面验收

**Files:**
- Verify only; no new committed artifacts.

- [ ] **Step 1: 运行全部新增 Node 测试**

Run: `node --test src/window/Translate/components/FormattedTranslation/normalize.test.js src/services/translate/ollama/prompt.test.js src/utils/translation_flow.test.js`

Expected: 全部 PASS，0 FAIL。

- [ ] **Step 2: 运行生产构建**

Run: `pnpm build`

Expected: Exit 0。

- [ ] **Step 3: 运行 Rust 检查**

Run: `cargo check --locked --target x86_64-pc-windows-msvc`

Workdir: `src-tauri`

Expected: Exit 0；只允许项目已有的 `std::fs`、`dirs::cache_dir` 未使用警告。

- [ ] **Step 4: 构建桌面可执行文件**

Run: `pnpm tauri build --bundles none --target x86_64-pc-windows-msvc`

Expected: Exit 0，产物为 `src-tauri/target/x86_64-pc-windows-msvc/release/pot.exe`。

- [ ] **Step 5: 实际渲染验收**

启动新构建，使用包含以下内容的测试译文：

```markdown
**关键结论**：稳态标记在 $\le 10$ 分钟内完成。

$$
v = \frac{V_{max}[S]}{K_m + [S]}
$$

普通金额为 \$10，变量名为 `snake_case`。

<img src="x" onerror="alert('unsafe')">
```

Expected:

- “关键结论”显示为粗体且不显示星号。
- `\le`、分式、上下标由 KaTeX 排版，不显示美元分隔符。
- `\$10` 显示为 `$10`，不进入公式模式。
- `snake_case` 显示为行内代码且下划线保留。
- 不创建图片元素、不执行 `onerror`，原始 HTML 不生效。
- 复制按钮得到原始 Markdown/LaTeX 字符串。
- 浏览器/WebView 控制台无与新组件相关的 error。

- [ ] **Step 6: 最终差异检查**

Run: `git diff --check`

Expected: 无空白错误。使用 `git status --short` 确认未把 `%APPDATA%` 备份、构建产物或无关用户文件加入仓库。

---

## 实施约束

- 无迁移，直接替换字符串译文展示；历史数据库不改。
- 不启用 `rehype-raw`，不执行模型输出 HTML。
- 不修改源文区域和非字符串词典结果。
- Ctrl+D 性能优化与渲染功能保持独立提交边界；最终在同一功能分支中一起验收。
