# macOS 与 Linux 试验构建

小允翻译目前以 Windows x64 Release 为稳定发布入口。仓库同时通过 [Cross-platform CI](../.github/workflows/cross-platform.yml) 生成 macOS Apple Silicon、macOS Intel 和 Linux x64 试验构建，便于逐步补齐跨平台支持。

> [!IMPORTANT]
> macOS 与 Linux 产物目前只经过 GitHub 托管 runner 上的编译、前端测试、Rust 测试和 clippy 检查，**尚未在对应实体设备和桌面环境上完成端到端验证**。这些产物只作为 GitHub Actions workflow artifacts 保留 14 天，不会附加到 GitHub Release。

## 当前状态

| 平台                | CI 环境                 | 产物                | 签名状态                     | 验证范围            |
| ------------------- | ----------------------- | ------------------- | ---------------------------- | ------------------- |
| Windows 10/11 x64   | `windows-latest`        | 现有 NSIS Release   | 未进行代码签名               | 当前主要验证平台    |
| macOS Apple Silicon | macOS 15 arm64 runner   | `.dmg`、`.app.zip`  | 无 Developer ID 签名、未公证 | CI 构建与自动化测试 |
| macOS Intel         | macOS 15 x64 runner     | `.dmg`、`.app.zip`  | 无 Developer ID 签名、未公证 | CI 构建与自动化测试 |
| Linux x64           | Ubuntu 22.04 x64 runner | `.deb`、`.AppImage` | 未进行发行包签名             | CI 构建与自动化测试 |

CI 通过不代表全局快捷键、跨应用划词、截图、托盘、朗读、GPU 加速或桌面权限流程已经在实机上可用。提交问题时请同时提供操作系统版本、CPU 架构、桌面环境，以及 X11/Wayland 会话类型。

## 获取和核对 workflow artifact

1. 打开仓库的 **Actions → Cross-platform CI**。
2. 选择成功完成的 workflow run。
3. 在 **Artifacts** 区域下载对应平台：
    - `xiaoyun-translator-macos-aarch64`
    - `xiaoyun-translator-macos-x64`
    - `xiaoyun-translator-linux-x64`
4. 解压 GitHub 下载的外层压缩包，在同一目录核对 SHA-256：

macOS：

```sh
shasum -a 256 -c checksums-macos-aarch64.txt
# Intel 产物改用 checksums-macos-x64.txt
```

Linux：

```sh
sha256sum -c checksums-linux-x64.txt
```

SHA-256 只能帮助确认文件与该次 workflow 输出一致，不能替代开发者签名或 macOS 公证。不要从第三方转载站点获取这些试验产物。

## macOS

### 安装与首次打开

Apple Silicon 使用文件名含 `macos-aarch64` 的产物，Intel 使用 `macos-x64`。可挂载 `.dmg` 后将应用拖入“应用程序”，也可解压 `.app.zip`。

这些构建没有 Developer ID 签名且未经过 Apple 公证，Gatekeeper 会将其视为无法验证开发者的应用。它们面向愿意核对 workflow 来源和 SHA-256 的测试者，不应作为常规发行包转发。不要为运行单个测试构建而全局关闭 Gatekeeper。

### 辅助功能与屏幕录制权限

跨应用划词依赖 macOS 辅助功能接口，截图翻译需要屏幕捕捉权限。首次测试前：

1. 打开“系统设置 → 隐私与安全性 → 辅助功能”，允许小允翻译；
2. 打开“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”（部分版本显示为“屏幕录制”），允许小允翻译；
3. 完全退出并重新打开应用，使新权限生效；
4. 若系统在划词回退流程中另行请求“自动化”权限，只授予系统实际弹出的必要项目。

未授予辅助功能权限时，`Command+D` 可能无法读取其他应用中的选中文本；未授予屏幕录制权限时，`Command+E` 可能得到空白画面或直接失败。未签名构建更新后，macOS 也可能要求重新授权。以上是权限前提说明，不代表这些交互已经在 Apple Silicon 或 Intel 实机验证。

### 本地 OCR 回退组件

截图 OCR 的主要路径仍是本机 Ollama 中的 Gemma 模型。macOS bundle 还会携带 `ocr-aarch64-apple-darwin` 和 `ocr-x86_64-apple-darwin` 两个 Mach-O sidecar，作为系统 OCR 路径不可用时的本地回退组件。

这两个二进制继承自[上游 Pot Desktop](https://github.com/pot-app/pot-desktop)，只在本机处理交给它们的图像，不把图像上传到云端。它们随 bundle 出现不代表已经在两种 Mac 架构上完成实机回归；来源与第三方组件关系另见[第三方组件说明](../THIRD_PARTY_NOTICES.md)。

### Ollama

按 [Ollama macOS 官方说明](https://docs.ollama.com/macos) 安装并启动 Ollama，再执行：

```sh
ollama pull gemma4:e4b-it-qat
ollama list
```

Ollama 当前官方要求 macOS 14 Sonoma 或更新版本；Apple Silicon 可使用 Metal，Intel Mac 为 CPU 运行。本项目尚未验证 Intel Mac 上该模型的交互性能。完整接入步骤见 [OLLAMA.md](./OLLAMA.md)。

## Linux x64

### 安装运行依赖

Ubuntu/Debian 测试者可先安装本项目截图、系统 OCR 和朗读所需的运行依赖：

```sh
sudo apt-get update
sudo apt-get install -y \
    libxcb1 \
    libxrandr2 \
    libdbus-1-3 \
    tesseract-ocr \
    espeak-ng
```

按需安装额外的 Tesseract 语言包。其他发行版请使用等价包名。

安装 `.deb`：

```sh
sudo apt install ./xiaoyun-translator_*_linux-x64.deb
```

运行 AppImage：

```sh
chmod +x xiaoyun-translator_*_linux-x64.AppImage
./xiaoyun-translator_*_linux-x64.AppImage
```

GitHub artifact 下载会重置普通文件的可执行位，因此 AppImage 的 `chmod +x` 步骤不能省略。部分发行版还需要安装兼容的 FUSE 运行库；具体包名随发行版版本而异。

### Wayland 与 X11 限制

-   划词依赖桌面会话的主选择区。X11 与 Wayland 的实现不同，Wayland 下是否能读取选区取决于合成器、应用和 primary-selection 协议支持；
-   Wayland 会限制全局快捷键、窗口定位和直接屏幕捕捉。截图可能经过桌面 portal、出现系统确认，也可能被合成器拒绝；
-   XWayland 应用与原生 Wayland 应用可能表现不同。遇到问题时可在同一台机器上用 X11 会话作对照，但这不是对 X11 完整兼容性的承诺；
-   CI 是无交互的构建环境，没有覆盖 GNOME/KDE、不同缩放比例、多显示器、portal 实现或显卡驱动组合。

诊断当前会话：

```sh
printf 'session=%s display=%s wayland=%s\n' \
    "${XDG_SESSION_TYPE:-unknown}" \
    "${DISPLAY:-unset}" \
    "${WAYLAND_DISPLAY:-unset}"
```

### Ollama

按 [Ollama Linux 官方说明](https://docs.ollama.com/linux) 安装：

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma4:e4b-it-qat
ollama list
```

安装脚本会请求系统级写入权限；如不希望直接运行脚本，请使用官方页面给出的手动安装步骤。确认服务监听在本机 `127.0.0.1:11434` 后，再回到小允翻译执行“重新检测”。GPU 驱动和加速方式取决于硬件与发行版，本项目尚未对 Linux GPU 组合做实机性能验证。

## 从源码构建

Tauri 2 的 Linux 构建依赖及平台构建命令以 workflow 为准。Ubuntu CI 使用 [Tauri 官方 GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/) 中的 WebKitGTK、appindicator、SVG 和打包工具依赖；完整开发环境准备可参考 [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)。

```sh
pnpm install --frozen-lockfile
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
```

平台打包命令：

```sh
# macOS，在对应架构的 Mac 上执行
pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg
pnpm tauri build --target x86_64-apple-darwin --bundles app,dmg

# Linux x64
pnpm tauri build --bundles deb,appimage
```

这些命令生成未签名产物。正式发布前仍需分别设计 Apple Developer ID 签名与公证、Linux 包签名和实机回归流程。
