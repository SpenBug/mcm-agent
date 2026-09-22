#!/usr/bin/env python3
"""part-zones：章节分区路线图（第一部分…第N部分，彩色虚线分区 + 绿色双箭头推进）。

    python3 part_zones.py content.json -o out.drawio
    python3 part_zones.py content.json --check

复刻自"整体思路流程图"：每个分区一条彩色圆角虚线框 + 框内同色章节标题，
内容为浅色流程小盒（行间下箭头），可在行下挂说明性小字注释；
分区之间用绿色双箭头（>>）推进，半宽分区成对并排、其余整行。
"""
import argparse
import base64
import html
import json
import pathlib
import sys
import unicodedata

W = 1080
M = 24
GAP_X = 44                 # 同行分区间距（留双箭头）
GAP_Y = 54
PAD = 20
TITLE_H = 30
ROW_H = 36
ROW_GAP = 16
FS, FS_T, FS_N = 13, 19, 11
FONT = 'SimSun'                            # 统一宋体
INK = '#262626'
NOTE_C = '#5a86b0'
GREEN = '#7fae55'                          # 双箭头：橄榄绿（柔化）
# accent: (框线/标题色, 盒浅底) —— 底色取参考图实测值
ACCENTS = {                                # 配色卡3：淡雅粉紫青
    'teal':   ('#6f9a94', '#d0f0f0'),
    'green':  ('#7f9a70', '#dcead0'),
    'orange': ('#c09070', '#f8e0d0'),
    'red':    ('#b08090', '#f4dce2'),
    'blue':   ('#8a8ab0', '#d0d0f0'),
}

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


def icon(cid, name, x, y, s=24, color=INK):
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


def text_label(cid, x, y, w, h, s, color, fs, bold=1, align='center'):
    raw(cid, x, y, w, h,
        f'text;html=1;align={align};verticalAlign=middle;fontSize={fs};'
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


def dashframe(cid, x, y, w, h, color, pattern='8 6'):
    raw(cid, x, y, w, h, f'rounded=0;html=1;fillColor=none;strokeColor={color};'
                         f'strokeWidth=1.5;dashed=1;dashPattern={pattern};')


def slots(a, b, n, gap):
    size = (b - a - (n - 1) * gap) / n
    if size < 60:
        problems.append(f'一行 {n} 个盒过挤（每盒仅 {size:.0f}px，至少 60px）')
    return [(a + i * (size + gap), size) for i in range(n)]


def zone_h(z):
    n = len(z.get('rows', []))
    notes = z.get('notes', [])
    return 14 + TITLE_H + 10 + n * ROW_H + (n - 1) * ROW_GAP + \
        (20 * len(notes) + 6 if notes else 0) + 14


def chevron(cid, cx, cy, direction):
    """绿色双箭头：direction='east'|'south'，(cx,cy) 为中心。"""
    if direction == 'east':
        for k in range(3):
            raw(f'{cid}_{k}', cx - 27 + k * 19, cy - 8, 15, 16,
                f'shape=triangle;direction=east;html=1;fillColor={GREEN};strokeColor=none;')
    else:
        for k in range(3):
            raw(f'{cid}_{k}', cx - 8, cy - 27 + k * 19, 16, 15,
                f'shape=triangle;direction=south;html=1;fillColor={GREEN};strokeColor=none;')


def build(c):
    zones = c['zones']
    if not 2 <= len(zones) <= 6:
        sys.exit(f'zones 数量 {len(zones)} 越界（允许 2–6）')
    full_w = W - 2 * M
    half_w = (full_w - GAP_X) / 2
    hs = [zone_h(z) for z in zones]

    pos, y, pending = [], M, None
    for z, h in zip(zones, hs):
        if z.get('layout') == 'half':
            if pending:
                pos.append((M + half_w + GAP_X, pending[0], half_w))
                y = pending[0] + max(pending[1], h) + GAP_Y
                pending = None
            else:
                pos.append((M, y, half_w))
                pending = (y, h)
        else:
            if pending:
                y = pending[0] + pending[1] + GAP_Y
                pending = None
            pos.append((M, y, full_w))
            y += h + GAP_Y
    if pending:
        y = pending[0] + pending[1] + GAP_Y
    H = int(y - GAP_Y + M)

    for zi, (z, (zx, zy, zw), zh) in enumerate(zip(zones, pos, hs)):
        accent = z.get('accent', 'teal')
        if accent not in ACCENTS:
            sys.exit(f'未知 accent {accent}（可选 {list(ACCENTS)}）')
        stk, light = ACCENTS[accent]
        dashframe(f'z{zi}', zx, zy, zw, zh, stk)
        if z.get('icon'):
            icon(f'z{zi}_ic', z['icon'], zx + 16, zy + 12 + (TITLE_H - 24) / 2, 24, stk)
        text_label(f'z{zi}_t', zx + 46, zy + 12, zw - 56, TITLE_H, z['title'], stk, FS_T)
        yy = zy + 14 + TITLE_H + 10
        prev_bottom = None
        for ri, row in enumerate(z.get('rows', [])):
            cells_r = slots(zx + PAD, zx + zw - PAD, len(row), 12)
            for ci, it in enumerate(row):
                cx, cw = cells_r[ci]
                box(f'z{zi}r{ri}c{ci}', cx, yy, cw, ROW_H, it, light, stk)
            if ri and prev_bottom is not None:
                edge(f'z{zi}da{ri}', [(zx + zw / 2, prev_bottom + 1),
                                      (zx + zw / 2, yy - 1)], stk, 1.6)
            prev_bottom = yy + ROW_H
            yy += ROW_H + ROW_GAP
        for ni, note in enumerate(z.get('notes', [])):
            text_label(f'z{zi}n{ni}', zx + 12, yy - ROW_GAP + 4 + ni * 18, zw - 24, 16,
                       note, NOTE_C, FS_N, bold=0)

    # 分区间绿色双箭头：同排半宽→东向，否则南向
    for i in range(len(zones)):
        nxt = next((j for j in range(i + 1, len(zones))
                    if pos[j][1] > pos[i][1] + 10), None)
        if nxt is not None:
            cx = pos[i][0] + pos[i][2] / 2
            chevron(f'cv{i}', cx, (pos[i][1] + hs[i] + pos[nxt][1]) / 2, 'south')
        elif i + 1 < len(zones) and abs(pos[i + 1][1] - pos[i][1]) < 10 \
                and pos[i + 1][0] > pos[i][0]:
            cy = pos[i][1] + hs[i] / 2
            chevron(f'cv{i}', (pos[i][0] + pos[i][2] + pos[i + 1][0]) / 2, cy, 'east')
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
        '  <diagram id="partzones" name="章节分区路线图">\n'
        f'    <mxGraphModel dx="{W}" dy="{H}" grid="0" gridSize="10" guides="1" tooltips="1" '
        f'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" '
        'math="0" shadow="0">\n      <root>\n        <mxCell id="0" />\n'
        '        <mxCell id="1" parent="0" />\n' + '\n'.join(cells) +
        '\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n', encoding='utf-8')
    print(f'✓ 已写出 {out}（{len(cells)} 个图元）')


if __name__ == '__main__':
    main()
