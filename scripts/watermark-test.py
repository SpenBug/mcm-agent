"""验证体验版水印真的进了产出文件。

⚠️ 关键：不能只验"函数被调用了"，要验**文件里真的有水印**：
  - 图表：渲染出来**看图**（人眼确认）
  - 论文：解压 docx，在页眉 XML 里找水印文本
  - 正式版：同样的产出**必须没有水印**
"""
import os
import subprocess
import sys
import tempfile
import zipfile

APP_PY = r"C:\Users\92182\AppData\Roaming\阿一古数模\python-env\Scripts\python.exe"
ROOT = r"D:\数学建模项目\mcm-agent"
STYLE = os.path.join(ROOT, "resources", "skills", "mcm-figure", "scripts")
DOCX = os.path.join(ROOT, "resources", "skills", "mcm-tools", "scripts", "mcm_docx.py")

WS = tempfile.mkdtemp(prefix="wm-test-")
os.makedirs(os.path.join(WS, "figures"), exist_ok=True)

PLOT = '''
import sys, os
sys.path.insert(0, r"%s")
import mcm_style as S
S.apply()
import numpy as np, matplotlib.pyplot as plt
x = np.linspace(0, 10, 200)
fig, ax = plt.subplots(figsize=(6, 3.6))
ax.plot(x, np.sin(x) * np.exp(-x/5), color=S.C["cyan"], linewidth=1.8)
S.style_axes(ax, ylabel="幅值", xlabel="时间")
S.save(fig, os.path.join(r"%s", "figures", "trial"))
print("saved")
''' % (STYLE, WS)

SPEC = {
    "title": "水印测试论文",
    "sections": [
        {"heading": "一、问题重述", "blocks": [{"type": "p", "text": "这是一段测试正文。"}]}
    ],
}


def run(code, env_extra):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(env_extra)
    r = subprocess.run([APP_PY, "-c", code], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=env, timeout=180)
    return r


def check_docx_watermark(path):
    """解压 docx，在 header XML 里找水印文本"""
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if "header" in n and n.endswith(".xml"):
                xml = z.read(n).decode("utf-8", "replace")
                if "体验版" in xml:
                    return True, n
    return False, None


print("=== ① 图表水印 ===")
r = run(PLOT, {"MCM_TRIAL": "1"})
print("  绘图:", r.stdout.strip() or r.stderr.strip()[:120])
trial_png = os.path.join(WS, "figures", "trial.png")
print("  体验版 PNG 存在:", os.path.exists(trial_png))

r2 = run(PLOT.replace('"trial"', '"paid"'), {})
paid_png = os.path.join(WS, "figures", "paid.png")
print("  正式版 PNG 存在:", os.path.exists(paid_png))

print()
print("=== ② 论文水印 ===")
spec_path = os.path.join(WS, "spec.json")
import json
json.dump(SPEC, open(spec_path, "w", encoding="utf-8"), ensure_ascii=False)

for tag, env in (("trial", {"MCM_TRIAL": "1"}), ("paid", {})):
    out = os.path.join(WS, "论文-%s.docx" % tag)
    r = subprocess.run([APP_PY, DOCX, "build", out, "--spec", spec_path],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", env={**os.environ, **env}, timeout=180)
    has, where = check_docx_watermark(out) if os.path.exists(out) else (False, None)
    print("  %-6s 生成成功=%-5s 页眉含水印=%s %s"
          % (tag, os.path.exists(out), has, ("(" + where + ")") if where else ""))
    if not os.path.exists(out):
        print("       stderr:", (r.stderr or "")[:200])

print()
print("=== ③ 环境变量能改水印文案 ===")
r = run(PLOT.replace('"trial"', '"custom"'), {"MCM_TRIAL": "1", "MCM_WATERMARK": "自定义水印ABC"})
print("  自定义水印绘图:", r.stdout.strip() or r.stderr.strip()[:120])

print()
print("  产物目录:", WS)
