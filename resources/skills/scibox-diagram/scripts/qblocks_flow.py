#!/usr/bin/env python3
"""qblocks-flow：分问题流程图（问题一…问题N，半宽并排 + 整行块）。

    python3 qblocks_flow.py content.json -o out.drawio
    python3 qblocks_flow.py content.json --check

复刻自横版"分问题"技术路线图：每块顶部一条实色标题条 + 齿孔虚线外框，
块内是若干行流程小盒（行间绿色下箭头、行内可选绿色右箭头链），
块与块之间用绿色粗箭头推进。半宽块成对并排（问题一/问题二），其余整行。
"""
import argparse
import base64
import html
import json
import pathlib
import sys
import unicodedata

W = 1080
M = 24                     # 画布外边距
GAP_X = 28                 # 同行半宽块间距
GAP_Y = 54                 # 块行距（留绿色推进箭头）
PAD = 14                   # 块内左右内边距
HEAD_H = 30                # 标题条高
ROW_H = 28                 # 流程盒高
ROW_GAP = 18               # 行距
FS, FS_T = 12, 14
FONT = 'SimSun'                            # 统一宋体
INK = '#262626'
HEAD_FILL, HEAD_STK = '#6880a0', '#4c6080'   # 配色卡2：石板蓝标题条（色不变）
BOX_FILL, BOX_STK = '#ffffff', '#6880a0'     # 白底 + 石板蓝边（色不变）
EMPH_FILL, EMPH_STK = '#f8c8c8', '#c87878'   # 配色卡2：藕粉强调盒（色不变）
GREEN = '#6880a0'                            # 推进箭头：同色系石板蓝

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


def icon(cid, name, x, y, s=22, color=INK):
    """内嵌 Tabler 线性图标（复制到内存后再改色，不动 assets 原文件）。"""
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
        f'rounded=0;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};'
        f'strokeWidth=1.4;fontSize={fs};fontStyle={bold};fontColor={fc};fontFamily={FONT};'
        f'align=center;verticalAlign=middle;spacingLeft=2;spacingRight=2;', mk(ls))


def edge(cid, pts, stroke=INK, width=1.6, end='block'):
    (sx, sy), (tx, ty) = pts[0], pts[-1]
    cells.append(
        f'        <mxCell id="{cid}" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=0;'
        f'html=1;endArrow={end};endFill=1;endSize=6;startArrow=none;'
        f'strokeColor={stroke};strokeWidth={width};" edge="1" parent="1">\n'
        f'          <mxGeometry relative="1" as="geometry">\n'
        f'            <mxPoint x="{sx:g}" y="{sy:g}" as="sourcePoint" />\n'
        f'            <mxPoint x="{tx:g}" y="{ty:g}" as="targetPoint" />\n'
        f'          </mxGeometry>\n        </mxCell>')


def dashframe(cid, x, y, w, h, color='#555555', pattern='8 6'):
    # 虚线框一律用「矩形顶点」绘制：折线边在正交路由下会出现缺角/断线
    raw(cid, x, y, w, h, f'rounded=0;html=1;fillColor=none;strokeColor={color};'
                         f'strokeWidth=1.5;dashed=1;dashPattern={pattern};')


def slots(a, b, n, gap):
    size = (b - a - (n - 1) * gap) / n
    if size < 40:
        problems.append(f'一行 {n} 个盒过挤（每盒仅 {size:.0f}px，至少 40px）')
    return [(a + i * (size + gap), size) for i in range(n)]


def rows_of(b):
    return b.get('rows', [])


def block_h(b):
    n = len(rows_of(b))
    return 2 + HEAD_H + 12 + n * ROW_H + (n - 1) * ROW_GAP + 12


def build(c):
    blocks = c['blocks']
    if not 2 <= len(blocks) <= 6:
        sys.exit(f'blocks 数量 {len(blocks)} 越界（允许 2–6）')
    full_w = W - 2 * M
    half_w = (full_w - GAP_X) / 2
    hs = [block_h(b) for b in blocks]

    pos, y, pending = [], M, None   # pending=(y,h) 半宽块已放左侧、行高未定
    for b, h in zip(blocks, hs):
        if b.get('layout') == 'half':
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

    for bi, (b, (bx, by, bw), bh) in enumerate(zip(blocks, pos, hs)):
        dashframe(f'b{bi}', bx, by, bw, bh, pattern='6 4')
        ls = lines_of(b['title'])
        if len(ls) != 1 or tw(ls[0], FS_T) > bw - 12:
            problems.append(f'b{bi}.title: 标题需单行且 ≤{int((bw - 12) // FS_T)} 汉字')
        raw(f'b{bi}_t', bx + 38, by + 2, bw - 42, HEAD_H,
            f'rounded=0;html=1;fillColor={HEAD_FILL};strokeColor={HEAD_STK};strokeWidth=1;'
            f'fontSize={FS_T};fontStyle=1;fontColor={INK};fontFamily={FONT};'
            f'align=center;verticalAlign=middle;', mk(ls))
        if b.get('icon'):
            icon(f'b{bi}_ic', b['icon'], bx + 10, by + 2 + (HEAD_H - 22) / 2, 22, '#33405a')
        yy = by + 2 + HEAD_H + 12
        prev_bottom = None
        for ri, row in enumerate(rows_of(b)):
            if isinstance(row, dict):
                items, flow = row.get('boxes', []), bool(row.get('flow'))
            else:
                items, flow = row, False
            gap = 34 if flow else 12
            cells_r = slots(bx + PAD, bx + bw - PAD, len(items), gap)
            for ci, it in enumerate(items):
                emph = isinstance(it, dict) and it.get('emph')
                text = it['text'] if isinstance(it, dict) else it
                cx, cw = cells_r[ci]
                box(f'b{bi}_r{ri}c{ci}', cx, yy, cw, ROW_H, text,
                    EMPH_FILL if emph else BOX_FILL,
                    EMPH_STK if emph else BOX_STK)
                if flow and ci:
                    px = cells_r[ci - 1][0] + cells_r[ci - 1][1] + 2
                    raw(f'b{bi}_fa{ri}c{ci}', px, yy + ROW_H / 2 - 5, gap - 4, 10,
                        f'shape=singleArrow;direction=east;arrowWidth=0.55;arrowSize=0.4;'
                        f'html=1;fillColor={GREEN};strokeColor=none;')
            if ri and prev_bottom is not None:
                edge(f'b{bi}_da{ri}', [(bx + bw / 2, prev_bottom + 1),
                                       (bx + bw / 2, yy - 1)], GREEN, 2.2)
            prev_bottom = yy + ROW_H
            yy += ROW_H + ROW_GAP

    # 块间绿色推进箭头（每个块下方，指向下一个更低位置的块）
    for i in range(len(blocks)):
        nxt = next((j for j in range(i + 1, len(blocks))
                    if pos[j][1] > pos[i][1] + 10), None)
        if nxt is None:
            continue
        cx = pos[i][0] + pos[i][2] / 2
        y0 = pos[i][1] + hs[i] + 4
        y1 = pos[nxt][1] - 6
        if y1 - y0 < 18:
            problems.append(f'块 {i}→{nxt} 间距不足（需 ≥28px）')
            continue
        raw(f'ga{i}', cx - 11, y0, 22, y1 - y0,
            f'shape=singleArrow;direction=south;arrowWidth=0.5;arrowSize=0.3;html=1;'
            f'fillColor={GREEN};strokeColor=none;')
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
        '  <diagram id="qblocks" name="分问题流程图">\n'
        f'    <mxGraphModel dx="{W}" dy="{H}" grid="0" gridSize="10" guides="1" tooltips="1" '
        f'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" '
        'math="0" shadow="0">\n      <root>\n        <mxCell id="0" />\n'
        '        <mxCell id="1" parent="0" />\n' + '\n'.join(cells) +
        '\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n', encoding='utf-8')
    print(f'✓ 已写出 {out}（{len(cells)} 个图元）')


if __name__ == '__main__':
    main()
