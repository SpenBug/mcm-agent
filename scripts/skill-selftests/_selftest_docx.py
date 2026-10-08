"""自检：mcm_docx 生成 → inspect → check 全链路。"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
DOCX = os.path.join(HERE, "scripts", "mcm_docx.py")
TMP = os.path.join(HERE, "_selftest")
os.makedirs(TMP, exist_ok=True)

# ---------- 造一张图当插图 ----------
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

fig_path = os.path.join(TMP, "fig_demo.png")
fig, ax = plt.subplots(figsize=(4, 2.4))
ax.bar(["A", "B", "C"], [0.8, 0.6, 0.9], color="#2563EB")
ax.set_ylabel("得分")
fig.tight_layout()
fig.savefig(fig_path, dpi=200)
plt.close(fig)

# ---------- 造 spec ----------
spec = {
    "title": "基于多目标优化的城市配送路径规划模型",
    "abstract": {
        "text": "本文针对城市配送路径规划问题，建立了以总里程最短和车辆数最少为目标的多目标优化模型，"
                "采用改进遗传算法求解，并在真实数据集上验证了模型的有效性。",
        "keywords": ["多目标优化", "车辆路径问题", "遗传算法"],
    },
    "sections": [
        {"heading": "一、问题重述", "level": 1, "blocks": [
            {"type": "para", "text": "城市配送是物流系统的关键环节。"},
            {"type": "list", "items": ["配送点数量大", "时间窗约束强"]},
        ]},
        {"heading": "二、模型建立", "level": 1, "blocks": [
            {"type": "para", "text": "设决策变量 x_ij 表示车辆是否从 i 行驶到 j。"},
            {"type": "equation", "text": "min Z = Σ Σ c_ij · x_ij", "number": "(1)"},
            {"type": "table", "caption": "表1 符号说明",
             "header": ["符号", "含义"], "rows": [["c_ij", "距离"], ["x_ij", "决策变量"]]},
        ]},
        {"heading": "三、结果分析", "level": 1, "blocks": [
            {"type": "para", "text": "三种方案的得分对比如图1所示。"},
            {"type": "figure", "path": fig_path, "caption": "图1 三种方案得分对比"},
        ]},
    ],
    "references": [
        "[1] 张三，运筹学，北京：高等教育出版社，12-34，2020。",
        "[2] 李四，车辆路径问题综述，系统工程，38(2)：1-10，2020。",
    ],
}
spec_path = os.path.join(TMP, "paper_spec.json")
json.dump(spec, open(spec_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

out_path = os.path.join(TMP, "论文.docx")


def run(args):
    r = subprocess.run([PY, DOCX] + args, capture_output=True, text=True, encoding="utf-8")
    return r.returncode, (r.stdout or ""), (r.stderr or "")


ok, bad = [], []

# --- build ---
code, out, err = run(["build", out_path, "--spec", spec_path])
if code == 0 and os.path.isfile(out_path):
    ok.append("build 生成 docx（%.1f KB）" % (os.path.getsize(out_path) / 1024))
else:
    bad.append("build -> code=%s err=%r" % (code, err[:200]))

# --- inspect ---
code, out, err = run(["inspect", out_path])
if code == 0 and "问题重述" in out and "参考文献" in out:
    ok.append("inspect 读出章节骨架")
else:
    bad.append("inspect -> code=%s out=%r" % (code, out[:200]))

# --- check（应该通过）---
code, out, err = run(["check", out_path])
if code == 0:
    ok.append("check 通过（无占位符残留、图表编号连续）")
else:
    bad.append("check -> code=%s out=%r" % (code, out[:250]))

# --- check 应该能抓出占位符残留 ---
bad_spec = dict(spec)
bad_spec["sections"] = [{"heading": "一、测试", "level": 1,
                         "blocks": [{"type": "para", "text": "这里还有【待填写】没替换"}]}]
bad_spec_path = os.path.join(TMP, "bad_spec.json")
json.dump(bad_spec, open(bad_spec_path, "w", encoding="utf-8"), ensure_ascii=False)
bad_out = os.path.join(TMP, "bad.docx")
run(["build", bad_out, "--spec", bad_spec_path])
code, out, err = run(["check", bad_out])
if code == 3 and "占位符" in out:
    ok.append("check 能抓出未替换的占位符")
else:
    bad.append("check 占位符检测 -> code=%s out=%r" % (code, out[:200]))

# --- check 应该能抓出图注编号不连续 ---
gap_spec = dict(spec)
gap_spec["sections"] = [{"heading": "一、测试", "level": 1, "blocks": [
    {"type": "figure", "path": fig_path, "caption": "图1 第一张"},
    {"type": "figure", "path": fig_path, "caption": "图3 跳号了"},
]}]
gap_spec_path = os.path.join(TMP, "gap_spec.json")
json.dump(gap_spec, open(gap_spec_path, "w", encoding="utf-8"), ensure_ascii=False)
gap_out = os.path.join(TMP, "gap.docx")
run(["build", gap_out, "--spec", gap_spec_path])
code, out, err = run(["check", gap_out])
if code == 3 and "不连续" in out:
    ok.append("check 能抓出图表编号跳号")
else:
    bad.append("check 编号检测 -> code=%s out=%r" % (code, out[:200]))

print()
for s in ok:
    print("  ✓ %s" % s)
for s in bad:
    print("  ✗ %s" % s)
print()
print("通过 %d / 失败 %d" % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
