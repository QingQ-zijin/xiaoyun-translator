# 小允翻译快速上手

这份指南适用于首次安装小允翻译、接入 Ollama，并开始使用划词、截图和文献阅读器的用户。Windows/Linux 默认快捷键为 `Ctrl+D`、`Ctrl+E`，macOS 为 `Command+D`、`Command+E`。

## 先完成第一次翻译（Windows）

Ollama 是一个**需要单独安装、在后台运行的本地 AI 程序**。小允翻译通过它完成翻译、OCR 和文献分析；默认全部在本机运行，**不需要注册账号或填写 API Key**。

在 Windows 上，小允翻译的首次接入向导会自动检测 Ollama、启动本地服务、显示模型下载进度，并在完成后预热模型。你只需要完成 Ollama 官方安装，并确认一次约 6.1 GB 的模型下载，不必先使用命令行。

开始前请确认：

-   Windows 10 22H2 或 Windows 11 x64；
-   16 GB 以上内存；
-   至少 12 GB 可用磁盘空间，推荐 15 GB；
-   可以访问 Ollama 官方网站和模型仓库的网络。

按以下步骤完成一次可见的成功验证：

1. 从 [最新 Release](https://github.com/Xiaoyun-0922/xiaoyun-translator/releases/latest) 下载并安装 `xiaoyun-translator_*_x64-setup.exe`。
2. 首次打开小允翻译会出现“先接入本地 Ollama”。点击向导中的主按钮，完成 [Ollama Windows 官方安装](https://ollama.com/download/windows)。
3. 返回小允翻译。向导会自动检测 Ollama 并启动本地服务；你只需点击“下载 Gemma 4 E4B（约 6.1 GB）”并确认。保持网络连接，等待“本地 AI 已准备好”，再点击“开始使用”。
4. 打开 Windows 记事本，输入并选中 `Hello, world.`，按 `Ctrl+D`。出现中文翻译浮窗即表示接入成功；第一次请求需要加载模型，可能比后续翻译慢。

如果你选择了“暂时跳过，仅浏览文献”，稍后可从“设置 → Ollama”重新打开完整向导。

### 没有成功时先看界面

如果首次向导仍在屏幕上，先点击“重新检测”；如果已经跳过，请打开“设置 → Ollama”再检测。随后按三步向导显示的状态处理：

-   **未检测到 Ollama**：确认官方安装程序已经完成；返回小允翻译后，软件会自动检测并继续。若仍未识别，完全退出并重新打开 Ollama 和小允翻译；
-   **服务尚未启动**：首次向导通常会自动启动服务；如果停在这一步，点击“启动 Ollama 服务”，等待片刻后重新检测；
-   **模型尚未安装**：点击“下载 Gemma 4 E4B”，确认下载并保持网络连接；
-   **已经显示“本地 AI 已准备好”**：在首次向导中点击“开始使用”；若你位于设置页，确认开关已开启并保存设置。再用记事本测试，不要先在浏览器中测试，因为浏览器可能占用 `Ctrl+D`；
-   **仍未成功**：从系统托盘依次退出 Ollama 和小允翻译，重新打开后再检测。需要进一步诊断时再使用 [Ollama 命令行排错](./OLLAMA.md#故障排查)。

> Windows 10 22H2/11 x64 是当前主要验证和 Release 发布平台。macOS Apple Silicon/Intel 与 Linux x64 只有未签名的 CI 试验构建，尚未完成实体设备端到端验证；请先阅读[跨平台说明](./CROSS_PLATFORM.md)。

## 1. 安装前检查

建议准备：

-   Windows 10 22H2/11 x64，或用于试验的 macOS 15 / Ubuntu 22.04 x64 环境；
-   16 GB 以上内存；
-   8 GB 显存的 NVIDIA GPU（推荐，但不是强制）；
-   至少 12 GB 可用磁盘空间；推荐预留 15 GB；
-   可访问 Ollama 官方网站和模型仓库的网络。

Windows 版本暂时沿用 Pot 的 `com.pot-app.desktop` bundle identifier，以保留已有数据，因此不建议在 Windows 上与原版 Pot 并行安装或同时运行。macOS/Linux 的平台配置使用独立 identifier `io.github.xiaoyun0922.translator`，正常情况下不会与原版 Pot 共用应用数据；试验构建升级前仍建议备份重要数据。

## 2. 安装客户端

### 2.1 Windows 10 22H2/11 Release

1. 打开[最新 Release](https://github.com/Xiaoyun-0922/xiaoyun-translator/releases/latest)。
2. 下载 `xiaoyun-translator_*_x64-setup.exe`。
3. 对照 Release 页面提供的 SHA-256 校验值。
4. 双击安装。

安装包当前未签名，SmartScreen 可能提示“Windows 已保护你的电脑”。确认文件来自本仓库后，点击“更多信息 → 仍要运行”。

### 2.2 macOS/Linux workflow artifact

macOS 与 Linux 构建不在 Releases 中。请从成功完成的 **Actions → Cross-platform CI** 运行下载对应 artifact，先核对其中的 SHA-256，再按[跨平台说明](./CROSS_PLATFORM.md)安装。

-   macOS 构建无 Developer ID 签名且未公证。使用划词前须授权“辅助功能”，使用截图前须授权“屏幕与系统音频录制/屏幕录制”，随后完全退出并重启应用；
-   Linux 构建未签名。先安装 `libxcb1`、`libxrandr2`、`libdbus-1-3`、`tesseract-ocr` 和 `espeak-ng`；Wayland 下的全局快捷键、划词和截图受合成器与 portal 限制；
-   这些构建只经过 CI 编译和自动化测试，不能视为已在 Apple Silicon、Intel Mac、GNOME 或 KDE 实机验证。

## 3. 三步接入 Ollama

需要重新配置，或在首次向导中选择跳过时，进入“设置 → Ollama”。

Windows 用户通常不需要打开终端：向导负责检测 Ollama 与模型状态，并可启动本地服务。只有约 6.1 GB 的模型下载需要你再次确认。

1. **安装 Ollama**
   点击“打开 Ollama 官方下载页”，完成官方安装程序；也可直接使用 [Ollama Windows 官方下载页](https://ollama.com/download/windows)。
2. **启动服务**
   返回软件点击“重新检测”；若服务未运行，可点击“启动 Ollama 服务”。
3. **下载模型**
   点击“下载 Gemma 4 E4B”，确认约 6.1 GB 下载。界面会显示进度，也可取消。

模型的准确名称为：

```text
gemma4:e4b-it-qat
```

向导显示“本地 AI 已准备好”后，保持地址 `http://127.0.0.1:11434` 不变，确认“启用本地 Ollama”已开启，再点击右上角“保存设置”。模型的官方名称、命令行接入方式和高级排错见 [OLLAMA.md](./OLLAMA.md)。

## 4. Ctrl+D：外部划词翻译

1. 保持小允翻译在运行或系统托盘中。
2. 在浏览器、Word、PDF 阅读器或其他程序中选中一段文字。
3. 按 `Ctrl+D`；macOS 按 `Command+D`。
4. 浮窗跟随鼠标显示，译文会流式出现。

浮窗支持复制、朗读和固定。未固定时点击其他位置会关闭并中断当前请求。

若快捷键无反应：

-   检查是否与浏览器“收藏当前页”等功能冲突；
-   在“设置 → 快捷键”录入新组合并保存；
-   确认没有同时运行原版 Pot；
-   退出软件后重新启动一次，恢复全局快捷键注册。

## 5. Ctrl+E：截图、公式与扫描文字

1. 按 `Ctrl+E`；macOS 按 `Command+E`。
2. 拖动鼠标框选屏幕区域。
3. Gemma 4 会识别文字、公式或混排内容并翻译。

适合：

-   图片中的论文段落；
-   扫描 PDF 的局部区域；
-   上下标、希腊字母、反应式和 LaTeX 公式；
-   图表标题、坐标轴和标注。

多模态模型会尝试理解图像，但它不能替代对原始数据的核验。引用公式或数值前请与原文对照。

## 6. 学术翻译工作台

进入左侧“翻译”：

-   在左栏粘贴原文；
-   使用 `Ctrl+Enter` 或“开始翻译”；
-   右栏流式显示格式化译文；
-   展开底部上下文区域，可填写论文标题、选区前文和后文帮助术语消歧。

Markdown 和 LaTeX 示例：

```markdown
In metabolic flux analysis, **reaction flux** satisfies $Sv = 0$ at steady state.
```

译文会保留粗体和公式，而不是显示原始语法。

## 7. 导入论文或书籍

进入“论文库 → 导入文献”，先选择内容类型：

-   **论文**：生成全文概要、研究问题、方法、发现、局限和关键术语；
-   **书籍**：使用独立目录页，识别章节与小节，并按需生成章节摘要和术语。

支持：

-   `.pdf`
-   `.md` / `.markdown`
-   `.docx`
-   `.tex`

TeX 可在“设置 → 文献存储”选择 `auto`、Tectonic、XeLaTeX、pdfLaTeX 或 latexmk。未找到编译器时，软件保留源码供阅读，不会丢弃文件。

扫描 PDF 没有可靠文本层时，可执行“当前页 OCR”，或启动可暂停的整篇后台 OCR。长文档的索引按页分批构建，不必等索引全部结束才能开始阅读。

## 8. 建立研究资料库

-   新建“项目”，按课题、综述或实验方向分类；
-   使用标签标记“待读”“方法学”“核心证据”等状态；
-   划词后保存高亮、摘录或带标签笔记；
-   点击摘录中的页码回到原文；
-   再次打开文献时恢复页码、缩放和滚动进度；
-   勾选当前筛选结果中的多篇文献后批量归档或移入回收站；“已归档”视图使用独立颜色和徽标，归档不会删除原文件；
-   删除文献先进入回收站，确认后再永久删除。

推荐工作流详见 [ACADEMIC_WORKFLOW.md](./ACADEMIC_WORKFLOW.md)。

## 9. 本地数据与备份

软件默认将文献、SQLite 数据库、概要、索引和标注保存到本机。建议：

1. 在设置中选择一个稳定的文献库目录；
2. 不要把临时下载目录作为长期文献库；
3. 定期备份文献库目录；
4. 重装、切换 Pot/小允翻译或更改路径前先备份。

## 10. 更新小允翻译

应用启动后会在后台静默检查 GitHub Release，不会阻塞论文库或翻译。发现新版本时，界面会显示更新提示；也可以进入“设置 → 软件更新”手动检查。

点击“立即更新”后，应用会显示下载进度，验证更新签名，安装完成后自动重启。若当前版本早于首个内置更新器的桥接版本，需要先从
[最新 Release](https://github.com/Xiaoyun-0922/xiaoyun-translator/releases/latest) 手动安装一次，之后即可使用应用内更新。

当前正式一键更新支持 Windows x64。更新失败不会影响现有版本继续使用；请检查网络后重试，或从 Release 页面手动下载安装包。

## 11. 获取帮助

提交 Issue 前请准备：

-   软件版本、操作系统版本与 CPU 架构；
-   Linux 桌面环境以及 X11/Wayland 会话类型；
-   `ollama --version` 与 `ollama list` 输出；
-   复现步骤；
-   不含隐私数据的截图；
-   示例文档是否为扫描件、是否加密、页数和大小。

Issue 地址：[Xiaoyun-0922/xiaoyun-translator/issues](https://github.com/Xiaoyun-0922/xiaoyun-translator/issues)
