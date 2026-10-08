#!/usr/bin/env node
/**
 * 卡密签发器（本地图形界面）
 *
 *   node tools/issuer.js          # 起服务并自动开浏览器
 *
 * 设计要点：
 *   - 只监听 127.0.0.1，局域网里别人访问不到。
 *   - **私钥永远留在 Node 这边**，浏览器只拿到签好的卡密，拿不到密钥。
 *   - 带一个随机 token：防止你浏览器里别的网页偷偷调这个本地接口。
 *   - 签发逻辑直接 require ./issue.js —— 不复制一份，保证和命令行版完全一致。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const { issue, pretty, readLedger } = require('./issue.js');

const TOKEN = process.env.MCM_ISSUER_TOKEN || crypto.randomBytes(12).toString('hex');
const PORT = Number(process.env.MCM_ISSUER_PORT || 38901);

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>阿一古数模 · 卡密签发</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 60px;
    font: 14px/1.65 "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
    background: #0f172a; color: #e6e8f0;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { font-size: 12.5px; color: #8b93a8; margin-bottom: 22px; }
  .card {
    background: #151d33; border: 1px solid rgba(255,255,255,.09);
    border-radius: 14px; padding: 20px 22px; margin-bottom: 18px;
  }
  label { display: block; font-size: 12.5px; color: #a3abc2; margin: 14px 0 6px; }
  label:first-child { margin-top: 0; }
  input, select, textarea {
    width: 100%; padding: 10px 12px; font: inherit; font-size: 13.5px;
    color: #e6e8f0; background: #0e1628;
    border: 1px solid rgba(255,255,255,.14); border-radius: 9px; outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: #6366f1; }
  .row { display: flex; gap: 12px; }
  .row > * { flex: 1; }
  button {
    margin-top: 18px; width: 100%; padding: 11px;
    font: inherit; font-size: 14px; font-weight: 600; color: #fff;
    background: linear-gradient(180deg, #6f72f5, #4f46e5);
    border: 0; border-radius: 10px; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: .5; cursor: default; }
  .ghost {
    background: transparent; color: #a3abc2;
    border: 1px solid rgba(255,255,255,.16); font-weight: 500;
  }
  .ok {
    font-size: 13px; font-weight: 600; color: #4ade80; margin-bottom: 10px;
  }
  .cred {
    font-family: Consolas, monospace; font-size: 11.5px; line-height: 1.55;
    height: 118px; resize: vertical; word-break: break-all;
    background: #0b1222; border-color: rgba(74,222,128,.35);
  }
  .meta { font-size: 12px; color: #8b93a8; margin-top: 10px; }
  .meta b { color: #c7cbe0; font-weight: 600; }
  .err {
    background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.4);
    color: #fca5a5; padding: 12px 14px; border-radius: 10px;
    font-size: 13px; margin-bottom: 18px;
  }
  .hidden { display: none !important; }
  h2 { font-size: 14px; margin: 26px 0 10px; color: #a3abc2; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid rgba(255,255,255,.07); }
  th { color: #8b93a8; font-weight: 500; }
  td.mono { font-family: Consolas, monospace; font-size: 11.5px; }
  .empty { color: #6b7385; font-size: 12.5px; padding: 10px 0; }
  .foot { font-size: 11.5px; color: #6b7385; margin-top: 26px; line-height: 1.8; }
</style>
</head>
<body>
<div class="wrap">
  <h1>卡密签发</h1>
  <div class="sub">私钥留在这台机器上，浏览器拿不到。</div>

  <div id="err" class="err hidden"></div>

  <div class="card">
    <label>① 用户的机器码</label>
    <input id="machine" placeholder="7E84-2A70-F998-6EB7（带不带横杠、大小写都行）" autocomplete="off">

    <label>② 有效期</label>
    <div class="row">
      <select id="preset">
        <option value="365">1 年（365 天）</option>
        <option value="180">半年（180 天）</option>
        <option value="90">3 个月（90 天）</option>
        <option value="30">1 个月（30 天）</option>
        <option value="7">7 天</option>
        <option value="custom">指定到期日…</option>
      </select>
      <input id="until" type="date" class="hidden">
    </div>

    <label>③ 买家备注（选填，只进你自己的台账）</label>
    <input id="buyer" placeholder="张三 / 学号 / 订单号" autocomplete="off">

    <button id="go">签 发</button>
  </div>

  <div id="out" class="card hidden">
    <div class="ok">✓ 已签发 —— 把下面这串发给用户，让他在软件里粘贴</div>
    <textarea id="cred" class="cred" readonly></textarea>
    <button id="copy" class="ghost">复制卡密</button>
    <div class="meta" id="meta"></div>
  </div>

  <h2>已签发 <span id="n">0</span> 张</h2>
  <div id="ledger"></div>

  <div class="foot">
    卡密绑定机器 —— 用户换电脑就失效，让他把新机器码发你，重新签一张。<br>
    台账在 <code>tools/issued.csv</code>（已 gitignore，别误传出去）。
  </div>
</div>

<script>
const TOKEN = '__TOKEN__';
const $ = (id) => document.getElementById(id);
const api = (p, body) => fetch(p + '?t=' + TOKEN, {
  method: body ? 'POST' : 'GET',
  headers: body ? { 'Content-Type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

function showErr(msg) {
  const el = $('err');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}

$('preset').addEventListener('change', () => {
  const custom = $('preset').value === 'custom';
  $('until').classList.toggle('hidden', !custom);
  if (custom) $('until').focus();
});

$('go').addEventListener('click', async () => {
  const machine = $('machine').value.trim();
  if (!machine) { showErr('先填机器码'); $('machine').focus(); return; }
  const preset = $('preset').value;
  const payload = {
    machine,
    buyer: $('buyer').value.trim(),
    ...(preset === 'custom' ? { until: $('until').value } : { days: Number(preset) }),
  };
  $('go').disabled = true;
  try {
    const r = await api('/api/issue', payload);
    if (!r.ok) { showErr(r.error || '签发失败'); return; }
    $('out').classList.remove('hidden');
    $('cred').value = r.credential;
    $('meta').innerHTML = '卡号 <b>' + r.card + '</b> · 机器码 <b>' + r.machinePretty
      + '</b> · 有效期至 <b>' + r.expireText + '</b>';
    loadLedger();
  } catch (e) {
    showErr('请求失败：' + e.message);
  } finally {
    $('go').disabled = false;
  }
});

$('copy').addEventListener('click', async () => {
  const ta = $('cred');
  ta.select();
  try {
    await navigator.clipboard.writeText(ta.value);
    $('copy').textContent = '✓ 已复制';
  } catch {
    document.execCommand('copy');
    $('copy').textContent = '✓ 已复制';
  }
  setTimeout(() => { $('copy').textContent = '复制卡密'; }, 1600);
});

async function loadLedger() {
  const rows = await api('/api/ledger');
  $('n').textContent = rows.length;
  if (!rows.length) {
    $('ledger').innerHTML = '<div class="empty">还没有签发记录。</div>';
    return;
  }
  const body = rows.slice(-12).reverse().map((r) =>
    '<tr><td class="mono">' + r.card + '</td><td class="mono">' + (r.machine || '')
    + '</td><td>' + (r.expireAt || '').slice(0, 10) + '</td><td>' + (r.buyer || '')
    + '</td></tr>').join('');
  $('ledger').innerHTML =
    '<table><tr><th>卡号</th><th>机器码</th><th>到期</th><th>买家</th></tr>' + body + '</table>';
}

loadLedger();
</script>
</body>
</html>`;

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  // token 校验：你浏览器里别的页面猜不到这串，就调不动这个本地接口
  if (url.searchParams.get('t') !== TOKEN) {
    return send(res, 403, { ok: false, error: 'token 不对' });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, HTML.replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/ledger') {
    // ⚠️ readLedger() 返回的是 CSV 拆出来的字符串数组（[card, machine, ...]），
    // 不是对象 —— 在服务端转成对象，前端就不用记列索引了。
    const rows = readLedger().map((a) => ({
      card: a[0], machine: a[1], edition: a[2],
      issuedAt: a[3], expireAt: a[4], buyer: a[5], note: a[6],
    }));
    return send(res, 200, rows);
  }

  if (req.method === 'POST' && url.pathname === '/api/issue') {
    const b = await readBody(req);
    try {
      const { credential, payload } = issue({
        machine: b.machine,
        days: b.days,
        until: b.until,
        edition: b.edition || 'pro',
        buyer: b.buyer || '',
      });
      const until = new Date(payload.expireAt);
      return send(res, 200, {
        ok: true,
        credential,
        card: payload.card,
        machine: payload.machine,
        machinePretty: pretty(payload.machine),
        expireText: until.toISOString().slice(0, 10),
      });
    } catch (e) {
      return send(res, 200, { ok: false, error: e.message });
    }
  }

  send(res, 404, { ok: false, error: 'not found' });
});

// 只绑 127.0.0.1：局域网里的同事/同学访问不到
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  console.log('');
  console.log('  卡密签发器已启动');
  console.log('  ' + url);
  console.log('');
  console.log('  关掉这个窗口就停了。');
  console.log('');
  // MCM_ISSUER_NO_OPEN=1 时不弹浏览器（自测/脚本调用用）
  if (process.platform === 'win32' && !process.env.MCM_ISSUER_NO_OPEN) {
    execFile('cmd', ['/c', 'start', '', url], () => {});
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 被占用了。关掉上一个签发器窗口再试，`);
    console.error(`  或者换个端口：set MCM_ISSUER_PORT=38902 && node tools/issuer.js\n`);
  } else {
    console.error('\n  启动失败：' + e.message + '\n');
  }
  process.exit(1);
});
