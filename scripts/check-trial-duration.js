#!/usr/bin/env node
'use strict';

/**
 * 体验期时长守卫。
 *
 * 防的是这一类事故：**改了 TRIAL_MS，但某处文案没说谎也没报错，只是从此变成假话。**
 * 2 小时 → 1 天这次改动就是活例子：需要同步的地方一共 8 处，
 * 靠人记必然漏，而漏掉的后果是**用户看到的界面写着 2 小时、实际给 24 小时**，
 * 或者反过来在 README 上承诺了软件没给的东西。
 *
 * 检查项（每条都对应一个真实可能发生的漂移）：
 *
 *  ① license.js 的 TRIAL_MS 必须能解析 —— 所有其他检查都以它为基准。
 *     解析不到就直接红：宁可误报，也不要"取不到值所以没比对"的空转守卫。
 *
 *  ② 用户可见文档（README / 用户指南 / 卖家手册）里，凡是
 *     「(免费)?体验|试用 + 数字 + 小时|天」这类时长表述，数字必须等于 TRIAL_MS。
 *     漏了这一条 = 页面承诺与软件行为不一致，而这是掏钱那一屏的信息。
 *
 *  ③ src/ 运行时代码里**禁止**出现「数字 + 小时/天 + 体验/试用」的写死文案。
 *     界面文案必须走 license.js 的 formatRemaining()，或者压根不写时长
 *     （激活页现在就是"免费体验时间已用完"）。
 *     为什么反过来比②更严：文档是人手写的说明，写清时长有价值；
 *     界面是软件自己的话，一旦写死就必然和常量分家。
 *     ⚠️ 判据刻意不含单字「试」（「再试 5 分钟」说的是代码超时，不是体验期）；
 *     预览桩 _pv*.html 也纳入扫描 —— 它们会被误用成宣传截图。
 *
 *  ④ 签发器 vendor 副本的 TRIAL_MS 必须与真源相同。
 *     vendor/license.js 是打包进 asar 的独立副本（打包后爬不到仓库外），
 *     不同步的话**卖家工具报出来的剩余时间和客户软件说的不是一回事**。
 *
 *  ⑤ license.js 注释承诺的守卫文件必须存在**且挂在 npm test 上**。
 *     这正是本文件存在的理由：注释写了"scripts/check-trial-duration.js 盯着这几处"
 *     时，那个文件还不存在 —— 承诺一条不存在的保护，比不写注释更糟。
 *     不挂进 SUITES 的守卫等于没有守卫（run-all-tests.js 也有反向孤儿检查，
 *     但那条查的是"文件存在却没挂"，这条查的是"注释指了个文件"）。
 *
 *  ⑥ 水印资源与引用必须齐备（本次改动的另一半承诺）：
 *     「反正产出都带水印，不需要靠缩时长防白嫖」这句理由成立的前提，
 *     是水印真的打得上去。所以校验 logo 文件存在、非空、是 PNG，
 *     校验两个 Python 入口引用的是同一个文件名，
 *     并硬拦水印文案里复活旧品牌 —— 这条最要命：
 *     水印是免费用户替我们转发广告的地方，写错品牌等于把流量送给别人。
 *
 * 用法：
 *   node scripts/check-trial-duration.js             # 校验真实文件
 *   node scripts/check-trial-duration.js --self-test # 反向验证：逐条注入违规，确认都会红
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SELF_TEST = process.argv.includes('--self-test');

const LICENSE_REL = 'src/main/license.js';
const VENDOR_REL = 'tools/issuer-app/vendor/license.js';
const RUNNER_REL = 'scripts/run-all-tests.js';
const SELF_REL = 'scripts/check-trial-duration.js';

const DOC_FILES = ['README.md', 'docs/用户指南.md', 'docs/卖家手册.md'];
const PY_FILES = [
  'resources/skills/mcm-figure/scripts/mcm_style.py',
  'resources/skills/mcm-tools/scripts/mcm_docx.py',
];

/** 旧品牌残留（水印文案最容易复发的地方） */
const LEGACY_BRANDS = ['汉谟拉比', '数模工坊', '拉比法典'];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, hint) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail += 1;
  failures.push(name);
  console.log(`  ✗ ${name}${hint ? `\n      ${hint}` : ''}`);
}

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/**
 * 解析 `const TRIAL_MS = 24 * 60 * 60 * 1000;`
 *
 * 只接受"常量表达式"这一种写法：支持 h/d/分钟与加减乘除，
 * 用 Function 求值而不是正则猜数字，这样 `24 * 60 * 60 * 1000`
 * 和 `86400000` 都能拿到同一个结果。
 */
function parseTrialMs(src) {
  const m = src && src.match(/^\s*const\s+TRIAL_MS\s*=\s*([^;]+);/m);
  if (!m) return null;
  const expr = m[1].trim();
  if (!/^[\s\d.+\-*/%()]+$/.test(expr)) return null; // 含标识符/函数调用 → 拒绝求值
  try {
    const v = Function(`"use strict"; return (${expr});`)();
    return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  } catch {
    return null;
  }
}

/** 毫秒 → 本仓库文档统一采用的口径：整天说「N 天」，不足一天说「N 小时」 */
function durationWords(ms) {
  const days = ms / 86400000;
  if (Number.isInteger(days) && days >= 1) return { unit: '天', n: days };
  const hours = ms / 3600000;
  if (Number.isInteger(hours)) return { unit: '小时', n: hours };
  const mins = ms / 60000;
  if (Number.isInteger(mins)) return { unit: '分钟', n: mins };
  return null;
}

/**
 * 抽取「时长承诺」句子。
 * 命中形如：免费体验 2 小时 / 免费试 1 天 / 体验 1 天 / 试用 3 小时 / 2 小时体验
 * 返回 [{ phrase, n, unit }]
 *
 * 动词备选要把单字「试」也算上：用户指南的标题写的是「先免费试 1 天」。
 * 漏了它就等于对这份文档彻底失明 —— 而它恰恰是买家最先读的那一份。
 * 「试试这道题」这类不带数字的用法不会被误伤（后面必须有 \d+ 与单位）。
 */
function extractDurationClaims(text) {
  const out = [];
  const re = /(?:免费)?(?:体验|试用|试)\s*(\d+)\s*(小时|天|分钟)|(?:^|[^0-9.])(\d+)\s*(小时|天|分钟)\s*(?:体验|试用|试)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out.push({ phrase: m[0].trim(), n: Number(m[1]), unit: m[2] });
    else out.push({ phrase: m[0].trim(), n: Number(m[3]), unit: m[4] });
  }
  return out;
}

/** 把 (n, unit) 归一到毫秒，用于和 TRIAL_MS 比对 */
function toMs(n, unit) {
  if (unit === '天') return n * 86400000;
  if (unit === '小时') return n * 3600000;
  if (unit === '分钟') return n * 60000;
  return NaN;
}

/** 逐行扫描，便于报出文件:行号 */
function claimsIn(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const c of extractDurationClaims(line)) hits.push({ ...c, line: i + 1, text: line.trim() });
  });
  return hits;
}

// 写死时长文案的形态（运行时代码里一律不许出现）
//
// ⚠️ 这里**刻意不含单字「试」**（与文档判据 extractDurationClaims 不同）：
// 「试」在界面里太常见，「加大超时再试（10 分钟）」「再试 5 分钟」说的都是
// **执行代码的超时**，跟体验期毫无关系。真误伤过一次。
// 界面要写死体验时长，只会写成「体验/试用 + 时长」，所以只收这两个词。
// 反过来文档里「先免费试 1 天」是真实的体验承诺，所以那边保留「试」。
const HARD_CODED = /(?:体验|试用)\s*(?:的)?\s*\d+\s*(?:小时|天|分钟)|\d+\s*(?:小时|天|分钟)\s*(?:的)?\s*(?:体验|试用)/;

function scanRuntimeHardcodes(rel, text) {
  const bad = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // 注释允许讲历史
    if (HARD_CODED.test(line)) bad.push({ line: i + 1, text: t.slice(0, 100) });
  });
  return bad;
}

// ===========================================================================
// 正常模式：校验真实文件
// ===========================================================================
function runRealChecks() {
  console.log('=== 体验期时长守卫 ===\n');

  // ---- ① 基准值必须解析得到 ----
  const licSrc = read(LICENSE_REL);
  check(`① ${LICENSE_REL} 存在`, licSrc !== null);
  if (licSrc === null) return;
  const trialMs = parseTrialMs(licSrc);
  check('① TRIAL_MS 可解析为常量毫秒数', trialMs !== null, '改成变量或函数后本守卫会失明，必须让人知道');
  if (trialMs === null) return;

  const expect = durationWords(trialMs);
  console.log(`\n  基准：TRIAL_MS = ${trialMs} ms` +
    (expect ? ` = ${expect.n} ${expect.unit}` : '（非整天/整小时/整分钟，走专用文案）'));

  // ---- ② 文档不许说假话 ----
  console.log('\n  [② 用户可见文档的时长口径]');
  for (const rel of DOC_FILES) {
    const text = read(rel);
    if (text === null) {
      check(`② ${rel} 存在`, false, '文档不见了');
      continue;
    }
    const claims = claimsIn(text);
    if (!claims.length) {
      // 三份文档都该写清给多久：一个数字都没有 = 买家/用户无从得知，
      // 而"文档没写"不会被任何人发现，正是本守卫要防的静默漂移。
      check(`② ${rel} 至少写了一处体验时长`, false,
        '一个时长数字都没写；若有意的话请连同本检查一起删，别让它空转');
      continue;
    }
    const wrong = docClaimsWrong(text, trialMs);
    check(`② ${rel} 的 ${claims.length} 处时长 = ${expect ? `${expect.n} ${expect.unit}` : trialMs + 'ms'}`,
      wrong.length === 0,
      wrong.map((w) => `L${w.line}: 「${w.phrase}」(=${toMs(w.n, w.unit) / 3600000}h) → ${w.text.slice(0, 70)}`).join('\n      '));
  }

  // ---- ③ 运行时代码不许写死 ----
  console.log('\n  [③ 界面/主进程不许写死时长]');
  const runtimeFiles = [];
  const walk = (dir, filterRe) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, filterRe); continue; }
      if (!filterRe.test(e.name)) continue;
      // _pv* 预览桩**也扫**：它们是 git 跟踪的品牌界面，
      // scrub-wechat.js 的注释就写明"将来可能被误用为宣传截图"。
      // 截图会被发出去，桩里的假话同样是假话。
      if (/^_(drawer_preview|tmp|test)/.test(e.name)) continue; // 纯开发期草稿才放过
      runtimeFiles.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(ROOT, 'src', 'main'), /\.js$/);
  walk(path.join(ROOT, 'src', 'renderer'), /\.(js|html)$/);
  const offenders = [];
  for (const rel of runtimeFiles) {
    if (rel === LICENSE_REL) continue;            // 常量本体在这里
    if (rel.endsWith('license.js')) continue;     // formatRemaining 是允许的出口
    const text = read(rel);
    if (!text) continue;
    for (const h of scanRuntimeHardcodes(rel, text)) offenders.push(`${rel}:${h.line} → ${h.text}`);
  }
  check(`③ 扫描 ${runtimeFiles.length} 个运行时代码文件，无写死时长文案`,
    offenders.length === 0,
    offenders.join('\n      '));

  // ---- ④ vendor 同步 ----
  console.log('\n  [④ 签发器 vendor 副本同步]');
  const vendorSrc = read(VENDOR_REL);
  if (vendorSrc === null) {
    check(`④ ${VENDOR_REL} 存在`, false, '跑 node scripts/sync-issuer-app.js 生成');
  } else {
    const vMs = parseTrialMs(vendorSrc);
    check('④ vendor 的 TRIAL_MS 与真源一致', vMs === trialMs,
      `真源 ${trialMs} vs vendor ${vMs === null ? '解析失败' : vMs} —— 跑 node scripts/sync-issuer-app.js`);
  }

  // ---- ⑤ 注释承诺的守卫必须存在且挂进 npm test ----
  console.log('\n  [⑤ 注释承诺的守卫]');
  const uniq = promisedGuardNames(licSrc);
  const runnerSrc = read(RUNNER_REL) || '';
  for (const name of uniq) {
    const exists = fs.existsSync(path.join(ROOT, 'scripts', name));
    check(`⑤ 注释点名的 scripts/${name} 存在`, exists, 'license.js 的注释承诺了它，但文件不在');
    check(`⑤ scripts/${name} 挂在 npm test 上`, runnerSrc.includes(name),
      '没挂进 SUITES 的守卫永远不会被跑');
  }
  check('⑤ license.js 至少点名了一条守卫', uniq.length > 0,
    '注释里的"要同步的地方"清单若删掉承诺，本检查会退化 —— 别删');
  check('⑤ 本文件自身挂在 SUITES 里', runnerSrc.includes('check-trial-duration.js'),
    '自己没挂上就谁都不会跑我');

  // ---- ⑥ 水印齐备 ----
  console.log('\n  [⑥ 体验版水印资源与引用]');
  const logoRel = 'resources/brand/wmark-logo.png';
  const logoAbs = path.join(ROOT, logoRel);
  const logoOk = fs.existsSync(logoAbs) && fs.statSync(logoAbs).size > 800;
  check(`⑥ ${logoRel} 存在且非空壳`, logoOk,
    logoOk ? '' : '跑 node scripts/make-watermark.js 生成（由 brand-mark.js 单一真源渲染）');
  if (logoOk) {
    const buf = fs.readFileSync(logoAbs);
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    check('⑥ logo 是有效 PNG（文件签名）', isPng);
  }

  // brand 目录是否真的会进安装包：extraResources 里必须收 brand
  const pkgJson = JSON.parse(read('package.json'));
  const extra = JSON.stringify((pkgJson.build || {}).extraResources || []);
  check('⑥ resources/brand 在打包 extraResources 清单里', /brand/.test(extra),
    'Python 靠 MCM_BRAND_DIR 找 logo，打包后没这个目录水印就只剩文字');

  const wmFiles = PY_FILES.map((rel) => [rel, read(rel)]);
  for (const [rel, text] of wmFiles) {
    if (!text) { check(`⑥ ${rel} 存在`, false); continue; }
    const hasBrandEnv = /MCM_BRAND_DIR/.test(text);
    check(`⑥ ${rel} 走 MCM_BRAND_DIR 定位 logo`, hasBrandEnv,
      '没有它打包后 Python 无从找到 logo（技能脚本没有仓库相对路径）');
    const legacy = legacyIn(text);
    check(`⑥ ${rel} 水印文案无旧品牌`, legacy.length === 0,
      legacy.map((b) => `发现「${b}」`).join('、') + ' —— 水印是免费用户替我们打广告的地方');
  }
  // 两个入口必须指向同一个 logo 文件名，否则改了一边另一边静默失效
  const logoNames = wmFiles.filter(([, t]) => t).map(([, t]) => wmarkLogoOf(t));
  check('⑥ 两个 Python 入口的 WMARK_LOGO 同名',
    logoNames.every((x) => x) && new Set(logoNames).size === 1,
    `实测：${logoNames.join(' / ')} —— 不一致会让其中一处加载不到 logo`);
  check('⑥ WMARK_LOGO 指向的文件真实存在',
    logoNames.every((x) => x) && fs.existsSync(path.join(ROOT, 'resources', 'brand', logoNames[0])),
    `文件名 ${logoNames[0]} 与 resources/brand/ 下实际文件对不上`);

  // 主进程必须真的注入 MCM_BRAND_DIR（否则上面全对也没用）
  const toolsSrc = read('src/main/agent/tools.js') || '';
  check('⑥ tools.js 给子进程注入 MCM_BRAND_DIR', /MCM_BRAND_DIR\s*[:=]/.test(toolsSrc),
    'Python 找不到 logo，水印会静默退化成纯文字');
}

/** 水印文案里的旧品牌残留 */
function legacyIn(text) {
  return LEGACY_BRANDS.filter((b) => text.includes(b));
}

/** license.js 注释里点名承诺的守卫文件名 */
function promisedGuardNames(licSrc) {
  return [...new Set([...(licSrc || '').matchAll(/scripts\/(check-[\w-]+\.js)/g)].map((m) => m[1]))];
}

/** Python 入口声明的水印 logo 文件名（没声明返回 null，不静默当空串） */
function wmarkLogoOf(pyText) {
  return (pyText.match(/^\s*WMARK_LOGO\s*=\s*["']([^"']+)["']/m) || [])[1] || null;
}

/**
 * 找出「与基准时长不符」的文档承诺。
 *
 * ⚠️ 这是生产判定与 --self-test **共用的同一个函数**：
 * 自检如果另写一份判据，就只能证明"自检那份判据自洽"，证明不了生产检查有牙齿。
 * （本轮 license-test 的推导式断言就踩过这个坑。）
 */
function docClaimsWrong(text, trialMs) {
  return claimsIn(text).filter((c) => toMs(c.n, c.unit) !== trialMs);
}

// ===========================================================================
// 反向验证：每注入一个违规，对应检查必须变红
// ===========================================================================
/**
 * 跑一遍"提取器 + 判定"，确认某句文案会被判成违规。
 * 不碰文件系统，只验判据本身 —— 用来给每条检查配一个正/负样本。
 */
function judge(kind, line, trialMs) {
  if (kind === 'doc') return docClaimsWrong(line, trialMs).length > 0;
  // 'rt' 走生产用的同一个 scanRuntimeHardcodes，顺带验注释行会被跳过
  return scanRuntimeHardcodes('x', line).length > 0;
}

function runSelfTest() {
  console.log('=== 体验期时长守卫 · 反向验证 ===');
  console.log('每条注入一个违规，确认对应判据会变红。全部"报警"才算有牙齿。\n');

  const trialMs = parseTrialMs(read(LICENSE_REL));
  if (trialMs === null) { console.error('✗ 解析不到 TRIAL_MS，自检无从比对'); process.exit(1); }
  const licSrc = read(LICENSE_REL);

  const cases = [
    // ② 文档口径：写错时长必须判违规
    ['doc 写「2 小时」而基准是 1 天',
      judge('doc', '打开即免费体验 2 小时（全功能）', trialMs), true],
    ['doc 写「免费体验 1 天」= 基准，应放行',
      judge('doc', '打开即免费体验 1 天（全功能）', trialMs), false],
    ['doc 写「试用 12 小时」是基准一半，必须红',
      judge('doc', '可以先试用 12 小时看看', trialMs), true],
    ['doc 写「体验 30 分钟」必须红',
      judge('doc', '免费体验 30 分钟', trialMs), true],
    // 不误伤：讲价格/讲赛事天数/讲宽限期的句子不是体验时长
    ['「卡密有效期 365 天」不该当成长度承诺',
      judge('doc', '全能包 ¥168，有效期 365 天', trialMs), false],
    ['「离线宽限 7 天」不该红',
      judge('doc', '过期后还有 7 天离线宽限', trialMs), false],

    // ③ 运行时代码写死时长
    ['app.js 写「2 小时体验时间已用完」必须红',
      judge('rt', "$('lockSub').textContent = '2 小时体验时间已用完。';", trialMs), true],
    ['app.js 写「体验 1 天」也算写死，必须红',
      judge('rt', "tip('体验 1 天，产出带水印');", trialMs), true],
    ['不含时长的界面文案应放行',
      judge('rt', "$('lockSub').textContent = '免费体验时间已用完。';", trialMs), false],
    ['formatRemaining 的小时分支不该被误判为写死',
      judge('rt', 'if (h > 0) return `还剩 ${h} 小时 ${m} 分`;', trialMs), false],
    // 真实误伤样本：这是「执行代码超时」按钮，与体验期无关。
    // 钉住它，防止以后有人把正则改宽又把正常代码判成违规。
    ['「加大超时再试（10 分钟）」是重试时长，不该红',
      judge('rt', 'data-rc="long">加大超时再试（10 分钟）</button>', trialMs), false],
    ['「再试 5 分钟」（单字试）不该算体验承诺',
      judge('rt', "tip('超时了，再试 5 分钟');", trialMs), false],
    ['「体验 2 小时」（写死且时长错）必须红',
      judge('rt', "badge.textContent = '体验 2 小时';", trialMs), true],
    ['「体验2小时」不留空格也要抓到',
      judge('rt', "tip('免费体验2小时');", trialMs), true],
  ];

  let bad = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${name}  [判为${got ? '违规' : '合规'}，期望${want ? '违规' : '合规'}]`);
  }

  // ①④⑤⑥ 这几条依赖文件内容，用"合成一份坏输入喂给同一个判据"来验，
  // 不去改真实文件（改文件再还原一旦中途崩，留下的就是被弄坏的工作树）。
  const structural = [];

  // ④ vendor 同步判据：喂一份漂移的副本，比对必须报不一致
  {
    const drifted = (read(VENDOR_REL) || '').replace(/const TRIAL_MS = [^;]+;/, 'const TRIAL_MS = 2 * 60 * 60 * 1000;');
    structural.push(['④ vendor 被改成 2 小时 → 同步检查报警', parseTrialMs(drifted) !== trialMs, true]);
    structural.push(['④ 真实 vendor 当前与真源一致（红=真源漂移）',
      parseTrialMs(read(VENDOR_REL)) === trialMs, true]);
  }

  // ① 解析器：非常量表达式必须拒绝（否则会拿 null 去比对而静默通过）
  structural.push(['① TRIAL_MS 写成变量时拒绝求值',
    parseTrialMs("const X=1; const TRIAL_MS = X * 1000;") === null, true]);
  structural.push(['① TRIAL_MS 缺失时返回 null（不许当成 0）',
    parseTrialMs('const OFFLINE_GRACE_MS = 1000;') === null, true]);
  structural.push(['① 直接毫秒字面量能解析',
    parseTrialMs('const TRIAL_MS = 86400000;') === 86400000, true]);
  structural.push(['① 表达式写法能解析',
    parseTrialMs('const TRIAL_MS = 24 * 60 * 60 * 1000;') === 86400000, true]);

  // durationWords：换算口径（决定文档该写「1 天」还是「24 小时」）
  structural.push(['口径换算 86400000 → 1 天',
    durationWords(86400000)?.unit === '天' && durationWords(86400000)?.n === 1, true]);
  structural.push(['口径换算 2h → 2 小时',
    durationWords(2 * 3600000)?.unit === '小时' && durationWords(2 * 3600000)?.n === 2, true]);
  structural.push(['口径换算 90 分 → 分钟档（非整小时不许谎报成小时）',
    durationWords(90 * 60000)?.unit === '分钟' && durationWords(90 * 60000)?.n === 90, true]);
  structural.push(['口径换算 100 秒 → 无整数档，返回 null', durationWords(100 * 1000) === null, true]);

  // ⑤ 注释点名提取：必须真的能从源码里提出守卫名，否则整条检查空转
  {
    const synthetic = "见\n * scripts/check-trial-duration.js 盯着。\n * 还有 scripts/nope.js\n";
    const found = [...synthetic.matchAll(/scripts\/(check-[\w-]+\.js)/g)].map((m) => m[1]);
    structural.push(['⑤ 能提取出注释点名的守卫名', found.includes('check-trial-duration.js'), true]);
    structural.push(['⑤ 非 check-* 文件名不误提（避免把普通路径当承诺）',
      found.includes('nope.js'), false]);
    structural.push(['⑤ 真实 license.js 确实点到了本守卫（红=注释承诺被删）',
      promisedGuardNames(licSrc).includes('check-trial-duration.js'), true]);
    // 反向：把注释里的承诺删掉，这条应当立刻变红
    const stripped = licSrc.replace(/check-trial-duration\.js/g, '某个不存在的守卫.js');
    structural.push(['⑤ 删掉本守卫的承诺后 → 提取不到本守卫（判据会报警）',
      promisedGuardNames(stripped).includes('check-trial-duration.js'), false]);
  }

  // ⑥ 旧品牌：水印文案里复活旧品牌必须被抓
  structural.push(['⑥ 水印文案含旧品牌 → 报警',
    legacyIn('WATERMARK_DEFAULT = "体验版 · 抖音/B站 @汉谟拉比法典"').length > 0, true]);
  structural.push(['⑥ 新品牌文案应放行',
    legacyIn('WATERMARK_DEFAULT = "阿一古数模 · 体验版"').length === 0, true]);

  // ⑥ WMARK_LOGO 一致性判据
  {
    const a = wmarkLogoOf(read(PY_FILES[0]) || '');
    const b = wmarkLogoOf(read(PY_FILES[1]) || '');
    structural.push(['⑥ 两入口当前同名（红=真源已漂移）', !!a && a === b, true]);
    structural.push(['⑥ 制造一个不一致 → 判据报警', new Set([a, 'other.png']).size === 1, false]);
    structural.push(['⑥ 缺 WMARK_LOGO 声明时返回 null（不许静默当成一致）',
      wmarkLogoOf('X = 1') === null, true]);
  }

  for (const [name, got, want] of structural) {
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  }

  console.log();
  if (bad) {
    console.error(`✗ 反向验证有 ${bad} 项不符预期 —— 判据本身不可信，别把上面的守卫当保护`);
    process.exit(1);
  }
  console.log(`✓ 全部 ${cases.length + structural.length} 项反向验证符合预期：` +
    '该报警的都报了，不该误伤的都没误伤');
}

if (SELF_TEST) runSelfTest();
else runRealChecks();

if (fail) {
  console.error(`\n✗ 体验期时长守卫：${fail} 项不通过`);
  process.exit(1);
}
if (!SELF_TEST) console.log('\n✓ 体验期时长守卫：全部通过');
