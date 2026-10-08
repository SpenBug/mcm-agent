#!/usr/bin/env python3
"""LaTeX 论文生成与编译。

两个动作:
    build    按 spec 生成 .tex（ctexart + xeCJK，中文开箱可用）
    compile  用 latexmk 编译成 PDF，并检查产物

用法:
    python mcm_latex.py build out/paper --spec reports/paper_spec.json
    python mcm_latex.py compile out/paper/main.tex
    python mcm_latex.py build out/paper --spec spec.json --compile

spec 与 mcm_docx.py 完全一致（同一份 spec 能出 Word 和 LaTeX 两版）。
公式块 type=equation 时，LaTeX 版会**真的排成数学式**（Word 版只能当文本插）。

退出码: 0 成功 / 1 参数或依赖问题 / 2 读取失败 / 3 编译或校验不通过
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys


def fail(code, msg):
    print("[mcm-latex] 错误: %s" % msg, file=sys.stderr)
    sys.exit(code)


def find_engine():
    for e in ("latexmk", "xelatex"):
        p = shutil.which(e)
        if p:
            return e, p
    return None, None


# ---------------------------------------------------------------- 转义

# LaTeX 特殊字符。正文里出现这些必须转义，否则编译直接报错。
ESC = {
    "\\": r"\textbackslash{}",
    "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
    "_": r"\_", "{": r"\{", "}": r"\}",
    "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
}


def esc(s):
    out = []
    for ch in str(s):
        out.append(ESC.get(ch, ch))
    return "".join(out)


def math(s):
    """公式块：不转义，但把常见 Unicode 运算符换成 LaTeX 命令。"""
    rep = {"Σ": r"\sum", "∑": r"\sum", "≤": r"\le ", "≥": r"\ge ",
           "×": r"\times ", "·": r"\cdot ", "α": r"\alpha ", "β": r"\beta ",
           "θ": r"\theta ", "λ": r"\lambda ", "μ": r"\mu ", "σ": r"\sigma ",
           "→": r"\to ", "∞": r"\infty ", "∈": r"\in "}
    for k, v in rep.items():
        s = str(s).replace(k, v)
    return s


# ---------------------------------------------------------------- build

PREAMBLE = r"""\documentclass[12pt,a4paper]{ctexart}
\usepackage[margin=2.5cm]{geometry}
\usepackage{graphicx}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{caption}
\usepackage{float}
\usepackage[hidelinks]{hyperref}
\usepackage{setspace}

% 题目三号黑体居中、一级标题四号黑体居中（按常见竞赛格式规范）
\ctexset{
  section/format = \centering\heiti\zihao{4},
  subsection/format = \heiti\zihao{-4},
}
\captionsetup{font={small},labelsep=quad}
\setstretch{1.0}   % 单倍行距

\title{\heiti\zihao{3} %TITLE%}
\date{}

\begin{document}
\maketitle
%ABSTRACT%
%BODY%
%REFS%
\end{document}
"""


def build_tex(spec, out_dir):
    parts = []

    # 摘要
    ab = spec.get("abstract")
    if ab:
        block = ["\\begin{center}\\heiti\\zihao{4}摘\\quad 要\\end{center}", ""]
        if ab.get("text"):
            block.append(esc(ab["text"]))
            block.append("")
        if ab.get("keywords"):
            block.append("\\noindent\\textbf{关键词：}" + esc("，".join(ab["keywords"])))
        block.append("\\newpage")
        parts.append("\n".join(block))

    # 正文
    body = []
    for sec in spec.get("sections", []):
        lvl = sec.get("level", 1)
        if sec.get("heading"):
            cmd = "section" if lvl == 1 else ("subsection" if lvl == 2 else "subsubsection")
            body.append("\\%s*{%s}" % (cmd, esc(sec["heading"])))
        for b in sec.get("blocks", []):
            t = b.get("type", "para")
            if t == "para":
                body.append(esc(b.get("text", "")))
                body.append("")
            elif t == "list":
                body.append("\\begin{itemize}")
                for it in b.get("items", []):
                    body.append("  \\item " + esc(it))
                body.append("\\end{itemize}")
            elif t == "equation":
                body.append("\\begin{equation}")
                body.append("  " + math(b.get("text", "")))
                body.append("\\end{equation}")
            elif t == "figure":
                path = b.get("path", "")
                if not os.path.isfile(path):
                    print("[mcm-latex] ⚠ 图不存在，已跳过: %s" % path, file=sys.stderr)
                    continue
                # 用相对路径，避免绝对路径在别的机器上失效
                rel = os.path.relpath(os.path.abspath(path), os.path.abspath(out_dir)).replace("\\", "/")
                body.append("\\begin{figure}[H]")
                body.append("  \\centering")
                body.append("  \\includegraphics[width=%s\\linewidth]{%s}"
                            % (b.get("width_frac", 0.85), rel))
                body.append("  \\caption{%s}" % esc(b.get("caption", "")))
                body.append("\\end{figure}")
            elif t == "table":
                header = b.get("header") or []
                rows = b.get("rows") or []
                ncol = len(header) or (len(rows[0]) if rows else 1)
                body.append("\\begin{table}[H]")
                body.append("  \\centering")
                body.append("  \\caption{%s}" % esc(b.get("caption", "")))
                body.append("  \\begin{tabular}{%s}" % ("l" * ncol))
                body.append("    \\toprule")
                if header:
                    body.append("    " + " & ".join(esc(h) for h in header) + r" \\")
                    body.append("    \\midrule")
                for row in rows:
                    body.append("    " + " & ".join(esc(v) for v in row) + r" \\")
                body.append("    \\bottomrule")
                body.append("  \\end{tabular}")
                body.append("\\end{table}")
            elif t == "pagebreak":
                body.append("\\newpage")
    parts.append("\n".join(body))

    # 参考文献（手写列表，不用 BibTeX —— 竞赛论文的引用格式要照官方句式）
    refs = spec.get("references") or []
    if refs:
        blk = ["\\begin{center}\\heiti\\zihao{4}参考文献\\end{center}", "",
               "\\begin{list}{}{\\setlength{\\leftmargin}{2em}\\setlength{\\itemindent}{-2em}}"]
        for r in refs:
            blk.append("  \\item[] " + esc(r))
        blk.append("\\end{list}")
        parts.append("\n".join(blk))

    tex = PREAMBLE.replace("%TITLE%", esc(spec.get("title", "论文")))
    tex = tex.replace("%ABSTRACT%", parts[0] if len(parts) > 0 else "")
    tex = tex.replace("%BODY%", parts[1] if len(parts) > 1 else "")
    tex = tex.replace("%REFS%", parts[2] if len(parts) > 2 else "")
    return tex


def cmd_build(args):
    if not os.path.isfile(args.spec):
        fail(2, "spec 不存在: %s" % args.spec)
    try:
        spec = json.load(open(args.spec, encoding="utf-8"))
    except Exception as e:
        fail(2, "spec 不是合法 JSON: %s" % e)

    os.makedirs(args.out, exist_ok=True)
    tex = build_tex(spec, args.out)
    tex_path = os.path.join(args.out, "main.tex")
    open(tex_path, "w", encoding="utf-8", newline="\n").write(tex)
    print("[mcm-latex] 已写出 %s（%d 字符）" % (tex_path, len(tex)), file=sys.stderr)

    if args.compile:
        return do_compile(tex_path)
    return 0


# ---------------------------------------------------------------- compile

def do_compile(tex_path):
    """编译 .tex。

    优先 latexmk（自动处理多趟编译与依赖），**失败时回退到直接跑 xelatex 两趟**。
    实测某些环境下 latexmk 会挂（它是 Perl 脚本，Perl 环境不完整就跑不起来），
    而 xelatex 本身是好的 —— 所以回退不是将就，是必需的。
    """
    engine, exe = find_engine()
    if not engine:
        print("[mcm-latex] 未找到 latexmk / xelatex —— 无法编译。"
              "请安装 TeX Live 或 MiKTeX，或改用 Word 版。", file=sys.stderr)
        return 3

    d = os.path.dirname(os.path.abspath(tex_path))
    base = os.path.splitext(os.path.basename(tex_path))[0]
    pdf = os.path.join(d, base + ".pdf")

    def run_cmd(cmd, label):
        print("[mcm-latex] %s: %s" % (label, " ".join(cmd)), file=sys.stderr)
        try:
            r = subprocess.run(cmd, cwd=d, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=600)
            return r.returncode, (r.stdout or "") + (r.stderr or "")
        except subprocess.TimeoutExpired:
            return 124, "编译超时（600s）"

    log = ""
    code = 1

    if engine == "latexmk":
        code, log = run_cmd(
            [exe, "-xelatex", "-interaction=nonstopmode", "-halt-on-error", "-quiet",
             os.path.basename(tex_path)], "latexmk")
        if code != 0 or not os.path.isfile(pdf):
            print("[mcm-latex] latexmk 未成功，回退到直接调用 xelatex", file=sys.stderr)

    if code != 0 or not os.path.isfile(pdf):
        xelatex = shutil.which("xelatex")
        if not xelatex:
            print("[mcm-latex] 也没有 xelatex，无法编译", file=sys.stderr)
            return 3
        # 两趟：第一趟生成 aux，第二趟解析引用与页码
        for i in (1, 2):
            code, log = run_cmd(
                [xelatex, "-interaction=nonstopmode", "-halt-on-error",
                 os.path.basename(tex_path)], "xelatex 第 %d 趟" % i)
            if code != 0 and not os.path.isfile(pdf):
                break

    if code != 0 or not os.path.isfile(pdf):
        print("[mcm-latex] ✗ 编译失败（退出码 %s）" % code, file=sys.stderr)
        errs = [l for l in log.splitlines()
                if l.startswith("!") or "Error" in l or "not found" in l][:8]
        for l in errs:
            print("    " + l, file=sys.stderr)
        if not errs:
            print("    （log 里没有明显错误行，可查看同目录下的 .log 文件）", file=sys.stderr)
        return 3

    size = os.path.getsize(pdf)
    print("[mcm-latex] ✓ 编译成功: %s (%.1f KB)" % (pdf, size / 1024), file=sys.stderr)

    warns = []
    if "undefined" in log.lower():
        warns.append("有未解析的引用（log 里出现 undefined）")
    if "cannot find" in log.lower():
        warns.append("有找不到的文件（图或字体）")
    for w in warns:
        print("[mcm-latex] ⚠ %s" % w, file=sys.stderr)

    print(pdf)
    return 0


def cmd_compile(args):
    if not os.path.isfile(args.tex):
        fail(2, "tex 不存在: %s" % args.tex)
    return do_compile(args.tex)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="LaTeX 论文生成与编译")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("build", help="按 spec 生成 .tex")
    p1.add_argument("out", help="输出目录")
    p1.add_argument("--spec", required=True)
    p1.add_argument("--compile", action="store_true", help="生成后立即编译")
    p1.set_defaults(func=cmd_build)

    p2 = sub.add_parser("compile", help="编译 .tex")
    p2.add_argument("tex")
    p2.set_defaults(func=cmd_compile)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
