# 图型与版式

先选图型，再谈好看。**图型选错，配色再讲究也没用。**

---

## 选图型

| 你要回答的问题 | 用 | 不要用 |
|---|---|---|
| 几组之间谁高谁低 | **分组柱状**（带误差棒） | 饼图 |
| 随某个量怎么变 | **折线 / 趋势图** | 柱状（连续量别用柱） |
| 两个量有没有关系 | **散点 + 拟合线** | 折线（那会暗示因果） |
| 多维样本的强弱分布 | **热图** | 多个小柱状 |
| 多个指标的综合对比 | **雷达图** | 分组柱状（超过 4 组就挤） |
| 分布形状 / 离群点 | **箱线 / 小提琴** | 只报均值 |
| 参数变化对结果的影响 | **灵敏度曲线**（一族折线） | 单条线 |
| 占比随时间变化 | **堆叠面积** | 堆叠柱状（除非只有 3–4 个时间点） |

> **饼图基本不要用。** 超过 3 个扇区人眼就分不清面积差，改成横向条形。

---

## 单图版式

```python
import mcm_style
mcm_style.apply()

fig, ax = plt.subplots(figsize=(6.3, 3.6))   # 单栏宽 6.3in ≈ 16cm
```

**尺寸**（按 A4 论文正文栏宽）

| 用途 | figsize |
|---|---|
| 单栏（半页宽） | `(6.3, 3.6)` |
| 双栏（通栏） | `(9.6, 4.0)` |
| 方形（热图 / 雷达） | `(5.2, 4.6)` |
| 一行三面板 | `(9.6, 3.1)` |

**长宽比**：一般 1.6–1.8:1 最顺眼。不要拉成正方形或细长条。

---

## 多面板

```python
fig, axes = plt.subplots(1, 3, figsize=(9.6, 3.1))
for ax, tag in zip(axes, ["(a)", "(b)", "(c)"]):
    ...
    mcm_style.panel_label(ax, tag)
fig.tight_layout()
```

**规则**

1. **每个面板都要编号** `(a) (b) (c)`，编号用粗体，位置在**左上角外侧**。
2. **共享的轴标签只写一次** —— 三个面板都是同一个 y 轴含义时，只在最左写 ylabel，中间和右边不写。
3. **共享量程** —— 同一组面板的 y 轴范围必须一致，否则视觉对比是假的。
   用 `sharey=True` 或手动 `ax.set_ylim(...)`。
4. **面板数不超过 6 个**。超过就拆成两张图。
5. 用 `fig.tight_layout()` 或 `constrained_layout`，不要手调 `subplots_adjust` 试数。

---

## 常用图型的写法要点

### 分组柱状 + 误差棒

```python
x = np.arange(len(groups)); w = 0.34
for i, (name, col, hatch) in enumerate(zip(names, mcm_style.SEQ2, mcm_style.HATCHES)):
    ax.bar(x + (i - 0.5) * w, vals[i], w, yerr=errs[i],
           label=name, color=col, hatch=hatch,
           edgecolor="white", linewidth=0.6,
           error_kw=dict(capsize=3, linewidth=1, ecolor=mcm_style.C["ink"]))
ax.set_xticks(x, groups)
```

要点：
- **必须有误差棒**（标准差 / 置信区间 / 多次实验的极差）。没有误差棒的对比图在建模论文里站不住。
- 柱宽 0.7 总量，组内间隙 0.1 → `w = 0.34` 两组、`w = 0.22` 三组
- 第二序列加斜纹 `hatch="///"` —— 黑白打印时才分得开

### 趋势线（多序列）

```python
for i, (name, col, ls, mk) in enumerate(zip(
        names, mcm_style.SEQ3, mcm_style.LINESTYLES, mcm_style.MARKERS)):
    ax.plot(t, y[i], color=col, linestyle=ls, marker=mk, markevery=7, label=name)
```

要点：
- **颜色 + 线型 + 标记三层区分**，不能只靠颜色
- `markevery` 让标记稀疏一点，别糊成一条带
- 线宽统一 1.6，别有的粗有的细

### 热图

```python
im = ax.imshow(m, cmap="RdBu_r", vmin=-1, vmax=1, aspect="auto")
ax.grid(False)                                   # 热图不要网格
cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
cb.outline.set_visible(False)                    # 色条去边框
```

要点：
- **色阶必须对称居中**（`vmin=-a, vmax=a`），否则"0"的位置会骗人
- 发散数据用 `RdBu_r` / `coolwarm`；单向量用 `viridis` / `Blues`
- **不要用 jet / rainbow** —— 感知不均匀，会造出假的边界
- 格子太密就别写数值，靠色条读

### 灵敏度曲线

```python
for i, p in enumerate(param_values):
    ax.plot(x, curves[i], color=mcm_style.seq(len(param_values))[i], label=f"α={p}")
ax.axvline(best_x, color=mcm_style.C["yellow"], linewidth=1, linestyle="--")
ax.annotate("最优", xy=(best_x, best_y), xytext=(8, 8), textcoords="offset points",
            fontsize=9, color=mcm_style.C["yellow"])
```

要点：
- 一族曲线**颜色随参数单调变化**（浅→深），不要跳色
- 标出最优点用琥珀 `#D97706` 虚线 + 短标注
- 曲线超过 6 条就只画关键几条，其余的说明"其余取值趋势相同"

---

## 不要做的事

| ❌ | 为什么 |
|---|---|
| 3D 柱状 / 3D 饼图 | 透视变形让数值不可读，且投影后无法准确比较 |
| 双 y 轴 | 两条轴可以随意缩放，能造出任何"相关"，是误导 |
| 截断 y 轴（不从 0 起） | 除非明确标注并说明理由，否则放大差异 = 视觉造假 |
| 图里塞满文字 | 说明放图注，图内只留必要的标注 |
| 手写数据点 | 每个数都要能追溯到 `results/` |
| 用 `jet` 色图 | 感知不均匀，制造假边界 |
