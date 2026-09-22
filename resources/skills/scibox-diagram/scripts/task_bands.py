#!/usr/bin/env python3
"""task-bands：任务带技术路线图（任务一…任务N 纵向条带）。

    python3 task_bands.py content.json -o out.drawio
    python3 task_bands.py content.json --check

复刻自"任务一带状"技术路线图：每条带左侧橙红竖排任务签、右侧红边竖排阶段签，
带内若干蓝虚线子区并排（子区标题 + 内部流程小盒行，行间细下箭头），
带与带之间用黑色粗箭头推进。
"""
import argparse
import base64
import html
import json
import pathlib
import sys
import unicodedata

W = 1080
M = 20
TASK_X, TASK_W = 20, 56                    # 左侧橙红任务签
STAGE_W = 76
STAGE_X = W - M - STAGE_W                  # 右侧阶段签
ZX0, ZX1 = TASK_X + TASK_W + 14, STAGE_X - 14   # 子区可用区间
FS, FS_SUB, FS_V = 12, 13, 14
FONT = 'SimSun'                            # 统一宋体
INK = '#262626'
TASK_FILL, TASK_STK = '#e07058', '#c05038'   # 珊瑚红：任务/阶段签填充（原图一致）
SUB_STK = '#4a7fb8'                          # 子区：钢蓝虚线圆角框（原图）
SUB_TITLE = '#2f5fa8'                        # 子区标题：深蓝居中（原图）
BOX_FILL, BOX_STK = '#f5c9a4', '#d08040'     # 流程盒：橙沙填充+深橙边（原图）
ARROW_GRAY = '#333333'                       # 盒间箭头：细黑线（原图）
BAND_STK = '#e07058'                         # 条带外框：珊瑚红实线（原图）
BLACK = '#262626'

cells, problems = [], []


def esc(t):
    return html.escape(str(t), quote=True)


def tw(line, fs=FS):
    return sum(fs if unicodedata.east_asian_width(c) in ('W', 'F') else fs / 2
               for c in line)


def lines_of(v):
    if v is None:
        return ['']
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


def icon(cid, name, x, y, s=22, color=SUB_TITLE):
    data = (ICON_DIR / f'{name}.svg').read_bytes()
    svg = data[data.index(b'<svg'):].replace(b'currentColor', color.encode())
    uri = 'data:image/svg+xml,' + base64.b64encode(svg).decode()
    raw(cid, x, y, s, s, f'shape=image;html=1;imageAspect=1;image={uri};')


def raw(cid, x, y, w, h, style, val=''):
    cells.append(f'        <mxCell id="{cid}" value="{val}" style="{style}" vertex="1" parent="1">\n'
                 f'          <mxGeometry x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}"'
                 f' as="geometry" />\n        </mxCell>')


def box(cid, x, y, w, h, text, fill, stroke, fs=FS, fc=INK, bold=1):
    ls = lines_of(text)
    fit(cid, ls, w, h, fs)
    raw(cid, x, y, w, h,
        f'rounded=1;arcSize=8;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};'
        f'strokeWidth=1.2;fontSize={fs};fontStyle={bold};fontColor={fc};fontFamily={FONT};'
        f'align=center;verticalAlign=middle;spacingLeft=2;spacingRight=2;', mk(ls))


def vbox(cid, x, y, w, h, text, fill, stroke, fs=FS_V, fc='#ffffff'):
    chars = list(str(text))
    if len(chars) * (fs + 4) > h:
        problems.append(f'{cid}: 竖排 {len(chars)} 字需 {len(chars) * (fs + 4)}px > 槽高 {h:g}px')
    raw(cid, x, y, w, h,
        f'rounded=0;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};'
        f'strokeWidth=2;fontSize={fs};fontStyle=1;fontColor={fc};fontFamily={FONT};'
        f'align=center;verticalAlign=middle;', '&lt;br&gt;'.join(esc(c) for c in chars))


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


def dashframe(cid, x, y, w, h, color=SUB_STK, pattern='8 6'):
    raw(cid, x, y, w, h, f'rounded=1;arcSize=6;html=1;fillColor=none;strokeColor={color};'
                         f'strokeWidth=1.5;dashed=1;dashPattern={pattern};')


def slots(a, b, n, gap):
    size = (b - a - (n - 1) * gap) / n
    if size < 120:
        problems.append(f'{n} 个子区过挤（每区仅 {size:.0f}px，至少 120px）')
    return [(a + i * (size + gap), size) for i in range(n)]


def sub_h(sub):
    n = len(sub.get('rows', []))
    return 10 + 26 + 8 + n * 28 + (n - 1) * 14 + 12


def build(c):
    bands = c['bands']
    if not 2 <= len(bands) <= 5:
        sys.exit(f'bands 数量 {len(bands)} 越界（允许 2–5）')
    for b in bands:
        if not 1 <= len(b['subs']) <= 4:
            sys.exit(f"带「{b.get('task')}」子区数 {len(b['subs'])} 越界（允许 1–4）")
    sub_hs = [[sub_h(s) for s in b['subs']] for b in bands]
    band_hs = [max(shs) for shs in sub_hs]
    GAP = 46
    H = int(M + sum(band_hs) + GAP * (len(bands) - 1) + M)

    y = M
    for bi, (b, bh) in enumerate(zip(bands, band_hs)):
        # 条带外框：珊瑚红实线（原图）。画成闭合折线，避免实线框被判碰撞
        edge(f'b{bi}_bd', [(TASK_X, y), (W - TASK_X, y), (W - TASK_X, y + bh),
                           (TASK_X, y + bh), (TASK_X, y)], BAND_STK, 2, 'none')
        vbox(f'b{bi}_task', TASK_X + 1, y + 1, TASK_W - 2, bh - 2,
             b['task'], TASK_FILL, TASK_STK)
        vbox(f'b{bi}_stage', STAGE_X + 1, y + 1, STAGE_W - 2, bh - 2,
             b['stage'], TASK_FILL, TASK_STK, fs=13, fc='#ffffff')
        ws = [s.get('w', 1) for s in b['subs']]     # 子区可带 w 权重，默认等分
        tot = sum(ws)
        avail = ZX1 - ZX0 - 18 * (len(ws) - 1)
        cx = ZX0
        xw = []
        for wgt in ws:
            wd = avail * wgt / tot
            xw.append((cx, wd))
            cx += wd + 18
        for si, (sub, sh) in enumerate(zip(b['subs'], sub_hs[bi])):
            sx, sw = xw[si]
            dashframe(f'b{bi}s{si}', sx, y, sw, sh)
            t = sub['title']
            if tw(t, FS_SUB) > sw - 16:
                problems.append(f'b{bi}s{si}.title: "{t}" ≤{int((sw - 16) // FS_SUB)} 汉字')
            raw(f'b{bi}s{si}_t', sx + 40, y + 5, sw - 50, 26,
                f'text;html=1;align=center;verticalAlign=middle;fontSize={FS_SUB};'
                f'fontStyle=1;fontColor={SUB_TITLE};fontFamily={FONT};', esc(t))
            if sub.get('icon'):
                icon(f'b{bi}s{si}_ic', sub['icon'], sx + 12, y + 8, 22, SUB_TITLE)
            yy = y + 5 + 26 + 8
            prev_bottom = None
            for ri, row in enumerate(sub['rows']):
                cells_r = slots2(sx + 10, sx + sw - 10, len(row))
                for ci, it in enumerate(row):
                    cx, cw = cells_r[ci]
                    box(f'b{bi}s{si}r{ri}c{ci}', cx, yy, cw, 28, it, BOX_FILL, BOX_STK)
                if ri and prev_bottom is not None:
                    edge(f'b{bi}s{si}da{ri}', [(sx + sw / 2, prev_bottom + 1),
                                               (sx + sw / 2, yy - 1)], ARROW_GRAY, 1.4)
                prev_bottom = yy + 28
                yy += 28 + 14
        if bi < len(bands) - 1:
            y0 = y + bh + 4
            y1 = y + bh + GAP - 6
            raw(f'b{bi}_ga', W * 0.46 - 15, y0, 30, y1 - y0,
                f'shape=singleArrow;direction=south;arrowWidth=0.5;arrowSize=0.3;html=1;'
                f'fillColor={BLACK};strokeColor=none;')
        y += bh + GAP
    return H


def slots2(a, b, n):
    gap = 10
    size = (b - a - (n - 1) * gap) / n
    if size < 60:
        problems.append(f'子区内一行 {n} 个盒过挤（每盒仅 {size:.0f}px，至少 60px）')
    return [(a + i * (size + gap), size) for i in range(n)]


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
        '  <diagram id="taskbands" name="任务带技术路线图">\n'
        f'    <mxGraphModel dx="{W}" dy="{H}" grid="0" gridSize="10" guides="1" tooltips="1" '
        f'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" '
        'math="0" shadow="0">\n      <root>\n        <mxCell id="0" />\n'
        '        <mxCell id="1" parent="0" />\n' + '\n'.join(cells) +
        '\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n', encoding='utf-8')
    print(f'✓ 已写出 {out}（{len(cells)} 个图元）')


if __name__ == '__main__':
    main()
