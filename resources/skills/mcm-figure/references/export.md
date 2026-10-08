# 导出与印刷

论文图必须**矢量**。位图放大就糊，评审放大一看就知道。

---

## 一图两出

```python
mcm_style.save(fig, "figures/result_q1_1")   # 自动出 .pdf + .png
```

| 格式 | 用途 | 要求 |
|---|---|---|
| **`.pdf`** | **进论文**（LaTeX 用 `\includegraphics`，Word 直接插入） | 矢量，字体已嵌入 |
| `.png` | 预览、贴到聊天/文档、答辩 PPT | 300 dpi |

**只有 PNG 不算交付。** 评审要看清细节时位图会露馅。

---

## 尺寸换算

论文正文宽度决定了图的实际尺寸，**不要出图后再缩放**——缩放会让字号偏离设计值。

| 目标 | figsize (in) | 说明 |
|---|---|---|
| A4 单栏 | `(6.3, ·)` | 16 cm |
| A4 通栏 | `(9.6, ·)` | 24.4 cm |
| Word 正文内嵌 | `(5.8, ·)` | 留出页边距 |

出图时按目标尺寸出，插入时**按 100% 缩放**放进去。这样图里 9.5pt 的刻度就是真的 9.5pt。

---

## 字体：最常翻车的地方

### 中文必须显式指定

```python
plt.rcParams["font.sans-serif"] = ["Noto Sans SC", "Source Han Sans SC",
                                   "Microsoft YaHei", "PingFang SC"]
plt.rcParams["axes.unicode_minus"] = False     # 负号不显示成方块
```

`mcm_style.apply()` 已经设好。

### ⚠️ 实测会遇到的字重警告

```
findfont: Failed to find font weight normal for Noto Sans SC, now using 100.
```

**这条警告本身不影响字形**（中文字能正常显示），但说明字重没匹配上——
如果图上出现了**粗细明显不对**的文字（比如刻度特别细），就是这个原因。

**处理办法**（按优先级）：

1. 确认系统装了对应字重的字体（`Noto Sans SC` 的 Regular / Bold 是分开的）
2. 换一个装全字重的字体，比如 `Source Han Sans SC` 或 `Microsoft YaHei`
3. 仍然不对时，显式指定：

```python
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei"]     # Windows 一定有
```

### 字体必须嵌入 PDF

```python
plt.rcParams["pdf.fonttype"] = 42     # TrueType 嵌入
plt.rcParams["ps.fonttype"] = 42
```

不嵌入的话，评审机器上没这个字体就会替换成别的，**排版全乱**。
`mcm_style` 里已设；如果自己写脚本，记得加。

### 交付前必查

```bash
pdffonts figures/result_q1_1.pdf     # poppler-utils；看 emb 列是否全为 yes
```

或用 Python：

```python
import re
raw = open("figures/result_q1_1.pdf", "rb").read()
print("含嵌入字体:", b"/FontFile2" in raw or b"/FontFile3" in raw)
```

---

## 字号：按最终尺寸定

论文正文小四 = 12pt。图里的字**不能小于 9pt**，否则打印出来看不清。

| 元素 | 目标 |
|---|---|
| 轴标题 | 10.5pt |
| 刻度 / 图例 | 9.5pt |
| 图内标注 | 9pt（下限） |
| 面板编号 | 11pt bold |

**图注（caption）不要画进图里** —— 由正文排版，这样排版软件能统一编号。

---

## 交付前门禁

逐条打勾，**任一项没过不算完成**：

- [ ] 中文字正常（没有方块 □□、没有乱码）
- [ ] 负号正常（不是方块）
- [ ] 输出含 `.pdf` 矢量版
- [ ] PDF 字体已嵌入（`/FontFile2` 存在）
- [ ] 字号 ≥ 9pt，与论文正文协调
- [ ] 尺寸按目标栏宽出，插入时 100% 缩放
- [ ] 图里没有元素被裁出边界（`mcm_style.save()` 会自动警告）
- [ ] 同一论文的其他图字号 / 线宽 / 配色一致
- [ ] 图上每个数值都能追溯到 `results/` 里的某个文件

---

## 交付清单

```
figures/
  raw_qN_*.pdf / .png        原始数据图
  process_qN_*.pdf / .png    数据处理过程图
  result_qN_*.pdf / .png     结果图（论文引用）
  FIGURE_REPORT.md           图表清单 + 每个图的结论 + 数据来源
```

`FIGURE_REPORT.md` 建议包含：

| 文件名 | 回答什么问题 | 数据来源 | 导出时间 |
|---|---|---|---|
| `result_q1_1.pdf` | 三种方案在三个场景下的准确率对比 | `results/q1_metrics.csv` | 2026-10-06 |

> 这份报告是**给论文手用的**：他按它写图注、排章节，不用回去翻代码。
