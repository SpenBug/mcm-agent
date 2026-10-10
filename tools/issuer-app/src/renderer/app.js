'use strict';

/**
 * 签发器界面逻辑。
 *
 * 这一层**不做任何业务判断**（不拼卡号、不查价格、不判邀请码）——
 * 全部走 preload 暴露的 window.issuer，由主进程交给 vendor/issuer-core.js。
 * 界面只负责取值、展示、把错误显示出来。
 */

const $ = (id) => document.getElementById(id);
const api = window.issuer;

let INFO = null;
let LEDGER = [];
let COMPS = [];

/* ---------------------------------------------------------------- 通用 */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function showErr(id, msg) {
  const el = $(id);
  if (!msg) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="err">✗ ${esc(msg)}</div>`;
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
}
function show(el, on) { el.classList.toggle('hidden', !on); }

/* ---------------------------------------------------------------- 标签页 */

document.querySelectorAll('nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.id === `page-${b.dataset.page}`));
    if (b.dataset.page === 'ledger') loadLedger();
    if (b.dataset.page === 'invite') loadInvites();
  });
});

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  try {
    INFO = await api.info();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;color:#f87171">启动失败：${esc(e.message)}</div>`;
    return;
  }

  $('verBadge').textContent = `v${INFO.version}`;
  const kb = $('keyBadge');
  if (INFO.hasKey) { kb.textContent = '私钥已就绪'; kb.classList.remove('bad'); }
  else { kb.textContent = '⚠ 缺私钥'; kb.classList.add('bad'); }

  // 赛事下拉：全部从数据源生成，不在界面里写死价格
  COMPS = await api.competitions();
  const sel = $('competition');
  for (const c of COMPS) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name}（¥${c.price}）`;
    sel.appendChild(o);
  }

  renderSettings();
  loadLedger();
}

api.onBootWarning((w) => {
  const box = $('bootWarn');
  const div = document.createElement('div');
  div.className = 'warnbox';
  div.innerHTML = `<b>${esc(w.title)}</b><pre>${esc(w.detail)}</pre>`;
  box.appendChild(div);
});

/* ---------------------------------------------------------------- 签发 */

$('preset').addEventListener('change', () => {
  const custom = $('preset').value === 'custom';
  show($('until'), custom);
  if (custom) $('until').focus();
});

$('competition').addEventListener('change', () => {
  const sel = $('competition');
  const opt = sel.options[sel.selectedIndex];
  $('compHint').textContent = sel.value === 'all'
    ? '全能包：解锁全部赛事。'
    : `只解锁「${opt.text.replace(/（¥\d+）/, '')}」。买家打别的赛事会被拦下。`;
});

let LAST = null;

$('go').addEventListener('click', async () => {
  showErr('issueErr', '');
  const machine = $('machine').value.trim();
  if (!machine) { showErr('issueErr', '先填机器码'); $('machine').focus(); return; }
  const competition = $('competition').value;
  if (!competition) { showErr('issueErr', '先选「解锁赛事」—— 这决定售价与买家能用哪个赛事'); $('competition').focus(); return; }
  const preset = $('preset').value;
  if (preset === 'custom' && !$('until').value) { showErr('issueErr', '选了「指定到期日」但没填日期'); $('until').focus(); return; }

  $('go').disabled = true;
  try {
    const r = await api.issue({
      machine,
      competition,
      buyer: $('buyer').value.trim(),
      note: $('note').value.trim(),
      ...(preset === 'custom' ? { until: $('until').value } : { days: Number(preset) }),
    });
    LAST = r;
    show($('out'), true);
    $('cred').value = r.credential;
    $('meta').innerHTML =
      `卡号 <b>${esc(r.card)}</b> · 解锁 <b>${esc(r.competitionName)}</b>`
      + (r.price ? `（¥${esc(r.price)}）` : '')
      + `<br>机器码 <b>${esc(r.machinePretty)}</b> · 有效期至 <b>${esc(r.expireText)}</b>`
      + `<br>邀请码 <b>${esc(r.inviteCode)}</b>（买家推荐 3 人后凭这个找你领奖）`;
    loadLedger();
  } catch (e) {
    showErr('issueErr', e.message);
  } finally {
    $('go').disabled = false;
  }
});

$('copyCred').addEventListener('click', async () => {
  await api.copy($('cred').value);
  toast('卡密已复制');
});

$('copyAll').addEventListener('click', async () => {
  if (!LAST) return;
  const text = [
    `卡号：${LAST.card}`,
    `解锁：${LAST.competitionName}${LAST.price ? `（¥${LAST.price}）` : ''}`,
    `有效期至：${LAST.expireText}`,
    `机器码：${LAST.machinePretty}`,
    '',
    '卡密（在软件里粘贴）：',
    LAST.credential,
  ].join('\n');
  await api.copy(text);
  toast('全部信息已复制');
});

/* ---------------------------------------------------------------- 台账 */

async function loadLedger() {
  try {
    LEDGER = await api.ledger();
  } catch (e) {
    $('ledgerWrap').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
    return;
  }
  renderLedger();
}

function renderLedger() {
  const q = $('q').value.trim().toLowerCase();
  const rows = q
    ? LEDGER.filter((r) => [r.card, r.machine, r.machinePretty, r.buyer, r.inviteCode, r.competition, r.note]
      .some((v) => String(v || '').toLowerCase().includes(q)))
    : LEDGER;

  $('ledgerCount').textContent = q
    ? `匹配 ${rows.length} / 共 ${LEDGER.length} 张`
    : `共 ${LEDGER.length} 张`;

  if (!rows.length) {
    $('ledgerWrap').innerHTML = `<div class="empty">${LEDGER.length ? '没有匹配的记录' : '还没有签发记录。'}</div>`;
    return;
  }
  const body = rows.slice().reverse().map((r) => `<tr>
    <td class="mono">${esc(r.card)}</td>
    <td>${esc(r.competition || 'all')}</td>
    <td class="mono">${esc(r.machinePretty || r.machine)}</td>
    <td class="mono">${esc(r.inviteCode)}</td>
    <td>${esc(String(r.expireAt || '').slice(0, 10))}</td>
    <td>${esc(r.buyer)}</td>
    <td>${esc(r.note)}</td>
  </tr>`).join('');
  $('ledgerWrap').innerHTML = `<table><thead><tr>
    <th>卡号</th><th>赛事</th><th>机器码</th><th>邀请码</th><th>到期</th><th>买家</th><th>备注</th>
  </tr></thead><tbody>${body}</tbody></table>`;
}

$('q').addEventListener('input', renderLedger);
$('refreshLedger').addEventListener('click', () => { loadLedger(); toast('已刷新'); });

$('exportZh').addEventListener('click', () => exportCsv(true));
$('exportEn').addEventListener('click', () => exportCsv(false));
async function exportCsv(zh) {
  try {
    const r = await api.exportLedger({ zh });
    if (r.canceled) return;
    toast(`已导出 ${r.rows} 张到 ${r.file.split(/[\\/]/).pop()}`);
  } catch (e) { showErr('ledgerResult', `导出失败：${e.message}`); }
}

$('importBtn').addEventListener('click', async () => {
  showErr('ledgerResult', '');
  try {
    const r = await api.importLedger({});
    if (r.canceled) return;
    let html = `<div class="warnbox" style="background:rgba(52,211,153,.08);border-color:rgba(52,211,153,.35)">`
      + `导入 <b>${esc(r.file)}</b>：新增 <b>${r.added}</b> 张，跳过重复 <b>${r.skipped}</b> 张。`;
    if (r.unknown && r.unknown.length) {
      html += `<br><br><b>⚠ ${r.unknown.length} 张卡的赛事名对不上已知赛事</b>，已按原样记入：`
        + `<pre>${esc(r.unknown.slice(0, 8).join('\n'))}</pre>`
        + `<div class="hint">没有偷偷改成 all —— 台账是收钱的凭据，记错了查不回来。请核对后手工改正。</div>`;
    }
    html += '</div>';
    if (r.cards && r.cards.length) {
      html += '<div class="tablewrap" style="max-height:24vh"><table><thead><tr><th>卡号</th><th>邀请码</th><th>赛事</th></tr></thead><tbody>'
        + r.cards.map((c) => `<tr><td class="mono">${esc(c.card)}</td><td class="mono">${esc(c.inviteCode)}</td><td>${esc(c.competition)}</td></tr>`).join('')
        + '</tbody></table></div>';
    }
    $('ledgerResult').innerHTML = html;
    loadLedger();
  } catch (e) { showErr('ledgerResult', `导入失败：${e.message}`); }
});

$('openLedgerDir').addEventListener('click', async () => {
  if (INFO) { await api.showItem(INFO.ledgerPath); }
});

/* ---------------------------------------------------------------- 邀请 */

async function loadInvites() {
  try {
    const r = await api.inviteStats();
    $('invRuleDesc').textContent =
      `朋友购买报邀请码立减 ¥${r.rules.friendDiscount}；累计满 ${r.rules.threshold} 人，送${r.rules.reward}。`
      + '（减价与送卡由你在微信里人工确认，软件只记账）';
    if (!r.stats.length) {
      $('invStats').innerHTML = '<div class="empty">还没有推荐记录。</div>';
      return;
    }
    const body = r.stats.map((s) => {
      const done = Math.floor(s.count / r.rules.threshold);
      const status = s.count >= r.rules.threshold
        ? `<span class="pill ok">🎁 可送 ${done} 次</span>`
        : `<span class="pill">差 ${r.rules.threshold - s.count} 人</span>`;
      const owner = s.owner
        ? `${esc(s.owner.card)}${s.owner.buyer ? `（${esc(s.owner.buyer)}）` : ''}`
        : '<span class="pill warn">台账无此码</span>';
      return `<tr><td class="mono">${esc(s.code)}</td><td>${s.count}</td><td>${status}</td><td>${owner}</td></tr>`;
    }).join('');
    $('invStats').innerHTML = `<table><thead><tr><th>邀请码</th><th>推荐数</th><th>状态</th><th>推荐人</th></tr></thead><tbody>${body}</tbody></table>`;
  } catch (e) {
    $('invStats').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
  }
}

$('invGo').addEventListener('click', async () => {
  showErr('invErr', '');
  const code = $('invCode').value.trim();
  if (!code) { showErr('invErr', '先填邀请码（6 位数字，见台账页的「邀请码」列）'); return; }
  $('invGo').disabled = true;
  try {
    const r = await api.inviteRecord({
      code,
      buyer: $('invBuyer').value.trim(),
      competition: $('invComp').value.trim(),
      amount: $('invAmount').value.trim(),
    });
    show($('invOut'), true);
    let html = `✓ 已记录推荐：邀请码 <b>${esc(r.code)}</b><br>`;
    html += r.owner
      ? `推荐人卡号 <b>${esc(r.owner.card)}</b>${r.owner.buyer ? `（${esc(r.owner.buyer)}）` : ''}<br>`
      : '<span class="pill warn">台账里没找到持有该邀请码的卡 —— 确认一下码有没有抄错</span><br>';
    html += `该邀请码累计 <b>${r.count}</b> 人<br>`;
    html += r.count >= r.threshold
      ? `<br>🎁 <b>已满 ${r.threshold} 人 —— 该送${esc(r.reward)}了！</b><br>记得给推荐人发一张免费卡。`
      : `还差 ${r.threshold - r.count} 人可送${esc(r.reward)}`;
    $('invMeta').innerHTML = html;
    $('invCode').value = '';
    $('invBuyer').value = '';
    $('invAmount').value = '';
    loadInvites();
  } catch (e) {
    showErr('invErr', e.message);
  } finally {
    $('invGo').disabled = false;
  }
});

/* ---------------------------------------------------------------- 验卡 */

$('vGo').addEventListener('click', async () => {
  showErr('vErr', '');
  const credential = $('vCred').value.trim();
  if (!credential) { showErr('vErr', '先粘贴卡密'); return; }
  $('vGo').disabled = true;
  try {
    const r = await api.verify({ credential, machine: $('vMachine').value.trim() });
    show($('vOut'), true);
    const pill = r.ok
      ? (r.expired ? '<span class="pill warn">有效（已过期，宽限期内）</span>' : '<span class="pill ok">✓ 有效</span>')
      : `<span class="pill bad">✗ ${esc(r.why)}</span>`;
    $('vMeta').innerHTML = `验签结果：${pill}<br>`
      + (r.card ? `卡号 <b>${esc(r.card)}</b><br>` : '')
      + (r.machine ? `机器码 <b>${esc(r.machine)}</b><br>` : '')
      + (r.edition ? `版本 <b>${esc(r.edition)}</b><br>` : '')
      + (r.competition ? `解锁赛事 <b>${esc(r.competition)}</b><br>` : '')
      + (r.issuedAt ? `签发于 <b>${esc(r.issuedAt)}</b><br>` : '')
      + (r.expireAt ? `到期 <b>${esc(r.expireAt)}</b><br>` : '')
      + (r.buyer ? `买家 <b>${esc(r.buyer)}</b>` : '');
  } catch (e) {
    showErr('vErr', e.message);
  } finally {
    $('vGo').disabled = false;
  }
});

/* ---------------------------------------------------------------- 设置 */

function renderSettings() {
  $('kv').innerHTML = [
    ['数据目录', INFO.dataDir],
    ['私钥', INFO.privPath + (INFO.hasKey ? '' : '（缺失）')],
    ['卡密台账', INFO.ledgerPath],
    ['邀请台账', INFO.invitePath],
  ].map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('');

  const box = $('legacyKeyBox');
  if (!INFO.legacyKeys || !INFO.legacyKeys.length) {
    box.innerHTML = '<div class="hint">✓ 没有发现多余的私钥副本。</div>';
    return;
  }
  box.innerHTML = `<div class="warnbox">
    <b>发现 ${INFO.legacyKeys.length} 份额外的私钥副本</b>
    <pre>${esc(INFO.legacyKeys.join('\n'))}</pre>
    <div class="hint" style="margin-bottom:10px">
      本应用已经用「数据目录」里那份在发卡。源码目录那份**没有自动删** ——
      私钥丢了就再也发不出新卡（已发的还能用），自动删风险太大，决定权留给你。
      删之前建议先备份到离线介质。
    </div>
    <button class="ghost tiny" id="delLegacy">确认后删除这些副本…</button>
  </div>`;
  $('delLegacy').addEventListener('click', async () => {
    try {
      const r = await api.deleteLegacyKeys();
      if (r.canceled) return;
      toast(r.deleted.length ? `已删除 ${r.deleted.length} 份副本` : '没有可删除的副本');
      INFO = await api.info();
      renderSettings();
    } catch (e) { toast('删除失败：' + e.message); }
  });
}

boot();
