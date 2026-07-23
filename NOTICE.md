# 版权与上游说明

小允翻译（Xiaoyun Translator）基于开源项目
[Pot 3.0.7](https://github.com/pot-app/pot-desktop/tree/3.0.7) 继续开发。

-   上游项目：Pot Desktop
-   上游作者与贡献者：见 Pot 项目的 Git 历史及版权声明
-   本项目维护者：Xiaoyun-0922
-   主要改造：Windows 划词/截图翻译稳定性、本地 Ollama 学术翻译、PDF/文档阅读器、论文与书籍知识整理、笔记/摘录/项目管理及小允品牌界面

本项目及其修改代码按 `GPL-3.0-only` 发布，完整条款见
[LICENSE](LICENSE)。发布的安装包与对应版本源码使用同一个 Git tag。

Ollama 与 Gemma 模型不包含在本仓库或安装包中。用户需要自行安装
Ollama，并在明确确认后下载模型；Ollama 和模型分别受其各自条款约束。

为了兼容既有“小允翻译”安装及保留用户数据，Windows bundle identifier
暂时沿用 `com.pot-app.desktop`。它可能与原版 Pot 共用应用数据位置，因此不建议
在同一 Windows 账户中同时安装两个程序。后续如迁移 identifier，将先提供数据迁移工具。
