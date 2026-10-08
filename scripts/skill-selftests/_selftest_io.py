"""自检：mcm_io 的三个读入功能是否真的能跑。"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
IO = os.path.join(HERE, "scripts", "mcm_io.py")
TMP = os.path.join(HERE, "_selftest")
os.makedirs(TMP, exist_ok=True)

# ---------- 造测试文件 ----------
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from openpyxl import Workbook

# 1) 一个带中文的 PDF
fig = plt.figure(figsize=(6, 2))
fig.text(0.05, 0.6, "数学建模竞赛 赛题 A 题", fontsize=14)
fig.text(0.05, 0.3, "附件1 第1页 测试内容 ABC-123", fontsize=11)
pdf_path = os.path.join(TMP, "赛题.pdf")
fig.savefig(pdf_path, format="pdf")
plt.close(fig)

# 2) 一个 Excel：首行就是数据（故意不放表头）
wb = Workbook()
ws = wb.active
ws.title = "附件1"
for i in range(1, 8):
    ws.append([i, "城市%d" % i, 399.6747 + i])
xlsx_path = os.path.join(TMP, "附件1.xlsx")
wb.save(xlsx_path)

# 3) 一个 CSV
csv_path = os.path.join(TMP, "data.csv")
with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
    f.write("id,name,value\n1,甲,10.5\n2,乙,20.3\n3,丙,30.1\n")


def run(args):
    r = subprocess.run([PY, IO] + args, capture_output=True, text=True, encoding="utf-8")
    return r.returncode, (r.stdout or ""), (r.stderr or "")


ok = []
bad = []

# --- PDF ---
code, out, err = run(["pdf", pdf_path])
if code == 0 and ("数学建模" in out or "赛题" in out):
    ok.append("PDF 抽取（含中文）")
else:
    bad.append("PDF 抽取 -> code=%s out=%r err=%r" % (code, out[:120], err[:160]))

# --- PDF 按页 ---
code, out, err = run(["pdf", pdf_path, "--pages", "1"])
if code == 0 and "第 1 页" in out:
    ok.append("PDF 页码范围")
else:
    bad.append("PDF 页码范围 -> code=%s" % code)

# --- XLSX 默认不推断表头（首行应是数据 1/城市1）---
code, out, err = run(["xlsx", xlsx_path, "--head", "2"])
if code == 0 and "城市1" in out and "列名" not in out:
    ok.append("XLSX 不推断表头")
else:
    bad.append("XLSX 不推断表头 -> code=%s out=%r" % (code, out[:160]))

# --- XLSX 行数断言：给错的期望值，应报错退出 ---
code, out, err = run(["xlsx", xlsx_path, "--expect-rows", "9999"])
if code == 3:
    ok.append("XLSX 行数断言（不符即失败）")
else:
    bad.append("XLSX 行数断言 -> 期望 code=3，实际 %s" % code)

# --- CSV ---
code, out, err = run(["csv", csv_path, "--header"])
if code == 0 and "甲" in out:
    ok.append("CSV 读取（utf-8-sig + 表头）")
else:
    bad.append("CSV -> code=%s out=%r" % (code, out[:120]))

# --- info ---
code, out, err = run(["info", TMP])
if code == 0 and "PDF" in out and "Excel" in out:
    ok.append("材料清点")
else:
    bad.append("材料清点 -> code=%s out=%r" % (code, out[:160]))

print()
for s in ok:
    print("  ✓ %s" % s)
for s in bad:
    print("  ✗ %s" % s)
print()
print("通过 %d / 失败 %d" % (len(ok), len(bad)))
sys.exit(1 if bad else 0)
