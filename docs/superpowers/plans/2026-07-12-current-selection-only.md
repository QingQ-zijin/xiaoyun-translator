# Pot 当前选区独立翻译实施计划

> **供智能体执行者使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项执行本计划，步骤使用复选框跟踪。

**目标：** 让每次 Ctrl+D 与 OCR 翻译只使用本次文本，彻底消除常驻翻译窗口中的旧源文追加。

**架构：** 保留 Rust 翻译窗口复用，只修改前端源文提交策略。划词与两条 OCR 路径统一用本次文本替换 `sourceTextRef`、本地状态和同步原子，并移除已失效的增量翻译设置入口。

**技术栈：** React 18、Jotai、Tauri 1、Node.js `node:test`、Vite、Rust/Cargo。

---

### Task 1：建立旧源文残留回归测试

**Files:**

- Modify: `src/utils/translation_flow.test.js:6,135-140,431-455`
- Test: `src/utils/translation_flow.test.js`

- [ ] **Step 1：把增量测试改为“本次文本始终替换旧文”**

```js
test('新取词始终用本次文本替换旧源文', () => {
    assert.equal(mergeSourceText('旧源文', '本次选区', true), '本次选区');
    assert.equal(mergeSourceText('旧源文', '本次选区', false), '本次选区');
});
```

- [ ] **Step 2：增加三条入口不得追加旧文的源码契约**

读取 `SourceArea/index.jsx`，断言不存在 `setSourceText((old)` 或 `old + ' ' + newText`；划词和共用 OCR 成功处理器都通过统一提交 helper 替换源文；同步时必须传入明确的 `nextSourceText`。同时断言 `SourceArea` 与配置页均不再读取或展示 `incremental_translate`。

- [ ] **Step 3：增加旧 OCR 不得覆盖新选区的请求契约**

断言 OCR 成功、失败和语言检测同步均校验当前 `requestId`；进入 `[IMAGE_TRANSLATE]` 后立即提交并同步空源文，禁止在等待识别期间展示上一选区。

- [ ] **Step 4：验证 RED**

Run: `node --test src/utils/translation_flow.test.js`

Expected: FAIL，显示实际值仍为 `旧源文 本次选区`，并指出 OCR 仍存在函数式追加。

### Task 2：统一替换源文、隔离过期 OCR 并移除误导开关

**Files:**

- Modify: `src/utils/translation_flow.js:1-3`
- Modify: `src/window/Translate/components/SourceArea/index.jsx:26-29,39-180,263-275`
- Modify: `src/window/Config/pages/Translate/index.jsx:16-35,159-180`
- Test: `src/utils/translation_flow.test.js`

- [ ] **Step 1：让源文策略只返回本次文本**

```js
export function mergeSourceText(_current, incoming, _incremental) {
    return incoming;
}
```

确认 RED 测试转绿后，将该函数重命名为只接收 `incoming` 的 `replaceSourceText`，同步更新测试与调用方，删除已经失效的旧源文和增量参数。

- [ ] **Step 2：划词和 OCR 同步提交本次文本**

定义统一提交函数：

```js
const commitSourceText = (newText) => {
    const nextSourceText = replaceSourceText(newText);
    sourceTextRef.current = nextSourceText;
    setSourceText(nextSourceText);
    return nextSourceText;
};
```

划词路径直接提交本次文本并继续由 `syncAndDetect` 同步。插件 OCR 与内置 OCR 共用一个成功处理器：提交前校验 `requestId`，提交后继续通过 `syncAndDetect` 等待语言检测，并在每个异步出口重复校验同一请求。OCR 失败处理器同样只允许当前请求写入错误信息。

- [ ] **Step 3：OCR 开始时清空旧状态，空选区也明确清空**

进入 `[IMAGE_TRANSLATE]` 时先执行 `commitSourceText('')` 和 `syncSourceText('')`，再读取截图并开始识别。划词收到空字符串时直接提交并同步空源文，不执行语言检测。

- [ ] **Step 4：移除运行期增量配置依赖与设置开关**

删除 `SourceArea` 与配置页中的 `useConfig('incremental_translate', false)`，并从配置初始化条件和依赖数组中移除该值。保留未使用的历史翻译字符串，避免无关多语言文件改动。

- [ ] **Step 5：验证 GREEN**

Run: `node --test src/utils/translation_flow.test.js`

Expected: 0 failures。

### Task 3：更新本机配置、构建并部署验证

**Files:**

- Modify: `%APPDATA%/com.pot-app.desktop/config.json`

- [ ] **Step 1：备份配置并将 `incremental_translate` 改为 `false`**

备份文件使用时间戳后缀；只修改该布尔值，不输出任何密钥或服务配置。

- [ ] **Step 2：运行前端与 Rust 验证**

Run: `npm run build`

Expected: Vite build exit 0。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: Cargo exit 0。

- [ ] **Step 3：在独立目标目录构建 release**

Run: `$env:CARGO_TARGET_DIR='src-tauri/target/deploy-stage'; pnpm tauri build --target x86_64-pc-windows-msvc --bundles none`

Expected: 生成 `src-tauri/target/deploy-stage/x86_64-pc-windows-msvc/release/pot.exe`，且不受当前运行程序的文件锁影响。

- [ ] **Step 4：安全替换并重启 Pot**

仅停止实际运行路径为 `src-tauri/target/x86_64-pc-windows-msvc/release/pot.exe` 的进程；备份旧 exe，把 staging exe 复制到该路径，比较 SHA256 一致后再从同一路径启动。

- [ ] **Step 5：核验运行实例和工作树**

确认新进程可执行路径、配置值为 `false`，并运行 `git diff --check` 与 `git status --short`。最终报告未覆盖的真实 Windows UI 手工交互风险。
