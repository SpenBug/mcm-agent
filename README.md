<h1 align="center">阿一古数模</h1>

<p align="center">
  把数学建模竞赛从「赛题」做到「能交的论文」的 Windows 桌面应用。<br/>
  自填 API Key、自选模型；代码在你本机真实运行，论文里的每个数字都能追到结果文件。
</p>

<p align="center">
  <a href="https://github.com/SpenBug/mcm-agent/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/SpenBug/mcm-agent?label=release&color=285d7c"></a>
  <a href="https://github.com/SpenBug/mcm-agent/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/SpenBug/mcm-agent/total?label=downloads&color=285d7c"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/SpenBug/mcm-agent?label=license&color=285d7c"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2B%20x64-285d7c">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Electron%20%2B%20Python-285d7c">
</p>

<p align="center">
  <b>下载</b> · <a href="#下载安装">安装版</a> ·
  <a href="#一它解决什么">功能</a> ·
  <a href="#三五步流水线">工作流</a> ·
  <a href="#四ai-工具使用声明2026-起是硬性要求">AI 声明合规</a> ·
  <a href="#八给卖家卡密与发卡">卖家发卡</a> ·
  <a href="#九文档">文档</a>
</p>

<p align="center">
  <img src="docs/screenshots/01-workbench.png" alt="阿一古数模主界面：四类材料槽位 + 五步流程 + 赛事倒计时" width="880">
  <br/>
  <sub>主界面：四类材料分别提交 → 五步流水线自动推进 · 顶栏实时显示当前赛事与倒计时</sub>
</p>

<p align="center">
  <img src="docs/screenshots/03-execution.png" alt="Agent 在本机真实运行 Python 代码出图" width="880">
  <br/>
  <sub>代码在**你本机真实运行**（不是让模型"编"结果）：运行卡片可展开看完整代码与 stdout</sub>
</p>

---

## 目录

- [下载安装](#下载安装)
- [一、它解决什么](#一它解决什么)
- [二、赛事日历与定价](#二赛事日历与定价)
- [三、邀请有礼](#三邀请有礼)
- [四、五步流水线](#四五步流水线)
- [五、AI 工具使用声明（2026 起是硬性要求）](#五ai-工具使用声明2026-起是硬性要求)
- [六、架构](#六架构)
- [七、内置技能库](#七内置技能库)
- [八、开发与测试](#八开发与测试)
- [九、给卖家：卡密与发卡](#九给卖家卡密与发卡)
- [十、文档](#十文档)
- [十一、二次开发提示](#十一二次开发提示)
- [十二、License](#十二license)

---

## 下载安装

**最新版：v1.1.1** —— [全部发布版本](https://github.com/SpenBug/mcm-agent/releases/latest)

| 下载 | 说明 |
|---|---|
| [**安装版**（推荐）](https://github.com/SpenBug/mcm-agent/releases/download/v1.1.1/ayigu-mcm-agent-setup-1.1.1.exe) | 装到系统，有开始菜单与桌面快捷方式 |
| [便携版](https://github.com/SpenBug/mcm-agent/releases/download/v1.1.1/ayigu-mcm-agent-portable-1.1.1.exe) | 免安装，双击即用，可放 U 盘 |

> 上面的直链带版本号，**每次发版都会变**。懒得看版本就直接进
> [Releases 页面](https://github.com/SpenBug/mcm-agent/releases/latest) 拿最新那个。

两个包功能完全相同。**Windows 10/11 x64**，打开即免费体验 2 小时（全功能，产出带体验水印）。

> ⚠️ 本版 exe **未做代码签名**，Windows SmartScreen 可能提示「未知发布者」，
> 点「更多信息 → 仍要运行」即可。
>
> 想校验下载完整性：在 [Release 页面](https://github.com/SpenBug/mcm-agent/releases/latest)
> 展开对应附件的 **Digest** 一栏，那里是 GitHub 自动生成的 SHA256
> （不在这里写死哈希 —— 每次重新打包都会变，写死必然过期，反而误导）。

---

## 一、它解决什么

| 常见痛点 | 阿一古数模的做法 |
|---|---|
| 论文里的数是「编」出来的 | Agent 在你本机**真实运行代码**，图表与结论都来自实际计算结果 |
| 流程图用 Matplotlib 手绘，不可编辑、不像竞赛图 | 走**竞赛模式**产出可编辑 `.drawio` + 矢量 PDF |
| 模型由客户端统一决定 | 设置页自填 API Key / Base URL / 模型，兼容任何 OpenAI 协议网关 |
| 环境要自己配 | 内置 Python 环境自检与一键安装（装到应用私有目录，不污染系统） |
| **AI 使用声明漏了被取消评奖资格** | 内置合规生成器，按赛事规定把声明放在参考文献之前 |
| 不知道今年哪个比赛快开始了 | 顶栏**赛事日历**：官方时间 + 状态 + 倒计时 |
| 提问要手抄一长串文件名 | 输入 `@{` **直接引用**已提交的材料 / 赛事 / 模型 |
| 输入到一半切会话就丢 | **草稿自动保存**，切回来、重开软件都还在 |

---

## 二、赛事日历与定价

内置 2026/2027 各主要赛事的**官方比赛时间**，顶栏「赛事」面板实时显示状态与倒计时：

| 赛事 | 时间（官方） | 解锁价 |
|---|---|---|
| **MathorCup 大数据赛** | **2026-10-23 18:00 → 10-30 20:00**（7 天赛；复赛 12-04 → 12-11） | ¥39 |
| 数维杯秋季赛 | 2026-11-20 09:00 → 11-24 09:00（报名截止 11-20 06:00） | ¥39 |
| 国赛 CUMCM 高教社杯 | 2026-09-10 18:00 → 09-13 20:00 | ¥69 |
| 华为杯研究生赛 | 2026-09-23 08:00 → 09-27 12:00 | ¥79 |
| 美赛 MCM/ICM | 2027 年 1 月底（待 COMAP 公布） | ¥79 |
| 亚太赛 APMCM | 2026-06-12 18:00 → 06-15 20:00 | ¥39 |
| 华数杯（国内赛） | 2026-08-07 18:00 → 08-10 20:00 | ¥39 |
| 华数杯国际赛 | 2026-01-17 06:00 → 01-21 09:00 | ¥39 |
| MathorCup（数学建模赛项） | 2026-04-17 08:00 → 04-21 09:00 | ¥29 |
| 其他小赛（华中杯/五一赛…） | 各赛事以官网为准 | ¥29 |
| **全能包** | 解锁以上全部 | **¥168** |

> 时间来源：国赛 [mcm.edu.cn](https://www.mcm.edu.cn/)、华为杯[开赛公告](https://www.cmathc.org.cn/cpmcm/news/642.html)、
> 数维杯[官网](https://www.nmmcm.org.cn/Competition/)、
> MathorCup 大数据[报名通知](https://www.cmathc.org.cn/mcm/tz/612.html)、
> 华数杯与华数杯国际赛赛氪赛题发布。
> 状态（报名中/进行中/已结束/待公布）与倒计时由程序按当前时间推导，不是写死的。

**免费体验 2 小时**，所有赛事都能试。激活后按所购赛事解锁 —— 买了国赛卡就只在国赛模式下可用；全能包解锁全部。
**旧卡兼容**：早期签发的卡没有赛事字段，一律按全能包处理。

---

## 三、邀请有礼

每个用户都有自己的**邀请码 = 卡号后 6 位**（如 `MCM-2026-0005` → `260005`），
在侧栏「邀请有礼」里**显眼展示 + 一键复制分享**。

| 规则 | 内容 |
|---|---|
| 朋友优惠 | 购买时报你的邀请码，**立减 ¥5** |
| 你的奖励 | 累计满 **3 人**，送 **一期比赛的使用权** |

> ⚠️ **减价与送卡由客服在微信里确认发放**，软件不做本地自动解锁。
> 原因：这是纯离线应用，本地记数删个文件就重置了 —— 那种"满 3 自动解锁"防不住任何人。
> 软件只负责把码展示出来、方便截图分享；卖家侧用 `node tools/issue.js invite <码>` 记账，
> 满 3 人会自动提醒发奖励（`node tools/issue.js invites` 看统计）。

---

## 四、五步流水线

```mermaid
flowchart LR
    Q(["赛题 + 四类附件"]) --> S1

    subgraph S1["① 接料建卡"]
        direction TB
        A1["读赛题 / 规范 / 模板 / 数据"]
        A2["产出规则卡<br/>硬性条款带原文出处"]
        A1 --> A2
    end

    subgraph S2["② 建模"]
        direction TB
        B1["选模型 · 定变量 · 立假设"]
        B2["产出题目分析报告"]
        B1 --> B2
    end

    subgraph S3["③ 求解出图"]
        direction TB
        C1["写代码 · 真实运行"]
        C2["数据图 mcm-figure<br/>非数据图 mcm-diagram"]
        C3["产出 code/ results/ figures/"]
        C1 --> C2 --> C3
    end

    subgraph S4["④ 成稿"]
        direction TB
        D1["按客户模板成稿"]
        D2["AI 声明置于参考文献之前"]
        D3["产出论文 Word + PDF"]
        D1 --> D2 --> D3
    end

    subgraph S5["⑤ 提交前自检"]
        E1["逐条走十二闸<br/>致命闸不过不算完成"]
    end

    S1 ==> S2 ==> S3 ==> S4 ==> S5
    S5 --> OUT(["成稿 + 图源 + 代码 + 自检报告"])
```

**三条硬约束**（写在系统提示词里，不是靠模型自觉）：

1. **每个环节开始前必须实际读取对应文件** —— 知道路径不等于已经执行；
2. **交付前必须跑完全部门禁** —— 任一命令未运行、退出码非零、或产物在门禁后被改动，都不允许声称「已完成」；
3. **门禁 FAIL 必须带证据回退** —— 编程手发现公式不完整时停止猜测、回到建模层修正；论文手发现结论没有真实结果支撑时回到前序补齐，**禁止编造**。

也可以只跑单个环节（只做题目分析 / 只写代码出图 / 只写论文）。

<p align="center">
  <img src="docs/screenshots/02-analysis.png" alt="题目分析完成，产出报告与图表" width="880">
  <br/>
  <sub>② 建模 → ③ 求解出图 完成：报告与图表落到 <code>reports/</code> 与 <code>figures/</code>，可点开预览</sub>
</p>

<p align="center">
  <img src="docs/screenshots/04-preview.png" alt="文件树与图表预览" width="880">
  <br/>
  <sub>左侧文件树 + 右侧预览：产出的图与论文都在工作区里，可直接打开</sub>
</p>

### 提问方式：`@{}` 引用与草稿

输入 `@{` 会弹出候选列表，直接引用已提交的材料，不用抄文件名：

```
请用 @{赛题/2024A.pdf} 结合 @{数据/附件1.xlsx} 建立评价模型
```

- 类别是固定六个：**赛题 / 规范 / 模板 / 数据 / 赛事 / 模型**
- 选中后输入框上方出现 chip（引用就是正文里的普通文字，可手改手删，模型直接读得懂）
- **没发出去的话不会丢**：切会话、点新建、甚至关软件重开，输入框内容都会回来
- 输入框提示语跟着进度变（未配 Key → 未交材料 → 已交材料 → 当前赛事）
- 会话名自动取：第一条消息发出后由模型起一个短标题，**中文按字、英文按词**计数，
  不会把「基于层次分析法的…」腰斩；拿不到结果时退回本地截断，侧栏不会空着

---

## 五、AI 工具使用声明（2026 起是硬性要求）

全国大学生数学建模竞赛《[人工智能工具使用规定（2026 年试行）](https://www.mcm.edu.cn/html_cn/node/fef94648f2836ab6cc81586f4c38512b.html)》
（2026-09-01 起试行）要求：

- 论文**参考文献之前**必须设置「AI 工具使用声明」，二选一（用了 / 没用，句式都规定了）；
- 使用 AI 的，支撑材料要附《AI工具使用详情.pdf》，含四项：工具名称版本 / 用途环节 / 提示方式 / 人工核验；
- **不符合规定的作品视为违反竞赛规则**，可能取消评奖资格。

阿一古数模的做法：

- 成稿时把 `ai_declaration` 自动插到**参考文献之前**（位置错了 `mcm_docx.py check` 会报出来）；
- 赛事面板一键生成《AI工具使用详情》草稿到 `reports/`；
- 🔴 **不替你编造声明**：用途、提示方式这些只有你知道，未填的项会留 `【占位符】`
  并被 `check` 查出，逼你亲自核实 —— 虚假声明是要取消评奖资格的。

> 华为杯同样允许 AI，但要求所有引用（含程序、AI 产品）注明来源；美赛需在报告中声明。三者措辞已分别内置。

<p align="center">
  <img src="docs/screenshots/05-settings.png" alt="设置页：自填 API Key、Base URL、模型" width="880">
  <br/>
  <sub>设置页：自填 API Key / Base URL / 模型 —— 兼容任何 OpenAI 协议网关，也可用本地模型</sub>
</p>

---

## 六、架构

```mermaid
flowchart TB
    subgraph R["渲染进程 · 原生 JS，无框架"]
        UI["三栏布局<br/>会话 / 对话 / 文件树与预览"]
        CMP["赛事日历面板<br/>状态 + 倒计时 + 解锁引导"]
    end

    subgraph M["主进程 · Electron"]
        IPC["ipc.js<br/>IPC 路由 + 授权门禁"]
        LOOP["agent/loop.js<br/>Agent 循环"]
        PR["agent/prompt.js<br/>系统提示词装配<br/>技能路由 + 当前赛事"]
        LLM["agent/llm.js<br/>OpenAI 兼容流式客户端"]
        TB["agent/tools.js<br/>7 个工具 + 路径沙箱"]
        AI["agent/ai-declare.js<br/>AI 使用声明生成"]
        LIC["license.js<br/>Ed25519 验签 + 机器码"]
        CP["competitions.js<br/>赛事数据 + 状态推导"]
    end

    subgraph RT["运行时探测"]
        PY["runtime/python.js<br/>探测 · venv · 依赖安装"]
        DR["runtime/drawio.js<br/>draw.io 探测 · 导出"]
    end

    subgraph SK["内置技能库（只读，167 文件）"]
        S1["mcm-workflow<br/>五步流程 + 门禁"]
        S2["mcm-figure<br/>论文级 Matplotlib"]
        S3["mcm-diagram<br/>竞赛模式 draw.io<br/>9 套模板 + 12 脚本"]
        S4["mcm-tools<br/>PDF/Excel/Word/LaTeX/文献"]
    end

    UI <--> IPC
    CMP <--> IPC
    IPC <--> LOOP
    LOOP --> PR
    LOOP --> LLM
    LOOP --> TB
    PR --> SK
    IPC --> LIC
    IPC --> CP
    IPC --> AI
    LOOP --> RT
```

---

## 七、内置技能库

| 技能 | 内容 | 文件数 |
|---|---|---|
| **mcm-workflow** | 五步流程、十二闸自检、规则卡模板 | 2 |
| **mcm-figure** | 论文级 Matplotlib 规范 + 可直接 import 的样式模块 | 5 |
| **mcm-diagram** | 竞赛模式 draw.io：9 套示意图模板 + 12 个渲染脚本 + 图标库 | 149 |
| **mcm-tools** | 读 PDF / 读写 Excel / 生成 Word / 编译 LaTeX / 检索文献 | 11 |

技能库是**只读**的：Agent 写产物只能落到工作区，7 个工具里写操作对 `skills/` 路径一律拒绝。

---

## 八、开发与测试

```bash
npm install
npm start              # 启动（无 GPU 环境用 npm run start:nogpu）

npm test               # 聚合离线测试（23 套，不需要图形界面）
npm run smoke          # 端到端：UI + IPC + 真实 Python/draw.io 导出
```

| 套件 | 覆盖 |
|---|---|
| `test:tools` | 7 个工具、路径沙箱、越界拦截、注入防护、超时强杀 |
| （`path-resolve-test`） | `read_file` 四种路径写法 + 三类越界必须被拒 |
| `test:loop` | Agent 循环、工具回灌、中断后历史合法性 |
| `test:license` | 机器指纹、Ed25519 验签、过期宽限、体验版、**删 license.json 不重置** |
| `test:competitions` | 赛事状态推导、倒计时、默认赛事、解锁判断、邀请码派生 |
| `test:ai-declare` | 声明措辞、**未填项留占位符不编造**、详情四项 |
| `test:snapshot` | 工作区快照与回滚 |
| （`session-title-test`） | CJK 感知长度、JSON 框防注入、四种降级码、**超时真的 abort 请求** |
| （`drafts-test`） | 草稿读写/上限/淘汰、损坏数据、localStorage 被禁、重启往返 |
| （`refs-test`） | `@{}` 解析、chip 是正文投影的不变量、按区间删除、`lastIndex` 陷阱 |
| `test:migration` | 改名后 userData 迁移：保住卡密 / 体验进度 / python-env |
| `icon:check` | 马头几何与拓扑 + 图标产物新鲜度（内容指纹，防"改了形状图标没重生成"） |
| （3 个 `--check` 同源项） | 品牌标记、签发器赛事选项、keygen 赛事选项 —— 与各自的数据源一致 |
| （`issuer-consistency-test`） | 三方公钥一致、**competition 必须透传**、台账列映射、端到端签发 |
| （`keygen-ledger-test`） | 卡号不重复（否则邀请码撞车）、CSV 往返契约 |

> 表里带括号的是 `npm test` 会跑、但没有单独 `test:` 别名的套件。
> `npm test` 还有一道**反向守卫**：`scripts/*-test.js` 若没挂进聚合入口就直接失败 ——
> 本轮真实发生过两次"测试写了但忘了挂"，于是它再也不执行，"全绿"其实少了一整套断言。

冒烟（`npm run smoke`）另外覆盖真实运行时：IPC 12 项、赛事面板 10 项、
品牌与邀请码 12 项、**会话框内容 14 项**（`@{` 弹面板→插入→chip→删除、
草稿写入与切会话不丢、placeholder 动态改写）、端到端对话与标题辅助请求。

打包：

```bash
npm run dist           # 出 NSIS 安装包 + 便携版到 dist/
npm run smoke:packaged # ★ 对打包出来的 exe 跑冒烟（发版前必跑）
npm run verify:package # 包内验收：该进的进了、私钥/签发器没进、内容是当前代码
npm run verify:icon    # 从 exe 里反查内嵌图标是不是当前品牌图标
```

> **为什么需要 `smoke:packaged`**：开发态全绿 ≠ 包里能跑。打包出的 exe 是
> GUI 子系统程序，Windows 下看不到 stdout，所以冒烟自己会把结果写成
> 报告文件并带退出码，这条命令再核对报告里的 `packaged=true` 与
> `execPath` —— 确认跑的是包里的 exe，不是不小心用源码跑的。
> 它还会清掉 `ELECTRON_RUN_AS_NODE`（不清的话 exe 退化成裸 node，
> `--smoke` 被当成非法参数，退出码 9 且什么都不写，看起来像包坏了）。

---

## 九、给卖家：卡密与发卡

**架构**：客户端只内嵌**公钥**（只能验签、不能伪造），私钥永远在你手里。

```
用户装 exe → 2 小时体验 → 到期弹激活页显示【机器码】
   ↓ 用户加微信发机器码
你签发：node tools/issue.js new --machine <机器码> --competition cumcm --days 365
   ↓ 把卡密发回
用户粘贴 → 本地验签 + 机器码比对 → 解锁
```

**没有服务器，全部本地验证，成本 0 元。**

- 详细流程见 [卖家手册](docs/卖家手册.md)（含价目表、`--competition` 参数、台账迁移、邀请码记账）
- **日常发卡用**：双击 `tools/签发卡密.bat`（本地服务，只监听 127.0.0.1，卡直接进 `tools/issued.csv`）
- 备用：双击 `tools/keygen.html`（纯网页，手边没 Node 时用）。
  ⚠️ 它的台账在浏览器本地，**用完要 `node tools/issue.js import <导出的csv>` 并回 issued.csv**，
  否则那些买家来领推荐奖时你查不到。
- 赛事与售价只有一个真源 `src/main/competitions.js`；网页签发器的下拉由
  `node scripts/sync-keygen-options.js` 生成，`npm test` 会盯住漂移（改了定价忘了同步 → 测试红）。
- ⚠️ **私钥备份**：`keys/license-private.pem` 丢了就再也发不出新卡（已发的还能用）。
  备份到至少两处离线介质，**别传网盘/GitHub**（`.gitignore` 已排除 `keys/`）。

---

## 十、文档

- [**开发与发版 SOP**](docs/SOP-开发与发版.md) —— ★ 环境坑、发版步骤、守卫清单（**活文档，随时更新**）
- [用户指南](docs/用户指南.md) —— 安装、配 Key、跑第一道题
- [卖家手册](docs/卖家手册.md) —— 发卡、定价、对账
- [设计文档](docs/plans/) —— 赛事定价、会话框内容的设计取舍
- [项目体检报告](docs/体检报告-2026-10-07.md) —— 历史快照（当时的问题清单）

> SOP 里的每条命令与数字都由 `npm test` 的 `SOP 文档事实核对` 守卫盯着 ——
> 文档与代码不一致会直接测试失败，不会悄悄腐烂。

---

## 十一、二次开发提示

| 想改什么 | 改哪里 |
|---|---|
| 系统提示词（技能路由、出图分工） | `src/main/agent/prompt.js` |
| 加新工具 | `src/main/agent/tools.js` 的 `TOOL_DEFS` + `executeTool` |
| 加服务商预设 | `src/main/store.js` 的 `PROVIDERS` |
| **赛事时间 / 定价** | `src/main/competitions.js`（改完重新打包） |
| **AI 声明措辞** | `src/main/agent/ai-declare.js` |
| 界面风格 | `src/renderer/styles.css` 顶部的 `:root` 设计令牌 |
| 更新内置技能 | 覆盖 `resources/skills/` 下的目录，重新打包 |
| 换应用图标 | 改 `src/main/brand-mark.js`（形状唯一真源），跑 `npm run brand && npm run icon` |
| 邀请码规则 | `src/main/competitions.js` 的 `inviteCodeFromCard` + `tools/issue.js` |

---

## 十二、License

[MIT](LICENSE) © 2026 SpenBug
