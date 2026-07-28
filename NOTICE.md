# 版权与上游说明

小允翻译（Xiaoyun Translator）基于开源项目 [Pot 3.0.7](https://github.com/pot-app/pot-desktop/tree/3.0.7) 继续开发。

-   上游项目：Pot Desktop
-   上游作者与贡献者：见 Pot 项目的 Git 历史及版权声明
-   本项目维护者：QingQ-zijin
-   主要改造：Windows/macOS/Linux 桌面适配、本地 Ollama 学术翻译、划词与截图翻译、PDF/文档阅读器、论文与书籍知识整理、笔记/摘录/项目管理及小允品牌界面

本项目及其修改代码按 `GPL-3.0-only` 发布，完整条款见 [LICENSE](LICENSE)。发布的安装包与对应版本源码使用同一个 Git tag。

Ollama 与 Gemma 模型不包含在本仓库或安装包中。用户需要自行安装 Ollama，并在明确确认后下载模型；Ollama 和模型分别受其各自条款约束。

为了兼容既有“小允翻译”安装并保留 Windows 用户数据，Windows bundle identifier 暂时沿用 `com.pot-app.desktop`。macOS 与 Linux 使用 `io.github.xiaoyun0922.translator`，避免与上游 Pot 的桌面数据目录混用。后续如迁移 Windows identifier，将先提供数据迁移工具。
