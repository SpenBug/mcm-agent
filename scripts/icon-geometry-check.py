#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
马头图标几何校验：把 SVG 路径解析成点集，检查形状是否符合"朝左的马头"。

为什么需要它：本机 Electron 的 capturePage 会报 UnknownVizError（无 GPU 环境），
没法截图目检。所以退一步做**几何断言** —— 至少能证明：
  - 路径闭合、无自交
  - 耳朵在最上方、口鼻在左侧、颈部在下方（马头的拓扑特征）
  - 轮廓比例合理（不是一条线或一坨方块）

真·目检请用浏览器打开 build/icon-preview.html。
"""
import json
import math
import re
import sys
import os

# ⚠️ Windows 控制台默认 GBK，直接 print '✓' 会 UnicodeEncodeError。
# 强制 stdout 走 UTF-8，脚本在任何代码页下都能跑。
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def parse_path(d):
    """把 'M x y C x1 y1 x2 y2 x y ...' 解析成 [(cmd, [(x,y),...]), ...]

    ⚠️ 命令字母必须整体匹配：早先写成 `[MCZ]|-?\\d+` 时，
    数字里的字母会被误判成命令（如 '96' 之后的字符）。
    这里改成先切命令、再按命令消费固定个数的数字。
    """
    tokens = re.findall(r'[MCLZ]|-?\d+(?:\.\d+)?', d)
    out = []
    i = 0
    while i < len(tokens):
        cmd = tokens[i]
        if cmd not in ('M', 'C', 'L', 'Z'):
            raise ValueError('位置 %d 处期待命令，得到 %r' % (i, cmd))
        if cmd == 'M':
            out.append(('M', [(float(tokens[i + 1]), float(tokens[i + 2]))]))
            i += 3
        elif cmd == 'L':
            out.append(('L', [(float(tokens[i + 1]), float(tokens[i + 2]))]))
            i += 3
        elif cmd == 'C':
            pts = []
            for k in range(3):
                pts.append((float(tokens[i + 1 + k * 2]), float(tokens[i + 2 + k * 2])))
            out.append(('C', pts))
            i += 7
        else:  # Z
            out.append(('Z', []))
            i += 1
    return out


def sample(segs, n=24):
    """把路径采样成闭合折线点集（贝塞尔按 n 段离散）"""
    pts = []
    cur = None
    start = None
    for cmd, args in segs:
        if cmd == 'M':
            cur = args[0]
            start = cur
            pts.append(cur)
        elif cmd == 'C':
            p0 = cur
            p1, p2, p3 = args
            for k in range(1, n + 1):
                t = k / n
                mt = 1 - t
                x = (mt ** 3) * p0[0] + 3 * (mt ** 2) * t * p1[0] + 3 * mt * (t ** 2) * p2[0] + (t ** 3) * p3[0]
                y = (mt ** 3) * p0[1] + 3 * (mt ** 2) * t * p1[1] + 3 * mt * (t ** 2) * p2[1] + (t ** 3) * p3[1]
                pts.append((x, y))
            cur = p3
        elif cmd == 'L':
            cur = args[0]
            pts.append(cur)
        elif cmd == 'Z':
            if start:
                pts.append(start)
    return pts


def area(pts):
    s = 0.0
    for i in range(len(pts) - 1):
        s += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
    return s / 2


def self_intersects(pts):
    """粗略自交检测（O(n²)，点数少够用）"""
    def seg_hit(a, b, c, d):
        def ccw(p, q, r):
            return (r[1] - p[1]) * (q[0] - p[0]) - (q[1] - p[1]) * (r[0] - p[0])
        d1, d2 = ccw(a, b, c), ccw(a, b, d)
        d3, d4 = ccw(c, d, a), ccw(c, d, b)
        return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))

    n = len(pts) - 1
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            if seg_hit(pts[i], pts[i + 1], pts[j], pts[j + 1]):
                return True
    return False


def main():
    data = json.load(open(os.path.join(ROOT, 'build', 'horse-path.json'), encoding='utf-8'))
    segs = parse_path(data['horse'])
    pts = sample(segs)

    ok = True

    def check(name, cond, extra=''):
        nonlocal ok
        print(('  ✓ ' if cond else '  ✗ ') + name + (('  [%s]' % extra) if extra else ''))
        if not cond:
            ok = False

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    w, h = maxx - minx, maxy - miny

    print('=== 马头路径几何 ===')
    check('路径闭合（Z 结尾）', segs[-1][0] == 'Z')
    check('有实际面积（不是线或点）', abs(area(pts)) > 3000, '%.0f px²' % abs(area(pts)))
    check('无自交', not self_intersects(pts))
    check('画布内（0..256）', minx >= 0 and miny >= 0 and maxx <= 256 and maxy <= 256,
          'x %.0f-%.0f, y %.0f-%.0f' % (minx, maxx, miny, maxy))
    check('纵横比合理（0.7-1.6）', 0.7 < w / h < 1.6, '%.2f (w=%.0f h=%.0f)' % (w / h, w, h))

    print()
    print('=== 马头拓扑特征 ===')
    # 耳朵：最上方的一小段，应该在右侧（马头朝左时耳朵偏后/右）
    top_pts = [p for p in pts if p[1] < miny + h * 0.12]
    ear_x = sum(p[0] for p in top_pts) / len(top_pts)
    check('顶部是耳朵（存在顶部点）', len(top_pts) >= 3, '%d 点' % len(top_pts))
    check('耳朵偏右侧（头朝左）', ear_x > (minx + maxx) / 2, 'x=%.0f vs 中线 %.0f' % (ear_x, (minx + maxx) / 2))

    # 口鼻：最左侧的点应在中部偏上（不是最上也不是最下）
    left_pts = [p for p in pts if p[0] < minx + w * 0.10]
    nose_y = sum(p[1] for p in left_pts) / len(left_pts)
    check('口鼻在最左侧', len(left_pts) >= 3, '%d 点' % len(left_pts))
    check('口鼻位于中上部（马头特征）', (miny + h * 0.25) < nose_y < (miny + h * 0.75),
          'y=%.0f（范围 %.0f-%.0f）' % (nose_y, miny + h * 0.25, miny + h * 0.75))

    # 颈部：最下方的点应在中左（颈部向下延伸）
    bot_pts = [p for p in pts if p[1] > maxy - h * 0.12]
    neck_x = sum(p[0] for p in bot_pts) / len(bot_pts)
    check('底部是颈部', len(bot_pts) >= 3, '%d 点' % len(bot_pts))
    check('颈部在中部（不是悬空尖角）', (minx + w * 0.15) < neck_x < (maxx - w * 0.05),
          'x=%.0f' % neck_x)

    print()
    print('结果：' + ('几何校验通过' if ok else '几何校验失败'))
    print('目检请用浏览器打开 build/icon-preview.html')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
