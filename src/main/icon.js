'use strict';

/**
 * 兼容层：马头形状的唯一真源已迁到 src/main/brand-mark.js。
 *
 * 为什么还留着这个文件：`electron . --make-icon` 曾引用过它，直接删会让老命令报错。
 * 现在它只做转发，**不再抄一份路径** —— 之前正是"icon.js 抄一份、index.html 再抄一份"
 * 导致改了代码界面还是旧图，而打包用的 build/icon.png 甚至停在更早的 ∑ 六边形上
 * 静默发版（本机无 GPU，普通窗口 capturePage 失败但不报错）。
 *
 * 出图请用：`npm run icon`（scripts/make-icon.js，offscreen 渲染 + 自检）。
 */

const {
  HORSE_PATH, FAR_EAR_PATH, MANE_PATH, EYE, NOSTRIL, PALETTE, markBody, markDefs, shapeDigest,
} = require('./brand-mark');

/** @deprecated 单条鬃毛带。保留数组形态只为不炸老引用。 */
const MANE_PATHS = [MANE_PATH];

/** @deprecated 出图已迁到 scripts/make-icon.js，且必须走 offscreen。 */
function generateIcon() {
  throw new Error(
    'generateIcon 已移除：普通窗口截图在本机（无 GPU）会静默失败。请改用 `npm run icon`。',
  );
}

module.exports = {
  generateIcon,
  HORSE_PATH,
  FAR_EAR_PATH,
  MANE_PATH,
  MANE_PATHS,
  EYE,
  NOSTRIL,
  PALETTE,
  markBody,
  markDefs,
  shapeDigest,
};
