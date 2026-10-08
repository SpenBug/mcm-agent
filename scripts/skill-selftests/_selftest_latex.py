"""自检：mcm_latex 生成 + 真编译。"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
LATEX = os.path.join(HERE, "scripts", "mcm_latex.py")
TMP = os.path.join(HERE, "_selftest")
os.makedirs(TMP, exist_ok=True)

# 复用 docx 自检造的图
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

fig_path = os.path.join(TMP, "fig_demo.png")
if not os.path.isfile(fig_path):
    fig, ax = plt.subplots(figsize=(4, 2.4))
    ax.bar(["A", "B", "C"], [0.8, 0.6, 0.9], color="#2563EB")
    fig.tight_layout()
    fig.savefig(fig_path, dpi=200)
    plt.close(fig)

spec = {
    "title": "基于多目标优化的城市配送路径规划模型",
    "abstract": {
        "text": "本文针对城市配送路径规划问题，建立了多目标优化模型。",
        "keywords": ["多目标优化", "车辆路径问题"],
    },
    "sections": [
        {"heading": "一、问题重述", "level": 1, "blocks": [
            {"type": "para", "text": "城市配送是物流系统的关键环节。"},
        ]},
        {"heading": "二、模型建立", "level": 1, "blocks": [
            {"type": "para", "text": "目标函数如下。"},
            {"type": "equation", "text": r"min Z = \sum_i \sum_j c_{ij} x_{ij}", "number": "(1)"},
            {"type": "table", "caption": "表1 符号说明",
             "header": ["符号", "含义"], "rows": [["c_ij", "距离"], ["x_ij", "决策变量"]]},
            {"type": "figure", "path": fig_path, "caption": "图1 方案得分对比"},
        ]},
    ],
    "references": ["[1] 张三，运筹学，北京：高等教育出版社，12-34，2020。"],
}
spec_path = os.path.join(TMP, "latex_spec.json")
json.dump(spec, open(spec_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

out_dir = os.path.join(TMP, "paper_tex")


def run(args, timeout=700):
    r = subprocess.run([PY, LATEX] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return r.returncode, (r.stdout or ""), (r.stderr or "")


ok, bad = [], []

# --- build ---
code, out, err = run(["build", out_dir, "--spec", spec_path])
tex = os.path.join(out_dir, "main.tex")
if code == 0 and os.path.isfile(tex):
    ok.append("build 生成 .tex（%.1f KB）" % (os.path.getsize(tex) / 1024))
else:
    bad.append("build -> code=%s err=%r" % (code, err[:200]))

# --- 转义检查：正文里的特殊字符应被转义，公式块不转义 ---
if os.path.isfile(tex):
    s = open(tex, encoding="utf-8").read()
    if r"\sum" in s and r"\begin{equation}" in s:
        ok.append("公式块正确排版（\\sum / equation 环境）")
    else:
        bad.append("公式块未正确排版")
    if r"\textbackslash{}" not in s and "\\&" not in s:
        ok.append("正文特殊字符已转义")
    else:
        bad.append("转义逻辑异常（不该出现转义符却有）")

# --- compile ---
code, out, err = run(["compile", tex])
pdf = os.path.join(out_dir, "main.pdf")
if code == 0 and os.path.isfile(pdf):
    ok.append("编译成功，产出 PDF（%.1f KB）" % (os.path.getsize(pdf) / 1024))
else:
    bad.append("compile -> code=%s err=%r" % (code, err[:400]))

# --- 页数（用 pypdf 数：xelatex 的 PDF 用对象流压缩，纯文本搜不到 /Type /Page）---
if os.path.isfile(pdf):
    try:
        from pypdf import PdfReader
        n = len(PdfReader(pdf).pages)
        if n >= 1:
            ok.append("PDF 页数 = %d" % n)
        else:
            bad.append("PDF 页数为 0")
    except Exception as e:
        bad.append("页数解析失败: %s" % e)

print()
for s in ok:
    print("  ✓ %s" % s)
for s in bad:
    print("  ✗ %s" % s)
print()
print("通过 %d / 失败 %d" % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
