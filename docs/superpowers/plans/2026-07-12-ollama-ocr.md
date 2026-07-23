# Pot Ollama OCR 实施计划

**目标：** 为 Ctrl+E 截图翻译新增低延迟、无历史污染、保留 Markdown/LaTeX 的本地 GLM-OCR 服务，并在异常时安全回退系统 OCR。

**架构：** 新增 `ollama_ocr` 内置识别服务。纯函数负责请求构造、输出守卫和校验；依赖注入管线负责流式生成与系统回退；React 配置页只负责实例配置和连接检查。现有截图请求 id 继续负责 UI 提交隔离。

**技术栈：** React 18、Ollama HTTP generate 流、Ollama JavaScript SDK（配置检查）、Tauri 1、Node.js `node:test`、Vite、Rust/Cargo。

---

### Task 1：先建立请求与输出守卫回归测试

**Files:**

- Create: `src/services/recognize/ollama_ocr/core.test.js`
- Create: `src/services/recognize/ollama_ocr/image.test.js`
- Create: `src/services/recognize/ollama_ocr/output.test.js`
- Test: 上述两个测试文件

- [x] 地址无协议时补 `http://`，并移除末尾斜杠。
- [x] 请求体只有当前一张图片和固定 `OCR:`，不含历史或 context。
- [x] 请求固定为流式、温度 0、固定种子、硬上限与保活。
- [x] 小截图按确定布局放大并增加背景色边距，大截图不额外放大。
- [x] 正确首段后重开 Markdown 围栏并精确重复前缀时给出截断点。
- [x] 重复证据不足、合法代码围栏、近似但不同的公式不得截断。
- [x] 清理后粗体、行内/块级公式与反斜杠保持逐字符一致。
- [x] 运行测试并确认 RED。

### Task 2：实现纯函数与识别管线

**Files:**

- Create: `src/services/recognize/ollama_ocr/core.js`
- Create: `src/services/recognize/ollama_ocr/image.js`
- Create: `src/services/recognize/ollama_ocr/output.js`
- Create: `src/services/recognize/ollama_ocr/pipeline.js`
- Create: `src/services/recognize/ollama_ocr/pipeline.test.js`

- [x] 实现主机规范化、请求构造、响应校验和输出清理。
- [x] 实现 Canvas 轻量预处理；浏览器不支持时无损回退原始 base64。
- [x] 实现流式缓冲、确认重复后主动中止、硬上限校验。
- [x] 实现依赖注入的系统 OCR 回退和聚合错误。
- [x] 区分“被新请求取代”的取消与真实失败；前者不得回退。
- [x] 使用外部 `AbortController` 覆盖等待 Ollama 首响应前的取消。
- [x] 系统回退使用本次 base64 的独占临时文件，不读取共享截图。
- [x] 运行三组定向测试并确认 GREEN。

### Task 3：注册服务并提供克制的配置界面

**Files:**

- Create: `src/services/recognize/ollama_ocr/index.jsx`
- Create: `src/services/recognize/ollama_ocr/Config.jsx`
- Create: `src/services/recognize/ollama_ocr/info.ts`
- Modify: `src/services/recognize/index.jsx`
- Modify: `src-tauri/src/config.rs`
- Modify: `src/i18n/locales/zh_CN.json`
- Modify: `src/i18n/locales/en_US.json`

- [x] 导出完整语言枚举和 `structuredOutput` 元数据。
- [x] 配置实例名称、地址、模型与系统回退，默认 `glm-ocr:latest`。
- [x] 保存前检查 Ollama 连接和模型存在，不隐式下载。
- [x] 注册前端服务与 Rust 内置白名单，确保重启后配置不被删除。

### Task 4：保护结构化输出并补源码契约

**Files:**

- Modify: `src/window/Translate/components/SourceArea/index.jsx`
- Modify: `src/window/Recognize/TextArea/index.jsx`
- Create: `src/services/recognize/ollama_ocr/service_contract.test.js`
- Modify: `src/utils/translation_flow.test.js`

- [x] 结构化 OCR 服务跳过自动删除换行，普通 OCR 行为不变。
- [x] 断言每个 OCR 成功/失败出口继续受当前 request id 保护。
- [x] 断言服务注册、白名单、默认模型和结构化元数据存在。
- [x] 运行 OCR 测试和已有翻译流回归。

### Task 5：构建、配置、部署与真实快捷键验证

**Files:**

- Modify: `%APPDATA%/com.pot-app.desktop/config.json`

- [x] 运行 `node --test src/services/recognize/ollama_ocr/*.test.js`。
- [x] 运行 `node --test src/utils/translation_flow.test.js src/window/Translate/service_config.test.js`。
- [x] 运行 `npm run build`。
- [x] 运行 `cargo check --manifest-path src-tauri/Cargo.toml`。
- [x] 在独立 staging target 构建 Windows release，安全替换正在使用的 `pot.exe`。
- [x] 备份本机配置，把 `ollama_ocr@local` 放到识别列表首位并保存模型配置。
- [ ] 使用 Ctrl+E 对真实文字与公式截图复测：已确认截图层立即弹出；自动框选受 Windows 选择层限制，模型链路改用同一真实截图完成验证。
- [x] 运行 `git diff --check` 与 `git status --short`，记录未覆盖的手工风险。

## 迁移策略

无迁移，直接新增。旧识别服务不删除，本机默认顺序改为新服务优先。
