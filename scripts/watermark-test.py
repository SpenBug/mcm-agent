"""验证体验版水印真的进了产出文件。

⚠️ 关键：不能只验"函数被调用了"，要验**文件里真的有水印**：
  - 图表：把 PNG 读回像素，确认右下角那块**不是纯白**（有东西画上去）
  - 论文：解压 docx，在页眉 XML 里找水印文本，并确认 media/ 里真有 logo 图
  - 正式版：同样的产出**必须没有水印**

退出码非零 = 有断言没过。以前这个脚本只 print 不判成败，也没挂进 npm test，
于是水印路径写死、Python 环境路径失效都没人发现 —— 这次一并修掉。
"""
import os
import subprocess
import sys
import tempfile
import zipfile

APP_PY = None
# 从本文件位置推仓库根，别写死绝对路径（体检报告点过：4 个 dev 脚本写死了
# D:\数学建模项目\mcm-agent，换机器/换盘就全废）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STYLE = os.path.join(ROOT, "resources", "skills", "mcm-figure", "scripts")
DOCX = os.path.join(ROOT, "resources", "skills", "mcm-tools", "scripts", "mcm_docx.py")
BRAND = os.path.join(ROOT, "resources", "brand")
WMARK_LOGO = os.path.join(BRAND, "wmark-logo.png")


def find_python():
    r"""找应用私有 Python 环境。

    ⚠️ 原来这里写死 `阿一古数模\python-env`，但品牌改名后 userData 迁移逻辑
    会让应用继续沿用旧名目录（见 paths.js 的 shouldMigrate），所以真实环境在
    `数模工坊\python-env` —— 写死的路径直接 FileNotFoundError。
    而且这个测试没挂进 npm test，烂了也没人发现（孤儿测试）。
    现在按候选顺序找，并在都找不到时明确报错，不再假装通过。

    本函数用 raw docstring：上面的 `\p` 这类反斜杠在普通字符串里
    于 Python 3.12+ 会报 SyntaxWarning: invalid escape sequence。
    （别在文档里写出 raw 前缀那三个引号本身 —— 会提前闭合 docstring，
    本轮真实踩过：报的是 SyntaxError: invalid character '：'，
    错误位置离病行很远，看着像中文字符出问题。）
    """
    appdata = os.environ.get("APPDATA", "")
    cands = [
        os.path.join(appdata, app, "python-env", "Scripts", "python.exe")
        for app in ("阿一古数模", "数模工坊")
    ]
    for p in cands:
        if os.path.isfile(p):
            return p
    return None


APP_PY = find_python()

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
    """解压 docx，看水印痕迹。

    返回 (has_text, where, has_logo, has_vml, legacy)
      has_text 页眉 XML 里有没有「体验版」字样
      where    命中的是哪个 header 文件
      has_logo word/media/ 里有没有内嵌图（logo 走这里）
      has_vml  有没有 VML textpath（对角淡字水印的载体）
      legacy   命中的旧品牌词（水印是免费用户替我们打广告的地方，绝不能错品牌）
    """
    has_text, where, has_logo, has_vml, legacy = False, None, False, False, []
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if "header" in n and n.endswith(".xml"):
                xml = z.read(n).decode("utf-8", "replace")
                if "体验版" in xml:
                    has_text, where = True, n
                if "textpath" in xml.lower():
                    has_vml = True
            if n.startswith("word/media/") and n.lower().endswith(".png"):
                has_logo = True
        # 全文档扫旧品牌：水印文案、页脚、版权行都算
        blob = "".join(z.read(n).decode("utf-8", "replace")
                       for n in z.namelist() if n.endswith(".xml"))
        legacy = [b for b in ("汉谟拉比", "数模工坊") if b in blob]
    return has_text, where, has_logo, has_vml, legacy


def corner_inked(png_path, y_from=0.93, x_from=0.50):
    """右下角区域内非白像素占比。

    ⚠️ 不能只判"文件存在"或"函数被调用"：水印是在 savefig 前画到 fig 上的，
    万一 logo 路径解析失败、或坐标算错画到画布外，文件照样生成、函数照样返回，
    但图是干净的。只有回读像素才能证明水印**真的在里面**。

    y_from=0.93 是刻意选的：水印文字基线在 fig 的 y≈0.008（PIL 坐标 ≈0.992h），
    logo 占 y_fig 0.012~0.067（PIL ≈0.933~0.988）；而 x 刻度标签在 axes 底部
    （PIL ≈0.89h）。取 0.93 能把水印框住、同时避开刻度，
    否则正式版会因为刻度被判成"有水印"（假失败）。
    """
    from PIL import Image
    im = Image.open(png_path).convert("RGB")
    w, h = im.size
    px = list(im.crop((int(w * x_from), int(h * y_from), w, h)).getdata())
    if not px:
        return 0.0
    nonwhite = sum(1 for (r, g, b) in px if r < 245 or g < 245 or b < 245)
    return nonwhite / len(px)


def diff_in_corner(a_png, b_png, y_from=0.93, x_from=0.50):
    """两张图在右下角区域的差异像素占比。

    比"绝对白底阈值"更可靠：正式版与体验版是**同一份绘图代码**出的，
    唯一差别就该是水印。直接比像素差，不用猜刻度标签会不会落进取样框。
    """
    from PIL import Image
    ia = Image.open(a_png).convert("RGB")
    ib = Image.open(b_png).convert("RGB")
    if ia.size != ib.size:
        return -1.0
    w, h = ia.size
    box = (int(w * x_from), int(h * y_from), w, h)
    pa = list(ia.crop(box).getdata())
    pb = list(ib.crop(box).getdata())
    if not pa:
        return 0.0
    diff = sum(1 for x, y in zip(pa, pb) if x != y)
    return diff / len(pa)


FAILS = []


def check(name, ok, extra=""):
    print("  %s %s%s" % ("✓" if ok else "✗", name, ("  [%s]" % extra) if extra else ""))
    if not ok:
        FAILS.append(name)


if not APP_PY:
    print("✗ 找不到应用私有 Python 环境（%APPDATA%\\{阿一古数模,数模工坊}\\python-env）")
    print("  先在软件里装一次 Python 环境，或设 MCM_PY 环境变量指向可用的 python.exe")
    sys.exit(1)
if os.environ.get("MCM_PY"):
    APP_PY = os.environ["MCM_PY"]
print("python = %s" % APP_PY)
print("logo   = %s (%s)" % (WMARK_LOGO, "有" if os.path.isfile(WMARK_LOGO) else "缺失"))

print()
print("=== ① 图表水印 ===")
if not os.path.isfile(WMARK_LOGO):
    print("  ✗ 水印 logo 不存在 —— 跑 npm run brand:wmark 生成")
    FAILS.append("logo 缺失")
else:
    r = run(PLOT, {"MCM_TRIAL": "1", "MCM_BRAND_DIR": BRAND})
    trial_png = os.path.join(WS, "figures", "trial.png")
    check("体验版出图成功", os.path.exists(trial_png), (r.stderr or "").strip()[:120])

    r2 = run(PLOT.replace('"trial"', '"paid"'), {"MCM_BRAND_DIR": BRAND})
    paid_png = os.path.join(WS, "figures", "paid.png")
    check("正式版出图成功", os.path.exists(paid_png), (r2.stderr or "").strip()[:120])

    if os.path.exists(trial_png) and os.path.exists(paid_png):
        ink = corner_inked(trial_png)
        check("体验版图右下角有水印", ink > 0.01, "非白像素 %.1f%%" % (ink * 100))
        # 主判据：同一段绘图代码，体验版与正式版在右下角**必须不一样**
        d = diff_in_corner(trial_png, paid_png)
        check("正式版与体验版右下角不同（水印只进体验版）", d > 0.005,
              "差异像素 %.2f%%" % (d * 100) if d >= 0 else "尺寸不一致")
        ink_paid = corner_inked(paid_png)
        check("正式版右下角干净（无水印）", ink_paid < 0.01, "非白像素 %.2f%%" % (ink_paid * 100))

    # logo 找不到时必须退化成"只打文字"，不能整个出图失败
    r3 = run(PLOT.replace('"trial"', '"nologo"'), {"MCM_TRIAL": "1", "MCM_BRAND_DIR": WS})
    nologo_png = os.path.join(WS, "figures", "nologo.png")
    check("logo 缺失时仍能出图（退化成文字水印）", os.path.exists(nologo_png),
          (r3.stderr or "").strip()[:120])
    if os.path.exists(nologo_png) and os.path.exists(trial_png):
        check("退化版右下角仍有水印", corner_inked(nologo_png) > 0.01,
              "非白像素 %.1f%%" % (corner_inked(nologo_png) * 100))

print()
print("=== ② 论文水印 ===")
spec_path = os.path.join(WS, "spec.json")
import json
json.dump(SPEC, open(spec_path, "w", encoding="utf-8"), ensure_ascii=False)

for tag, env, expect in (("trial", {"MCM_TRIAL": "1", "MCM_BRAND_DIR": BRAND}, True),
                         ("paid", {"MCM_BRAND_DIR": BRAND}, False)):
    label = "体验版" if expect else "正式版"
    out = os.path.join(WS, "论文-%s.docx" % tag)
    r = subprocess.run([APP_PY, DOCX, "build", out, "--spec", spec_path],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", env={**os.environ, **env}, timeout=180)
    if not os.path.exists(out):
        check("%s生成 docx" % label, False, (r.stderr or "")[:160])
        continue
    has, where, has_logo, has_vml, legacy = check_docx_watermark(out)
    # ⚠️ 断言名必须与**实际断言的内容**一致。上一版写成
    #   「%s 版页眉含水印文字」，判据是 has == expect，
    #   于是正式版通过时打印的是「正式版页眉含水印文字 ✓」——
    #   绿灯配一句假话，读输出的人会以为付费论文带水印（实测付费版连 header1.xml 都没有）。
    if expect:
        check("体验版页眉含水印文字", has, ("在 " + where) if where else "没找到")
        check("体验版有对角 VML 水印（防删）", has_vml)
        check("体验版论文内嵌了 logo 图", has_logo)
    else:
        check("正式版页眉不含水印文字", not has,
              "泄漏自 %s" % where if has else "")
        # 实测：正式版根本不生成 header1.xml，所以这两条现在恒真；
        # 留着是因为将来若给正式版加页眉/页脚，logo 会跟着漏进去 —— 那是付费用户的产出。
        check("正式版不内嵌 logo 图", not has_logo,
              "付费用户的论文里出现了体验版 logo" if has_logo else "")
        check("正式版无 VML 水印", not has_vml,
              "正式版带上了对角水印" if has_vml else "")
    check("%s正文无旧品牌残留" % label, not legacy,
          "发现 %s" % "、".join(legacy) if legacy else "")

print()
print("=== ③ 环境变量能改水印文案 ===")
r = run(PLOT.replace('"trial"', '"custom"'),
        {"MCM_TRIAL": "1", "MCM_BRAND_DIR": BRAND, "MCM_WATERMARK": "自定义水印ABC"})
check("自定义文案时仍能出图", os.path.exists(os.path.join(WS, "figures", "custom.png")),
      (r.stderr or "").strip()[:120])
# 文案真的取自环境变量。
# ⚠️ 必须在 import **之前**把变量设进本进程的环境：
#    WATERMARK 是模块级求值的，而前面那次 run() 只给子进程设了 MCM_WATERMARK，
#    父进程环境里根本没有 —— 上一版就是因此误报"没生效"（拿到的是默认文案）。
os.environ["MCM_WATERMARK"] = "自定义水印ABC"
sys.path.insert(0, STYLE)
try:
    import mcm_style
    check("水印文案取自 MCM_WATERMARK",
          mcm_style.WATERMARK == "自定义水印ABC", mcm_style.WATERMARK)
except Exception as e:
    check("水印文案取自 MCM_WATERMARK", False, str(e))
finally:
    del os.environ["MCM_WATERMARK"]

print()
print("  产物目录:", WS)
if FAILS:
    print("\n✗ %d 项未通过：%s" % (len(FAILS), "、".join(FAILS)))
    sys.exit(1)
print("\n✓ 水印全部验证通过")
