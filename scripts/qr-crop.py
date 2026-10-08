"""重裁两张二维码 —— **不缩放**。

⚠️ 教训：上一版裁完 resize 到 600x600。
微信码是 678→600（缩小），Lanczos 插值把模块边缘糊掉，**原图能解、裁后解不出**。
收款码是 586→600（放大），放大不糊，所以侥幸没事。

**二维码是二值图，缩放必然引入灰度过渡，模块边界一糊就解不出来。**
正确做法：裁完直接存，保持原始像素。

顺带把「裁完必须能解码」做成脚本内的断言，以后不会再犯。
"""
import os
import subprocess
import sys

from PIL import Image

ROOT = r"D:\数学建模项目\mcm-agent"
NODE = r"C:\Users\92182\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe"
NODE_MODULES = r"C:\Users\92182\.workbuddy-ai\binaries\node\workspace\node_modules"

JOBS = [
    # (源图, 输出, 标签, 扫描区域比例, 阈值)
    (r"C:\Users\92182\.workbuddy-ai\clipboard-images\clipboard-2026-10-07T13-35-34-519Z-bf2d0ecf.jpg",
     os.path.join(ROOT, "resources", "brand", "wechat-qr.png"), "微信加好友码",
     (0.08, 0.92, 0.20, 0.85), 110),
    (r"C:\Users\92182\.workbuddy-ai\blobs\87\87bea5f504100e180f489933dbf8a492de2ed309cfd8d866e352cfecb8ac0a63.jpg",
     os.path.join(ROOT, "resources", "brand", "pay-qr.png"), "收款码",
     (0.10, 0.90, 0.15, 0.82), 90),
]


def crop_qr(src, out, rx0, rx1, ry0, ry1, threshold):
    im = Image.open(src)
    gray = im.convert("L")
    w, h = gray.size
    px = gray.load()

    minx, miny, maxx, maxy = w, h, 0, 0
    for y in range(int(h * ry0), int(h * ry1)):
        for x in range(int(w * rx0), int(w * rx1)):
            if px[x, y] < threshold:
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)

    bw, bh = maxx - minx, maxy - miny
    # 边长取**宽度** —— 二维码下方的文字只会撑高，不会撑宽
    side = bw
    pad = int(side * 0.06)
    box = (minx - pad, miny - pad, minx - pad + side + pad * 2, miny - pad + side + pad * 2)
    box = (max(0, box[0]), max(0, box[1]), min(w, box[2]), min(h, box[3]))

    crop = im.crop(box)          # ⚠️ 不 resize
    crop.save(out, "PNG")
    return crop.size, (bw, bh)


def can_decode(path):
    """用 **zxing** 真解一遍。

    ⚠️ 别用 jsQR —— 实测它在微信个人码上会给**假阴性**：
       同一个码，jsQR 报"解不出"，zxing 正常解出。
       而且 jsQR 的结果**非单调**（裁到 1200 高解不出、更小的 1100 反而能解），
       这种自相矛盾就说明是解码器的问题，不是图的问题。
    zxing 是 Google 的成熟实现，和微信扫码器同类算法，判得更准。
    """
    code = (
        "const fs=require('fs');const {PNG}=require('pngjs');"
        "const {MultiFormatReader,BarcodeFormat,DecodeHintType,RGBLuminanceSource,BinaryBitmap,HybridBinarizer}=require('@zxing/library');"
        "const p=PNG.sync.read(fs.readFileSync(process.argv[1]));"
        "const l=new Uint8ClampedArray(p.width*p.height);"
        "for(let i=0;i<l.length;i++){const r=p.data[i*4],g=p.data[i*4+1],b=p.data[i*4+2];l[i]=(r*299+g*587+b*114)/1000;}"
        "const h=new Map();h.set(DecodeHintType.POSSIBLE_FORMATS,[BarcodeFormat.QR_CODE]);h.set(DecodeHintType.TRY_HARDER,true);"
        "const rd=new MultiFormatReader();rd.setHints(h);"
        "try{const r=rd.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(l,p.width,p.height))));"
        "console.log('OK '+r.getText());}catch(e){console.log('FAIL '+e.constructor.name);}"
    )
    env = dict(os.environ, NODE_PATH=NODE_MODULES)
    r = subprocess.run([NODE, "-e", code, path], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=env, timeout=120)
    out = (r.stdout or "").strip()
    return (True, out[3:]) if out.startswith("OK ") else (False, out)


ok = 0
for src, out, label, (rx0, rx1, ry0, ry1), th in JOBS:
    size, (bw, bh) = crop_qr(src, out, rx0, rx1, ry0, ry1, th)
    good, detail = can_decode(out)
    print("  %-12s 裁后 %dx%d（原检测 %dx%d）  %s"
          % (label, size[0], size[1], bw, bh, "✓ 可扫" if good else "✗ 解不出"))
    if good:
        print("      " + detail[:100])
        ok += 1
    else:
        print("      " + detail[:100])

print()
print("  %d/%d 可扫" % (ok, len(JOBS)))
sys.exit(0 if ok == len(JOBS) else 1)
