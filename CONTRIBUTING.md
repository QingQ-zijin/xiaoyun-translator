# 参与开发

感谢帮助改进小允翻译。提交 Pull Request 前请：

1. 使用 Windows 10/11、Node.js 22、pnpm 10、Rust stable、MSVC Build Tools
   与 WebView2 Runtime。
2. 运行 `pnpm install --frozen-lockfile`。
3. 运行 `pnpm test`、`pnpm build`。
4. 运行 `cargo test --manifest-path src-tauri/Cargo.toml --all-targets`。
5. 运行 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`。
6. 不要提交论文原文、模型文件、数据库、日志、安装包或本地路径。

代码、注释和文档优先使用简洁中文；新增用户界面需要兼顾键盘操作、触摸板和
Windows 125%/150% 缩放。
