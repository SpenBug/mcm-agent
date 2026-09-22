#!/usr/bin/env python3
"""trihead-flow：三栏绿头流程图（绿实色标题栏 + 浅绿栏体 + 蓝系流程盒）。

    python3 trihead_flow.py content.json -o out.drawio
    python3 trihead_flow.py content.json --check

复刻自"任务思路流程图"：每栏顶部一条绿实色标题栏，栏体浅绿底；
栏内自上而下流程盒（蓝系三档深浅，粗蓝下箭头），支持
虚线橙框特征组（组标题 + 小盒阵列 + 两侧竖排标签）与底部图表占位；
栏与栏之间用黑色粗箭头推进。
"""
import argparse
import base64
import html
import json
import math
import pathlib
import sys
import unicodedata

W = 1080
TOP, M = 20, 20
HEAD_H = 36
COLGAP = 64
FS, FS_G, FS_H = 12, 11, 16
FONT = 'SimSun'                            # 统一宋体
INK = '#262626'
HEAD_FILL = '#387068'                       # 配色卡4：墨绿标题栏
BODY_FILL = '#f8f8f8'                       # 栏体白
TONE = {'deep': ('#407068', '#ffffff'), 'mid': ('#70b0a8', '#ffffff'),
        'light': ('#dbe8e2', INK)}
BOX_STK = '#387068'
ARROW = '#387068'
GRP_STK = '#d8a8a8'                         # 配色卡4：藕粉组虚线框
CHIP_FILL, CHIP_STK = '#f8f0d8', '#c8b078'  # 配色卡4：奶油组标题
SIDE_FILL, SIDE_STK = '#f8d8d8', '#c09090'  # 配色卡4：藕粉侧签
CHIP_FC = '#5a3a3a'

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


def icon(cid, name, x, y, s=22, color='#ffffff'):
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


def vbox(cid, x, y, w, h, text, fill, stroke, fs=FS_G, fc=CHIP_FC):
    chars = list(str(text))
    if len(chars) * (fs + 4) > h:
        problems.append(f'{cid}: 竖排 {len(chars)} 字需 {len(chars) * (fs + 4)}px > 槽高 {h:g}px')
    raw(cid, x, y, w, h,
        f'rounded=0;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};'
        f'strokeWidth=1.2;fontSize={fs};fontStyle=1;fontColor={fc};fontFamily={FONT};'
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


def slots(a, b, n, gap):
    size = (b - a - (n - 1) * gap) / n
    if size < 56:
        problems.append(f'一行 {n} 个盒过挤（每盒仅 {size:.0f}px，至少 56px）')
    return [(a + i * (size + gap), size) for i in range(n)]


def item_h(it):
    if isinstance(it, dict) and 'group' in it:
        g = it['group']
        rows = math.ceil(len(g['boxes']) / 3)
        return 8 + 24 + 8 + rows * 24 + (rows - 1) * 8 + 10
    if isinstance(it, dict) and 'chart' in it:
        return 64
    return 30


def draw_item(k, it, x, w, y, tone_i):
    if isinstance(it, dict) and 'group' in it:
        g = it['group']
        gh = item_h(it)
        raw(f'{k}_gf', x + 4, y + 2, w - 8, gh - 4,
            f'rounded=0;html=1;fillColor=none;strokeColor={GRP_STK};'
            f'strokeWidth=1.5;dashed=1;dashPattern=8 6;')
        box(f'{k}_gt', x + w * 0.24, y + 8, w * 0.52, 24, g['title'],
            CHIP_FILL, CHIP_STK, FS_G, CHIP_FC, bold=1)
        bx0, bx1 = x + 34, x + w - 34
        rows = math.ceil(len(g['boxes']) / 3)
        by = y + 8 + 24 + 8
        for ri in range(rows):
            row = g['boxes'][ri * 3:(ri + 1) * 3]
            for ci, (cx, cw) in enumerate(slots(bx0, bx1, len(row), 8)):
                box(f'{k}_gb{ri}{ci}', cx, by, cw, 24, row[ci], '#deebf7', BOX_STK, FS_G)
            by += 24 + 8
        if g.get('left'):
            vbox(f'{k}_gl', x + 6, y + 38, 24, gh - 44, g['left'], SIDE_FILL, SIDE_STK)
        if g.get('right'):
            vbox(f'{k}_gr', x + w - 30, y + 38, 24, gh - 44, g['right'], SIDE_FILL, SIDE_STK)
        return gh
    if isinstance(it, dict) and 'chart' in it:
        box(f'{k}_c', x, y, w, 64, it['chart'], '#ffffff', BOX_STK, FS_G, ARROW)
        cells[-1] = cells[-1].replace('rounded=0;', 'rounded=0;dashed=1;dashPattern=4 4;', 1)
        return 64
    tone = it.get('tone') if isinstance(it, dict) else None
    text = it['text'] if isinstance(it, dict) else it
    fill, fc = TONE[tone or ['mid', 'mid', 'light', 'light'][tone_i % 4]]
    box(k, x, y, w, 30, text, fill, BOX_STK, FS, fc)
    return 30


def build(c):
    cols = c['columns']
    if not 2 <= len(cols) <= 4:
        sys.exit(f'columns 数量 {len(cols)} 越界（允许 2–4）')
    col_w = (W - 2 * M - (len(cols) - 1) * COLGAP) / len(cols)
    body_top = TOP + HEAD_H
    bodies = []
    for ci, col in enumerate(cols):
        x = M + ci * (col_w + COLGAP)
        h = sum(item_h(it) for it in col['items']) + 14 + 14 * (len(col['items']) - 1) + 12
        bodies.append((x, h))
    H = int(body_top + max(h for _, h in bodies) + M)

    for ci, (col, (x, h)) in enumerate(zip(cols, bodies)):
        ls = lines_of(col['title'])
        if tw(ls[0], FS_H) > col_w - 8:
            problems.append(f'col{ci}.title: ≤{int((col_w - 8) // FS_H)} 汉字')
        raw(f'c{ci}_bg', x, body_top, col_w, max(h for _, h in bodies),
            f'rounded=0;html=1;fillColor={BODY_FILL};strokeColor=none;')
        hd_w = col_w - 34 if col.get('icon') else col_w
        raw(f'c{ci}_hd', x, TOP, hd_w, HEAD_H,
            f'rounded=0;html=1;fillColor={HEAD_FILL};strokeColor=none;fontSize={FS_H};'
            f'fontStyle=1;fontColor=#ffffff;fontFamily={FONT};align=center;'
            f'verticalAlign=middle;', mk(ls))
        if col.get('icon'):
            icon(f'c{ci}_ic', col['icon'], x + col_w - 30, TOP + (HEAD_H - 22) / 2, 22,
                 HEAD_FILL)
        y = body_top + 14
        tone_i = 0
        for ii, it in enumerate(col['items']):
            ih = draw_item(f'c{ci}i{ii}', it, x + 14, col_w - 28, y, tone_i)
            tone_i += 1
            if ii < len(col['items']) - 1:
                raw(f'c{ci}da{ii}', x + col_w / 2 - 7, y + ih + 3, 14, 10,
                    f'shape=singleArrow;direction=south;arrowWidth=0.6;arrowSize=0.45;'
                    f'html=1;fillColor={ARROW};strokeColor=none;')
            y += ih + 14
        if ci < len(cols) - 1:
            raw(f'c{ci}_ca', x + col_w + 8, body_top + h / 2 - 10, COLGAP - 16, 20,
                f'shape=singleArrow;direction=east;arrowWidth=0.55;arrowSize=0.4;html=1;'
                f'fillColor={INK};strokeColor=none;')
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
        '  <diagram id="trihead" name="三栏绿头流程图">\n'
        f'    <mxGraphModel dx="{W}" dy="{H}" grid="0" gridSize="10" guides="1" tooltips="1" '
        f'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" '
        'math="0" shadow="0">\n      <root>\n        <mxCell id="0" />\n'
        '        <mxCell id="1" parent="0" />\n' + '\n'.join(cells) +
        '\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n', encoding='utf-8')
    print(f'✓ 已写出 {out}（{len(cells)} 个图元）')


if __name__ == '__main__':
    main()
