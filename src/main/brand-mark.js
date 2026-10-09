'use strict';

/**
 * 阿一古数模 · 品牌标记（侧面马头）—— **形状的唯一真源**。
 *
 * 为什么单独一个文件：马头路径要在三个地方用（exe 图标 PNG、应用内顶栏/首屏
 * brandMark、以及目检用的预览页）。以前路径抄了两份（这里 + index.html），
 * 结果改了代码里的那份、界面还是旧图，图标和界面各说各话。
 * 现在 index.html 由 scripts/sync-brand-mark.js 从本文件生成，改一处即可。
 *
 * 构图（viewBox 0 0 256 256，马头朝左）：
 *   近侧耳（主体的一部分，耳尖 150,32）
 *   远侧耳（独立小尖，被主体遮住根部 → 前后层次）
 *   额 → 鼻梁 → 口鼻 → 下颌 → 颈
 *   鬃毛：贴颈后的实心带，从枕部一路到颈底
 *   眼 / 鼻孔：镂空成深底色，小尺寸下靠这两点确认"是动物头"
 *
 * ⚠️ 改完必须跑 `node scripts/icon-check.js` 做几何断言 + 渲染出图目检。
 *    历史教训：第一版手写路径自交且只有 1760px²（细长条，根本不是马头），
 *    靠几何断言查出来；而本机 capturePage 报 UnknownVizError 截不了图，
 *    一度导致 icon.png 停在旧的 ∑ 六边形上静默发版。
 */

/** 主体：近侧耳 + 面部 + 颈（顺时针闭合） */
const HORSE_PATH = [
  'M150 32',                                   // 近侧耳尖
  'C147 44 143 53 139 61',                     // 耳前缘 → 额顶
  'C124 68 108 80 92 96',                      // 额头斜下
  'C76 112 60 128 50 142',                     // 鼻梁（微凹）
  'C44 151 42 160 46 167',                     // 口鼻前端圆钝
  'C51 174 60 178 71 180',                     // 口鼻下缘
  'C84 182 94 186 99 193',                     // 下颌
  'C103 201 104 209 104 218',                  // 喉 → 颈前
  'L178 218',                                  // 颈底
  'C183 199 186 178 185 158',                  // 颈后下段
  'C184 134 178 110 169 89',                   // 颈后中段
  'C165 80 161 71 158 62',                     // 枕部
  'C160 52 158 41 150 32',                     // 回耳尖
  'Z',
].join(' ');

/** 远侧耳：主体之后绘制，根部被遮住，只露出朝右上的尖 */
const FAR_EAR_PATH = 'M153 74 L172 34 L184 70 Z';

/** 鬃毛：贴颈后的实心带（不是描边线条 —— 描边在 32px 下会糊成一根灰条） */
const MANE_PATH =
  'M157 62 C166 84 175 116 179 148 C182 174 180 198 175 218 L159 218 ' +
  'C165 197 167 174 164 150 C160 118 151 90 143 71 Z';

/** 眼睛（镂空成深底色） */
const EYE = { cx: 112, cy: 101, r: 7.5 };

/** 鼻孔：椭圆并沿鼻梁方向倾斜 */
const NOSTRIL = { cx: 57, cy: 154, rx: 5, ry: 7, rotate: -28 };

/** 底板与配色（图标底 / 应用内底都用它，保证同一品牌色） */
const PALETTE = {
  bgStops: [
    { offset: '0%', color: '#4468bd' },
    { offset: '52%', color: '#2b4179' },
    { offset: '100%', color: '#1a2545' },
  ],
  bodyStops: [
    { offset: '0%', color: '#ffffff' },
    { offset: '100%', color: '#dbe4ff' },
  ],
  deep: '#1a2545',        // 眼/鼻孔
  mane: '#3a569c',        // 鬃毛
  farEar: '#c3d0f5',      // 远侧耳（比主体略暗，形成层次）
  accent: '#e8590c',      // 品牌橙（标语/焦点色，图标上不用）
};

/**
 * 生成马头图形（不含底板），供不同容器复用。
 * @param {object} [o]
 * @param {boolean} [o.mane] 是否画鬃毛（应用内小尺寸可关掉，避免糊）
 * @param {boolean} [o.face] 是否画眼/鼻孔
 * @param {boolean} [o.mono] 单色模式：全部用 currentColor，跟随 CSS color。
 *   头像、锁页标记这类"容器自己已经有底色"的位置要用它 ——
 *   带底板的 brandMark 放进去会变成"蓝底套蓝底"；
 *   而写死白色在浅色主题下会直接看不见。
 *   单色模式不画五官：28px 下眼睛只有 1 像素，和 16px 图标同理会糊成脏点。
 */
function markBody({ mane = true, face = true, mono = false } = {}) {
  if (mono) {
    const parts = [
      // 远侧耳压暗一档，靠透明度做出前后层次（仍然是单色）
      `<path d="${FAR_EAR_PATH}" fill="currentColor" opacity=".55"/>`,
      `<path d="${HORSE_PATH}" fill="currentColor"/>`,
    ];
    if (mane) parts.push(`<path d="${MANE_PATH}" fill="currentColor" opacity=".22"/>`);
    return parts.join('\n    ');
  }

  const parts = [
    `<path d="${FAR_EAR_PATH}" fill="${PALETTE.farEar}"/>`,
    `<path d="${HORSE_PATH}" fill="url(#lgHorse)"/>`,
  ];
  if (mane) parts.push(`<path d="${MANE_PATH}" fill="${PALETTE.mane}" opacity=".55"/>`);
  if (face) {
    parts.push(`<circle cx="${EYE.cx}" cy="${EYE.cy}" r="${EYE.r}" fill="${PALETTE.deep}"/>`);
    parts.push(
      `<ellipse cx="${NOSTRIL.cx}" cy="${NOSTRIL.cy}" rx="${NOSTRIL.rx}" ry="${NOSTRIL.ry}" ` +
      `transform="rotate(${NOSTRIL.rotate} ${NOSTRIL.cx} ${NOSTRIL.cy})" ` +
      `fill="${PALETTE.deep}" opacity=".85"/>`,
    );
  }
  return parts.join('\n    ');
}

/**
 * 形状指纹：把影响出图的所有输入拼起来哈希。
 *
 * 用途是**内容级**的新鲜度判断（scripts/icon-check.js 会拿它和
 * build/icon-manifest.json 里记录的指纹比对）。
 * 不用 mtime：git clone 后各文件的检出顺序是字母序
 * （icon.ico < icon.png < icon.svg），时间戳先后完全不可信。
 */
function shapeDigest() {
  const crypto = require('node:crypto');
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      horse: HORSE_PATH,
      ear: FAR_EAR_PATH,
      mane: MANE_PATH,
      eye: EYE,
      nostril: NOSTRIL,
      palette: PALETTE,
      master: MASTER,
      icoSizes: ICO_SIZES,
      noFaceMax: NO_FACE_MAX,
    }))
    .digest('hex')
    .slice(0, 16);
}

/** 渐变定义（id 固定为 lgBg / lgHorse，容器里引用） */
function markDefs() {
  const stops = (arr) => arr.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join('');
  return [
    `<linearGradient id="lgBg" x1="0" y1="0" x2="0.85" y2="1">${stops(PALETTE.bgStops)}</linearGradient>`,
    `<linearGradient id="lgHorse" x1="0" y1="0" x2="0.3" y2="1">${stops(PALETTE.bodyStops)}</linearGradient>`,
  ].join('\n    ');
}

/** 主图边长。electron-builder 会自己缩放，但 .ico 我们手做，所以要出多尺寸 */
const MASTER = 512;

/** .ico 内嵌的尺寸。16/32 是 Windows 任务栏与快捷方式的关键档 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** ≤ 这个尺寸用无五官版：眼睛鼻孔只有 1 像素，会糊成马脸上的脏点 */
const NO_FACE_MAX = 24;

module.exports = {
  HORSE_PATH,
  FAR_EAR_PATH,
  MANE_PATH,
  EYE,
  NOSTRIL,
  PALETTE,
  MASTER,
  ICO_SIZES,
  NO_FACE_MAX,
  markBody,
  markDefs,
  shapeDigest,
};
