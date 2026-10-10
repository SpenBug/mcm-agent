#!/usr/bin/env node
'use strict';

/**
 * 独立签发器应用（tools/issuer-app）的离线测试。
 *
 * 为什么必须有这一套：应用是**第 4 个签发入口**（命令行 / 旧 HTTP 服务 /
 * keygen 网页 / 桌面应用），而它跑在打包后的 asar 里，布局与源码目录不同：
 *   · vendor/ 是同步进来的副本，require 路径被改写过了
 *   · 数据目录在 %APPDATA%，不是仓库目录
 * 这两点都**不会在开发态自然暴露**，必须专门测。
 *
 * 本套件不启动 Electron（跑得快、不需要图形界面）：
 * 只验证 vendor 副本能被正确加载、以及核心链路（签发→验签→台账→邀请→导入导出）
 * 在"应用的数据目录"这一形态下成立。
 * 窗口 / IPC / 界面渲染由 scripts/issuer-app-e2e.js 在真 Electron 里覆盖。
 *
 * ⚠️ 全程用临时目录，绝不碰 %APPDATA% 与真实台账。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'tools', 'issuer-app');
const VENDOR = path.join(APP, 'vendor');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? `  [${extra}]` : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ayigu-issuer-app-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ } });

// 私钥：优先用真的（能验签），没有就临时造一把（本套件仍要能跑）
const realPrivPath = path.join(ROOT, 'keys', 'license-private.pem');
const hasRealKey = fs.existsSync(realPrivPath);
if (hasRealKey) {
  fs.copyFileSync(realPrivPath, path.join(tmp, 'license-private.pem'));
} else {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(tmp, 'license-private.pem'),
    privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8');
}

/* ---------------------------------------------------------------- ① 结构 */

console.log('=== ① 应用结构完整（缺文件会打包出一个跑不起来的 exe）===');
for (const rel of ['package.json', 'src/main.js', 'src/preload.js',
  'src/renderer/index.html', 'src/renderer/app.js',
  'vendor/issuer-core.js', 'vendor/competitions.js', 'vendor/license.js']) {
  check(`存在 ${rel}`, fs.existsSync(path.join(APP, rel)));
}

const appPkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
check('main 指向 src/main.js', appPkg.main === 'src/main.js', appPkg.main);
check('打包 files 含 src 与 vendor', appPkg.build.files.includes('src/**/*')
  && appPkg.build.files.includes('vendor/**/*'), JSON.stringify(appPkg.build.files));
check('产物名是英文（中文附件名会被 GitHub 吃掉）',
  /^ayigu-issuer/.test(appPkg.build.portable.artifactName), appPkg.build.portable.artifactName);

/* ---------------------------------------------------------------- ② 安全 */

console.log('\n=== ② vendor 里绝不能有私钥或台账（应用会被分发/拷贝）===');
const FORBIDDEN = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '私钥 PEM' },
  { re: /^card,machine,edition,competition,issuedAt/m, why: '卡密台账表头' },
  { re: /^inviterCode,buyer,competition/m, why: '邀请台账表头' },
];
for (const f of fs.readdirSync(VENDOR)) {
  const t = fs.readFileSync(path.join(VENDOR, f), 'utf8');
  for (const { re, why } of FORBIDDEN) {
    check(`vendor/${f} 不含${why}`, !re.test(t));
  }
}

console.log('\n=== ③ 主进程不该自己算卡号/价格（否则又抄了一份）===');
const mainSrc = fs.readFileSync(path.join(APP, 'src', 'main.js'), 'utf8');
check('main.js 复用 vendor 核心', /require\(.*vendor.*issuer-core/.test(mainSrc));
check('main.js 不自己拼卡号', !/MCM-\$\{/.test(mainSrc), '出现了卡号拼装');
check('main.js 不写死价格', !/¥\s*\d+/.test(mainSrc), '出现了写死价格');
check('不起 HTTP 服务（走 IPC，攻击面更小）', !/require\('node:http'\)/.test(mainSrc));
check('开启了 contextIsolation', /contextIsolation:\s*true/.test(mainSrc));
check('关闭了 nodeIntegration', /nodeIntegration:\s*false/.test(mainSrc));

/* ---------------------------------------------------------------- ④ 链路 */

console.log('\n=== ④ 核心链路（以"应用的数据目录"形态跑）===');
const { createIssuer } = require(path.join(VENDOR, 'issuer-core'));
const comps = require(path.join(VENDOR, 'competitions'));
const license = require(path.join(VENDOR, 'license'));
const core = createIssuer({ dataDir: tmp, comps, license });

check('vendor 的 core 能解析同目录依赖', Array.isArray(comps.COMPETITIONS) && comps.COMPETITIONS.length > 0);
check('数据目录被采纳（不是仓库目录）', core.dataDir === tmp, core.dataDir);
check('台账落在数据目录', core.ledgerPath === path.join(tmp, 'issued.csv'), core.ledgerPath);

const M = '7E842A70F9986EB7';
const r = core.issue({ machine: M, days: 30, competition: 'cumcm', buyer: '应用测试' });
check('签发成功', /^MCM-\d{4}-\d{4}$/.test(r.payload.card), r.payload.card);
check('价格取自数据源', r.price === comps.PRICES.cumcm, `${r.price} vs ${comps.PRICES.cumcm}`);
check('返回邀请码', /^\d{6}$/.test(r.inviteCode), r.inviteCode);
check('台账写入', core.readLedger().length === 1, String(core.readLedger().length));
check('列映射正确', core.readLedger()[0].competition === 'cumcm');

if (hasRealKey) {
  check('本机验签通过', core.verify(r.credential, M).ok === true, core.verify(r.credential, M).why);
  check('换机被拒（一机一码）', core.verify(r.credential, 'AAAAAAAAAAAAAAAA').ok === false);
} else {
  console.log('  · 本机无私钥，跳过验签断言');
}

console.log('\n=== ⑤ 排号不撞（有空洞也取 max+1）===');
check('空台账 → 1', core.nextSeq(2026, []) === 1);
check('有空洞（0001,0003）→ 4', core.nextSeq(2026, [{ card: 'MCM-2026-0001' }, { card: 'MCM-2026-0003' }]) === 4);
check('跨年不影响本年', core.nextSeq(2026, [{ card: 'MCM-2027-0042' }]) === 1);

console.log('\n=== ⑥ 邀请记账 ===');
const inv = core.recordInvite({ inviterCode: r.inviteCode, buyer: '张三' });
check('记录成功', inv.count === 1, String(inv.count));
check('whoIs 找到推荐人', core.whoIs(r.inviteCode)?.card === r.payload.card);
core.recordInvite({ inviterCode: r.inviteCode, buyer: '李四' });
core.recordInvite({ inviterCode: r.inviteCode, buyer: '王五' });
check('满 3 人', core.inviteStats()[0].count === 3, String(core.inviteStats()[0].count));
check('非法邀请码被拒', (() => {
  try { core.recordInvite({ inviterCode: 'abc' }); return false; } catch { return true; }
})());

console.log('\n=== ⑦ 导入解析与导出往返 ===');
const csv = '卡号,机器码,版本,赛事,签发时间,到期时间,买家,备注\n'
  + 'MCM-2026-0009,7E842A70F9986EB7,pro,华数杯,2026-10-01,2027-10-01,客户甲,\n'
  + 'MCM-2026-0010,7E842A70F9986EB7,pro,不存在的赛,2026-10-02,2027-10-02,客户乙,\n';
const parsed = core.parseImportCsv(csv, { existingCards: new Set(core.readLedger().map((x) => x.card)) });
check('解析出 2 行', parsed.rows.length === 2, String(parsed.rows.length));
check('中文赛事名能认出', parsed.rows[0].competition === 'huashu', parsed.rows[0].competition);
check('未知赛事不偷偷改成 all', parsed.rows[1].competition === '不存在的赛' && parsed.unknown.length === 1,
  `${parsed.rows[1].competition} / unknown=${parsed.unknown.length}`);
core.importRows(parsed.rows);
check('导入后台账 3 行', core.readLedger().length === 3, String(core.readLedger().length));
check('中文表头导出', core.ledgerToCsvZh().startsWith('卡号,机器码'));
check('英文表头导出', core.ledgerToCsv().startsWith('card,machine'));
check('英文 CSV 往返可再导入', (() => {
  const p = core.parseImportCsv(core.ledgerToCsv(), { existingCards: new Set() });
  return !p.error && p.rows.length === 3;
})());

console.log(`\n结果：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
