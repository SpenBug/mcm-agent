"""验证 references/paths.md 里那段 find_workspace_root() 真能用。

直接从 markdown 里抽出代码块跑 —— 文档和测试共用同一份代码，不会漂移。
"""
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile

DOC = r"D:\数学建模项目\mcm-agent\resources\skills\mcm-tools\references\paths.md"
PY = sys.executable

md = io.open(DOC, encoding="utf-8").read()
# 抽第一个 ```python 代码块
m = re.search(r"```python\n(.*?)```", md, re.S)
if not m:
    print("  ✗ 文档里找不到 python 代码块")
    sys.exit(2)
snippet = m.group(1)
print("  ✓ 从文档抽出 %d 行引导代码" % len(snippet.strip().splitlines()))

ROOT = tempfile.mkdtemp(prefix="wsroot-")
WS = os.path.join(ROOT, "工作区")
CODE = os.path.join(WS, "code")
os.makedirs(os.path.join(WS, ".mcm-agent"), exist_ok=True)
os.makedirs(os.path.join(WS, "input", "数据"), exist_ok=True)
os.makedirs(os.path.join(WS, "results"), exist_ok=True)
os.makedirs(CODE, exist_ok=True)
io.open(os.path.join(WS, "input", "数据", "附件1.xlsx"), "w", encoding="utf-8").write("x")

probe = snippet + '''

import json, sys
print(json.dumps({
    "ROOT": str(ROOT),
    "cwd": str(Path.cwd()),
    "file": str(Path(__file__).resolve()),
    "target": str(P("input", "数据", "附件1.xlsx")),
    "exists": P("input", "数据", "附件1.xlsx").exists(),
}, ensure_ascii=False))
'''
probe_path = os.path.join(CODE, "probe.py")
io.open(probe_path, "w", encoding="utf-8").write(probe)

# ① 从 code/ 下跑（cwd = code/，这正是出问题的场景）
r = subprocess.run([PY, "probe.py"], cwd=CODE, capture_output=True, text=True,
                   encoding="utf-8", errors="replace")
print("\n  === ① cwd = code/（出问题的场景）===")
print("    退出码:", r.returncode)
if r.stdout.strip():
    import json
    d = json.loads(r.stdout.strip().splitlines()[-1])
    print("    脚本位置:", d["file"])
    print("    cwd     :", d["cwd"])
    print("    解析出的根:", d["ROOT"])
    print("    拼出的路径:", d["target"])
    print("    文件存在:", "✓" if d["exists"] else "✗")
    ok1 = d["exists"] and os.path.normcase(d["ROOT"]) == os.path.normcase(WS)
else:
    print("    stderr:", r.stderr[:300])
    ok1 = False
print("    →", "✓ 正确解析到工作区根" if ok1 else "✗ 没解析对")

# ② 从工作区根跑（cwd = 根）
r2 = subprocess.run([PY, os.path.join("code", "probe.py")], cwd=WS, capture_output=True,
                    text=True, encoding="utf-8", errors="replace")
print("\n  === ② cwd = 工作区根 ===")
if r2.stdout.strip():
    import json
    d2 = json.loads(r2.stdout.strip().splitlines()[-1])
    print("    解析出的根:", d2["ROOT"])
    print("    文件存在:", "✓" if d2["exists"] else "✗")
    ok2 = d2["exists"] and os.path.normcase(d2["ROOT"]) == os.path.normcase(WS)
else:
    print("    stderr:", r2.stderr[:300])
    ok2 = False
print("    →", "✓ 也正确" if ok2 else "✗ 不对")

# ③ 用绝对路径从别处跑
r3 = subprocess.run([PY, probe_path], cwd=ROOT, capture_output=True,
                    text=True, encoding="utf-8", errors="replace")
print("\n  === ③ cwd = 完全无关的目录 ===")
if r3.stdout.strip():
    import json
    d3 = json.loads(r3.stdout.strip().splitlines()[-1])
    print("    解析出的根:", d3["ROOT"])
    print("    文件存在:", "✓" if d3["exists"] else "✗")
    ok3 = d3["exists"] and os.path.normcase(d3["ROOT"]) == os.path.normcase(WS)
else:
    print("    stderr:", r3.stderr[:300])
    ok3 = False
print("    →", "✓ 也正确" if ok3 else "✗ 不对")

shutil.rmtree(ROOT, ignore_errors=True)
print()
print("=== " + ("✓ 三种运行方式都能定位到工作区根" if (ok1 and ok2 and ok3) else "✗ 有失败项") + " ===")
sys.exit(0 if (ok1 and ok2 and ok3) else 1)
