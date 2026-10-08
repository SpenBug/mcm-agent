#!/usr/bin/env node
'use strict';

/**
 * 马头图标几何校验：把 SVG 路径采样成点集，断言它确实是"朝左的马头"。
 *
 * 为什么需要它：图标形状靠手写贝塞尔，肉眼很容易被骗 ——
 * 第一版路径自交且只有 1760px²（细长条，根本不是马头），就是这套断言查出来的。
 * 出图目检虽然已经能跑（offscreen 渲染），但断言仍是**唯一能在 CI 里挡住退化**的一环。
 *
 * ⚠️ 直接 require 真源 src/main/brand-mark.js。
 *    以前这里读 build/horse-path.json（手抄的副本），
 *    结果改了真源、校验还在测旧形状，等于没有防线。
 *
 * 用法：npm run icon:check
 */

const {
  HORSE_PATH, FAR_EAR_PATH, MANE_PATH, EYE, NOSTRIL, MASTER, ICO_SIZES, shapeDigest,
} = require('../src/main/brand-mark');

/** 把 'M x y C ... L ... Z' 解析成 [{cmd, pts}] */
function parsePath(d) {
  const tokens = d.match(/[MCLZ]|-?\d+(?:\.\d+)?/g) || [];
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i];
    if (!['M', 'C', 'L', 'Z'].includes(cmd)) throw new Error(`第 ${i} 个期待命令，得到 ${cmd}`);
    if (cmd === 'M' || cmd === 'L') {
      out.push({ cmd, pts: [[+tokens[i + 1], +tokens[i + 2]]] });
      i += 3;
    } else if (cmd === 'C') {
      const pts = [];
      for (let k = 0; k < 3; k += 1) pts.push([+tokens[i + 1 + k * 2], +tokens[i + 2 + k * 2]]);
      out.push({ cmd, pts });
      i += 7;
    } else {
      out.push({ cmd, pts: [] });
      i += 1;
    }
  }
  return out;
}

/** 采样成闭合折线（三次贝塞尔按 n 段离散） */
function sample(segs, n = 24) {
  const pts = [];
  let cur = null;
  let start = null;
  for (const { cmd, pts: args } of segs) {
    if (cmd === 'M') { cur = args[0]; start = cur; pts.push(cur); }
    else if (cmd === 'L') { cur = args[0]; pts.push(cur); }
    else if (cmd === 'C') {
      const [p1, p2, p3] = args;
      const p0 = cur;
      for (let k = 1; k <= n; k += 1) {
        const t = k / n;
        const mt = 1 - t;
        pts.push([
          mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
          mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1],
        ]);
      }
      cur = p3;
    } else if (cmd === 'Z' && start) pts.push(start);
  }
  return pts;
}

function area(pts) {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i += 1) s += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  return s / 2;
}

function selfIntersects(pts) {
  const ccw = (p, q, r) => (r[1] - p[1]) * (q[0] - p[0]) - (q[1] - p[1]) * (r[0] - p[0]);
  const hit = (a, b, c, d) => {
    const d1 = ccw(a, b, c); const d2 = ccw(a, b, d);
    const d3 = ccw(c, d, a); const d4 = ccw(c, d, b);
    return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
  };
  const n = pts.length - 1;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue;
      if (hit(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
    }
  }
  return false;
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? `  [${extra}]` : ''}`); }
}

function bbox(pts) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minx: Math.min(...xs), maxx: Math.max(...xs), miny: Math.min(...ys), maxy: Math.max(...ys) };
}

const segs = parsePath(HORSE_PATH);
const pts = sample(segs);
const { minx, maxx, miny, maxy } = bbox(pts);
const w = maxx - minx;
const h = maxy - miny;

console.log('=== 主体路径几何 ===');
check('路径闭合（Z 结尾）', segs[segs.length - 1].cmd === 'Z');
check('有实际面积（不是线或点）', Math.abs(area(pts)) > 3000, `${Math.abs(area(pts)).toFixed(0)} px²`);
check('无自交', !selfIntersects(pts));
check('画布内（0..256）', minx >= 0 && miny >= 0 && maxx <= 256 && maxy <= 256, `x ${minx.toFixed(0)}-${maxx.toFixed(0)}, y ${miny.toFixed(0)}-${maxy.toFixed(0)}`);
check('纵横比合理（0.7–1.6）', w / h > 0.7 && w / h < 1.6, `${(w / h).toFixed(2)} (w=${w.toFixed(0)} h=${h.toFixed(0)})`);

console.log('\n=== 马头拓扑特征（朝左）===');
const top = pts.filter((p) => p[1] < miny + h * 0.12);
const earX = top.reduce((a, p) => a + p[0], 0) / top.length;
check('顶部有耳朵', top.length >= 3, `${top.length} 点`);
check('耳朵偏右（头朝左）', earX > (minx + maxx) / 2, `x=${earX.toFixed(0)} vs 中线 ${((minx + maxx) / 2).toFixed(0)}`);

const left = pts.filter((p) => p[0] < minx + w * 0.1);
const noseY = left.reduce((a, p) => a + p[1], 0) / left.length;
check('口鼻在最左侧', left.length >= 3, `${left.length} 点`);
check('口鼻位于中上部', noseY > miny + h * 0.25 && noseY < miny + h * 0.75, `y=${noseY.toFixed(0)}`);

const bottom = pts.filter((p) => p[1] > maxy - h * 0.12);
const neckX = bottom.reduce((a, p) => a + p[0], 0) / bottom.length;
check('底部是颈部', bottom.length >= 3, `${bottom.length} 点`);
check('颈部在中部（不是悬空尖角）', neckX > minx + w * 0.15 && neckX < maxx - w * 0.05, `x=${neckX.toFixed(0)}`);

console.log('\n=== 配件与主体的关系（避免"零件各飞各的"）===');
const ear = sample(parsePath(FAR_EAR_PATH));
const eb = bbox(ear);
check('远侧耳在画布内', eb.minx >= 0 && eb.miny >= 0 && eb.maxx <= 256 && eb.maxy <= 256);
check('远侧耳贴着主体（水平重叠）', eb.minx < maxx && eb.maxx > minx, `耳 x ${eb.minx.toFixed(0)}-${eb.maxx.toFixed(0)}`);
check('远侧耳不压住眼睛', Math.hypot(eb.minx - EYE.cx, eb.maxy - EYE.cy) > 20 || EYE.cx < eb.minx);

const mane = sample(parsePath(MANE_PATH));
const mb = bbox(mane);
check('鬃毛在颈后（主体右半）', (mb.minx + mb.maxx) / 2 > (minx + maxx) / 2, `鬃毛中心 x=${((mb.minx + mb.maxx) / 2).toFixed(0)}`);
check('鬃毛不越出主体右缘', mb.maxx <= maxx + 2, `鬃毛右 ${mb.maxx.toFixed(0)} vs 主体右 ${maxx.toFixed(0)}`);
check('鬃毛有长度（不是小点）', mb.maxy - mb.miny > h * 0.4, `${(mb.maxy - mb.miny).toFixed(0)} px`);

check('眼睛在主体轮廓内', pts.length > 0 && (() => {
  // 射线法：判断点是否在闭合多边形内
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > EYE.cy) !== (yj > EYE.cy) && EYE.cx < ((xj - xi) * (EYE.cy - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
})());
check('鼻孔在口鼻前端附近', Math.hypot(NOSTRIL.cx - minx, NOSTRIL.cy - (miny + h * 0.5)) < w * 0.25);

console.log('\n=== 小尺寸可辨性（16px 下五官会糊，所以靠轮廓）===');
check('主体宽度足够（≥ 画布 55%）', w >= 256 * 0.55, `${w.toFixed(0)} px`);
check('主体高度足够（≥ 画布 65%）', h >= 256 * 0.65, `${h.toFixed(0)} px`);

/**
 * 产物新鲜度 —— 钉住这次真实踩过的坑：
 * 改了马头路径，但 build/icon.png 还停在更早的 ∑ 六边形上，
 * 打包不报错、照常发版，装出来的 exe 图标跟品牌对不上。
 *
 * 判据不用「图标 mtime ≥ 真源 mtime」：那样只改真源里的注释也会误报，
 * 而且 git clone 后各文件检出顺序是字母序，时间戳先后完全不可信。
 * 用**内容**：npm run icon 会写 build/icon-manifest.json 记录形状指纹，
 * 这里比对指纹即可精确发现"形状改了、图标没重生成"。
 */
console.log('\n=== 图标产物新鲜度（防"改了形状、图标还是旧的"）===');
const fs = require('node:fs');
const pathMod = require('node:path');
const buildDir = pathMod.join(__dirname, '..', 'build');

const svgFile = pathMod.join(buildDir, 'icon.svg');
const pngFile = pathMod.join(buildDir, 'icon.png');
const icoFile = pathMod.join(buildDir, 'icon.ico');
const manifestFile = pathMod.join(buildDir, 'icon-manifest.json');

for (const [name, p] of [['icon.svg', svgFile], ['icon.png', pngFile], ['icon.ico', icoFile]]) {
  check(`${name} 存在`, fs.existsSync(p), '跑 npm run icon 生成');
}

let manifest = null;
if (fs.existsSync(manifestFile)) {
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { manifest = null; }
}
check('icon-manifest.json 可读', manifest !== null, '跑 npm run icon 重新生成');
if (manifest) {
  check('图标由当前形状生成（指纹一致）', manifest.shape === shapeDigest(),
    `清单 ${manifest.shape} vs 真源 ${shapeDigest()} → npm run icon`);
  check('主图尺寸与清单一致', manifest.master === MASTER, `清单 ${manifest.master}`);
  check('ico 尺寸档与清单一致', JSON.stringify(manifest.icoSizes) === JSON.stringify(ICO_SIZES));
}

if (fs.existsSync(svgFile)) {
  const svg = fs.readFileSync(svgFile, 'utf8');
  check('icon.svg 用的是当前马头路径', svg.includes(HORSE_PATH), '形状已改但图标没重生成 → npm run icon');
  check('icon.svg 不含旧 ∑ 图形', !/∑|M170 84 H100/.test(svg));
  check('icon.svg 品牌名正确', svg.includes('阿一古数模') && !svg.includes('数模工坊'));
}

// 位图里没法读路径，但可以确认它不是那张旧的 ∑ 图（旧图 1024×1024）
if (fs.existsSync(pngFile)) {
  const wPng = fs.readFileSync(pngFile).readUInt32BE(16);
  check(`icon.png 是 make-icon.js 出的主图（${MASTER}px）`, wPng === MASTER, `实际 ${wPng}px`);
}

// 界面里的 brandMark 必须和图标同源（这条同时被 sync-brand-mark --check 覆盖，
// 这里再查一次是因为它是"图标改了、界面没跟上"最常见的漏点）
const indexHtml = pathMod.join(__dirname, '..', 'src', 'renderer', 'index.html');
if (fs.existsSync(indexHtml)) {
  const html = fs.readFileSync(indexHtml, 'utf8');
  check('界面 brandMark 用的是当前马头路径', html.includes(HORSE_PATH), '跑 npm run brand');
  check('界面 brandMark 有远侧耳', html.includes(FAR_EAR_PATH));
  check('界面 brandMark 有鬃毛带', html.includes(MANE_PATH));
  check('界面不含旧马头路径', !html.includes('M152 26 C146 36'));
}

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
