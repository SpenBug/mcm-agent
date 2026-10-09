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

### ② 草稿持久化 — `localStorage`（实现时改了方案）

原设计写 `userData/drafts.json`，实现时改成 `localStorage`，理由：
项目已经在用它存主题（`mcm-theme`），草稿是同样的"应用级小状态"；
走文件要新增 IPC + 防抖写盘 + 路径处理，收益不抵成本（YAGNI）。
两者都满足原设计的核心约束：**不存工作区**（那是用户成果目录，且可能未设置）。

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
| 默认 | 按当前赛事取名字（取自 `compState`，**不写赛事→文案映射表**） |

> 实现修正：原本设计写"国赛/美赛各给一个具体例子"，那会是又一份手抄清单
> （本轮已为手抄数据吃过四次亏）。改成直接用 `compState.list` 里的赛事名拼提示，
> 零副本、改了赛事数据自动跟上。

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
| LLM 比本地兜底更慢/更快返回 | 两边都比对 `state.sessionId` 与"是否仍是占位标题"，谁后到都不覆盖更好的那个 |
| 未设置工作区 | 草稿走 localStorage，不受影响 |
| 草稿数据损坏 / localStorage 被禁 | 读失败当空对象、写失败返回 false，全程不抛错 |
| chip 语法被用户手打坏 | 解析失败就不显示 chip，正文照常发送 |
| 文件名含 `/` | 类别用固定枚举先匹配，其余整体作名称 |
| 中文输入法打 `@` | composition 期间不弹面板、不重解析，避免打断拼音上屏 |
| 面板开着时按 Enter | 发送监听器里显式判断 `refPopOpen()` 直接返回（不靠监听器注册顺序或 capture） |

### 实现期间发现并补上的三件事（原设计没预料到）

1. **落盘标题的竞态**：会话文件是 `chat:send` 在 agent 跑完**之后**才写的，
   用的是调用时传入的标题快照；而 LLM 标题几秒就回来了。
   直接写会"文件还不存在"，晚写又会把 LLM 标题覆盖回本地兜底。
   → 主进程加 `pendingTitles`（带上限 50）暂存，两处写盘点统一走
   `resolveSessionTitle()`：LLM 标题 > 渲染层标题 > 主进程本地算 > 未命名。
   本地兜底也移到主进程算，规则只有一份。
2. **孤儿测试防线**：本轮真实发生过两次"测试文件写了、跑过一次就忘了挂进
   `run-all-tests.js`"，于是它再也不执行，"全绿"其实少了一整套断言。
   靠人记住防不住 → `run-all-tests.js` 加反向守卫：
   `scripts/*-test.js` 若不在 SUITES 里就直接失败。
   守卫上线当场就抓到一个**早就存在的孤儿** `path-resolve-test.js`（从未被跑过）。
3. **旧品牌符号残留远比预想的多**：见下一节。

### 测试策略（实际落地）

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `scripts/session-title-test.js` | 54 | CJK 判定、字节裁剪不切断代理对、`cleanTitle` 各畸形输入、JSON 框不被撑破、四种降级 code、**超时真的 abort 底层请求** |
| `scripts/drafts-test.js` | 35 | 读写/上限/淘汰不碰恢复指针、损坏数据五类、storage 被禁、重启往返 |
| `scripts/refs-test.js` | 52 | `@{}` 解析（中文/嵌套/跨行/空类别）、投影不变量、按区间删除、`lastIndex` 陷阱、触发检测、候选过滤 |

（原设计写的单个 `draft-chip-test.js` 实现时拆成两个：草稿与引用解析的
关注点完全不同，混在一起失败信息不好定位。）

冒烟新增 **25 项运行时断言**（逐条对着 diff 数过）：
- 会话框内容 14：`@{` 弹面板 → 选中插入 → chip 出现 → 点 ✕ 删除 → rail 隐藏，
  以及草稿写入/恢复指针/切会话不丢、placeholder 已被动态改写
- 品牌符号 3：单色 symbol 存在、激活页标记已是马头、界面无残留 `∑`
- 端到端 8：标题辅助请求 4（确实并行发出、不带 tools、JSON 框住原文、`max_tokens` 收紧）
  + 助手头像 3（已是马头、svg 尺寸受控、发消息后仍无 `∑`）+ 发送后输入框已清空 1

这些必须实测：本轮反复验证过"源码看着对、运行时是坏的"（图标那次最典型）。

## 顺手修的既有缺陷（实际规模远超预期）

设计时以为只有一处，grep 之后是 **30 个文件**，而且最要紧的一处不在激活页：

| 位置 | 说明 |
|---|---|
| `app.js` 助手头像 | 原本是 `∑`。**每条回复都显示**，是全站出现频率最高的品牌标记 |
| 激活页 `lock-mark` | 掏钱那一屏的标记 |
| 30 个预览桩 HTML | logo / es-mark / avatar 里的 `∑`（将来拿去做宣传图就会露出旧品牌） |

根因：改名脚本 `scripts/rename-brand.js` 只替换**文字**「数模工坊」，
图形符号 `∑` 不在它的字典里 —— 所以"改完了、测试也绿了"，符号却整片留着。

做法沿用本轮已验证有效的两条经验：
1. **不做手改**，写 `scripts/scrub-legacy-mark.js`（20+ 个文件手改必漏）；
2. **加防复活检查**并挂进 `npm test`（`--check` 模式）。

符号本身仍从 `brand-mark.js` 真源生成，为此给 `markBody()` 加了 `mono` 模式：
头像/锁页标记**容器自己已经有品牌蓝底**，再放带底板的 `brandMark` 就是"蓝底套蓝底"；
而写死白色在浅色主题下会直接看不见 → 单色版用 `currentColor` 跟随 CSS color。
单色版不画五官：那些位置只有 28~42px，眼睛会糊成脏点（与 16px 图标同理）。

## 风险与待确认项

- LLM 生成标题会多耗用户少量额度（约 200–400 token / 会话），已获用户确认接受。
- 若某些网关不支持小 `max_tokens`，标题可能失败 → 已设计为静默降级到本地兜底。
- chip 方案 B 与 DSH 观感不同（在上方而非行内），是用户明确选择的结果。
