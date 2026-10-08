# 生成与编译 LaTeX 论文

```bash
python skills/mcm-tools/scripts/mcm_latex.py build out/paper --spec reports/paper_spec.json
python skills/mcm-tools/scripts/mcm_latex.py build out/paper --spec reports/paper_spec.json --compile
python skills/mcm-tools/scripts/mcm_latex.py compile out/paper/main.tex
```

**spec 格式与 `mcm_docx.py` 完全一致** —— 同一份 spec 能出 Word 和 LaTeX 两版，不用维护两份内容。

---

## 什么时候用 LaTeX 版

- 客户**指定**要 LaTeX
- 公式多、需要正式排版（Word 版的公式只是文本，见 `docx.md`）
- 需要精确控制版式

否则**默认出 Word** —— 客户更容易打开和修改。

---

## 中文支持

生成的模板用 `ctexart` + **xelatex** 编译，中文开箱可用：

```latex
\documentclass[12pt,a4paper]{ctexart}
\usepackage[margin=2.5cm]{geometry}
```

**必须用 xelatex，不要用 pdflatex** —— 后者处理中文需要额外配置。

### 竞赛格式的默认值

```latex
\ctexset{
  section/format = \centering\heiti\zihao{4},      % 一级标题四号黑体居中
  subsection/format = \heiti\zihao{-4},
}
\setstretch{1.0}   % 单倍行距
```

同样**以客户提供的当届规范为准**。

---

## ⚠️ 编译：latexmk 失败是常态，必须回退

脚本的编译顺序是：

1. 先试 `latexmk -xelatex`（能自动处理多趟编译和依赖）
2. **失败就回退到直接跑 `xelatex` 两趟**（第一趟出 aux，第二趟解析引用与页码）

> **为什么必须有回退**：`latexmk` 是 Perl 脚本，Perl 环境不完整时它会直接挂掉，
> **连 `.log` 都不产出**，只留下一句没头没尾的错误。而 `xelatex` 本身是好的。
> 实测就遇到过这个情况——没有回退的话会误判成「TeX 没装」。

---

## 特殊字符转义

正文里的 `& % $ # _ { } ~ ^ \` 必须转义，否则编译直接报错。

`build_tex()` 里的 `esc()` 处理了这些。**但公式块（`type: equation`）不转义** ——
公式里要用真正的 LaTeX 语法（`\sum_i`、`\frac{}{}`）。

常见 Unicode 运算符会自动替换成 LaTeX 命令：

| Unicode | LaTeX |
|---|---|
| `Σ` `∑` | `\sum` |
| `≤` `≥` | `\le` `\ge` |
| `×` `·` | `\times` `\cdot` |
| `α` `β` `θ` `λ` `μ` `σ` | `\alpha` `\beta` … |
| `→` `∞` `∈` | `\to` `\infty` `\in` |

---

## 编译后的检查

脚本会自动检查并警告：

- **`undefined`** —— 有未解析的引用（可能要多编译一趟）
- **`cannot find`** —— 有找不到的文件（图路径不对 / 字体缺失）

图用**相对路径**引用（脚本自动算），这样换台机器也能编译。

---

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（stdout 会打印 PDF 的绝对路径） |
| 1 | 参数错误 |
| 2 | spec 读取失败 |
| **3** | **编译失败 —— 不要声称已出稿** |
