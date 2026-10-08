# 生成 Word 论文

```bash
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" inspect input/论文模板.docx
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" build 论文.docx --spec reports/paper_spec.json
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" build 论文.docx --template input/论文模板.docx --spec reports/paper_spec.json
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" check 论文.docx
```

---

## 流程：先 inspect，再 build

**客户给了模板就一定要用模板**，不要自建版式。

### 1. `inspect` —— 拿到模板先看结构

```bash
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" inspect input/论文模板.docx
```

输出：章节骨架、用到的样式、表格数、内嵌图数、**发现的可替换占位符**（`{{xxx}}` 或 `【xxx】`）。

> 有些官方模板会把「题目」「摘要」写成占位符。inspect 会把它们列出来，
> 你据此决定是**填占位符**还是**在模板基础上追加内容**。

### 2. `build` —— 按 spec 生成

spec 是 JSON，格式见 `mcm_docx.py` 文件头的注释。支持的内容块：

| `type` | 字段 | 说明 |
|---|---|---|
| `para` | `text` | 正文段落，自动首行缩进两字符、单倍行距 |
| `list` | `items[]` | 项目符号列表 |
| `figure` | `path` `caption` `width_in` | 插图 + 居中图注 |
| `table` | `header[]` `rows[][]` `caption` | 三线外的网格表 + 居中表注 |
| `equation` | `text` `number` | 公式（**Word 里是文本，不是可编辑公式对象**） |
| `pagebreak` | — | 分页 |

顶层字段：`title` · `abstract{text, keywords[]}` · `sections[]` · `references[]`

### 3. `check` —— 交付前必跑

```bash
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" check 论文.docx
```

会检查：

- **未替换的占位符**（`{{…}}` / `【…】` 还有残留 → 退出码 3）
- **图 / 表编号是否连续**（图1、图3 跳号 → 退出码 3）
- **内嵌图张数与图注编号数是否对得上**
- **有没有「参考文献」章节**

---

### 4. `pdf` —— 转 PDF（**交付前必做**）

竞赛提交基本都收 PDF，所以 **docx 生成完必须再转一份 PDF**。

```bash
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" pdf 论文.docx
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" pdf 论文.docx --out 提交/     # 指定输出目录
python "%MCM_SKILL_ROOT%/mcm-tools/scripts/mcm_docx.py" pdf 论文.docx --engine word  # 强制用 Word
```

**引擎自动选**：

| 引擎 | 依赖 | 说明 |
|---|---|---|
| `soffice`（优先） | LibreOffice | 无需额外 Python 依赖，跨平台 |
| `word` | Word + pywin32 | 版式与 Word 完全一致；装了才可用 |

两个都没有时会报错并列出原因，**不要跳过 PDF 直接交付**。

**转完必须核对**：PDF 页数与 docx 一致、首页标题与正文正确。
页数对不上说明转换时版式变了，要回头查（常见原因是字体缺失或用了 docx 不支持的排版）。

---

## 字体

默认：正文**宋体小四**、一级标题**黑体四号**居中、题目**黑体三号**居中、单倍行距 —— 这是常见竞赛格式规范的默认值。

**但一定要以客户提供的当届规范为准。** 规范里写了几号就用几号，不要用默认值覆盖。

中文字体必须显式设 `w:eastAsia`，否则 python-docx 会让中文回落成默认字体：

```python
from docx.oxml.ns import qn
run.font.name = "Times New Roman"
run._element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
```

`mcm_docx.py` 的 `set_run_font()` 已经处理了，自己写脚本时记得。

---

## ⚠️ 公式的限制

Word 版的公式是**普通文本**（`y = ax + b`），不是可编辑的公式对象（OMML）。
复杂公式排版会不好看。

**需要正式排版的公式 → 用 LaTeX 版**（`mcm_latex.py`），那边是真的 `equation` 环境。

如果客户指定要 Word 且公式很多，**如实说明这个限制**，让他决定。

---

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 参数错误 / 缺 python-docx |
| 2 | spec 或模板读取失败 |
| **3** | **`check` 发现问题 —— 不要直接交付** |
