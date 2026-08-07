<div align="center">
  <img src="./public/icon.png" width="112" alt="小允翻译——论文阅读器图标">
</div>

# 小允翻译——论文阅读器

<div align="center">
  <strong>把划词翻译和论文阅读放进同一个本地 AI 工作流。</strong><br>
  Academic Translator · AI Paper Reader · PDF Translation · Local Ollama
</div>

<div align="center">
  <a href="https://github.com/QingQ-zijin/xiaoyun-translator/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/QingQ-zijin/xiaoyun-translator?display_name=tag&sort=semver"></a>
  <a href="https://github.com/QingQ-zijin/xiaoyun-translator/actions/workflows/cross-platform.yml"><img alt="Cross-platform CI" src="https://github.com/QingQ-zijin/xiaoyun-translator/actions/workflows/cross-platform.yml/badge.svg"></a>
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%2022H2%2B-2563eb?logo=windows">
  <img alt="macOS" src="https://img.shields.io/badge/macOS-Intel%20%7C%20Apple%20Silicon-111827?logo=apple">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-x86__64-f59e0b?logo=linux&logoColor=white">
  <a href="./LICENSE"><img alt="GPL-3.0" src="https://img.shields.io/github/license/QingQ-zijin/xiaoyun-translator"></a>
</div>

小允翻译——论文阅读器是一款面向论文、教材和技术文档的本地优先桌面应用。它既是能在任意软件中调用的**学术划词／截图翻译器**，也是支持 PDF、扫描件、Markdown、DOCX 与 TeX 的**AI 论文阅读器**。翻译、视觉理解、术语解释和文献概要默认由本机 [Ollama](https://ollama.com/) 驱动，不需要账号或云端 API Key。

## ✨ 为什么值得使用

| 划词翻译                                                                              | 论文阅读器                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 在浏览器、Word、PDF 阅读器等外部软件选中文字，按 `Ctrl+D`（macOS 为 `Command+D`）即译 | 导入论文或长篇书籍，保留阅读进度、项目分类、批注、高亮、摘录和术语 |
| `Ctrl+E`／`Command+E` 截图识别文字、公式和图表                                        | 在 PDF 内划词即译，结合标题、章节、上下文和领域术语消歧            |
| 流式输出，保留 Markdown、LaTeX、引用、变量与单位                                      | 生成一次并缓存全文／章节概要、研究问题、方法、局限和关键术语       |
| 单词模式提供词性、音标、多义项和语境解释                                              | 图片右键调用 Gemma 视觉能力，结合邻近正文解释图、表和公式          |

> 核心定位：**学术翻译（academic translation）+ 论文阅读器（paper/PDF reader）**，不是一个堆叠通用聊天服务的工具箱。

## 📥 下载 4.6.5

前往 [GitHub Releases](https://github.com/QingQ-zijin/xiaoyun-translator/releases/latest) 下载与你的系统匹配的文件。

| 系统                     | 推荐文件                         | 状态与说明                                           |
| ------------------------ | -------------------------------- | ---------------------------------------------------- |
| Windows 10 22H2 / 11 x64 | `*_windows-x64-setup.exe`        | 主要验证平台；支持应用内自动更新                     |
| macOS Apple Silicon      | `*_macos-arm64.dmg`              | 原生 arm64；支持应用内自动更新；当前未做 Apple 公证  |
| macOS Intel              | `*_macos-x64.dmg`                | 原生 x86_64；支持应用内自动更新；当前未做 Apple 公证 |
| Linux x86_64             | `*_linux-x64.AppImage` 或 `.deb` | 支持应用内自动更新；桌面集成依发行版而异             |

Release 同时提供 SHA-256 校验文件和 Tauri 更新签名。macOS 首次打开若被 Gatekeeper 拦截，请在“系统设置 → 隐私与安全性”确认来源后手动允许；这不等同于 Apple 公证。Linux 的全局划词在 X11 下兼容性更好，Wayland 受合成器安全策略限制，详见[跨平台说明](./docs/CROSS_PLATFORM.md)。

## 🚀 五分钟完成第一次翻译

1. 安装并启动 [Ollama](https://ollama.com/download)。Ollama 是独立运行的本地模型服务，小允翻译通过 `127.0.0.1:11434` 与它通信。
2. 安装并打开小允翻译。首次向导会自动检测 Ollama；Windows 和 macOS 可直接从界面尝试启动服务，Linux 会显示对应命令。
3. 确认下载默认的 Gemma 4 E4B 模型（约 6.1 GB）。下载结束后，向导会预热模型并显示“本地 AI 已准备好”。
4. 在任意应用中选中 `Thermodynamic flux analysis`，按 `Ctrl+D`；macOS 按 `Command+D`。
5. 打开“论文库”，导入一篇 PDF，在正文中划词即可获得结合论文上下文的翻译。

第一次请求需要把模型载入内存，会比后续请求慢。若检测失败，请进入“设置 → Ollama → 重新检测”，或参照[零基础接入与排错](./docs/OLLAMA.md)。模型下载需要约 6.1 GB 空间，建议预留至少 12 GB。

## 🧭 两个核心入口

### 1. 随处可用的学术翻译

-   **外部划词翻译**：窗口跟随鼠标出现，可移动、固定、复制和朗读；连续调用只保留最新请求。
-   **截图翻译与 OCR**：识别普通文本、上下标、LaTeX 公式和图表；适合扫描页及无法复制的网页。
-   **学术 Prompt**：原文只作为待翻译数据，不执行其中的命令；限制助手式跑题与异常扩写。
-   **语境术语**：结合论文标题、章节和上下文处理 `flux`、`translation` 等领域多义词，同时保留格式。
-   **全文翻译**：在“翻译 → 文件翻译”拖入文档，后台分段翻译并导出完整 PDF。

### 2. AI 驱动的论文与书籍阅读器

-   **文献管理**：项目分类、标签、批量归档、导入日期／最近打开排序和回收站。
-   **长文档阅读**：页面虚拟化、目录和章节跳转、链接历史、搜索、触摸板缩放与阅读进度恢复。
-   **书籍模式**：长篇 PDF 可按章节建立目录，分别保存章节摘要、关键术语和阅读位置。
-   **研究笔记**：高亮、摘录、彩色批注、文中标记、右键笔记、撤销和定位；标注不写回原 PDF。
-   **图片与公式理解**：选中或右键图表，Gemma 结合页面图像、图注和邻近正文进行视觉解读。
-   **本地词库**：从选区或论文术语面板保存词汇，记录音标、词性、释义、例句、来源论文和页码。

## 🖼️ 界面预览

### 论文阅读、翻译与笔记

![小允翻译论文阅读器：PDF 阅读、学术划词翻译和研究笔记](./docs/screenshots/academic-reader.png)

### 学术划词翻译

![小允翻译外部划词翻译浮窗](./docs/screenshots/selection-translation.png)

### 论文库与项目管理

![小允翻译论文库、项目、标签和阅读进度](./docs/screenshots/literature-library.png)

### 无命令行的 Ollama 接入

![小允翻译 Ollama 首次接入向导](./docs/screenshots/ollama-setup.png)

## 🧠 本地学术工作流

```mermaid
flowchart LR
    accTitle: 小允翻译的本地学术阅读工作流
    accDescr: 从导入文献，经本地解析、Gemma 翻译与理解，到批注、词库和可追溯研究输出的流程。

    Import["导入论文或书籍"] --> Parse["解析文本、目录与页面"]
    Parse --> Read["阅读、搜索与划词"]
    Read --> Gemma["本地 Gemma 翻译与视觉理解"]
    Gemma --> Notes["高亮、摘录与笔记"]
    Gemma --> Terms["关键术语与个人词库"]
    Notes --> Research["项目化研究记录"]
    Terms --> Research

    classDef source fill:#eef2ff,stroke:#6366f1,color:#1e1b4b
    classDef ai fill:#f5f3ff,stroke:#8b5cf6,color:#3b0764
    classDef output fill:#ecfdf5,stroke:#10b981,color:#064e3b
    class Import,Parse,Read source
    class Gemma ai
    class Notes,Terms,Research output
```

PDF 渲染与文本层基于 [PDF.js](https://mozilla.github.io/pdf.js/)[^pdfjs]；桌面跨平台能力和更新机制基于 [Tauri 2](https://v2.tauri.app/)[^tauri]；本地模型通过 [Ollama API](https://docs.ollama.com/api/introduction)[^ollama-api] 调用。

## 🖥️ 跨平台支持

| 能力                 |       Windows        |       macOS        |        Linux         |
| -------------------- | :------------------: | :----------------: | :------------------: |
| 论文／书籍阅读器     |          ✅          |         ✅         |          ✅          |
| PDF 内划词翻译       |          ✅          |         ✅         |          ✅          |
| 外部全局划词         |          ✅          | ✅ 需辅助功能权限  |     ⚠️ X11 推荐      |
| 截图 OCR             | ✅ 系统 OCR + Gemma  |      ✅ Gemma      | ✅ Tesseract + Gemma |
| 本地朗读             | ✅ SpeechSynthesizer |      ✅ `say`      |    ✅ `espeak-ng`    |
| 应用内签名更新       |          ✅          |         ✅         |     ✅ AppImage      |
| 安装包代码签名／公证 | ⚠️ 未做 Authenticode | ⚠️ 未做 Apple 公证 |        不适用        |

macOS 需要授予辅助功能和屏幕录制权限。Linux `.deb` 推荐 Ubuntu 22.04+ 或兼容发行版；AppImage 需要系统提供 WebKitGTK 及相关桌面库。更完整的权限、依赖和 Wayland 边界见[跨平台说明](./docs/CROSS_PLATFORM.md)。

## 🔒 隐私与资源占用

-   翻译、OCR、论文概要、术语解释和问答默认只访问本机 Ollama。
-   文献、批注、阅读进度、翻译缓存和词库存储在本地 `research.db` 与用户选择的文献库目录。
-   应用不会自动把原 PDF、选区或笔记同步到云端，也不会修改原始文件。
-   默认只预热用户启用的 Gemma 模型；其他模型不会常驻占用显存。
-   自动更新仅下载由 Tauri 更新密钥签名的包；签名验证不等同于操作系统代码签名。[^tauri-updater]

## 🛠️ 从源码开发

### 环境

-   Node.js 22+
-   pnpm 10.18.1
-   Rust stable
-   对应平台的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)

### 启动与验证

```bash
git clone https://github.com/QingQ-zijin/xiaoyun-translator.git
cd xiaoyun-translator
pnpm install --frozen-lockfile
pnpm tauri dev
```

```bash
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

本地打包命令与各平台依赖见[跨平台构建指南](./docs/CROSS_PLATFORM.md)，发布流程见[维护者发布指南](./docs/RELEASING.md)。

## 📚 文档

| 文档                                      | 适合谁                               |
| ----------------------------------------- | ------------------------------------ |
| [快速上手](./docs/GETTING_STARTED.md)     | 第一次安装、接入 Ollama、测试快捷键  |
| [Ollama 接入与排错](./docs/OLLAMA.md)     | 模型未启动、下载失败或显存占用异常   |
| [跨平台说明](./docs/CROSS_PLATFORM.md)    | macOS 权限、Linux 依赖、Wayland 限制 |
| [学术工作流](./docs/ACADEMIC_WORKFLOW.md) | 论文、书籍、批注、词库和项目管理     |
| [发布指南](./docs/RELEASING.md)           | 版本维护者与 Release 检查            |

## 🤝 贡献与反馈

欢迎提交 [Issue](https://github.com/QingQ-zijin/xiaoyun-translator/issues) 或 Pull Request。报告问题时请附上操作系统、应用版本、Ollama 版本、复现步骤和经过脱敏的日志；请勿上传含隐私的论文、截图或剪贴板内容。

本项目基于 [Pot Desktop 3.0.7](https://github.com/pot-app/pot-desktop) 深度改造，感谢 Pot 及其贡献者。Windows 为保留已有 Pot 数据，暂时沿用 bundle identifier `com.pot-app.desktop`；不建议与原版 Pot 同时运行。macOS 与 Linux 使用独立 identifier。

## 📄 许可证

源代码依据 [GNU GPL v3](./LICENSE) 发布。Ollama 与 Gemma 模型分别受其上游许可证和模型条款约束，本项目不重新分发模型权重。

[^pdfjs]: Mozilla, “PDF.js — A general-purpose, web standards-based platform for parsing and rendering PDFs.”

[^tauri]: Tauri, “Tauri 2 Documentation,” desktop application framework documentation.

[^ollama-api]: Ollama, “API Introduction,” local API available by default at `http://localhost:11434/api`.

[^tauri-updater]: Tauri, “Updater Plugin,” signed update artifacts and platform update bundles.
