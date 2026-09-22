# 竞赛模式（数学建模非数据图）

把 `4drawio` 阶段（MathModelAgent 流水线）的**流程规范**接到本技能的**工具链**上。
本模式不改变 A/B/C 三条路的画法，只增加：命名规范、图型判定、模板映射、导出与报告要求。

**定位**：本模式取代手写 XML 的裸流程；`mathmodelagent-suite/skills/4drawio` 是上游只读镜像，不要改它，按本文件执行即可。

## 一、何时进入

- 用户说"做建模题/写数模论文"并需要技术路线图、分问题流程图；
- 项目里存在 `reports/ANALYSIS_MODELING_REPORT.md`、`reports/RESULTS_REPORT.md`；
- 上游流水线走到"非数据图"环节。

只画单张图、不在竞赛流水线里 → 走常规 A/B/C，不进本模式。

## 二、阶段边界（红线）

- **只画非数据图**。禁止在本模式生成：结果对比柱状图、预测误差曲线、灵敏度曲线、相关性热力图、分布图、箱线图。这些属数据图，归编程阶段，用 `scibox-figure`。
- **不重跑模型、不改 `code/`、不改 `RESULTS_REPORT.md` 的数值**。图中数值一律从报告/结果文件抄，抄不到就空着并记进报告的"未生成图示及原因"，**严禁编造**。
- **图必须能对应到 `ANALYSIS_MODELING_REPORT.md` 里的真实方法**，不为凑数画图。清单里的图型可删减，未生成的必须写明原因。

## 三、Step 1 · 盘点输入

读（存在才读）：`reports/ANALYSIS_MODELING_REPORT.md`、`reports/RESULTS_REPORT.md`、`figures/` 目录列表、论文大纲。

目的不是取数作图，而是搞清**子问题数量、每问的方法链、已有图表**，避免与数据图重复。子问题数量由题目决定，不固定为三个。

## 四、Step 2 · 图型判定与模板映射

先定图型，再选模板。下表"推荐模板"是默认建议，若内容形态明显不符则改用手写（B 路）。

| 图型 | 文件名 | 场景 | 推荐模板 |
|---|---|---|---|
| 技术路线图 | `fig_roadmap` | 整体解题路线、章节逻辑、方法串联 | `task-bands`（任务带式，最像竞赛技术路线图）／`part-zones`（章节推进）／`roadmap-5band`（提出问题→数据→方法→结果→评价） |
| 子问题求解流程图 | `fig_flow_q1` `fig_flow_q2` … | 单问的输入→判断→算法→输出 | `qblocks-flow`（多问并排，横版）／`trihead-flow`（单问思路）／`step-zones`（step 分区）／`stageflow-3col`（阶段推进+分支） |
| 数据处理流程图 | `fig_pipeline` | 清洗、特征构造、建模输入 | `step-zones` ／ `taskflow-land` |
| 模型结构图 | `fig_model` | 模块关系、变量关系、模型层次 | 手写 B（`references/authoring.md`） |
| 指标体系图 | `fig_index_system` | 目标层/准则层/指标层 | 手写 B（树形分层，自上而下分层连线） |
| 决策树/规则图 | `fig_decision_tree` | 分类规则、设备选择、策略分支 | 手写 B |

**版式取向**：论文正文是 A4 单栏竖排时优先竖版模板（≤1080 宽）；`taskflow-land`(1360)、`qblocks-flow`(1080 横版) 天然适合整页横排或答辩 PPT。尺寸提醒见 SKILL.md 末尾：954px 宽 16px 字号压到 `0.97\textwidth` 约 6.5pt，正文小图另做精简版。

竞赛论文**通常至少要有 `fig_roadmap`**。

## 五、Step 3 · 出图

照 A 路（套模板）或 B 路（手写）执行，纪律不变：

1. 内容从报告抽，**不编**；术语用原文，数值逐个核对。
2. 套模板时复制 `assets/<template_id>/example.json` 改写，写文件前逐槽校验字数，超框按预算改文案。
3. 节点文字短，必要时双行；同类节点同款样式；不写大段解释（解释留给正文）。
4. 箭头方向明确，避免交叉；说不出含义的箭头不画。

**关于"不过度渐变"**：本模式沿用上游那条红线，口径是——模板自带的两档水平渐变（如 `#2c2c56 → #6f6f9e`）属**平涂过渡，不算装饰性渐变**，可保留；禁止的是阴影、发光、立体/斜面、多段彩虹渐变。

## 六、Step 4 · 导出

两张产物都要，落在 `figures/`：

```bash
python3 scripts/export_figure.py figures/fig_roadmap.drawio     # 1:1 PNG + 矢量 PDF
```

上游要求的是论文可引用的 crop PDF；`export_figure.py` 会一次出 PNG + PDF。

**⚠️ 输入文件必须放在最前面**（这条踩过，写错就是一次失败）：

```bash
# ✅ 正确：输入文件在前
drawio figures/fig_roadmap.drawio --export --format pdf --crop --output figures/fig_roadmap.pdf

# ❌ 错误：输入文件在后 → 报 "input file/directory not found"
drawio --export --format pdf --crop --output figures/fig_roadmap.pdf figures/fig_roadmap.drawio
```

原因：drawio 用 commander 解析参数且开了 `allowUnknownOption()`，未知开关会被塞进位置参数数组，于是它把 `--disable-gpu` 这类开关**当成了输入文件**（其源码里只特殊过滤了 `--no-sandbox` 这一个）。把输入文件放最前，才能安全追加兜底开关。

**无 GPU 环境**（虚拟机 / 远程桌面 / 容器）必须加软件渲染开关，否则 drawio 会直接崩（`GPU process isn't usable. Goodbye.`）：

```bash
drawio figures/fig_roadmap.drawio --no-sandbox --disable-gpu --disable-software-rasterizer --in-process-gpu \
       --export --format pdf --crop --output figures/fig_roadmap.pdf
```

`export_figure.py --no-gpu` 已封装这组开关。

**CLI 探测**：Windows 上 draw.io 常装在 PATH 之外（如 `D:\Drawio\draw.io\draw.io.exe`），`where`、`Get-Command`、`shutil.which` 都找不到。`export_figure.py` 的 `find_drawio()` 会依次查 PATH → 常见安装目录 → 开始菜单 `.lnk`（二进制正则挖路径，不依赖 COM）。找不到 CLI 就保留 `.drawio`，用 `scripts/preview_html.py` 预览，并在报告记录失败原因和建议命令，**不得声称已导出**。

**关于 `preview_html.py`**：它把图交给 `https://embed.diagrams.net` 的**在线 viewer** 渲染，**必须联网**，且该域名在国内经常连不上 —— 此时预览页是**一片空白**，那是网络问题不是图画错了。离线场景请改用 `export_figure.py` 出 PNG 来看。

## 七、Step 5 · 自检

两道关都要过：

```bash
python3 scripts/check_layout.py figures/fig_roadmap.drawio --strict
```

| 检查 | 谁负责 |
|---|---|
| 溢出/越界/重复 id/重叠/穿盒/位图 | `check_layout.py`，应 FAIL 0 / WARN 0 |
| `.drawio`、`.pdf` 非空 | 人工 |
| 节点明显重叠、箭头穿过核心节点 | 人工（看 PNG） |
| 字号/颜色/边框风格一致、文件名与图意一致 | 人工（看 PNG） |
| 与数据图不重复 | 对照 `figures/` 清单 |

再按 `references/self-check.md` 打开 PNG 过两轮：① 文字溢出/压线；② 箭头方向与语义；③ 同族元素对齐同宽；④ 数值有没有抄错。
**发现问题就改 `.drawio` 重导，不许只在报告里解释。**

## 八、Step 6 · 生成记录

写 `reports/DRAWIO_REPORT.md`：

```markdown
# DrawIO 图示生成报告

## 图示清单
| 文件 | 类型 | 来源依据 | 用途 | 状态 |
| --- | --- | --- | --- | --- |

## 未生成图示及原因

## 导出与自检记录
（check_layout 结果、drawio CLI 是否可用、PDF 是否产出）

## 给论文阶段的嵌入建议
```

嵌入建议**只写每张图适合放哪个章节 + 建议 caption**。插入代码（Typst `#figure(image(...), caption: [...])` 或 LaTeX `\begin{figure}`）由写作阶段决定，本模式不生成 `*_typst_includes.typ`。

## 九、产物

```text
figures/
  fig_roadmap.drawio      fig_roadmap.pdf
  fig_flow_q1.drawio      fig_flow_q1.pdf
  ...
reports/DRAWIO_REPORT.md
```

走模板路径时，content JSON 一并留在 `figures/` 或项目内，作为可复现源。

## 十、与上游的差异（为什么可以取代）

| 项 | 上游 `4drawio` | 本模式 |
|---|---|---|
| 生成方式 | 手写 mxGraphModel XML（heredoc 分段写） | 优先套模板（9 个 + 渲染脚本），复杂图才手写 |
| 文字度量 | 定性要求"文字短" | 中文字宽模型 + 每模板字数预算，超框报错 |
| 质检 | 5 条人工目测 | `check_layout.py --strict` + 九区盘点 + 预览 |
| 预览 | 无 | `preview_html.py`，无 CLI 也能看 |
| 导出 | 仅 PDF | PNG + PDF |

上游的命名规范、图型判定、报告结构、红线，全部保留在本文件里。
