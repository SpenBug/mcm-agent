#!/usr/bin/env python3
"""step-zones：step 分区流程图（step1…stepN 彩色虚线圆角分区横排）。

    python3 step_zones.py content.json -o out.drawio
    python3 step_zones.py content.json --check

复刻自"step 三段"流程图：每个分区一条彩色圆角虚线框 + 框顶同色 step 标题，
内部为流程小盒行（行间细灰下箭头，可标 emph 实色强调盒）；
分区之间用蓝白粗块箭头推进。
"""
import argparse
import base64
import html
import json
import pathlib
import sys
import unicodedata

W = 1080
M, TOP = 20, 20
ZGAP = 58                 # 分区横向间距（留块箭头）
PAD = 12
TITLE_H = 22
ROW_H = 28
ROW_GAP = 14
FS, FS_T = 12, 15
FONT = 'SimSun'                            # 统一宋体
INK = '#262626'
ARROW_GRAY = '#8a8a8a'
BIG_ARROW = '#3f7fb0'
# 分区循环配色：(框线/标题/强调底, 盒浅底) —— 取参考图实测值
ACCENTS = [                    # 配色卡5：橙红 + 琥珀
    ('#e87040', '#fbe8dc'),   # step1 橙
    ('#f0a048', '#fdf1de'),   # step2 琥珀
    ('#c01038', '#f8dcde'),   # step3 绛红
    ('#e87040', '#f9e4d6'),   # step4 橙（循环）
]

cells, problems = [], []


def esc(t):
    return html.escape(str(t), quote=True)


def tw(line, fs=FS):
    return sum(fs if unicodedata.east_asian_width(c) in ('W', 'F') else fs / 2
               for c in line)


def lines_of(v):
    return [str(x) for x in v] if isinstance(v, (list, tuple)) else str(v).split('\n')


def fit(cid, ls, w, h, fs=FS):
    for ln in ls:
        usable = w - 8
        if tw(ln, fs) > usable:
            problems.append(f'{cid}: "{ln}" 宽 {tw(ln, fs):.0f}px > 可用 {usable:.0f}px'
                            f'（约 {int(usable // fs)} 个汉字）')
    if len(ls) * (fs + 3) > h:
        problems.append(f'{cid}: {len(ls)} 行需 {len(ls) * (fs + 3)}px，槽高仅 {h:g}px')


def mk(ls):
    return '&lt;br&gt;'.join(esc(l) for l in ls)


ICON_DIR = pathlib.Path(__file__).resolve().parents[1] / 'assets' / 'icons' / 'tabler' / 'outline'


def icon(cid, name, x, y, s=22, color=INK):
    data = (ICON_DIR / f'{name}.svg').read_bytes()
    svg = data[data.index(b'<svg'):].replace(b'currentColor', color.encode())
    uri = 'data:image/svg+xml,' + base64.b64encode(svg).decode()
    raw(cid, x, y, s, s, f'shape=image;html=1;imageAspect=1;image={uri};')


def raw(cid, x, y, w, h, style, val=''):
    cells.append(f'        <mxCell id="{cid}" value="{val}" style="{style}" vertex="1" parent="1">\n'
                 f'          <mxGeometry x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}"'
                 f' as="geometry" />\n        </mxCell>')


def box(cid, x, y, w, h, text, fill, stroke, fs=FS, fc=INK, bold=0):
    ls = lines_of(text)
    fit(cid, ls, w, h, fs)
    raw(cid, x, y, w, h,
        f'rounded=0;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};'
        f'strokeWidth=1.2;fontSize={fs};fontStyle={bold};fontColor={fc};fontFamily={FONT};'
        f'align=center;verticalAlign=middle;spacingLeft=2;spacingRight=2;', mk(ls))


def text_label(cid, x, y, w, h, s, color, fs, bold=1):
    raw(cid, x, y, w, h,
        f'text;html=1;align=center;verticalAlign=middle;fontSize={fs};'
        f'fontStyle={bold};fontColor={color};fontFamily={FONT};', esc(s))


def edge(cid, pts, stroke=INK, width=1.6, end='block'):
    (sx, sy), (tx, ty) = pts[0], pts[-1]
    cells.append(
        f'        <mxCell id="{cid}" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=0;'
        f'html=1;endArrow={end};endFill=1;endSize=5;startArrow=none;'
        f'strokeColor={stroke};strokeWidth={width};" edge="1" parent="1">\n'
        f'          <mxGeometry relative="1" as="geometry">\n'
        f'            <mxPoint x="{sx:g}" y="{sy:g}" as="sourcePoint" />\n'
        f'            <mxPoint x="{tx:g}" y="{ty:g}" as="targetPoint" />\n'
        f'          </mxGeometry>\n        </mxCell>')


def slots(a, b, n, gap):
    size = (b - a - (n - 1) * gap) / n
    if size < 80:
        problems.append(f'一行 {n} 个盒过挤（每盒仅 {size:.0f}px，至少 80px）')
    return [(a + i * (size + gap), size) for i in range(n)]


def zone_h(z):
    n = len(z.get('rows', []))
    return 8 + TITLE_H + 10 + n * ROW_H + (n - 1) * ROW_GAP + 10


def build(c):
    zones = c['zones']
    if not 2 <= len(zones) <= 4:
        sys.exit(f'zones 数量 {len(zones)} 越界（允许 2–4）')
    for z in zones:
        for row in z.get('rows', []):
            if len(row) > 3:
                sys.exit(f'分区「{z["title"]}」一行 {len(row)} 个盒越界（允许 1–3）')
    zw = (W - 2 * M - (len(zones) - 1) * ZGAP) / len(zones)
    if zw < 240:
        problems.append(f'分区宽仅 {zw:.0f}px（至少 240px，请减少分区数）')
    hs = [zone_h(z) for z in zones]
    H = int(TOP + max(hs) + M)

    for zi, (z, zh) in enumerate(zip(zones, hs)):
        zx = M + zi * (zw + ZGAP)
        stk, light = ACCENTS[zi % len(ACCENTS)]
        raw(f'z{zi}', zx, TOP, zw, zh,
            f'rounded=0;html=1;fillColor=none;strokeColor={stk};'
            f'strokeWidth=1.5;dashed=1;dashPattern=8 6;')
        if z.get('icon'):
            icon(f'z{zi}_ic', z['icon'], zx + 14, TOP + 5, 22, stk)
        text_label(f'z{zi}_t', zx + 40, TOP + 6, zw - 50, TITLE_H, z['title'], stk, FS_T)
        yy = TOP + 6 + TITLE_H + 10
        prev_bottom = None
        for ri, row in enumerate(z.get('rows', [])):
            cells_r = slots(zx + PAD, zx + zw - PAD, len(row), 10)
            for ci, it in enumerate(row):
                emph = isinstance(it, dict) and it.get('emph')
                text = it['text'] if isinstance(it, dict) else it
                cx, cw = cells_r[ci]
                box(f'z{zi}r{ri}c{ci}', cx, yy, cw, ROW_H, text,
                    stk if emph else light, stk, fc='#ffffff' if emph else INK,
                    bold=1 if emph else 0)
            if ri and prev_bottom is not None:
                edge(f'z{zi}da{ri}', [(zx + zw / 2, prev_bottom + 1),
                                      (zx + zw / 2, yy - 1)], ARROW_GRAY, 1.4)
            prev_bottom = yy + ROW_H
            yy += ROW_H + ROW_GAP
        if zi < len(zones) - 1:
            raw(f'z{zi}_ba', zx + zw + 8, TOP + max(hs) / 2 - 11, ZGAP - 16, 22,
                f'shape=singleArrow;direction=east;arrowWidth=0.55;arrowSize=0.4;html=1;'
                f'fillColor={BIG_ARROW};strokeColor=none;')
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('content')
    ap.add_argument('-o', '--out')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    c = json.loads(pathlib.Path(a.content).read_text(encoding='utf-8'))
    H = build(c)
    if problems:
        print(f'✗ 容量检查未通过（{len(problems)} 处）：', file=sys.stderr)
        for p in problems:
            print('  - ' + p, file=sys.stderr)
        sys.exit(2)
    print(f'✓ 容量检查通过（画布 {W}×{H}）')
    if a.check:
        return
    out = pathlib.Path(a.out or pathlib.Path(a.content).with_suffix('.drawio'))
    out.write_text(
        '<mxfile host="app.diagrams.net" agent="scibox-diagram" version="24.7.17" pages="1">\n'
        '  <diagram id="stepzones" name="step分区流程图">\n'
        f'    <mxGraphModel dx="{W}" dy="{H}" grid="0" gridSize="10" guides="1" tooltips="1" '
        f'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" '
        'math="0" shadow="0">\n      <root>\n        <mxCell id="0" />\n'
        '        <mxCell id="1" parent="0" />\n' + '\n'.join(cells) +
        '\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n', encoding='utf-8')
    print(f'✓ 已写出 {out}（{len(cells)} 个图元）')


if __name__ == '__main__':
    main()
