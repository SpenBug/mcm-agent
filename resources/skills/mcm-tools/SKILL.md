---
name: mcm-tools
description: 数模工坊的工具链（自有实现）。读赛题 PDF / 规范、读写 Excel 与 CSV、按模板生成 Word 论文、生成并编译 LaTeX、检索文献。当流程走到「读材料」「跑数据」「成稿」环节、需要实际读写文件或调用外部程序时使用。
---

# 工具链 · mcm-tools

驱动层（`mcm-workflow`）决定**做什么**，本技能提供**怎么做到**。
数据图见 `mcm-figure`，非数据图见 `mcm-diagram`。

---

## 原则

1. **输入只读**：客户拖进来的材料在 `input/`，**只读不写**。
2. **产物只写工作区**：所有输出落在 `PROJECT_ROOT` 下，不写技能目录。
3. **不覆盖原始附件**：需要改就先复制一份再改。
4. **结果核对再往下走**：读进来的行数 / 页数 / 字段数要跟题目声明对上，**对不上就停下来报错**，不要静默继续。

---

## 路由

| 要做的事 | 打开 | 脚本 |
|---|---|---|
| 读赛题 / 规范的 PDF | `references/pdf.md` | `scripts/mcm_io.py` |
| 读写 Excel / CSV | `references/xlsx.md` | `scripts/mcm_io.py` |
| 生成 Word 论文 | `references/docx.md` | `scripts/mcm_docx.py` |
| **Word 转 PDF** | `references/docx.md` | `scripts/mcm_docx.py pdf` |
| 生成 + 编译 LaTeX 论文 | `references/latex.md` | `scripts/mcm_latex.py` |
| 检索文献 | `references/scholar.md` | `scripts/mcm_scholar.py` |
| **写脚本时的路径处理** | `references/paths.md` | — |

脚本都可**直接命令行调用**，也可 import：

```bash
python skills/mcm-tools/scripts/mcm_io.py pdf input/赛题.pdf --pages 1-3
python skills/mcm-tools/scripts/mcm_io.py xlsx input/附件1.xlsx --head 10
```

---

## 环境依赖

| 工具 | 依赖 | 缺失时 |
|---|---|---|
| PDF 读 | `pypdf`（纯 Python） | 报告阻塞；可退回 `pdfplumber` |
| Excel 读写 | `openpyxl` | 报告阻塞 |
| CSV | 标准库 `csv` | — |
| Word 生成 | `python-docx` | 报告阻塞 |
| LaTeX | `latexmk` 或 `xelatex`（TeX Live / MiKTeX） | **只能出 Word 版**，如实说明 |
| 文献检索 | 标准库 `urllib`（无需 key） | 报告阻塞；离线时跳过 |

**任一依赖缺失 → 在回复里明确说「缺什么、影响哪一步」，不要静默换方案。**

---

## 通用约定

### 路径

- 读技能文件：`skills/mcm-tools/...`
- 读客户材料：`input/...`
- 写产物：`figures/` `code/` `results/` `reports/`

⚠️ **落到 `code/` 里的脚本，一律不能依赖 cwd。**
脚本常被 cd 到 `code/` 下跑，裸相对路径 `input/...` 会去找 `code/input/...` 然后报文件不存在。
**每个脚本开头都要解析工作区根**（从 `__file__` 往上找 `.mcm-agent/` 或 `input/` 标记目录），
再用它拼绝对路径。现成代码见 `references/paths.md`，直接复制即可。

```python
ROOT = find_workspace_root()            # 见 references/paths.md
df = pd.read_excel(P('input', '数据', '附件1.xlsx'))
```

### 退出码

脚本**成功返回 0，失败返回非 0**，并把原因写到 stderr。
调用方（Agent）**必须核对退出码**，非零就是失败，不要当成成功。

### 输出

脚本默认把结构化结果打到 stdout（JSON 或文本），进度信息打到 stderr。
需要机器可读时加 `--json`。
