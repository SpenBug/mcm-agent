# 路径规范：生成的脚本怎么定位工作区根

## 为什么必须这样

工作区结构是：

```
<工作区根>/
  ├─ input/{赛题,规范,模板,数据}/
  ├─ code/          ← 生成的脚本通常放这里
  ├─ results/
  ├─ figures/
  ├─ reports/
  └─ .mcm-agent/    ← 应用私有目录，可当作"工作区根"的标记
```

**脚本被 cd 到 `code/` 下运行时，cwd 就是 `code/`。**
此时脚本里写 `open('input/数据/附件1.xlsx')` 会去找 `code/input/...` —— **必然 FileNotFoundError**。

## 正确写法

**每个生成的脚本，开头都必须解析出工作区根。** 首选从 `__file__` 往上找标记目录：

```python
# --- 工作区根解析（每个脚本都要有，别删）---
import os
from pathlib import Path


def find_workspace_root(start=None):
    """从脚本位置往上找，直到看见 .mcm-agent/ 或 input/ —— 那就是工作区根。

    为什么不用 cwd：脚本常被 cd 到 code/ 下跑，cwd 是 code/ 而不是工作区根。
    为什么不用纯相对路径：同上，会解析到 code/input/... 然后报文件不存在。
    """
    here = Path(start or __file__).resolve()
    for d in [here.parent, *here.parents]:
        if (d / '.mcm-agent').is_dir() or (d / 'input').is_dir():
            return d
    # 兜底：应用跑命令时会注入 MCM_WORKSPACE 环境变量
    env = os.environ.get('MCM_WORKSPACE')
    return Path(env).resolve() if env else here.parent


ROOT = find_workspace_root()


def P(*parts):
    """拼一个工作区内的绝对路径：P('input', '数据', '附件1.xlsx')"""
    return ROOT.joinpath(*parts)
# --- 解析结束 ---
```

用的时候一律走 `P()`，**不要写裸相对路径**：

```python
import pandas as pd

df = pd.read_excel(P('input', '数据', '附件1.xlsx'))
df.to_csv(P('results', '清洗后.csv'), index=False, encoding='utf-8-sig')
```

## 输出路径同理

```python
fig.savefig(P('figures', 'fig_trend.pdf'))          # 不要写 'figures/fig_trend.pdf'
Path(P('reports')).mkdir(parents=True, exist_ok=True)
```

## 常见错误对照

| ❌ 错的 | ✅ 对的 | 后果 |
|---|---|---|
| `open('input/数据/x.xlsx')` | `open(P('input','数据','x.xlsx'))` | cd 到 code/ 后找不到 |
| `open('../input/数据/x.xlsx')` | `open(P('input','数据','x.xlsx'))` | 只在"恰好一层深"时对，换个位置就崩 |
| `ROOT = Path.cwd()` | `ROOT = find_workspace_root()` | cwd 取决于从哪调用，不可靠 |
| 写死 `C:\Users\...\工作区` | `P(...)` | 换机器/换工作区就废 |

## 命令行里也一样

`run_command` 的 cwd 默认就是工作区根，所以**命令里直接用相对路径没问题**：

```bash
python code/preprocess.py            # ✓ cwd = 工作区根
python code/preprocess.py --root .   # ✓ 也可以显式传
```

**但脚本内部**不能依赖 cwd —— 因为脚本也可能被从别处调用（比如你自己 `cd code && python preprocess.py` 调试）。

## 什么时候可以不用这套

一次性、只用来验证几行逻辑的 `run_python({code: "..."})` 片段可以简单点 ——
但**只要落到 `code/` 里成为文件，就必须带 `find_workspace_root()`**。
