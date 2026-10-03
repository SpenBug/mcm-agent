# 数模智能体（mcm-agent）

把 `math-modeling` 技能做成了一个**可独立运行的 Windows 桌面应用**：自己填 API Key、自己选模型，内置完整的三阶段建模流水线，并用 `scibox-diagram` 的**竞赛模式取代了原来的流程图环节**。

## 直接下载

| 版本 | 说明 |
|---|---|
| **[便携版](https://github.com/SpenBug/mcm-agent/releases/download/v1.0.0/mcm-agent-portable-1.0.0.exe)** | 双击即用，不写注册表（推荐先试这个） |
| **[安装包](https://github.com/SpenBug/mcm-agent/releases/download/v1.0.0/mcm-agent-setup-1.0.0.exe)** | NSIS，可换安装目录、建桌面 / 开始菜单快捷方式 |

全部版本见 [Releases](https://github.com/SpenBug/mcm-agent/releases)。

---

## 一、它解决什么

| 原来的痛点 | 现在 |
|---|---|
| 技能只能在 WorkBuddy 里用 | 打包成 exe，双击就跑，可拷给别人 |
| 模型由客户端统一决定 | 设置页自填 API Key、Base URL、模型，兼容任何 OpenAI 协议网关 |
| 流程图用 Matplotlib 手绘，不可编辑、不像竞赛图 | 走 `scibox-diagram` 竞赛模式，产出**可编辑的 `.drawio` + 矢量 PDF** |
| 环境依赖要自己配 | 内置 Python 环境自检与一键安装（装到应用私有目录，不污染系统） |

---

## 二、快速开始

### 开发态运行

```bash
cd D:\数学建模项目\mcm-agent
npm install
npm start              # 常规启动
npm start:nogpu        # 虚拟机 / 远程桌面 / 无 GPU 环境
npm run smoke          # 冒烟自检（界面 + 后端链路，跑完自动退出）
```

### 打包成 exe

```bash
npm run dist           # 产出安装包 + 便携版
npm run pack           # 只产出免安装目录（调试用）
```

> ⚠️ **打包前需手动清空 `dist/win-unpacked`**，否则会被工作区的 safe-delete 守卫拦下（要删 435 个文件，超过 50 的阈值）：
> ```powershell
> [System.IO.Directory]::Delete("D:\数学建模项目\mcm-agent\dist\win-unpacked", $true)
> ```

产物（各 159 MB）：

| 文件 | 说明 |
|---|---|
| `dist\数模智能体 Setup 1.0.0.exe` | NSIS 安装包，可换安装目录、建桌面/开始菜单快捷方式 |
| `dist\数模智能体-便携版-1.0.0.exe` | 单文件便携版，双击即用，不写注册表 |

### 首次配置

1. 启动后自动弹出**设置**（也可点右上角「设置」）。
2. 选服务商 → 自动填 Base URL 与候选模型；任何 OpenAI 兼容网关都选「自定义」。
3. 填 API Key → 点**测试连通性** → **保存**。
4. 点右上角「运行环境」查看依赖状态：
   - **Python 运行时** —— 依赖不齐时点「创建独立环境并安装依赖」（装到 `%APPDATA%\数模智能体\python-env`，不污染系统 Python）
   - **draw.io 桌面版** —— 应用自动探测，无需手动配路径，状态一目了然

内置预设：DeepSeek、Kimi、通义千问、智谱 GLM、OpenAI、硅基流动、Ollama 本地、自定义。

---

## 三、内置能力

### 技能库（打包在 `resources/skills/`）

| 技能 | 内容 | 体积 |
|---|---|---|
| `math-modeling` | 三阶段角色（建模手 / 编程手 / 论文手）、PDF·Excel·绘图·Word·LaTeX·论文搜索工具链、算法索引、华为杯 2026 官方附件 | 5.7 MB |
| `scibox-diagram` | 9 套示意图模板 + 12 个 Python 脚本（渲染 / 校验 / 导出 / 预览）、竞赛模式规范 | 3.1 MB |

> **关于优秀论文集**：本仓库的技能库**不含** COMAP / CUMCM 优秀论文 PDF（`references/Outstanding Thesis/`，约 54MB）。
> 那部分属第三方版权资料，不适合公开分发。本地开发时从 `~/.agents/skills/math-modeling/references/` 复制过来即可。
> 该目录只影响「参考往届优秀论文」这一项能力，不影响建模、出图与写作流程。

### 出图分工（关键）

数学建模的图分两类，走**两套完全不同的工具链** —— 这是本应用和原技能最大的区别：

| 图型 | 例子 | 工具链 | 命名 |
|---|---|---|---|
| **数据图** | 折线、柱状、散点、热图、箱线、误差曲线 | `math-modeling/tools/figure`（Matplotlib + Nature/SCI 视觉流程） | `raw_qN_*` / `process_qN_*` / `result_qN_*` |
| **非数据图** | 技术路线图、子问题流程图、数据处理流程、模型结构图、指标体系图、决策树 | **`scibox-diagram` 竞赛模式（draw.io）** | `fig_roadmap` / `fig_flow_qN` / `fig_pipeline` / `fig_model` / `fig_index_system` / `fig_decision_tree` |

非数据图**不再用 Matplotlib 手绘**。竞赛模式产出：

```
figures/
  fig_roadmap.drawio    fig_roadmap.pdf
  fig_flow_q1.drawio    fig_flow_q1.pdf
  ...
reports/DRAWIO_REPORT.md
```

`.drawio` 是可编辑源文件（能在 draw.io 桌面版/网页版里直接改），`.pdf` 是论文引用的矢量图。

---

## 四、目录结构

```
mcm-agent/
├── src/
│   ├── main/                  # 主进程
│   │   ├── index.js           # 窗口与生命周期（含 --smoke / --make-icon / --shot / --no-gpu 开关）
│   │   ├── paths.js           # 技能目录 / 配置目录 / 工作区解析
│   │   ├── store.js           # 配置持久化 + 8 家服务商预设
│   │   ├── ipc.js             # IPC 路由
│   │   ├── smoke.js           # 冒烟自检（界面截图 + 环境面板 + 后端链路）
│   │   ├── shot.js            # 通用截图（HTML/URL → PNG）
│   │   ├── icon.js            # 用 Electron 渲染生成图标
│   │   ├── agent/
│   │   │   ├── llm.js         # OpenAI 兼容流式客户端（含 tool calling）
│   │   │   ├── loop.js        # Agent 循环
│   │   │   ├── prompt.js      # 系统提示词装配（技能路由 + 出图分工）
│   │   │   └── tools.js       # 7 个工具 + 路径沙箱
│   │   └── runtime/
│   │       ├── python.js      # Python 探测 / venv / 依赖安装
│   │       └── drawio.js      # draw.io 探测 / 导出
│   ├── preload/index.js       # contextBridge 安全桥
│   └── renderer/              # 界面（原生 JS，无框架）
├── scripts/
│   ├── dev.js                 # 启动包装（清 ELECTRON_RUN_AS_NODE）
│   ├── test-agent-loop.js     # Agent 内核离线验证（mock LLM）
│   └── test-tools.js          # 工具层验证（37 项断言）
├── resources/skills/          # 内置技能（打包进 exe）
├── build/icon.png             # 应用图标 384×384
└── dist/                      # 打包产物
```

**工作区**默认在 `文档\数模智能体工作区`，可在顶栏切换。所有产物写在工作区里，技能库只读。

---

## 五、Agent 能用的工具

| 工具 | 用途 |
|---|---|
| `read_file` | 读题目、技能文档、代码、报告（带行号） |
| `write_file` | 写代码、报告、content JSON |
| `edit_file` | 精确替换，局部改文件 |
| `list_files` | glob 列文件 |
| `search_text` | 正则搜内容 |
| `run_command` | 跑技能脚本、编译、导出 |
| `run_python` | 直接执行 Python 代码片段或脚本 |

安全约束：写操作只能落在工作区内；读技能库要用 `skills/` 前缀；命令有超时保护（默认 180s，上限 15min）。

---

## 六、实测验证结果

### 6.1 Agent 内核离线验证（`npm run test:loop`）

用本地 mock LLM 服务器跑通完整链路，**不需要真实 API Key**：

```
事件序列: turn_start → turn_end → tool_start(write_file) → tool_result(write_file)
        → turn_start → delta → turn_end → tool_start(read_file) → tool_result(read_file)
        → tool_start(list_files) → tool_result(list_files)
        → turn_start → delta → turn_end → done

✓ LLM 请求次数 = 3
✓ tool_start 事件 = 3（write_file, read_file, list_files）
✓ arguments 分片拼接正确  [{"path":"out/result.txt","content":"hello from mock"}]
✓ 工具全部执行成功
✓ 文件确实落盘且内容正确
✓ 同轮多工具并行
✓ 回灌了 tool 角色消息
✓ assistant 消息带 tool_calls
✓ 请求里带上了 7 个 tools 定义
✓ 收到 done 事件、无 error 事件
✓ 最终返回文本正确

结果：13/13 通过
```

### 6.2 界面与后端链路（`npm run smoke`）

开发态与打包后各跑一次，均通过：

```
界面   : 三栏布局 272px | 1194px | 0px、8 个服务商预设、
         preload 桥 ok、空状态 4 张快捷卡、无控制台报错
技能   : math-modeling/SKILL.md ✓  scibox-diagram/mcm-mode.md ✓  task_bands.py ✓
提示词 : 4384 字符，含「竞赛模式」「fig_roadmap」「DRAWIO_REPORT」
         与「不要用 Matplotlib」约束
工具   : 7 个全部注册；read_file 可经 skills/ 前缀读技能库
沙箱   : 越界写入 ../../evil.txt 被拦截 ✓
Python : 应用私有 venv 已就绪，依赖「已装 8 项，缺 0 项」
draw.io: 自动探测到 D:\Drawio\draw.io\draw.io.exe
打包后 : skillsRoot 正确指向 resources\skills，362 个技能文件齐全
```

### 6.3 竞赛模式出图端到端验证

用 `task-bands` 模板跑了一遍真实的四任务技术路线图：

```
渲染   : ✓ 容量检查通过（画布 1080×850）
         ✓ 已写出 figures/fig_roadmap.drawio（73 个图元）
布局   : 顶点 55 / 连接器 18    FAIL 0  WARN 0    ✓ 版式体检通过
导出   : fig_roadmap.pdf（65 KB 矢量）+ fig_roadmap.png（298 KB）
目检   : 左侧橙红任务签（任务一~四）、右侧竖排阶段签（特征提取 / 源域诊断 /
         迁移诊断 / 可解释性）、蓝色虚线分区、橙色流程盒、箭头连接、
         黑色推进箭头 —— 结构完整，与源数据一致
```

### 6.4 工具层完整验证（`npm run test:tools`）

7 个工具的正面用例 + 边界 + 路径沙箱，共 **37 项断言全部通过**：

```
✓ write_file   自动建多级目录 / 覆盖写
✓ read_file    带行号 / offset·limit / skills/ 前缀读技能库 / 不存在文件报错
✓ edit_file    唯一替换 / 非唯一拒绝 / replace_all / 找不到原文报错
✓ list_files   递归 glob / 子目录 glob / 无匹配提示
✓ search_text  跨文件命中 / glob 过滤 / 正则 / 非法正则报错
✓ run_command  正常执行 / 透传非零退出码 / 捕获 stderr / cwd / 超时强杀（2.5s）
✓ run_python   代码片段 / 脚本传参 / 透传异常 / 缺参报错
✓ 路径沙箱     4 种越界写法 + 绝对路径越界 全部拦截
✓ 技能库只读   写/编辑 skills/ 前缀被拒，且不在工作区留残留目录
```

### 6.5 IPC 链路验证（含在 `npm run smoke`）

12 项断言全部通过 —— 走完整的「渲染进程 → preload → 主进程」链路：

```
✓ config 保存往返          ✓ config 脱敏（apiKey 不返回渲染进程）
✓ session 保存后可见        ✓ session 内容可读
✓ session 删除生效          ✓ workspace 可枚举
✓ workspace 读不存在文件不崩 ✓ skills 枚举（2 个技能，math-modeling 209 文件）
✓ 技能描述已解析            ✓ chat.abort 空调用无害
✓ 连通性失败优雅返回        ✓ 未配 Key 时给明确提示而非崩溃
```

### 6.6 端到端对话验证（含在 `npm run smoke`）

**这是最关键的一条** —— 前面几层测试都有盲区，只有它能抓到"消息组装错了"这类 bug。

做法：启动本地 mock LLM，**从界面填输入框 → 点发送按钮**（不直接调 IPC，确保覆盖渲染层的组装逻辑），然后检查 mock 收到的请求：

```
✓ mock LLM 收到请求
✓ 请求含 system prompt
✓ 请求含用户消息（关键）
✓ 请求带 7 个 tools 定义
✓ 界面渲染出用户气泡
✓ 界面收到模型回复
```

> 这条用例真抓到过 bug：渲染进程曾把 `messages` 写成 `state.messages.slice(0, -0)` —— 因为 `-0 === 0`，它等价于 `slice(0, 0)`，返回**空数组**，用户消息根本传不到主进程。
> 模块级测试（直接调 `runAgent`）和守卫分支测试都发现不了它。修好后把 bug 临时改回去复跑，确认测试报出 `实际 roles=[system]` —— 证明这条断言不是摆设。

### 6.7 建模能力端到端验证（`npm run test:modeling`）

前面几层测的都是「函数返回了正确的东西」，**从没真的让 matplotlib 出过图**。这条补上：用 mock LLM 驱动一遍完整的「写脚本 → 跑脚本 → 出图」。

```
事件序列: turn_start → delta → turn_end → tool_start(write_file) → tool_result
        → turn_start → delta → turn_end → tool_start(run_python) → tool_stream ×5
        → tool_result → turn_start → delta → turn_end → done

✓ LLM 轮次 = 3
✓ 调用了 write_file 与 run_python
✓ 两次工具都成功
✓ 建模脚本已落盘
✓ matplotlib 图已生成
✓ 产物是有效 PNG（魔数校验）  [82.8 KB]
✓ PNG 体积合理（>10KB，挡住空图）
✓ run_python 输出了脚本的 print
✓ 两轮工具结果都回灌给了模型

结果：9/9 通过
```

> **这条用例第一版是 5/9 失败的**，而且失败方式很典型：工具报 `ok: true`，但图根本没生成。
> 根因是 `figures/` 目录不存在 —— matplotlib 不会自动创建目录，`savefig('figures/x.png')` 直接抛 `FileNotFoundError`。
> 由此修掉两个真问题：
> 1. **`ok` 不再只看"有没有抛异常"**，而是以命令退出码判定 —— 否则 UI 会给一个绿色的"成功"卡片，实际什么都没产出。
> 2. **工作区预建标准目录**（`figures/` `code/` `results/` `reports/`），因为 `math-modeling` 的约定就是这几个目录。

---

## 七、draw.io 集成

应用启动时会**自动探测 draw.io 桌面版** —— 先扫常见安装目录（Program Files / LocalAppData / 各盘符的 `Drawio\draw.io`），再从开始菜单 `.lnk` 里挖路径（纯二进制解析，不用 COM，避免权限拦截）。

### 导出命令的参数顺序是硬要求

```bash
drawio <输入文件.drawio> --no-sandbox --disable-gpu --export --format pdf --crop --output <输出.pdf>
```

⚠️ **输入文件必须放在最前面**。drawio 用 commander 解析参数且开了 `allowUnknownOption()`，未知开关会被塞进 `program.args` —— 输入文件放后面会被当成 `--disable-gpu`，报 `input file/directory not found`（其源码里只特殊过滤了 `--no-sandbox` 这一个）。

### 预览不再依赖在线服务

预览面板打开 `.drawio` 时，会调 `drawio:export` 先导出 PNG 再显示，**断网也能看图**。

（`scibox-diagram` 自带的 `preview_html.py` 走的是 `embed.diagrams.net` 在线 viewer，离线或网络受限时是空白 —— 那不是图画错了。）

## 八、已知限制

- **未安装 draw.io 桌面版时**，竞赛模式只能产出 `.drawio` 源文件，无法导出 PDF。Agent 会如实记录失败原因，不会假装已导出。
- **LaTeX 论文**需要本机有 TeX 发行版（如 TeX Live / MiKTeX）；没有时只能出 Word 版。
- **Ollama 等本地模型**的 tool calling 支持程度参差，建议用 DeepSeek / Kimi / 通义这类对 function calling 支持好的模型跑完整流程。
- 首次启动便携版需要解压 159 MB 到临时目录，稍慢属正常。

---

## 九、开发环境踩坑记录

这台机器上打包时遇到的、值得记下来的坑：

1. **`ELECTRON_RUN_AS_NODE=1` 被环境注入** → electron 以纯 Node 模式运行，`require('electron')` 返回的是 exe 路径字符串，主进程直接抛 `Cannot read properties of undefined (reading 'whenReady')`。
   - 诊断：打印 `process.type`，正常应为 `browser`
   - 解决：`scripts/dev.js` 在 spawn 前 `delete process.env.ELECTRON_RUN_AS_NODE`
   - 附带发现：`electron path/to/script.js` 形式的独立入口同样中招，所以冒烟测试改成由主进程 `--smoke` 开关触发
2. **`npm install` 不下载 electron 二进制**（只留 1.2 MB 壳），`install.js` 静默退出。手动执行 `node node_modules/electron/install.js` 并设 `ELECTRON_MIRROR` 可修复。
3. **`node_modules/.bin` 未创建** → `electron-builder` 命令找不到 → package.json 里直接写 `node node_modules/electron-builder/cli.js`。
4. **`app-builder-lib/templates/nsis/` 缺失** → NSIS 打包报 `ENOENT messages.yml` → `npm install app-builder-lib@<ver> --force` 补齐。
5. **`package.json` 缺 `devDependencies`** → 后续任何 `npm install` 都会把 electron-builder 当多余包清掉 → 依赖必须显式声明。
6. **safe-delete 守卫**：`Expand-Archive -Force`、`rm -rf`、electron-builder 清目录都会被拦 → 用 `tar -xf` 解压、用 `[System.IO.Directory]::Delete()` 删目录。
7. **沙箱内 GPU 起不来**（`GPU process isn't usable. Goodbye.`）→ `--no-gpu` 走软件渲染。
8. **`nativeImage.resize()` 报 `UnknownVizError`** → 改用 `crop()` 取正方形。
9. **Pillow 装不上** → 图标改用 Electron 渲染 HTML + `capturePage` 生成。

---

## 十、二次开发提示

- 改**系统提示词**（技能路由、出图分工）→ `src/main/agent/prompt.js`
- 加**新工具** → `src/main/agent/tools.js` 的 `TOOL_DEFS` + `executeTool`
- 加**服务商预设** → `src/main/store.js` 的 `PROVIDERS`
- 换**界面风格** → `src/renderer/styles.css` 顶部的 `:root` 设计令牌
- 更新**内置技能** → 覆盖 `resources/skills/` 下的目录，重新打包即可
- 换**应用图标** → 改 `src/main/icon.js` 里的 HTML，跑 `node scripts/dev.js --make-icon`
