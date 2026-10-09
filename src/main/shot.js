'use strict';

/**
 * 通用截图工具：把 HTML 文件或 URL 渲染成 PNG。
 * 用于目检 drawio 预览、报告页面等的真实渲染效果。
 *
 * 用法：node scripts/dev.js --shot <file.html|url> <out.png> [width] [height]
 */

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow } = require('electron');

async function capturePageToFile(target, outPath, opts = {}) {
  const win = new BrowserWindow({
    width: opts.width || 1200,
    height: opts.height || 900,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  try {
    if (/^https?:\/\//.test(target)) {
      await win.loadURL(target);
    } else {
      await win.loadFile(path.resolve(target));
    }
    await new Promise((r) => setTimeout(r, opts.wait || 2000));

    const img = await win.webContents.capturePage();
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, img.toPNG());

    const s = img.getSize();
    return { path: abs, size: `${s.width}x${s.height}` };
  } finally {
    win.destroy();
  }
}

/**
 * 截图前：把画面等到"入场动画全部落定且已是终态"。
 *
 * 为什么放在 shot.js 而不是各自实现：宣传截图（promo.js）和冒烟截图（smoke.js）
 * 截的是同一个首屏，而首屏现在带入场动画。两边各写一份"等一会儿"必然漂走 ——
 * 本仓库已经因为"同一事实两处手抄"翻过几次车（版本号、套件数、锚点）。
 *
 * 判据只等**有限次**的动画，不等两类东西：
 *   · CSSTransition —— hover / 折叠随时触发，算进来会被无关的 0.16s 效果拖住；
 *   · iterations === Infinity 的循环微动（机器人漂浮、眨眼、浮块）—— 它们永不结束，
 *     等它们等于必然超时。用 timing 判断而不是写死类名，动效改名也不会腐烂。
 *
 * 降级友好：系统开了"减少动态效果"时动画全被关掉，entrance 为 0 → 直接通过。
 */
const SETTLE_JS = `(() => {
  const all = (document.getAnimations ? document.getAnimations() : []);
  const isKeyframeAnim = (a) => {
    const n = (a.constructor && a.constructor.name) || '';
    return n !== 'CSSTransition';
  };
  const isLoop = (a) => {
    try {
      const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
      return !t || t.iterations === Infinity;
    } catch (e) { return true; }   // 读不出 timing 就当作循环，别死等
  };
  const entrance = all.filter(a => isKeyframeAnim(a) && !isLoop(a));
  const UNSETTLED = ['pending', 'running', 'paused'];
  const pending = entrance.filter(a => a.pending || UNSETTLED.includes(a.playState)).length;

  // 终态断言：动画跑完后，计算出来的 opacity 必须等于该动画最后一帧的值。
  // 不等就是画面停在半路（或 fill 写错，把元素定在了错误的透明度上）。
  //
  // ⚠️ 取元素只能走 effect.target **属性**，不能用 effect.getTarget() ——
  //    本机实测 getTarget 不是函数。上一版拿它做存在性判断后 continue，
  //    结果这段断言一条都没执行过，打出来的 "mismatch: []" 是"没查"而不是
  //    "查了没问题"。所以把 checked 带出去，由调用方确认它 > 0。
  const mismatch = [];
  let checked = 0;
  if (pending === 0) {
    for (const a of entrance) {
      if (!a.effect || !a.effect.getKeyframes) continue;
      const el = a.effect.target || (a.effect.getTarget ? a.effect.getTarget() : null);
      if (!el || el.nodeType !== 1) { mismatch.push('取不到动画元素，终态未校验'); continue; }
      const kfs = a.effect.getKeyframes();
      const last = kfs && kfs.length ? kfs[kfs.length - 1] : null;
      if (!last || last.opacity === undefined || last.opacity === null) continue;
      const want = parseFloat(last.opacity);
      const got = parseFloat(getComputedStyle(el).opacity);
      if (!isFinite(want) || !isFinite(got)) continue;
      checked += 1;
      if (Math.abs(want - got) > 0.02) {
        // SVG 元素的 className 是 SVGAnimatedString 对象，只能走 getAttribute
        const who = (el.getAttribute && el.getAttribute('class')) || el.tagName;
        mismatch.push(who + ': 期望 ' + want + ' 实际 ' + got);
      }
    }
  }
  return JSON.stringify({
    entrance: entrance.length,
    pending,
    mismatch,
    checked,
    hasEmptyState: !!document.querySelector('.empty-state'),
  });
})()`;

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} name  仅用于报错与日志定位（哪一张截图卡住了）
 * @returns {Promise<object>} SETTLE_JS 的统计结果
 */
async function settleForShot(win, name = '', timeoutMs = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = JSON.parse(await win.webContents.executeJavaScript(SETTLE_JS));
    if (last.pending === 0 && last.mismatch.length === 0) {
      /* 有入场动画却一条终态都没校验 = 断言空转，等同于没写。
         宁可在这里炸，也不要"看起来校验过了"。 */
      if (last.entrance > 0 && last.checked === 0) {
        throw new Error(
          `截图前检查失败[${name}]：入场动画 ${last.entrance} 条已结束，但终态校验一条都没做成`
          + '（effect.target 取不到元素？）—— 断言空转不能当成通过。',
        );
      }
      return last;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `截图前检查失败[${name}]：入场动画没落定 —— 仍在进行 ${last ? last.pending : '?'} 条`
    + `（入场共 ${last ? last.entrance : '?'} 条）`
    + (last && last.mismatch.length ? `，终态不符 ${last.mismatch.join('; ')}` : '')
    + '。这时候截出来是半透明的过渡画面（字节上与其它图不同，能骗过查重，但是废图）。'
    + '查一下：是不是新加了不结束的入场动画（应为有限次），或 fill 没写导致停在 from 帧。',
  );
}

module.exports = { capturePageToFile, settleForShot, SETTLE_JS };
