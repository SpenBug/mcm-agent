# 读写 Excel / CSV（赛题数据）

```bash
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_io.py" xlsx input/附件1.xlsx --head 10
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_io.py" xlsx input/附件1.xlsx --expect-rows 7470
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_io.py" csv  input/data.csv --header --head 5
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_io.py" info input/
```

---

## ⚠️ 第一条：不要相信自动表头推断

**`pandas.read_excel()` 默认 `header=0`，会把第一行数据当列名。**

题目附件经常**首行就是数据**（没有表头行）。默认推断的后果是：
第一行数据消失、列名变成一串数字、后面所有计算全错——**而且不报错**。

所以本工具的 `xlsx` 子命令**默认不做表头推断**。确实有表头时，显式加 `--header`。

```python
# 用 pandas 时也必须显式：
data = pd.read_excel("input/附件1.xlsx", sheet_name=0, header=None)
```

---

## 第二条：读进来先核对行数

**行数对不上就停下来报错，不要静默继续建模。**

```bash
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_io.py" xlsx input/附件1.xlsx --expect-rows 7470
# 不符时退出码 3，不会给你一份"看起来正常"的数据
```

要核对三件事：
1. **数据行数**是否等于题目声明的记录数
2. **首行**和**末行**的内容是否合理
3. **工作表数量**对不对（`--json` 里的 `sheets` 字段）

---

## 读

```python
import sys; sys.path.insert(0, "skills/mcm-tools/scripts")
from mcm_io import read_xlsx

d = read_xlsx("input/附件1.xlsx", sheet=0, header=False, expect_rows=7470)
print(d["sheets"], d["n_rows"], d["n_cols"])
rows = d["rows"]
```

参数：

| 参数 | 说明 |
|---|---|
| `sheet` | 工作表名或索引，默认 0 |
| `header` | `True` 时才把首行当列名（**默认 False**） |
| `expect_rows` | 断言数据行数，不符抛异常 |
| `head` | 只取前 N 行 |

## 写

**普通结果优先用 CSV** —— 简单、可直接 diff、不会被 Excel 的公式坑到。

```python
import pandas as pd
pd.DataFrame({"方案": names, "目标值": vals}).to_csv("results/q1_metrics.csv", index=False)
```

只有这些情况才用 XLSX：
- 题目**指定**要 xlsx
- 需要**保留公式**
- 需要**多工作表**
- 要**套用模板结构**

写 XLSX 时用 `openpyxl.load_workbook()` 打开模板 → 改指定单元格 → 另存新文件。
**不要删除未知的工作表、命名区域、公式或数据验证规则**——那些可能是题目给的。

## 中文编码

CSV 读中文常遇到编码问题，工具已按 `utf-8-sig → utf-8 → gbk` 依次尝试。
自己写的时候：

```python
pd.read_csv("input/data.csv", encoding="utf-8-sig")   # 带 BOM 的 Excel 导出
```

---

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 参数错误 / 缺 openpyxl |
| 2 | 文件不存在或读取失败 |
| **3** | **行数断言不符 —— 不要继续往下走** |
