# MathModelAgent 预设（`mathmodelagent`）

把用户级技能 **`mathmodelagent-suite`** 封装为 DSH 的 agent 预设 `mathmodelagent`
（显示名「MathModelAgent 数模」）。

## 技能来源

| 项 | 值 |
|---|---|
| 技能入口 | `<agentsHome>/skills/mathmodelagent-suite/SKILL.md` |
| 本机实际路径 | `C:\Users\92182\.agents\skills\mathmodelagent-suite\SKILL.md` |
| 发现根 | `user-agents`（rank 500） |
| 上游 | https://github.com/jihe520/MathModelAgent/tree/main/skills |
| 结构 | 单一入口 + 10 个内置阶段模块（不通过技能注册名调用） |

该技能是「单一入口 + 按需读取内置阶段模块」结构：入口 `SKILL.md` 给出阶段路由表，
按需读取 `skills/<阶段>/SKILL.md`。内部模块**不是**注册技能，因此一律用 read 按路径读取。

## 阶段路由（预设 persona 已内联其纪律）

规划 → 分析建模 → 编程计算与数据图 → 按需非数据图（draw.io）→ 论文撰写 → 复现与验收。

## 安装

```powershell
# 通过 DSH 的 plugin_manager 工具安装（不要用 shell 复刻其步骤）
# action: install_bundle, target: <本目录绝对路径>
```

安装后 `plugin_manager list_plugins` 应出现 `preset-mathmodelagent` 且
`fiberPhase: active`；新会话的预设选择器里出现「MathModelAgent 数模」。

## 本目录包含的修复（重要）

`skill-filesystem` 行的 `bundledSkillDir` 是本预设附带的一处**环境修复**。

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
这正是 `mathmodelagent-suite` 一度无法被 `skill` 工具发现的根因。

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

修复生效后该警告应消失，且 `skill` 工具能按名加载 `mathmodelagent-suite`。
**注意**：插件安装返回 `restart-required` 时，需重启 DSH Desktop 才生效 ——
正在运行的进程仍持有旧 revision。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 声明（`dsh.bundle.patch`） |
| `cordis.patch.yml` | 预设声明：persona + 工具组成 + skill 修复 |
| `scripts/extract-bundled-skills.mjs` | 把随包技能解到真实目录 |
