# Ollama 接入与故障排查

小允翻译使用本地 Ollama 运行翻译、截图 OCR、论文概要、术语解释和论文问答。默认不需要 API Key。

## 当前统一模型

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

## 命令行安装

### 1. 安装 Ollama

从 [Ollama 官方下载页](https://ollama.com/download/windows) 安装 Windows 版本。

安装完成后打开一个新的 PowerShell：

```powershell
ollama --version
```

### 2. 启动服务

Windows 官方安装通常会自动启动 Ollama。若未启动：

```powershell
ollama serve
```

不要在已有服务运行时重复执行 `ollama serve`。

检查 API：

```powershell
curl.exe http://127.0.0.1:11434/api/tags
```

### 3. 下载模型

```powershell
ollama pull gemma4:e4b-it-qat
```

检查：

```powershell
ollama list
```

列表中应出现准确的 `gemma4:e4b-it-qat`。

### 4. 在软件中检测

回到小允翻译：

1. Ollama 地址保持 `http://127.0.0.1:11434`；
2. 点击“重新检测”；
3. 开启“启用本地 Ollama”；
4. 点击“保存设置”。

## 显存和性能

推荐 8 GB 或以上显存、16 GB 或以上系统内存。

查看模型是否进入 GPU：

```powershell
ollama ps
nvidia-smi
```

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

依次执行：

```powershell
ollama --version
ollama list
curl.exe http://127.0.0.1:11434/api/tags
```

-   第一条失败：重新安装 Ollama，并重新打开 PowerShell。
-   前两条成功、第三条失败：启动 Ollama 服务。
-   三条都成功：确认软件地址没有多余路径或错误端口，然后点击“重新检测”。

### 模型未安装

```powershell
ollama pull gemma4:e4b-it-qat
ollama list
```

模型名称必须完全一致。旧的 `translategemma:4b`、`qwen3-vl:*` 或 `embeddinggemma` 不会被当前统一模型设置自动采用。

### 下载中断或空间不足

-   释放至少 8 GB 空间后重试；
-   软件内取消不会破坏已下载分层；
-   检查 Ollama 模型目录所在磁盘；
-   网络恢复后再次执行相同 `ollama pull` 命令即可复用已有分层。

### 模型已安装但翻译很慢

```powershell
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

默认端口为 11434。检查监听进程：

```powershell
Get-NetTCPConnection -LocalPort 11434 -ErrorAction SilentlyContinue
```

不要为本地默认端口随意开启公网防火墙规则。

## 隐私与许可证

默认本机地址下，内容不会因为小允翻译而发送到云端。Ollama 和 Gemma 模型仍分别受其上游许可证、模型条款和版本政策约束；本项目不重新分发模型权重。
