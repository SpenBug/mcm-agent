#!/usr/bin/env python3
"""export_figure.py — 把 .drawio 导成 1:1 PNG 与矢量 PDF，供肉眼自检和交付。

    python3 export_figure.py fig.drawio                 # 出 fig.png + fig.pdf
    python3 export_figure.py fig.drawio --png-only -s 2 # 只出 2 倍图，便于看细节

依赖 draw.io 桌面版命令行（macOS: brew install --cask drawio；命令名 drawio）。
没装时会给出替代方案，不静默失败。
"""
import argparse
import os
import pathlib
import re
import shutil
import subprocess
import sys


def find_drawio():
    """定位 draw.io 桌面版可执行文件。

    顺序：PATH → 常见安装目录 → Windows 开始菜单快捷方式。

    只查 PATH 是不够的 —— Windows 上大量用户把 draw.io 装在 D:\\Drawio\\ 这类
    PATH 之外的目录（安装器默认路径也不在 PATH 里）。
    """
    for name in ('drawio', 'draw.io'):
        p = shutil.which(name)
        if p:
            return p

    exe = 'draw.io.exe' if sys.platform == 'win32' else 'draw.io'
    bases = [os.environ.get('ProgramFiles'), os.environ.get('ProgramFiles(x86)')]
    if os.environ.get('LOCALAPPDATA'):
        bases.append(os.path.join(os.environ['LOCALAPPDATA'], 'Programs'))

    cands = []
    for b in bases:
        if b:
            cands.append(pathlib.Path(b) / 'draw.io' / exe)
    for drive in ('C:', 'D:', 'E:'):
        cands.append(pathlib.Path(drive + '\\') / 'Drawio' / 'draw.io' / exe)
        cands.append(pathlib.Path(drive + '\\') / 'draw.io' / exe)
    for c in cands:
        if c.exists():
            return str(c)

    # Windows：从开始菜单 .lnk 里挖路径（lnk 存明文路径，直接正则，不依赖 COM）
    if sys.platform == 'win32':
        dirs = [
            os.path.join(os.environ.get('ProgramData', ''), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
            os.path.join(os.environ.get('APPDATA', ''), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        ]
        for d in dirs:
            if not os.path.isdir(d):
                continue
            for f in os.listdir(d):
                if 'draw' not in f.lower() or not f.lower().endswith('.lnk'):
                    continue
                try:
                    raw = open(os.path.join(d, f), 'rb').read().decode('latin1')
                except OSError:
                    continue
                m = re.search(r'[A-Za-z]:\\[^\x00-\x1f"]*draw\.io\.exe', raw, re.I)
                if m and os.path.exists(m.group(0)):
                    return m.group(0)
    return None


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        print(p.stdout + p.stderr, file=sys.stderr)
    return p.returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('drawio')
    ap.add_argument('-s', '--scale', type=float, default=1, help='PNG 缩放，默认 1（1 单位=1 像素）')
    ap.add_argument('--png-only', action='store_true')
    ap.add_argument('--pdf-only', action='store_true')
    ap.add_argument('--no-gpu', action='store_true',
                    help='无 GPU 环境（虚拟机/远程桌面/容器）加软件渲染兜底开关')
    a = ap.parse_args()

    src = pathlib.Path(a.drawio)
    if not src.exists():
        sys.exit(f'找不到 {src}')
    cli = find_drawio()
    if not cli:
        sys.exit('未找到 draw.io 桌面版。\n'
                 '  macOS: brew install --cask drawio\n'
                 '  Windows: 从 https://github.com/jgraph/drawio-desktop/releases 安装（装完自动探测）\n'
                 '  或：用 diagrams.net 网页版打开 .drawio 后 File → Export as → PNG/PDF\n'
                 '  注意：没有渲染图就无法自检，不要跳过这一步。')

    # 用画布宽度锁定输出，保证 1 单位 = 1 像素；否则 drawio 会按内容包围盒另算，
    # 输出比画布大几像素，没法和参考图做逐像素比对
    m = re.search(r'pageWidth="([\d.]+)"', src.read_text(encoding='utf-8'))
    width = [f'--width', str(int(float(m.group(1)) * a.scale))] if m else []

    # ⚠️ 输入文件必须放在最前面。
    # drawio 用 commander 解析参数且开了 allowUnknownOption()，未知开关会被塞进
    # program.args —— 输入文件若放后面会被当成开关名，报 "input file/directory not found"
    # （其源码里只特殊过滤了 --no-sandbox 这一个）。
    # 把 src 提到最前，才能安全地追加 --disable-gpu 之类的兜底开关。
    head = [cli, str(src)]
    tail_flags = []
    if a.no_gpu:
        # 无 GPU 环境（虚拟机 / 远程桌面 / 容器）必须走软件渲染，否则 drawio 会直接崩
        tail_flags = ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu']

    ok = True
    if not a.pdf_only:
        png = src.with_suffix('.png')
        ok &= run([*head, *tail_flags, '-x', '-f', 'png', '-s', str(a.scale), '-b', '0',
                   *width, '-o', str(png)])
        if ok:
            print(f'✓ {png}')
    if not a.png_only:
        pdf = src.with_suffix('.pdf')
        ok &= run([*head, *tail_flags, '-x', '-f', 'pdf', '--crop', '-o', str(pdf)])
        if ok:
            print(f'✓ {pdf}')
    if not ok:
        sys.exit(1)
    print('接下来务必打开 PNG 逐块核对：文字有无溢出/压线、箭头方向、数值有没有抄错。')


if __name__ == '__main__':
    main()
