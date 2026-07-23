# Ollama 接入与故障排查

Ollama 是一个**需要单独安装、在后台运行的本地 AI 程序**。小允翻译通过本机 Ollama 完成翻译、截图 OCR、论文概要、术语解释和论文问答；默认不需要账号或 API Key。

## Windows 零基础接入

开始前请确认：Windows 10 22H2 或 Windows 11 x64、16 GB 以上内存，以及至少 12 GB 可用磁盘空间（推荐 15 GB）。

普通 Windows 用户不需要先打开终端。首次向导会自动检测 Ollama、启动本地服务、显示模型下载进度，并在完成后预热模型；你只需要安装官方 Ollama，并确认一次约 6.1 GB 的模型下载。

1. 首次打开小允翻译会出现“先接入本地 Ollama”。
2. 点击向导中的主按钮，完成 [Ollama Windows 官方安装](https://ollama.com/download/windows)。安装程序通常会让 Ollama 在后台运行。
3. 返回小允翻译。向导会自动检测 Ollama 并启动本地服务；你只需点击“下载 Gemma 4 E4B（约 6.1 GB）”并确认。
4. 等待向导显示“本地 AI 已准备好”，再点击“开始使用”。普通用户无需修改地址、端口或模型名称。
5. 打开 Windows 记事本，输入并选中 `Hello, world.`，按 `Ctrl+D`。出现中文翻译浮窗即表示接入成功；第一次请求需要加载模型，可能比后续翻译慢。

如果你选择了“暂时跳过，仅浏览文献”，稍后可从“设置 → Ollama”重新打开完整向导。

## 当前统一模型

官方模型页面：[Gemma 4 E4B QAT](https://ollama.com/library/gemma4:e4b-it-qat)

```text
gemma4:e4b-it-qat
```

-   下载体积约 6.1 GB；
-   支持文字和图像输入；
-   当前版本只保持这一模型 runner，减少多模型同时占用显存；
-   Gemma 4 不提供 embeddings，因此文献检索使用本地 SQLite FTS5，不会再加载第二个嵌入模型。

## 推荐方式：软件内接入向导

打开“设置 → Ollama”，向导会依次检查：

1. Ollama 客户端是否安装；
2. `127.0.0.1:11434` 服务是否运行；
3. `gemma4:e4b-it-qat` 是否安装。

可执行的操作：

-   打开 Ollama 官方下载页；
-   启动本地 Ollama 服务；
-   在确认后下载约 6.1 GB 模型；
-   实时显示逐层下载进度；
-   取消下载；Ollama 会保留已经完成、可复用的分层；
-   下载完成后预热模型。

软件不会在未确认的情况下静默下载模型。

## 新手图形化排错

先不要打开终端。如果首次向导仍在屏幕上，点击“重新检测”；如果已经跳过，请打开“设置 → Ollama”再检测。观察三步向导停在哪一步：

1. **停在“安装 Ollama”**
   点击“打开 Ollama 官方下载页”并完成官方安装。安装完成后返回小允翻译，软件会自动检测并继续；若仍未识别，完全退出并重新打开 Ollama 和小允翻译。
2. **停在“启动服务”**
   Windows 首次向导通常会自动启动服务；如果停在这一步，点击“启动 Ollama 服务”，等待片刻后重新检测。macOS/Linux 请按界面提示启动 Ollama，再返回检测。
3. **停在“下载模型”**
   点击“下载 Gemma 4 E4B（约 6.1 GB）”并确认。保持网络连接；下载中断后可重试，Ollama 会复用已经完成的分层。
4. **已经显示“本地 AI 已准备好”**
   在首次向导中点击“开始使用”；若你位于设置页，保持默认地址不变，确认“启用本地 Ollama”已开启并保存设置。先用 Windows 记事本中的 `Hello, world.` 测试，不要先在浏览器测试，因为浏览器可能占用 `Ctrl+D`。
5. **记事本测试仍无响应**
   确认 Ollama 和小允翻译仍在系统托盘运行；从托盘依次退出两者，重新打开后再次检测。仍未解决时，再继续下面的命令行排错。

## 安装与命令行接入

### 1. 安装 Ollama

只从 Ollama 官方渠道安装：

-   **Windows**：从 [Ollama Windows 下载页](https://ollama.com/download/windows) 运行官方安装程序；要求 Windows 10 22H2 或更新版本，详细要求见 [Ollama Windows 官方说明](https://docs.ollama.com/windows)；
-   **macOS**：按 [Ollama macOS 说明](https://docs.ollama.com/macos) 安装应用。Ollama 当前要求 macOS 14 Sonoma 或更新版本，支持 Apple M 系列 GPU；Intel Mac 为 CPU 运行；
-   **Linux**：按 [Ollama Linux 说明](https://docs.ollama.com/linux) 使用官方安装脚本或手动安装。官方脚本命令为：

```sh
curl -fsSL https://ollama.com/install.sh | sh
```

Linux 安装脚本会请求系统级写入权限；如不希望直接运行脚本，请先阅读脚本内容或改用官方页面的手动安装步骤。

安装完成后打开一个新的终端：

```console
ollama --version
```

### 2. 启动服务

Windows/macOS 官方应用通常会启动 Ollama。Linux 官方脚本在使用 systemd 的发行版上通常会创建服务，可执行：

```sh
sudo systemctl enable --now ollama
sudo systemctl status ollama
```

不使用 systemd 或服务未启动时，可在单独终端前台运行：

```console
ollama serve
```

不要在已有服务运行时重复执行 `ollama serve`。

macOS/Linux 检查 API：

```sh
curl http://127.0.0.1:11434/api/tags
```

Windows PowerShell 检查 API：

```powershell
curl.exe http://127.0.0.1:11434/api/tags
```

### 3. 下载模型

```console
ollama pull gemma4:e4b-it-qat
```

检查：

```console
ollama list
```

列表中应出现准确的 `gemma4:e4b-it-qat`。

### 4. 在软件中检测

回到小允翻译：

1. Ollama 地址保持 `http://127.0.0.1:11434`；
2. 点击“重新检测”；
3. 开启“启用本地 Ollama”；
4. 点击“保存设置”。

macOS/Linux 客户端本身仍是未签名 CI 试验构建；Ollama 安装成功不代表划词、截图权限或 Wayland/X11 集成已经验证。平台权限与运行依赖见[跨平台说明](./CROSS_PLATFORM.md)。

## 显存和性能

推荐 8 GB 或以上显存、16 GB 或以上系统内存。从零安装 Ollama 和当前模型时至少预留 12 GB 磁盘空间，推荐 15 GB。

查看模型是否进入 GPU：

```console
ollama ps
nvidia-smi
```

`nvidia-smi` 仅适用于配置了 NVIDIA 驱动的平台。Apple Silicon 可通过 `ollama ps` 查看模型状态；Intel Mac 的 Ollama 当前为 CPU 运行，本项目尚未验证该模型在 Intel Mac 上的交互性能。

8 GB 显存属于可用但偏紧的配置。建议：

-   只让小允翻译使用统一 Gemma 4 模型；
-   关闭同时占用大量显存的游戏、图像生成和其他本地模型；
-   长书 OCR 与论文概要不要同时运行；
-   不使用时在设置中关闭本地 Ollama，软件会取消生成并释放模型占用；
-   模型冷启动后的第一次请求会慢一些，开启预热可改善 Ctrl+D 首字延迟。

CPU 也可以运行 Ollama，但本项目未将 CPU-only 作为流畅体验目标。

## 远程 Ollama

可把 Ollama 地址改成远程服务，但需要注意：

-   设置页只能检测远程状态，不能替远程设备安装或启动 Ollama；
-   文本、图片和论文片段会发送到该远程地址；
-   请自行配置访问控制、TLS 和防火墙；
-   不要把未保护的 Ollama 端口直接暴露到公网。

## 故障排查

### 软件显示“无法连接 Ollama”

先执行：

```console
ollama --version
ollama list
```

再检查本机 API：

```sh
# macOS/Linux
curl http://127.0.0.1:11434/api/tags
```

```powershell
# Windows PowerShell
curl.exe http://127.0.0.1:11434/api/tags
```

-   `ollama --version` 失败：重新安装 Ollama，并重新打开终端。
-   前两条成功、API 失败：启动 Ollama 服务。
-   三项都成功：确认软件地址没有多余路径或错误端口，然后点击“重新检测”。

### 模型未安装

```console
ollama pull gemma4:e4b-it-qat
ollama list
```

模型名称必须完全一致。旧的 `translategemma:4b`、`qwen3-vl:*` 或 `embeddinggemma` 不会被当前统一模型设置自动采用。

### 下载中断或空间不足

-   从零安装时确保至少 12 GB 可用空间，推荐 15 GB；如果 Ollama 已安装，也应为模型和临时下载保留充足空间；
-   软件内取消不会破坏已下载分层；
-   检查 Ollama 模型目录所在磁盘；
-   网络恢复后再次执行相同 `ollama pull` 命令即可复用已有分层。

### 模型已安装但翻译很慢

```console
ollama ps
nvidia-smi
```

若模型全部落在 CPU：

-   更新 NVIDIA 驱动；
-   关闭其他占用显存的软件；
-   重启 Ollama；
-   保持只有 `gemma4:e4b-it-qat` 处于运行状态。

长段落、整页图片和全文概要本身就比单句划词需要更多时间。Ctrl+D 的窗口应先出现，译文随后流式输出。

### Ctrl+D 第二次没有响应

这通常不是模型下载问题。请：

1. 确认浮窗没有被固定；
2. 点击浮窗外部关闭旧请求；
3. 检查快捷键冲突；
4. 从托盘退出小允翻译后重新启动；
5. 若仍能复现，提交目标应用名称和连续操作步骤。

### 端口被占用

默认端口为 11434。Windows PowerShell 检查监听进程：

```powershell
Get-NetTCPConnection -LocalPort 11434 -ErrorAction SilentlyContinue
```

macOS/Linux：

```sh
lsof -nP -iTCP:11434 -sTCP:LISTEN
```

不要为本地默认端口随意开启公网防火墙规则。

## 隐私与许可证

默认本机地址下，内容不会因为小允翻译而发送到云端。Ollama 和 Gemma 模型仍分别受其上游许可证、模型条款和版本政策约束；本项目不重新分发模型权重。
