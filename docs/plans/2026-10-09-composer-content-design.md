# 会话框内容设计说明（对标 DSH）

> 日期：2026-10-09 · 状态：已与用户确认 · 参考实现：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## 背景与目标

用户要求「看开源 DSH 怎么设置会话框的内容，然后模仿」。经查 DSH 的会话框分三层，本项目三层都有差距：

| 层 | DSH 的做法 | 本项目现状 |
|---|---|---|
| 输入框本体 | Lexical 富文本编辑器，@引用是原子 `DecoratorNode` | 原生 `<textarea>`，无任何引用系统 |
| 草稿 | 语义快照 `{text, references[]}` + zod 校验 span 一致性 | **无**（切会话/重启即丢） |
| 会话标题 | 独立插件调 LLM 生成，CJK 感知、JSON 框住输入防注入、严格输出约束 | `firstLine.trim().slice(0, 20)` 硬截断 |

**成功标准**：新会话有可读的中文短标题；输入到一半切会话不丢内容；材料/赛事可用 @ 引用且界面看得出被引用了什么；上述任一项失败都不影响正常对话。

## 现状与约束

- **零前端依赖、无打包器**：`dependencies` 只有 `app-builder-lib`，`index.html` 直接 `<script src="app.js">`。
- **CSP `script-src 'self'`**（[index.html:11](../../src/renderer/index.html)）：不能引外部脚本。
- 已验证 `lexical@0.52.0` 是 ESM 且依赖 `@lexical/internal` → 引入需先加构建链，本次不做。
- **用户全打中文**：`contenteditable` 的 IME 组合态是重灾区。DSH 靠 Lexical 内部处理才敢做行内 chip。
- 会话落盘在**工作区** `sessionsDir(ws)`，工作区可能尚未设置。
- 已有可复用通道：`api.input.list()`（四类材料）、`api.competitions.list()`、`streamChat()`。

## 方案对比

### 会话标题

- **A. 纯 LLM**（DSH 原样）：失败就没有标题 → 侧栏可能长期显示「新会话」。
- **B. 纯本地截断**：零成本零风险，但中文标题被腰斩。
- **C. 本地兜底 + LLM 异步替换**（选定）：立刻有可读标题，LLM 成功后替换。网络异常/未配 Key/超时都不白屏。

### chip（@引用）

- **A. 手写 contenteditable**：观感最贴 DSH，但 IME 要自己啃，400+ 行且难测。
- **B. chip 排在输入框上方，正文仍是 textarea**（选定）：零 IME 风险、零依赖。DSH 的 `AttachmentRail` 同思路。
- **C. textarea 叠装饰层**：DSH 架构笔记明确写了这套导致 #2813/#2793 并已废弃。**不采用**。
- **D. 引入 Lexical**：需先加构建链，收益不匹配成本。

## 详细设计

### ① 会话标题 — 新增 `src/main/agent/session-title.js`

照搬 DSH `session-title-llm` 的四条设计：

```
CJK 感知    targetWords=5 / targetCjkCharacters=10 分开配置
            （现在硬截 20 字，「基于层次分析法的…」会被切成半句）
JSON 框住   "Generate the title from this JSON array:\n" + JSON.stringify(msgs)
            ← DSH 注释原文：so user text cannot break structural delimiters
输出约束    单行纯文本；禁引号/前缀/Markdown/XML/控制码/代码；用消息的语言
硬限制      maxInputBytes / maxOutputTokens / timeoutMs + 专用错误码 TITLE_TIMEOUT
```

导出纯函数便于离线测试：`frameMessages()`、`systemPrompt()`、`cleanTitle()`（裁剪/去引号/去换行/按 CJK 计数截断）、`looksCjk()`。

**IPC `session:title`**（`{sessionId, text}` → `{ok, title}`）：
- 复用 `readConfig()` 的 provider+model（= DSH 的 `request.route` 兜底分支）
- 用**独立的 AbortController**，绝不写 `currentAbort`（否则污染对话的停止句柄）
- 成功后若 session 文件已存在，顺手更新其 `title` 字段（避免侧栏读到旧值）
- 任何失败都返回 `{ok:false}`，不抛错

**渲染层**：`send()` 里先按 CJK 感知规则给本地兜底标题（替换现在的 `slice(0,20)`），再异步调 `session:title`，成功则替换并刷新侧栏。只在**第一条**消息触发。

### ② 草稿持久化 — `userData/drafts.json`

**存 userData 而非工作区**：工作区是用户的成果目录，草稿是应用状态；且工作区可能未设置。

```
{ "<sessionId>": "<未发送文本>", ... }     按会话分键
```

- `input` 事件防抖 400ms 写入；发送成功/切会话时清除对应键
- 启动与切会话时回填
- 上限：单条 8000 字、总键数 50（超出按最旧淘汰），写失败静默（不影响输入）
- 不引入 DSH 的 `references[]` 校验——本项目 chip 是文本投影，没有独立 span 需要保真

### ③ placeholder / 空态引导

placeholder 不再写死，按状态优先级取第一个命中的：

| 条件 | 文案 |
|---|---|
| 未配 Key | `先在设置里填 API Key（点左下角设置）` |
| 未选赛事 | `点顶栏「赛事」选题，我按该赛事的规范成稿` |
| 已提交材料 | `已收到 N 项材料，说明要怎么处理（@ 可直接引用）` |
| 默认 | 按当前赛事给具体例子（国赛/美赛各不同） |

### ④ chip（方案 B）

**单一真源原则**（DSH 教训）：chip 不独立存列表，每次从 textarea 文本解析。

引用语法：`@{类别/名称}`，类别为固定枚举（赛题/规范/模板/数据/赛事/模型）。
选它是因为：无空格歧义、可正则 `@\{([^{}\n]+)\}`、中文友好、**模型直接读得懂**（不像 base64 标记）。

- 输入 `@{` 触发候选面板，数据来自已有的 `api.input.list()` / `api.competitions.list()`，**零新增 IPC**
- 选中 → 在光标处插入文本
- 输入框上方一条 chip rail 显示当前所有引用，点 ✕ 从 textarea 删掉该片段
- **IME 保护**：`compositionstart/end` 期间不弹面板、不重解析，避免打断拼音上屏
- 发送时文本原样带上（主进程 tools 能按名字读文件）

### 异常与边界

| 情况 | 处理 |
|---|---|
| LLM 超时/报错/返回空 | 保留本地兜底标题，不提示（静默降级） |
| LLM 返回超长/多行/带引号 | `cleanTitle()` 强制裁剪成单行 |
| 用户快速连发 | 标题只在第一条触发，用 state 标记防重复 |
| 未设置工作区 | 草稿走 userData，不受影响 |
| drafts.json 损坏 | 读失败当空对象，下次写入覆盖 |
| chip 语法被用户手打坏 | 解析失败就不显示 chip，正文照常发送 |
| 文件名含 `/` | 类别用固定枚举先匹配，其余整体作名称 |

### 测试策略

新增 `scripts/session-title-test.js`（离线，mock LLM）：CJK 判定、`cleanTitle` 各畸形输入、JSON 框住不被撑破、超时返回 `TITLE_TIMEOUT`、未配 Key 不发起请求。

新增 `scripts/draft-chip-test.js`：草稿读写与上限、损坏文件、`@{}` 解析（含中文/嵌套花括号/跨行/空类别）、投影与正文一致性、删除片段。

挂进 `scripts/run-all-tests.js`；冒烟补 placeholder 与 chip 的渲染断言。

## 顺手修的既有缺陷

[index.html:188](../../src/renderer/index.html) 激活页仍用旧的 `∑` 品牌标记（改名时漏网），换成 `#brandMark` 马头。

## 风险与待确认项

- LLM 生成标题会多耗用户少量额度（约 200–400 token / 会话），已获用户确认接受。
- 若某些网关不支持小 `max_tokens`，标题可能失败 → 已设计为静默降级到本地兜底。
- chip 方案 B 与 DSH 观感不同（在上方而非行内），是用户明确选择的结果。
