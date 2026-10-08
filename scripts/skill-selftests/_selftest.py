"""自检：mcm_style 能否真的出图。跑通才说明这份规范可用。"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))

import numpy as np
import matplotlib.pyplot as plt
import mcm_style

OUT = os.path.join(HERE, "_selftest")
os.makedirs(OUT, exist_ok=True)
mcm_style.apply()

rng = np.random.default_rng(7)
ok = []

# ---- 1. 分组柱状 + 误差棒（论文最常见的对比图）----
fig, ax = plt.subplots(figsize=(6.3, 3.6))
groups = ["方案A", "方案B", "方案C"]
x = np.arange(len(groups))
w = 0.34
for i, (name, col, hatch) in enumerate(zip(["本文方法", "基线"], mcm_style.SEQ2, mcm_style.HATCHES)):
    v = rng.uniform(0.6, 0.95, len(groups))
    e = rng.uniform(0.02, 0.05, len(groups))
    ax.bar(x + (i - 0.5) * w, v, w, yerr=e, label=name, color=col,
           hatch=hatch, edgecolor="white", linewidth=0.6,
           error_kw=dict(capsize=3, linewidth=1, ecolor=mcm_style.C["ink"]))
ax.set_xticks(x, groups)
mcm_style.style_axes(ax, ylabel="准确率", xlabel="实验组")
ax.legend(loc="lower right", ncol=2)
mcm_style.save(fig, os.path.join(OUT, "result_q1_1"))
plt.close(fig)
ok.append("分组柱状图")

# ---- 2. 趋势线 + 线型/标记双层区分 ----
fig, ax = plt.subplots(figsize=(6.3, 3.6))
t = np.linspace(0, 10, 60)
for i, (name, col, ls, mk) in enumerate(zip(
        ["本文方法", "对照一", "对照二"], mcm_style.SEQ3, mcm_style.LINESTYLES, mcm_style.MARKERS)):
    y = 1 - np.exp(-t / (1.2 + i * 0.5)) + rng.normal(0, 0.008, len(t))
    ax.plot(t, y, color=col, linestyle=ls, marker=mk, markevery=7, label=name)
mcm_style.style_axes(ax, ylabel="收敛指标", xlabel="迭代轮次")
ax.legend(loc="lower right")
mcm_style.save(fig, os.path.join(OUT, "result_q2_1"))
plt.close(fig)
ok.append("趋势线图")

# ---- 3. 热图 ----
fig, ax = plt.subplots(figsize=(5.2, 4.2))
m = rng.uniform(-1, 1, (8, 10))
im = ax.imshow(m, cmap="RdBu_r", vmin=-1, vmax=1, aspect="auto")
ax.set_xticks(range(10), [f"{i+1}" for i in range(10)])
ax.set_yticks(range(8), [f"F{i+1}" for i in range(8)])
ax.grid(False)
cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
cb.outline.set_visible(False)
cb.ax.tick_params(labelsize=9.5, color=mcm_style.C["axis"])
mcm_style.style_axes(ax, ylabel="特征", xlabel="样本")
mcm_style.save(fig, os.path.join(OUT, "result_q3_1"))
plt.close(fig)
ok.append("热图")

# ---- 4. 多面板 + 面板编号 ----
fig, axes = plt.subplots(1, 3, figsize=(9.6, 3.1))
for i, (ax, tag) in enumerate(zip(axes, ["(a)", "(b)", "(c)"])):
    ax.plot(t, np.sin(t * (1 + i * 0.4)) + rng.normal(0, 0.03, len(t)),
            color=mcm_style.SEQ3[i], linewidth=1.6)
    mcm_style.style_axes(ax, ylabel="响应" if i == 0 else None,
                         xlabel="时间" if i == 1 else None)
    mcm_style.panel_label(ax, tag)
fig.tight_layout()
mcm_style.save(fig, os.path.join(OUT, "result_q4_1"))
plt.close(fig)
ok.append("多面板 + 编号")

print()
print("自检通过 %d 项：%s" % (len(ok), "、".join(ok)))
