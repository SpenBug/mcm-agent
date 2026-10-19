# 数模视频生产线预设（`mcm-video`）

把用户级技能 **`mcm-video-pipeline`** 封装为 DSH 的 agent 预设 `mcm-video`
（显示名「数模视频生产线」）。

## 技能来源

| 项 | 值 |
|---|---|
| 技能入口 | `<agentsHome>/skills/mcm-video-pipeline/SKILL.md` |
| 本机实际路径 | `C:\Users\92182\.agents\skills\mcm-video-pipeline\SKILL.md` |
| 发现根 | `user-agents`（rank 500） |
| 源仓库 | `D:\自媒体\自媒体\mcm-video-pipeline`（含 `.git`、`docs/`、`tools/`、`assets/`） |
| 上游 | https://github.com/SpenBug/mcm-video-pipeline |
| 结构 | 单一入口 + `references/` 4 份 + `templates/` 11 套（不通过技能注册名调用） |

该技能是「单一入口 + 按需读取参考文档」结构：入口 `SKILL.md` 给出 13 步流程与
确认门协议，按需读取 `references/<主题>.md` 与 `templates/T*.md`。内部文档
**不是**注册技能，因此一律用 read 按路径读取。

> 已核对：安装目录与源仓库的 `SKILL.md` 哈希一致
> （`524D957B…CCA5DD`），即用户级技能就是该仓库的副本，没有本地私改。

## 流程（预设 persona 已内联其纪律）

S1 立项卡 → S2 素材清点 → S3 事实核对与合规 → S4 视频思路蓝图（**未批准不许写稿**）
→ S5 口播稿 → S6 模板选型 → S7 工程初始化 → S8 内容配置 → S9 配音+混音+时间轴
→ S10 目检与抽帧 → S11 渲染 → S12 后处理两关（loudnorm + bt709）→ S13 交付与文档。

铁律是**确认门协议**：每一步开始前先输出确认卡，用户答复后才执行；没答复不动任何文件
（只读操作除外）。

## 安装

```powershell
# 通过 DSH 的 plugin_manager 工具安装（不要用 shell 复刻其步骤）
# action: install_bundle, target: <本目录绝对路径>
```

安装后 `plugin_manager list_bundles` 应出现 `@local/dsh-mcm-video-preset`，
`list_plugins` 中 `preset-mcm-video` 行为 `fiberPhase: active`；新会话的预设选择器里
出现「数模视频生产线」。

## 本目录包含的修复（重要）

`skill-filesystem` 行的 `bundledSkillDir` 是本预设附带的一处**环境修复**
（与 `mathmodelagent-preset` 同源）。

### 问题

`@deepseek-ai/dsh-skill-filesystem` 默认扫描
`process.env.DSH_BUNDLED_SKILL_DIR`。本机 DSH Desktop 把该变量指向 **asar 包内**：

```
D:\DSH Desktop\resources\app.asar\node_modules\@deepseek-ai\dsh-agent-preset\skills
```

Electron 的 asar `fs` 包装在列该目录时抛错：

```
FsError: cannot list "…app.asar…/dsh-agent-preset/skills":
Cannot mix BigInt and other types, use explicit conversions
```

`@deepseek-ai/dsh-skill` 对 provider 抛错的处理是**整段丢弃**
（`skill provider "filesystem" skipped`），于是一个根目录报错会让
**所有**本地技能（随包、用户级、项目级）一起从技能目录里消失 ——
这正是 `mcm-video-pipeline` 一度无法被 `skill` 工具发现的根因。

### 修复

补丁里显式给出 `bundledSkillDir`，指向磁盘上的真实目录，覆盖 asar 路径：

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    bundledSkillDir: !!js dshHomePath('bundled-skills')
```

`dshHomePath` 是 Loader 提供的全局函数（见 `@deepseek-ai/dsh-app-boot`），
官方 `dsh-base` 补丁与内置 `cordis` 预设都以同样方式使用 `!!js`，用法有先例。

配套脚本把 asar 内的 4 个内置技能解到该目录，避免修复过程中丢掉它们：

```powershell
node scripts/extract-bundled-skills.mjs
```

目标目录默认为 `<DSH_HOME>/bundled-skills`。**目录为空也能止住崩溃**；
解出技能包只是让随包技能继续可用。DSH 升级后需要重跑一次。

### 验证

修复前 `harness.log` 持续刷：

```
warn skill-registry: skill provider "filesystem" skipped: FsError: cannot list "…app.asar…"
```

修复生效后该警告消失，且日志出现 `skill-filesystem: skill file …` 的成功扫描记录
（例如本机的 `baibaiAIGC` 因名字非 kebab-case 被逐条跳过——这正说明扫描已恢复），
`skill` 工具能按名加载 `mcm-video-pipeline`。

**注意**：插件安装返回 `restart-required` 时，需重启 DSH Desktop 才生效 ——
正在运行的进程仍持有旧 revision。

## 与另外两个预设的关系

| 预设 | id | order | 技能 |
|---|---|---|---|
| 阿一古数模 | `math-modeling` | 6 | `math-modeling`（建模手→编程手→论文手） |
| MathModelAgent 数模 | `mathmodelagent` | 7 | `mathmodelagent-suite`（六阶段流水线） |
| **数模视频生产线** | `mcm-video` | 8 | `mcm-video-pipeline`（13 步视频生产线） |

三者是并列的独立预设，各自封装一个用户级技能；`mcm-video` 与另两者的**领域不重叠**
（前两者出论文，本预设出视频）。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 声明（`dsh.bundle.patch`） |
| `cordis.patch.yml` | 预设声明：persona + 工具组成 + skill 修复 |
| `scripts/extract-bundled-skills.mjs` | 把随包技能解到真实目录 |

## 环境前置（技能实测，persona 已内联）

- Python 用 `C:\Program Files\Python312\python.exe` + `PYTHONPATH` 指向
  `C:\Users\92182\AppData\Roaming\Python\Python312\site-packages`（edge-tts 装在这里）；
  裸 `python` 会 `ModuleNotFoundError`。
- **本机 PATH 无 ffmpeg**：后处理两关改用
  `D:\自媒体\自媒体\mcm-video-agent\resources\runtime\ffmpeg\ffmpeg.exe`
  （6.1.1-essentials，含 loudnorm + libx264，实测可用）。
- 视频工作区为 `D:\自媒体\自媒体`（含 `风格规范\`、各期目录、`数模AI冲国奖_视频交付包\`、
  `.workbuddy-ai\memory\`）。
