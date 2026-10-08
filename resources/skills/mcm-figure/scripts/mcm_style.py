"""mcm-figure 配套的 matplotlib 样式模块。

用法:
    import sys; sys.path.insert(0, "skills/mcm-figure/scripts")
    import mcm_style

    mcm_style.apply()                       # 套用全局 rcParams
    fig, ax = plt.subplots(figsize=(6.3, 4.0))
    ax.plot(x, y, color=mcm_style.C["blue"])
    mcm_style.save(fig, "figures/result_q1_1")   # 同时出 .pdf + .png

设计说明:
  - 色板沿用本系列视觉系统（风格规范/template/src/remotion/theme.ts）。
    那里有亮版 / 深版两套：亮版给深色视频背景，**深版给白纸**。
    本模块只用深版 —— 亮版在白底上对比度不够。
  - 字号按论文正文小四(12pt)反推；图注(caption)由正文排版，不画进图里。
"""

import os

import matplotlib

matplotlib.use("Agg")          # 无头环境也能跑
import matplotlib.pyplot as plt  # noqa: E402

# ---------------------------------------------------------------- 色板

# 深版 = 论文用色
C = {
    "blue": "#2563EB",      # 主方案 / 基准组
    "cyan": "#0E8FA6",      # 对照方案 / normal 语气
    "green": "#0F9B6C",     # 达标 / 正收益
    "purple": "#7C3AED",    # 第三序列 / 消融
    "orange": "#C2410C",    # 中间态
    "amber": "#B45309",     # 警告
    "red": "#C41F3C",       # 失败 / 负收益 / danger 语气
    "yellow": "#D97706",    # 强调标注 / warn 语气
    # 中性
    "ink": "#08101F",       # 正文 / 轴标题
    "tick": "#3D4658",      # 刻度标签
    "muted": "#6B7796",     # 次要说明
    "grid": "#E3E7EF",      # 网格线
    "axis": "#C3CDE8",      # 坐标轴
    "bg": "#FFFFFF",        # 画布
}

# 语气色：同一篇论文里，青=正常、黄=注意、红=危险，不要混用
TONE = {"normal": C["cyan"], "warn": C["yellow"], "danger": C["red"]}

# 预设序列色序（已按明度拉开，灰阶打印也分得开）
SEQ2 = [C["blue"], C["cyan"]]
SEQ3 = [C["blue"], C["cyan"], C["purple"]]
SEQ4 = [C["blue"], C["cyan"], C["purple"], C["orange"]]
# 有"好坏"含义时用这组，别用上面的
SEQ_QUALITY = [C["green"], C["yellow"], C["red"]]

# 线型 / 标记：颜色之外的第二层区分线索（色觉障碍 + 黑白打印）
LINESTYLES = ["-", "--", "-.", ":"]
MARKERS = ["o", "s", "^", "D", "v", "P"]
HATCHES = ["", "///", "...", "xxx", "\\\\\\"]

# ---------------------------------------------------------------- rcParams

RC = {
    # 字体
    "font.sans-serif": ["Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei",
                        "PingFang SC", "SimHei", "DejaVu Sans"],
    "font.family": "sans-serif",
    "axes.unicode_minus": False,        # 负号不显示成方块
    # PDF/PS 字体嵌入：不嵌入的话，评审机器上没这个字体就会替换，排版全乱
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
    # 字号（论文正文小四 12pt 反推）
    "font.size": 9.5,
    "axes.titlesize": 10.5,
    "axes.labelsize": 10.5,
    "xtick.labelsize": 9.5,
    "ytick.labelsize": 9.5,
    "legend.fontsize": 9.5,
    # 画布
    "figure.facecolor": C["bg"],
    "axes.facecolor": C["bg"],
    "savefig.facecolor": C["bg"],
    "figure.dpi": 120,
    "savefig.dpi": 300,
    "savefig.bbox": "tight",
    "savefig.pad_inches": 0.04,
    # 坐标轴：只留左 + 下
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.spines.left": True,
    "axes.spines.bottom": True,
    "axes.edgecolor": C["axis"],
    "axes.linewidth": 0.8,
    "axes.labelcolor": C["ink"],
    "axes.titlecolor": C["ink"],
    "axes.axisbelow": True,
    # 刻度
    "xtick.direction": "in",
    "ytick.direction": "in",
    "xtick.color": C["axis"],
    "ytick.color": C["axis"],
    "xtick.labelcolor": C["tick"],
    "ytick.labelcolor": C["tick"],
    "xtick.major.size": 3,
    "ytick.major.size": 3,
    "xtick.major.width": 0.8,
    "ytick.major.width": 0.8,
    # 网格：只留横向
    "axes.grid": True,
    "axes.grid.axis": "y",
    "grid.color": C["grid"],
    "grid.linewidth": 0.6,
    "grid.linestyle": "-",
    # 线
    "lines.linewidth": 1.6,
    "lines.markersize": 4,
    "lines.markeredgewidth": 0.8,
    # 图例：无边框无底色
    "legend.frameon": False,
    "legend.handlelength": 1.6,
    "legend.handletextpad": 0.6,
    "legend.labelspacing": 0.35,
    "legend.borderaxespad": 0.4,
}


def apply():
    """套用全局 rcParams。每个脚本开头调一次即可。"""
    plt.rcParams.update(RC)


def seq(n, quality=False):
    """按序列数取配色。n>4 时循环补齐。"""
    base = SEQ_QUALITY if quality else SEQ4
    if n <= 2:
        base = SEQ2 if not quality else SEQ_QUALITY
    elif n == 3:
        base = SEQ3 if not quality else SEQ_QUALITY
    return [base[i % len(base)] for i in range(n)]


def style_axes(ax, ylabel=None, xlabel=None):
    """给单个 axes 补上统一标签与去边（多面板时逐个调用）。"""
    if ylabel:
        ax.set_ylabel(ylabel)
    if xlabel:
        ax.set_xlabel(xlabel)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    return ax


def panel_label(ax, text, loc="upper left"):
    """多面板编号 (a)(b)(c)。位置默认左上角外侧。"""
    xy = {"upper left": (-0.16, 1.06), "upper right": (1.02, 1.06)}[loc]
    ax.text(xy[0], xy[1], text, transform=ax.transAxes,
            fontsize=11, fontweight="bold", color=C["ink"],
            va="bottom", ha="left" if loc == "upper left" else "right")


# ---------------------------------------------------------------- 体验版水印

#: 水印文案。可用环境变量 MCM_WATERMARK 覆盖（换账号时不用改代码）
WATERMARK = os.environ.get("MCM_WATERMARK") or "体验版 · 抖音/B站 @汉谟拉比法典"


def is_trial():
    """是不是体验版。由主进程注入环境变量，脚本自己判断 —— 不依赖调用方记得传参。"""
    return os.environ.get("MCM_TRIAL") == "1"


def stamp_watermark(fig):
    """在右下角打体验版水印。正式版什么都不做。"""
    if not is_trial():
        return
    fig.text(
        0.995, 0.008, WATERMARK,
        ha="right", va="bottom",
        fontsize=7.5, color="#9aa0ae", alpha=0.9,
    )


def save(fig, path_no_ext, formats=("pdf", "png")):
    """导出矢量 PDF（进论文）+ 高 DPI PNG（预览）。

    同时检查有没有元素被裁出画布 —— 标注被裁是这类图最常见的翻车点。
    """
    d = os.path.dirname(path_no_ext)
    if d:
        os.makedirs(d, exist_ok=True)

    # ⚠️ 水印必须在 savefig **之前**打 —— 打完再存才进得去文件
    stamp_watermark(fig)

    out = []
    for fmt in formats:
        p = "%s.%s" % (path_no_ext, fmt)
        fig.savefig(p, format=fmt)
        out.append(p)

    # 画布边界检查：tight bbox 之外若还有可见图元，说明有东西被裁
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    tb = fig.get_tightbbox(renderer)
    fb = fig.bbox_inches
    overflow = []
    for name, edge in (("左", tb.x0 < -0.01), ("右", tb.x1 > fb.width + 0.01),
                       ("下", tb.y0 < -0.01), ("上", tb.y1 > fb.height + 0.01)):
        if edge:
            overflow.append(name)
    if overflow:
        print("[mcm-figure] ⚠ 有元素超出画布边界（%s）—— 检查标注/图例是否被裁"
              % "、".join(overflow))

    for p in out:
        size = os.path.getsize(p)
        print("[mcm-figure] %s  (%.1f KB)" % (p, size / 1024))
    return out
