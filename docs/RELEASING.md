# 发布与应用内更新

小允翻译使用 Tauri 2 官方更新器。Windows 安装包、更新清单和签名由
`.github/workflows/windows-release.yml` 在推送版本标签时生成，应用只会安装通过仓库专用公钥验证的更新。

## 一次性配置

1. 使用 Tauri CLI 生成更新签名密钥，并把私钥保存在仓库之外：

   ```powershell
   pnpm tauri signer generate --write-keys "$HOME\.tauri\xiaoyun-updater.key"
   ```

2. 将 `.pub` 文件的完整内容填写到 `src-tauri/tauri.conf.json` 的
   `plugins.updater.pubkey`。公钥可以提交，私钥和密码不得提交。
3. 由仓库管理员在 GitHub 仓库的
   `Settings → Secrets and variables → Actions` 新建：

   - `TAURI_SIGNING_PRIVATE_KEY`：私钥文件的完整内容；
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时使用的密码。

   也可以在拥有仓库管理权限的 GitHub CLI 会话中执行：

   ```powershell
   Get-Content -Raw "$HOME\.tauri\xiaoyun-updater.key" |
     gh secret set TAURI_SIGNING_PRIVATE_KEY --repo Xiaoyun-0922/xiaoyun-translator
   Get-Content -Raw "$HOME\.tauri\xiaoyun-updater-password.txt" |
     gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo Xiaoyun-0922/xiaoyun-translator
   ```

4. 至少在另一处离线备份私钥和密码。丢失私钥后，已经安装的客户端无法信任用新密钥签名的更新，只能重新手动安装。

## 发布新版本

先同步 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的版本号，
完成测试后推送提交与标签：

```powershell
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

git push origin main
git tag v4.5.3
git push origin v4.5.3
```

标签会触发 Windows Release 工作流。工作流会：

- 运行前端与 Rust 测试；
- 构建 NSIS 安装包；
- 生成并上传 Tauri 更新签名；
- 生成 `latest.json`；
- 生成 SHA-256 校验文件；
- 创建或更新同名 GitHub Release。

发布后检查 Release 至少包含安装包、`.sig`、`latest.json` 和 SHA-256 文件。
在应用的“设置 → 软件更新”点击“检查更新”，应能看到新版本并完成下载、验证、安装和重启。

## 首个更新器版本

不包含 Tauri 更新器的旧版本无法自行获得更新能力。因此首个包含本功能的版本仍需用户手动安装一次；
从该版本开始，后续版本才可在应用内一键更新。不要删除这个桥接版本的 Release 或签名资产。

## 安全边界

- 更新地址必须使用 HTTPS，且固定指向本仓库 Release 的 `latest.json`。
- 不得把私钥、密码或 GitHub Token 写入源码、日志、Issue、Release 或 workflow artifact。
- Tauri 更新签名用于验证更新来源；它不等同于 Windows Authenticode 代码签名。
- 当前正式自动更新资产只发布 Windows x64。macOS 公证与 Linux 包签名完成前，不应把试验构建写入正式更新清单。
