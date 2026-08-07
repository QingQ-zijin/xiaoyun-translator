# 小允翻译——论文阅读器跨平台说明

自 4.6.5 起，正式 Release 同时提供 Windows x64、macOS Apple Silicon、macOS Intel 与 Linux x86_64 安装包。三套桌面端共用论文阅读、PDF 内划词翻译、Gemma/Ollama、批注、词库、项目和自动更新逻辑；全局取词、截图及朗读使用各系统的原生能力或兼容后端。

## 🖥️ 发布矩阵

| 平台                     | GitHub Runner           | Release 文件        |  自动更新   | 代码签名状态                       |
| ------------------------ | ----------------------- | ------------------- | :---------: | ---------------------------------- |
| Windows 10 22H2 / 11 x64 | `windows-latest`        | NSIS `.exe`         |     ✅      | Tauri 更新签名；未做 Authenticode  |
| macOS Apple Silicon      | `macos-15` arm64        | `.dmg`、`.app.zip`  |     ✅      | Tauri 更新签名；未做 Apple 公证    |
| macOS Intel              | `macos-15-intel` x86_64 | `.dmg`、`.app.zip`  |     ✅      | Tauri 更新签名；未做 Apple 公证    |
| Linux x86_64             | Ubuntu 22.04            | `.AppImage`、`.deb` | ✅ AppImage | Tauri 更新签名；未做发行版仓库签名 |

每个 Release 还包含分平台 SHA-256 校验文件。Tauri 更新签名用于阻止应用安装被替换的更新包，但不等同于 Windows Authenticode 或 Apple Developer ID 公证。

## 🍎 macOS 安装与权限

1. Apple Silicon 下载 `macos-arm64.dmg`；Intel Mac 下载 `macos-x64.dmg`。
2. 把应用拖入“应用程序”。首次启动若被 Gatekeeper 拦截，打开“系统设置 → 隐私与安全性”，确认文件来自本仓库 Release 后选择允许打开。
3. 为外部划词开启“系统设置 → 隐私与安全性 → 辅助功能”。
4. 为截图翻译开启“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”（部分系统显示为“屏幕录制”）。
5. 启动 Ollama macOS 应用，再回到小允翻译执行“设置 → Ollama → 重新检测”。

macOS 快捷键显示为 `Command+D` 和 `Command+E`。系统朗读使用本地 `say`，不会调用网络 TTS。

## 🐧 Linux 安装与桌面限制

### AppImage

```bash
chmod +x xiaoyun-translator_*_linux-x64.AppImage
./xiaoyun-translator_*_linux-x64.AppImage
```

### Debian / Ubuntu

```bash
sudo apt install ./xiaoyun-translator_*_linux-x64.deb
```

运行时建议安装：

```bash
sudo apt install libwebkit2gtk-4.1-0 libappindicator3-1 tesseract-ocr espeak-ng
```

Linux 全局划词依赖窗口系统允许模拟复制和读取选区：

-   X11 通常可正常使用；
-   Wayland 会限制跨应用输入与剪贴板访问，不同 GNOME/KDE/合成器结果不同；
-   Wayland 下如果外部快捷键无法取词，仍可使用论文阅读器内划词、手动输入和截图 OCR；
-   Linux 朗读使用 `espeak-ng`（兼容回退到 `espeak`）。

Ollama 安装完成后，在使用 systemd 的发行版上可运行：

```bash
sudo systemctl enable --now ollama
curl http://127.0.0.1:11434/api/tags
```

## 🔄 三平台自动更新

4.6.5 的 `latest.json` 同时包含：

-   `windows-x86_64`（或 NSIS 别名）；
-   `darwin-aarch64`；
-   `darwin-x86_64`；
-   `linux-x86_64`。

Windows 更新 NSIS 安装包，macOS 更新 `.app.tar.gz`，Linux 更新 AppImage。`.deb` 用户也可以在应用中收到新版本提示；若当前运行方式无法原位替换，请从 Release 手动下载新版 `.deb`。

## 🧪 本地构建

所有平台先执行：

```bash
pnpm install --frozen-lockfile
pnpm test
```

Windows：

```powershell
pnpm tauri build
```

macOS：

```bash
pnpm tauri build --bundles app,dmg
```

Linux：

```bash
pnpm tauri build --bundles deb,appimage
```

macOS/Linux 打包需要 [Tauri 2 对应系统依赖](https://v2.tauri.app/start/prerequisites/)。正式更新产物还必须设置 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，普通本地调试不需要发布私钥。

## ✅ 发布前验证重点

-   macOS：两种架构原生启动、辅助功能授权、截图权限、`Command+D/E`、Ollama 检测、更新检查；
-   Linux：AppImage 与 `.deb` 启动、X11/Wayland 行为、Tesseract、`espeak-ng`、Ollama 服务、AppImage 更新；
-   全平台：PDF 导入、长文档虚拟化、阅读进度恢复、划词翻译、批注、项目、词库、图片分析与 updater 签名验证。

CI 能证明源码在对应 runner 上测试与打包通过，但不能替代不同显卡、桌面环境和系统权限下的实机测试。发现平台特有问题时，请在 Issue 中附上系统版本、CPU 架构、桌面环境（Linux）和复现日志。
