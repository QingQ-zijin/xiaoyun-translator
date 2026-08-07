# 小允翻译——论文阅读器发布指南

4.6.5 起使用统一的 `Desktop release` 工作流发布 Windows、macOS 和 Linux。Git 标签只在所有平台构建、签名、校验及更新清单合并成功后才会变成公开 Release。

## 🔐 一次性仓库配置

在 GitHub 仓库的 Actions secrets 中配置：

-   `TAURI_SIGNING_PRIVATE_KEY`
-   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

公钥保存在 `src-tauri/tauri.conf.json`，私钥不得提交到源码、日志、Issue 或 Release。该密钥用于 Tauri updater 签名，不是 Windows Authenticode 或 Apple Developer ID 证书。

## 🧾 版本一致性

发布前必须让以下版本完全一致：

-   `package.json`
-   `src-tauri/Cargo.toml`
-   `src-tauri/Cargo.lock`
-   `src-tauri/tauri.conf.json`
-   Git 标签（例如 `v4.6.5`）

并同步 README 下载说明、更新日志和用户可见版本测试。

## ✅ 本地门禁

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Windows 维护者还应至少完成一次：

```powershell
pnpm tauri build
```

随后检查 `git diff --check` 和 `git status --short`，确认没有私钥、模型、数据库、论文或本地缓存进入提交。

## 🚀 创建 Release

```bash
git tag -a v4.6.5 -m "小允翻译——论文阅读器 v4.6.5"
git push origin main
git push origin v4.6.5
```

标签触发 `.github/workflows/windows-release.yml` 中的统一桌面发布流程：

1. Windows 运行前端测试、Rust 测试和严格 Clippy；
2. Windows 构建 NSIS updater，并创建仍处于草稿状态的 Release；
3. macOS Apple Silicon 与 Intel 分别运行原生 Rust 测试、Clippy，并构建 DMG、APP 与 updater archive；
4. Linux x64 运行原生 Rust 测试、Clippy，并构建 `.deb`、AppImage 与 updater signature；
5. 汇总三平台 SHA-256 文件与安装资产；
6. 把 Windows、`darwin-aarch64`、`darwin-x86_64`、`linux-x86_64` 合并到同一 `latest.json`；
7. 只有全部校验通过，才把草稿发布为 latest Release。

任一平台失败时，Release 保持草稿，旧版客户端继续使用上一个有效的 `latest.json`。

## 📦 必须存在的资产

| 平台        | 安装资产                  | 更新资产                          |
| ----------- | ------------------------- | --------------------------------- |
| Windows x64 | `*_windows-x64-setup.exe` | 安装器 `.sig`、`latest.json` 条目 |
| macOS arm64 | `.dmg`、`.app.zip`        | `.app.tar.gz` 与 `.sig`           |
| macOS x64   | `.dmg`、`.app.zip`        | `.app.tar.gz` 与 `.sig`           |
| Linux x64   | `.deb`、`.AppImage`       | `.AppImage.sig`                   |

此外必须有 `checksums-windows-x64.txt`、`checksums-macos-arm64.txt`、`checksums-macos-x64.txt` 和 `checksums-linux-x64.txt`。

## 🔎 发布后检查

1. 在匿名浏览器中打开 Release，确认不是草稿且标记为 Latest；
2. 下载并核对四个 checksum 文件；
3. 打开 `latest.json`，确认版本号和四个平台键；
4. 在上一正式版 Windows、macOS 和 Linux AppImage 中点击“检查更新”；
5. 确认下载、签名验证、安装和重启链路；
6. 新安装环境完成 Ollama 首次向导、第一次翻译和 PDF 导入。

若自动更新失败，不要手动修改或绕过签名。修复工作流或产物后重新发布补丁版本，并保留失败日志用于审计。
