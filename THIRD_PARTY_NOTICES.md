# 第三方开源组件

小允翻译使用了多个开源项目。以下是主要运行时组件的简要索引；精确版本以 `pnpm-lock.yaml` 与 `src-tauri/Cargo.lock` 为准。各项目的许可证及版权声明仍归原作者所有。

| 组件                                                      | 用途                                                                       | 主要许可证          |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------- |
| [Pot Desktop](https://github.com/pot-app/pot-desktop)     | 上游翻译应用基础                                                           | GPL-3.0             |
| Pot macOS OCR helper                                      | macOS 本地 OCR 回退组件，来源于 Pot Desktop 3.0.7 的 `src-tauri/resources` | GPL-3.0             |
| [Tauri](https://github.com/tauri-apps/tauri)              | Windows、macOS 与 Linux 桌面运行时                                         | Apache-2.0 / MIT    |
| [React](https://github.com/facebook/react)                | 用户界面                                                                   | MIT                 |
| [PDF.js](https://github.com/mozilla/pdf.js)               | PDF 显示、文本层与目录解析                                                 | Apache-2.0          |
| [KaTeX](https://github.com/KaTeX/KaTeX)                   | LaTeX 公式渲染                                                             | MIT                 |
| [SQLite / rusqlite](https://github.com/rusqlite/rusqlite) | 本地论文、笔记与检索数据                                                   | Public Domain / MIT |
| [Tokio](https://github.com/tokio-rs/tokio)                | Rust 异步运行时                                                            | MIT                 |
| [reqwest](https://github.com/seanmonstar/reqwest)         | Ollama 本地 API 通信                                                       | Apache-2.0 / MIT    |
| [selection](https://crates.io/crates/selection)           | macOS 与 Linux 选区取词基础                                                | GPL-3.0-only        |

## 外部软件与模型

-   [Ollama](https://ollama.com/) 由用户独立安装，不随小允翻译分发。
-   `gemma4:e4b-it-qat` 由 Ollama 模型库按需下载，不随小允翻译分发，并受 Google Gemma 独立使用条款约束。
-   Linux 系统 OCR 与朗读分别依赖用户环境中的 `tesseract-ocr` 与 `espeak-ng`。

若发现遗漏或许可证标注需要修正，请通过本仓库 Issue 反馈。
