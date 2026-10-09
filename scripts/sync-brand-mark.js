'use strict';

/**
 * 把品牌标记（马头）从唯一真源 src/main/brand-mark.js 同步进渲染层 HTML。
 *
 * 为什么需要它：马头形状要在三处一致 —— exe 图标、顶栏/首屏 brandMark、
 * 宣传预览页。以前路径抄了两份（icon.js + index.html），结果改了代码那份、
 * 界面还是旧图，图标和界面各说各话，而且没有任何报错。
 *
 * 用法：
 *   node scripts/sync-brand-mark.js          # 写入
 *   node scripts/sync-brand-mark.js --check  # 只校验（CI / 提交前），不一致退出码 1
 *
 * 替换靠 HTML 里的成对标记，不靠正则猜形状：
 *   <!-- BRAND:MARK:START --> ... <!-- BRAND:MARK:END -->
 */

const fs = require('node:fs');
const path = require('node:path');
const { PALETTE, markBody, markDefs } = require('../src/main/brand-mark');

const ROOT = path.join(__dirname, '..');
const START = '<!-- BRAND:MARK:START -->';
const END = '<!-- BRAND:MARK:END -->';

/** 需要保持同源的 HTML（渲染层 + 宣传预览桩） */
function targets() {
  const dir = path.join(ROOT, 'src', 'renderer');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(dir, f))
    .filter((p) => fs.readFileSync(p, 'utf8').includes(START));
}

/**
 * 生成 symbol 块。
 * 界面里底板留 8px 内缩（顶栏尺寸小，贴边会显得挤），图标是全出血 ——
 * 差别只在底板矩形，马头路径完全一致。
 */
function block() {
  const bg = PALETTE.bgStops.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join('');
  return `${START}
    <svg class="brand-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="lgBrand" x1="0" y1="0" x2="0.85" y2="1">${bg}</linearGradient>
        ${markDefs()}
        <!-- 顶光：软渐变。用不透明矩形硬切的话，缩到 32px 会看成一条"地平线" -->
        <linearGradient id="lgGloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.14"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
        <symbol id="brandMark" viewBox="0 0 256 256">
          <!-- 圆角方底（界面里留 8px 内缩，顶栏小尺寸贴边会显挤；图标是全出血） -->
          <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#lgBrand)"/>
          <rect x="8" y="8" width="240" height="140" rx="56" fill="url(#lgGloss)"/>
          ${markBody({ mane: true, face: true }).split('\n').join('\n          ')}
        </symbol>
        <!-- 单色马头：给"容器自己已有底色"的位置用（助手头像、激活页标记）。
             用 currentColor 所以深色/浅色主题都看得见；不画五官，
             那些位置只有 28~42px，眼睛会糊成脏点。 -->
        <symbol id="brandMarkMono" viewBox="0 0 256 256">
          ${markBody({ mane: true, face: false, mono: true }).split('\n').join('\n          ')}
        </symbol>
      </defs>
    </svg>
    ${END}`;
}

/**
 * 替换 START..END 之间（含标记本身）的内容。
 *
 * ⚠️ 每一行（含首行）都要补上原缩进，否则首行会掉到第 0 列，
 * 下次再跑时算出来的 indent 就变了 → 替换不幂等，--check 永远报不一致。
 */
function replaceBlock(text, next) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a) return null;
  const lineStart = text.lastIndexOf('\n', a) + 1;
  const indent = text.slice(lineStart, a);
  if (!/^\s*$/.test(indent)) return null;   // 标记不在行首 → 文件被手改过，别乱动
  const indented = next.split('\n').map((l) => (l ? indent + l : l)).join('\n');
  return text.slice(0, lineStart) + indented + text.slice(b + END.length);
}

const check = process.argv.includes('--check');
const next = block();
let changed = 0;
let missing = 0;

for (const file of targets()) {
  const cur = fs.readFileSync(file, 'utf8');
  const out = replaceBlock(cur, next);
  if (out === null) { missing += 1; continue; }
  if (out === cur) continue;
  changed += 1;
  if (check) {
    console.log(`✗ ${path.relative(ROOT, file)} 的品牌标记与真源不一致`);
  } else {
    fs.writeFileSync(file, out, 'utf8');
    console.log(`✓ ${path.relative(ROOT, file)}`);
  }
}

// 反向守卫：旧马头路径不该在任何地方复活
const OLD = 'M152 26 C146 36 142 46';
const stale = targets().filter((f) => fs.readFileSync(f, 'utf8').includes(OLD));
if (stale.length) {
  console.log('✗ 仍残留旧马头路径：', stale.map((f) => path.relative(ROOT, f)).join(', '));
  process.exit(1);
}

if (check && changed) process.exit(1);
console.log(
  check
    ? `${changed ? '需要同步' : '已同步'}（检查 ${targets().length} 个文件，缺标记 ${missing}）`
    : `同步完成：${changed} 个文件更新，${missing} 个缺标记`,
);
