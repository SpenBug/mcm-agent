/* global window, document */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.mcm;

  const state = {
    config: null,
    providers: [],
    skillsRoot: '',
    workspace: '',
    messages: [],      // OpenAI 格式历史
    sessionId: null,
    sessionTitle: '',
    streaming: false,
    currentAssistantEl: null,
    currentAssistant: null,
    turnStatus: null,   // { kind, text } 本轮为什么结束，重渲染后要重新贴回去
    assistantPushed: false,   // 本轮的 assistant 消息是否已入列（工具消息必须排在它后面）
    usage: { prompt: 0, completion: 0, total: 0, cached: 0, missed: 0, hasCacheInfo: false, turns: [] },
    sessionCache: [],   // 会话列表缓存，命令面板切会话用
    toolNodes: new Map(),
    reasoningBuffer: '',
    lastPreview: '',
  };

  /* ================= 工具函数 ================= */

  const esc = (s) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }

  function timeStr(ts) {
    const d = new Date(ts || Date.now());
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------- 轻量 Markdown 渲染 ---------- */

  function inline(text) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return s;
  }

  function mdToHtml(src) {
    const lines = String(src || '').split(/\r?\n/);
    const out = [];
    let i = 0;

    const flushList = (ordered) => {
      const items = [];
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length && re.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(re, '$1'))}</li>`);
        i += 1;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
    };

    while (i < lines.length) {
      const line = lines[i];

      // 代码块
      if (/^\s*```/.test(line)) {
        const lang = line.replace(/^\s*```/, '').trim();
        i += 1;
        const buf = [];
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push(`<pre data-lang="${esc(lang)}"><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // 表格
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          rows.push(cells(lines[i]));
          i += 1;
        }
        out.push(
          `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`
        );
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lv = Math.min(h[1].length + 1, 4);
        out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
        i += 1;
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        out.push('<hr>');
        i += 1;
        continue;
      }

      // 列表
      if (/^\s*[-*+]\s+/.test(line)) { flushList(false); continue; }
      if (/^\s*\d+\.\s+/.test(line)) { flushList(true); continue; }

      // 空行
      if (!line.trim()) { i += 1; continue; }

      // 段落
      const buf = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(```|#{1,6}\s|>|\||[-*+]\s|\d+\.\s)/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i += 1;
      }
      if (buf.length) out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
      else i += 1;
    }

    return out.join('');
  }

  /* ================= 消息渲染 ================= */

  function scrollBottom(force) {
    const el = $('messages');
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (force || near) el.scrollTop = el.scrollHeight;
  }

  function makeMsgEl(role) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = role === 'user' ? '你' : '∑';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    // 内容列：气泡 + 思考过程块都放这里，**竖向排列**。
    // 直接 append 到 .msg 的话会变成 flex 行的一个子项，跟气泡并排 —— 工具卡就会横着排。
    const col = document.createElement('div');
    col.className = 'msg-col';
    col.appendChild(bubble);
    wrap.append(av, col);
    return { wrap, bubble, col };
  }

  /**
   * 把工具调用翻译成一句人话。
   *
   * 原来卡片上只写 `run_command` / `read_file` —— 客户根本不知道这一步在干什么。
   * 现在从参数里提出关键信息，标题写成「读取 PDF · 赛题.pdf」这种。
   */
  function describeStep(name, args) {
    const a = args || {};
    const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

    switch (name) {
      case 'read_file':
        return `读取 ${base(a.path)}`;
      case 'write_file':
        return `写入 ${base(a.path)}`;
      case 'edit_file':
        return `修改 ${base(a.path)}`;
      case 'list_files':
        return `列出 ${a.root ? base(a.root) : '工作区'}`;
      case 'run_python':
        return a.script ? `运行脚本 ${base(a.script)}` : '运行 Python 片段';
      case 'run_command': {
        const cmd = String(a.command || '');
        // 技能脚本：从文件名 + 子命令推断在干什么
        const m = cmd.match(/mcm_(\w+)\.py"?\s+(\w+)/);
        if (m) {
          const sub = m[2];
          const file = cmd.match(/["']([^"']+\.(?:pdf|docx|xlsx|xls|csv|tex|doc))["']/i);
          const what = base(file ? file[1] : '');
          const label = {
            info: '查看目录', pdf: '读取 PDF', xlsx: '读取表格', docx: '读取 Word',
            tex: '处理 LaTeX', search: '检索文献', compile: '编译 LaTeX',
          }[sub] || `执行 ${sub}`;
          return what ? `${label} · ${what}` : label;
        }
        // 常见命令。⚠️ 顺序有讲究：**具体命令必须排在 cd/ls 之前** ——
        // `cd X && tar -xzf ...` 这种，真正在干的事是解压，不是"查看文件"。
        const guess = [
          [/\btar\s|unzip|Expand-Archive/i, '解压'],
          [/\bpip\s+install|npm\s+install/, '安装依赖'],
          [/\bdrawio\b/i, '导出图表'],
          [/\blatexmk\b|\bxelatex\b/i, '编译 LaTeX'],
          [/\bgit\s/i, '版本控制'],
          [/\bmkdir\b/i, '建目录'],
          [/\bcp\s|\bcopy\s|\bmv\s|\bmove\s/i, '复制/移动文件'],
          [/^cd\s|&&\s*(ls|dir)\b|\bls\s|\bdir\s/i, '查看文件'],
        ].find(([re]) => re.test(cmd));
        if (guess) return guess[1];
        // 实在看不出来，退回命令首词
        const first = cmd.trim().split(/\s+/)[0] || '命令';
        return `执行 ${base(first)}`;
      }
      default:
        return name;
    }
  }

  /**
   * 取得（必要时创建）当前助手消息下的「思考过程」折叠块。
   *
   * 一轮对话里的模型思考 + 所有工具调用归到一个块里，默认收起 ——
   * 展开时是竖向排列的，收起时只留一行「思考过程 · N 步」。
   */
  function getThinkBlock(col) {
    let box = col.querySelector(':scope > .think');
    if (box) return box;

    box = document.createElement('div');
    box.className = 'think';
    box.innerHTML = `
      <div class="think-head">
        <div class="think-row">
          <span class="caret">▸</span>
          <span class="think-title">思考过程</span>
          <span class="think-meta"></span>
        </div>
        <div class="think-steps"></div>
      </div>
      <div class="think-body">
        <div class="think-reasoning" hidden></div>
      </div>`;
    box.querySelector('.think-head').addEventListener('click', () => {
      box.classList.toggle('open');
      box.dataset.userToggled = '1';   // 用户手动开合过，之后就别自动动了
    });
    col.appendChild(box);
    return box;
  }

  /** 模型的思考文字写进折叠块（工具卡之前），而不是塞在气泡里 */
  function writeReasoning(box, text) {
    const r = box.querySelector('.think-reasoning');
    if (!r) return;
    r.hidden = false;
    r.textContent = text;
  }

  /** 更新折叠块标题上的统计：几步、有没有失败 */
  function refreshThinkMeta(box) {
    if (!box) return;
    const cards = box.querySelectorAll('.tool-card');
    const fails = box.querySelectorAll('.tool-card.fail').length;
    const runs = box.querySelectorAll('.tool-card.running, .tool-card.pending').length;
    // 用 ?. 兜底：万一拿到的是个结构不完整的 .think（比如旧会话残留），别整个崩掉
    const hasThink = !box.querySelector('.think-reasoning')?.hidden;
    const parts = [];
    if (hasThink) parts.push('思考');
    if (cards.length) parts.push(`${cards.length} 步`);
    if (runs) parts.push('进行中');
    else if (fails) parts.push(`${fails} 个失败`);
    else if (cards.length) parts.push('全部完成');
    const meta = box.querySelector('.think-meta');
    if (meta) meta.textContent = parts.join(' · ');

    // 收起状态下也要看得见每一步在干什么，而不是只有一个"N 步"
    const stepsEl = box.querySelector('.think-steps');
    if (stepsEl) {
      const names = [...cards]
        .map((c) => {
          const nm = c.querySelector('.nm');
          return nm ? nm.textContent.trim() : '';
        })
        .filter(Boolean);
      stepsEl.textContent = names.join('  ·  ');
      stepsEl.hidden = names.length === 0;
    }
    box.classList.toggle('has-fail', fails > 0);
  }

  /**
   * 记录「本轮为什么结束」。
   *
   * ⚠️ 不能只往 DOM 里塞一行 —— send() 收尾时会 `state.messages = res.messages;
   * renderMessages()`，而 renderMessages() 第一件事就是 `host.innerHTML = ''`，
   * 会把刚加的那行**直接清掉**。所以状态存进 state，由 renderMessages() 重新贴回去。
   */
  function appendTurnStatus(kind, text) {
    state.turnStatus = { kind, text };
    paintTurnStatus();
  }

  /** 把 state.turnStatus 渲染到消息流末尾（每次 renderMessages 后都要调） */
  function paintTurnStatus() {
    const host = $('messages');
    host.querySelectorAll('.turn-status').forEach((n) => n.remove());
    if (!state.turnStatus) return;
    const el = document.createElement('div');
    el.className = `turn-status ${state.turnStatus.kind}`;
    el.textContent = state.turnStatus.text;
    host.appendChild(el);
  }

  /* ================= 等待计时 & 超时重试 ================= */

  let waitTimer = null;
  let waitStart = 0;
  let waitLabel = '';

  /**
   * 在状态栏显示「… · 已 45s」并每秒跳。
   *
   * 为什么需要：大上下文下模型首字可能要等很久，界面看着像卡死。
   * 有个在走的秒数，用户就知道"还在等"而不是"挂了"；超过 60 秒变黄。
   */
  function startWait(label) {
    stopWait();
    waitStart = Date.now();
    waitLabel = label;
    const tick = () => {
      const hint = $('statusHint');
      if (!hint) return;
      const sec = Math.round((Date.now() - waitStart) / 1000);
      hint.textContent = `${waitLabel} · 已 ${sec}s`;
      hint.classList.toggle('slow', sec >= 60);
    };
    tick();
    waitTimer = setInterval(tick, 1000);
  }

  function stopWait() {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    const hint = $('statusHint');
    if (!hint) return;
    hint.classList.remove('slow');
    // 只停定时器不清文字的话，会留一句"已 0s"挂在那儿 —— 看着像还在等
    if (hint.textContent.includes('· 已 ')) hint.textContent = '';
  }

  /** 是不是"模型超时"类错误 —— 这类给重试卡片，普通错误只给一行提示 */
  function isTimeoutError(msg) {
    const m = String(msg || '');
    return m.includes('没有任何数据') || m.includes('超时')
        || m.includes('timeout') || m.includes('Timeout');
  }

  /** 超时卡片：一条醒目提示 + 两个可操作按钮 */
  function appendRetryCard(message) {
    const host = $('messages');
    host.querySelectorAll('.retry-card').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.className = 'retry-card';
    el.innerHTML = `
      <div class="rc-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>
        </svg>
        <span>模型没有在预期时间内返回</span>
      </div>
      <p class="rc-msg">${esc(message)}</p>
      <div class="rc-acts">
        <button class="btn sm primary" type="button" data-rc="same">重试</button>
        <button class="btn sm" type="button" data-rc="long">加大超时再试（10 分钟）</button>
      </div>`;
    el.querySelector('[data-rc="same"]').addEventListener('click', () => retryLast(300000));
    el.querySelector('[data-rc="long"]').addEventListener('click', () => retryLast(600000));
    host.appendChild(el);
    el.scrollIntoView({ block: 'nearest' });
  }

  /** 把上一条用户消息重发一次 */
  function retryLast(timeoutMs) {
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) { toast('找不到可重试的消息', 'err'); return; }
    document.querySelectorAll('.retry-card').forEach((n) => n.remove());
    send(lastUser.content, timeoutMs);
  }

  /* ================= Token 仪表盘 ================= */

  const emptyUsage = () => ({
    prompt: 0, completion: 0, total: 0, cached: 0, missed: 0,
    hasCacheInfo: false, turns: [],
  });

  /** 12.3K / 1.2M —— 仪表盘上不要出现 1234567 这种数字 */
  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v < 1000) return String(v);
    if (v < 1000000) return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}K`;
    return `${(v / 1000000).toFixed(2)}M`;
  }

  /** 累加一轮的用量。usage 来自主进程 normalizeUsage()，字段已归一 */
  function addUsage(u) {
    if (!u) return;
    const acc = state.usage;
    acc.prompt += u.prompt || 0;
    acc.completion += u.completion || 0;
    acc.total += u.total || 0;
    acc.cached += u.cached || 0;
    acc.missed += u.missed || 0;
    // 只要有一轮带缓存信息，整体就算"有缓存数据"
    if (u.hasCacheInfo) acc.hasCacheInfo = true;
    acc.turns.push({
      prompt: u.prompt || 0,
      completion: u.completion || 0,
      cached: u.cached || 0,
      missed: u.missed || 0,
      hasCacheInfo: !!u.hasCacheInfo,
    });
    paintTokenBar();
  }

  /** 命中率；没有缓存数据时返回 null（界面要显示"—"而不是 0%） */
  function cacheRate(o) {
    if (!o.hasCacheInfo) return null;
    const denom = o.cached + o.missed;
    if (!denom) return null;
    return o.cached / denom;
  }

  /** 输入框上方那行常驻读数 */
  function paintTokenBar() {
    const el = $('tokenBar');
    if (!el) return;
    const u = state.usage;
    if (!u.total && !u.turns.length) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const rate = cacheRate(u);
    const rateTxt = rate === null
      ? '<span class="tb-cache off">缓存 —</span>'
      : `<span class="tb-cache${rate >= 0.5 ? ' good' : ''}">缓存 ${(rate * 100).toFixed(0)}%</span>`;
    el.innerHTML =
      `<span class="tb-item">↑ <b>${fmtTokens(u.prompt)}</b></span>`
      + `<span class="tb-item">↓ <b>${fmtTokens(u.completion)}</b></span>`
      + `<span class="tb-item">Σ <b>${fmtTokens(u.total)}</b></span>`
      + rateTxt
      + `<span class="tb-more">仪表盘</span>`;
  }

  /** 打开完整仪表盘抽屉 */
  function openUsageDashboard() {
    const u = state.usage;
    const rate = cacheRate(u);
    const n = u.turns.length;

    const rows = u.turns.map((t, i) => {
      const r = t.hasCacheInfo && t.cached + t.missed
        ? `${((t.cached / (t.cached + t.missed)) * 100).toFixed(0)}%`
        : '—';
      return `<tr>
        <td class="num">${i + 1}</td>
        <td class="num">${t.prompt.toLocaleString()}</td>
        <td class="num">${t.completion.toLocaleString()}</td>
        <td class="num">${t.cached.toLocaleString()}</td>
        <td class="num">${r}</td>
      </tr>`;
    }).join('');

    // 命中/未命中的横条 —— 一眼看出缓存效果
    let barHtml = '';
    if (rate !== null) {
      const hitPct = (rate * 100).toFixed(1);
      barHtml = `
        <div class="tk-bar" role="img" aria-label="缓存命中 ${hitPct}%">
          <span class="tk-hit" style="width:${(rate * 100).toFixed(2)}%"></span>
          <span class="tk-miss" style="width:${(100 - rate * 100).toFixed(2)}%"></span>
        </div>
        <div class="tk-legend">
          <span><i class="dot hit"></i>命中 ${u.cached.toLocaleString()}</span>
          <span><i class="dot miss"></i>未命中 ${u.missed.toLocaleString()}</span>
        </div>`;
    } else {
      barHtml = '<p class="fm-hint">当前模型/接口没有返回缓存字段，命中率无法计算。'
        + '（DeepSeek 会返回 <code>prompt_cache_hit_tokens</code>，OpenAI 返回 '
        + '<code>prompt_tokens_details.cached_tokens</code>）</p>';
    }

    const html = `
      <div class="tk-cards">
        <div class="tk-card">
          <span class="tk-k">输入 Token</span>
          <span class="tk-v">${u.prompt.toLocaleString()}</span>
          <span class="tk-sub">发给模型的上下文</span>
        </div>
        <div class="tk-card">
          <span class="tk-k">输出 Token</span>
          <span class="tk-v">${u.completion.toLocaleString()}</span>
          <span class="tk-sub">模型生成的内容</span>
        </div>
        <div class="tk-card accent">
          <span class="tk-k">合计</span>
          <span class="tk-v">${u.total.toLocaleString()}</span>
          <span class="tk-sub">${n} 轮对话</span>
        </div>
        <div class="tk-card">
          <span class="tk-k">缓存命中率</span>
          <span class="tk-v">${rate === null ? '—' : (rate * 100).toFixed(1) + '%'}</span>
          <span class="tk-sub">${rate === null ? '接口未返回缓存字段' : `命中 ${fmtTokens(u.cached)}`}</span>
        </div>
      </div>
      ${barHtml}
      <h3 class="tk-h3">按轮次</h3>
      ${n ? `<table class="tk-table">
        <thead><tr><th>轮</th><th>输入</th><th>输出</th><th>缓存命中</th><th>命中率</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<p class="fm-hint">还没有对话记录。</p>'}
      <div class="fm-actions">
        <button class="btn sm" id="tkReset" type="button">清零统计</button>
        <span class="fm-hint">统计只针对当前会话，切换会话会各自计数。</span>
      </div>`;

    openDrawer('Token 用量', html, () => {
      const b = document.querySelector('#tkReset');
      if (b) {
        b.addEventListener('click', () => {
          state.usage = emptyUsage();
          paintTokenBar();
          closeDrawer();
          toast('Token 统计已清零', 'ok');
        });
      }
    });
  }

  function renderMessages() {
    const host = $('messages');
    host.innerHTML = '';
    state.toolNodes.clear();
    state.currentAssistantEl = null;

    const visible = state.messages.filter((m) => m.role !== 'system');
    if (!visible.length) {
      host.appendChild(buildEmptyState());
      paintTurnStatus();
      return;
    }

    let lastAssistant = null;
    let lastUser = null;              // 最后一条提问 —— 只有它能改
    for (const m of visible) {
      if (m.role === 'user') {
        const { wrap, bubble } = makeMsgEl('user');
        bubble.innerHTML = mdToHtml(m.content);
        host.appendChild(wrap);
        lastUser = { wrap, msg: m };
        lastAssistant = null;
      } else if (m.role === 'assistant') {
        const { wrap, bubble, col } = makeMsgEl('assistant');
        bubble.innerHTML = mdToHtml(m.content || '');
        host.appendChild(wrap);
        lastAssistant = { bubble, wrap, col };
        // 思考文字和工具调用都进「思考过程」折叠块
        if (m.reasoning || (Array.isArray(m.tool_calls) && m.tool_calls.length)) {
          const box = getThinkBlock(col);
          if (m.reasoning) writeReasoning(box, m.reasoning);
          if (Array.isArray(m.tool_calls)) {
            const body = box.querySelector('.think-body');
            for (const tc of m.tool_calls) {
              const node = buildToolCard(tc.id, tc.function?.name || 'tool', safeParse(tc.function?.arguments));
              node.classList.add('pending');
              body.appendChild(node);
              state.toolNodes.set(tc.id, node);
            }
          }
          refreshThinkMeta(box);
        }
      } else if (m.role === 'tool' && lastAssistant) {
        const node = state.toolNodes.get(m.tool_call_id);
        if (node) {
          node.classList.remove('pending');
          node.classList.add('ok');
          node.querySelector('.tool-body').innerHTML = `<pre>${esc(m.content)}</pre>`;
          const box = node.closest('.think');
          if (box) refreshThinkMeta(box);
        }
      }
    }
    // 加载历史会话后，最后一条提问同样要能改 —— 否则只有「刚发完」那一下能回滚
    if (lastUser) markRollbackTarget(lastUser.wrap, lastUser.msg);

    paintTurnStatus();
    scrollBottom(true);
  }

  function safeParse(s) {
    try {
      return typeof s === 'string' ? JSON.parse(s) : s || {};
    } catch {
      return { _raw: s };
    }
  }

  function buildToolCard(id, name, args) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolId = id;
    const argStr = JSON.stringify(args, null, 2);
    card.innerHTML = `
      <div class="tool-head">
        <span class="dot"></span>
        <span class="nm">${esc(describeStep(name, args))}</span>
        <span class="raw">${esc(name)}</span>
        <span class="meta">执行中…</span>
      </div>
      <div class="tool-body">
        <div class="tool-args"><span class="k">参数</span><pre>${esc(argStr)}</pre></div>
        <div class="tool-out"><pre>等待结果…</pre></div>
      </div>`;
    card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('open'));
    return card;
  }

  /* ---------- 空态用的手写 SVG 素材 ----------
     全部内联、颜色走 CSS 变量：深浅主题自动适配、无版权风险、体积极小。 */

  /** 助手形象：几何风小机器人，手里举着一张折线图 */
  const SVG_BOT = `
    <svg class="es-bot" viewBox="0 0 260 210" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id="botGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="var(--brand)" stop-opacity=".20"/>
          <stop offset="100%" stop-color="var(--brand)" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <ellipse cx="130" cy="100" rx="104" ry="88" fill="url(#botGlow)"/>
      <ellipse cx="130" cy="186" rx="52" ry="9" fill="var(--brand)" opacity=".13"/>

      <!-- 身体 -->
      <rect x="98" y="118" width="64" height="60" rx="18"
            fill="var(--panel)" stroke="var(--brand)" stroke-width="1.6"/>
      <!-- 胸口一张小折线图 -->
      <path d="M112 160 l10-10 8 6 12-16" stroke="var(--viz-1)" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="142" cy="140" r="2.6" fill="var(--viz-3)"/>
      <rect x="124" y="110" width="12" height="10" fill="var(--panel)"/>

      <!-- 头 -->
      <rect x="96" y="52" width="68" height="60" rx="20"
            fill="var(--panel)" stroke="var(--brand)" stroke-width="1.6"/>
      <path d="M130 52 V38" stroke="var(--brand)" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="130" cy="33" r="4.5" fill="var(--viz-3)"/>

      <!-- 眼睛 -->
      <circle cx="115" cy="80" r="7.5" fill="var(--viz-6)" opacity=".20"/>
      <circle cx="145" cy="80" r="7.5" fill="var(--viz-6)" opacity=".20"/>
      <circle cx="115" cy="80" r="3.6" fill="var(--viz-6)"/>
      <circle cx="145" cy="80" r="3.6" fill="var(--viz-6)"/>
      <path d="M120 94 q10 7 20 0" stroke="var(--brand)" stroke-width="1.8"
            stroke-linecap="round"/>

      <!-- 手臂：左手下垂，右手举图 -->
      <path d="M98 134 q-17 5 -21 20" stroke="var(--brand)" stroke-width="1.6"
            stroke-linecap="round"/>
      <path d="M162 134 q17 2 21 -12" stroke="var(--brand)" stroke-width="1.6"
            stroke-linecap="round"/>
      <g transform="translate(178,84)">
        <rect width="48" height="36" rx="7" fill="var(--panel-2)"
              stroke="var(--brand-line)" stroke-width="1.2"/>
        <path d="M8 27 l8-8 6 5 11-14" stroke="var(--viz-5)" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round"/>
      </g>

      <!-- 浮动的小元素：加号 / 圆环 / 对勾 -->
      <rect x="38" y="56" width="26" height="26" rx="8" fill="var(--viz-2-soft)"/>
      <path d="M46 69 h10 M51 64 v10" stroke="var(--viz-2)" stroke-width="1.6" stroke-linecap="round"/>
      <rect x="196" y="42" width="24" height="24" rx="8" fill="var(--viz-4-soft)"/>
      <circle cx="208" cy="54" r="4.5" stroke="var(--viz-4)" stroke-width="1.6"/>
      <rect x="50" y="140" width="22" height="22" rx="7" fill="var(--viz-3-soft)"/>
      <path d="M56 151 l4-4 5 5" stroke="var(--viz-3)" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

  /** 示例产出 · 折线图 */
  const SVG_LINE = `
    <svg viewBox="0 0 180 96" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="lnFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--viz-1)" stop-opacity=".38"/>
          <stop offset="100%" stop-color="var(--viz-1)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="M10 20 H170 M10 44 H170 M10 68 H170" stroke="var(--line)" stroke-width="1"/>
      <path d="M10 12 V80 H172" stroke="var(--line-strong)" stroke-width="1"/>
      <path d="M14 62 L42 44 L70 52 L98 30 L126 38 L154 18 L166 22 V80 H14 Z" fill="url(#lnFill)"/>
      <path d="M14 62 L42 44 L70 52 L98 30 L126 38 L154 18 L166 22"
            stroke="var(--viz-1)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="98" cy="30" r="3.2" fill="var(--bg)" stroke="var(--viz-1)" stroke-width="2"/>
      <circle cx="154" cy="18" r="3.2" fill="var(--bg)" stroke="var(--viz-1)" stroke-width="2"/>
    </svg>`;

  /** 示例产出 · 分组柱状图 */
  const SVG_BAR = `
    <svg viewBox="0 0 180 96" fill="none" aria-hidden="true">
      <path d="M10 20 H170 M10 44 H170" stroke="var(--line)" stroke-width="1"/>
      <path d="M10 12 V80 H172" stroke="var(--line-strong)" stroke-width="1"/>
      <rect x="24"  y="50" width="12" height="30" rx="3" fill="var(--viz-2)"/>
      <rect x="38"  y="62" width="12" height="18" rx="3" fill="var(--viz-1)" opacity=".55"/>
      <rect x="60"  y="36" width="12" height="44" rx="3" fill="var(--viz-2)"/>
      <rect x="74"  y="52" width="12" height="28" rx="3" fill="var(--viz-1)" opacity=".55"/>
      <rect x="96"  y="26" width="12" height="54" rx="3" fill="var(--viz-2)"/>
      <rect x="110" y="44" width="12" height="36" rx="3" fill="var(--viz-1)" opacity=".55"/>
      <rect x="132" y="40" width="12" height="40" rx="3" fill="var(--viz-2)"/>
      <rect x="146" y="56" width="12" height="24" rx="3" fill="var(--viz-1)" opacity=".55"/>
    </svg>`;

  /** 取一个 24x24 的线性图标 */
  const ico = (d, sw) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 1.6}"
          stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

  function buildEmptyState() {
    const div = document.createElement('div');
    div.className = 'empty-state';

    // 四类材料：分类键 / 名称 / 说明 / 配色槽位 / 图标路径
    const SLOTS = [
      ['赛题', '竞赛赛题', 'PDF / DOCX / 图片', 'v1', 'M6 3h9l5 5v13H6zM15 3v5h5'],
      ['规范', '格式规范', '当届官方规范 / 须知', 'v2', 'M4 5h16v14H4zM4 9h16M9 9v10'],
      ['模板', '论文模板', '.docx / .tex / 目录', 'v3', 'M6 3h9l5 5v13H6zM9 13h6M9 17h4'],
      ['数据', '赛题数据', 'XLSX / CSV / 附件', 'v4', 'M4 5h16v14H4zM4 5l8 7 8-7'],
    ];

    // 五步流程：标题 / 说明 / 图标路径
    const STEPS = [
      ['接料建卡', '读四类材料，产出规则卡', 'M4 6h16M4 12h10M4 18h7'],
      ['建模', '拆子问题、选模型、写假设', 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9'],
      ['求解出图', '跑代码、出结果、出图', 'M4 19V5M4 19h16M8 15l3-4 3 3 4-6'],
      ['成稿', '按你的模板产出论文', 'M6 3h9l5 5v13H6zM9 13h6M9 17h4'],
      ['交卷前自检', '逐闸打勾，不过不发', 'M12 3l7 4v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V7zM9 12l2 2 4-4'],
    ];

    div.innerHTML = `
      <!-- 背景花字标语：装饰层，pointer-events:none 不挡交互。
           前三行是淡的引子，"他阿一古数模"是渐变大字（视觉焦点）。 -->
      <div class="es-slogan" aria-hidden="true">
        <span class="sl-line">春风若有怜花意</span>
        <span class="sl-line">可否许我再少年</span>
        <span class="sl-line">但是...</span>
        <span class="sl-hero">他阿一古数模</span>
      </div>

      <div class="es-brand">
        <span class="es-mark"><svg viewBox="0 0 256 256" aria-hidden="true"><use href="#brandMark"/></svg></span>
        <div class="es-brand-txt">
          <h2>阿一古数模</h2>
          <p class="es-lede">四类材料分别提交，剩下的我来。</p>
        </div>
      </div>

      <div class="es-grid">
        <div class="es-col-l">
          <div class="es-cap">① 把材料放进来</div>
          <div class="slots" id="slots">
            ${SLOTS.map(([key, label, hint, v, d]) => `
              <div class="slot" data-cat="${esc(key)}" tabindex="0">
                <span class="slot-ico ${v}">${ico(d)}</span>
                <span class="slot-body"><b>${esc(label)}</b><i>${esc(hint)}</i></span>
                <span class="slot-count"></span>
              </div>`).join('')}
          </div>

          <div class="es-cap">② 我按这五步走</div>
          <div class="flow-cards">
            ${STEPS.map(([t, d, p], i) => `
              <div class="flow-card${i === STEPS.length - 1 ? ' gate' : ''}">
                <span class="fc-ico">${ico(p, 1.7)}</span>
                <span class="fc-t">${esc(t)}</span>
                <span class="fc-d">${esc(d)}</span>
              </div>`).join('')}
          </div>
        </div>

        <div class="es-col-r">
          ${SVG_BOT}
          <div class="es-demo">
            <div class="es-demo-cap">产出示例</div>
            <div class="es-charts">
              <figure class="es-chart">${SVG_LINE}<figcaption>趋势曲线</figcaption></figure>
              <figure class="es-chart">${SVG_BAR}<figcaption>分组对比</figcaption></figure>
            </div>
          </div>
        </div>
      </div>`;

    // 原来这里还有 4 张「快捷卡」。按用户决策去掉 —— 首屏重心落在「交材料」上。
    // 那 4 条提示语没有丢，挪进了命令面板（Ctrl+K），见 QUICK_PROMPTS。
    setTimeout(() => {
      // ⚠️ 槽位事件必须在这里绑 —— 见 bindSlots() 的注释
      bindSlots(div);
      refreshSlots(div);
    }, 0);
    return div;
  }

  /**
   * 管理某一类已提交的材料。
   *
   * 为什么要它：材料导入后原本没有任何删除入口 —— 客户拖错了、拖了旧版本，
   * 只能去工作区手动删，很容易把整个流程卡住。
   */
  async function openCatFiles(cat, label) {
    let files = [];
    try {
      const data = await api.input.list();
      const c = (data.cats || []).find((x) => x.key === cat);
      files = c ? c.files : [];
    } catch (err) {
      toast('读取失败：' + err.message, 'err');
      return;
    }

    const html = files.length
      ? `<ul class="fm-list">
          ${files.map((f) => `
            <li class="fm-row">
              <span class="fm-name" title="${esc(f.name)}">${esc(f.name)}</span>
              <span class="fm-size">${fmtSize(f.bytes)}</span>
              <button class="icon-btn fm-del" data-del="${esc(f.name)}" title="删除这个文件">✕</button>
            </li>`).join('')}
        </ul>
        <div class="fm-actions">
          <button class="btn sm" id="fmAdd" type="button">＋ 继续添加</button>
          <span class="fm-hint">删除会同时从工作区的 <code>input/${esc(cat)}/</code> 里移除，不可恢复。</span>
        </div>`
      : `<p class="fm-hint">这一类还没有材料。把文件拖到对话页对应的槽位，或点下面的按钮选。</p>
        <div class="fm-actions"><button class="btn sm primary" id="fmAdd" type="button">＋ 选择文件</button></div>`;

    openDrawer(`${label} · 已提交的材料`, html, () => {
      const addBtn = document.querySelector('#fmAdd');
      if (addBtn) {
        addBtn.addEventListener('click', async () => {
          closeDrawer();
          try {
            await reportImport(await api.input.pick(cat));
          } catch (err) {
            toast('打开文件选择框失败：' + err.message, 'err');
          }
        });
      }
      document.querySelectorAll('.fm-del').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.del;
          if (!confirm(`确定删除「${name}」？\n\n会从 input/${cat}/ 里移除，不可恢复。`)) return;
          const r = await api.input.remove(cat, name);
          if (!r.ok) {
            toast('删除失败：' + r.error, 'err');
            return;
          }
          toast('已删除 ' + name, 'ok');
          await refreshSlots();
          openCatFiles(cat, label);   // 刷新列表
        });
      });
    });
  }

  /** 把工作区 input/<分类>/ 里的文件数回填到四个槽位上 */
  async function refreshSlots(scope) {
    const host = (scope || document).querySelector('#slots');
    if (!host) return;
    let data;
    try {
      data = await api.input.list();
    } catch {
      return;
    }
    for (const cat of data.cats || []) {
      const el = host.querySelector(`.slot[data-cat="${cat.key}"]`);
      if (!el) continue;
      const n = (cat.files || []).length;
      el.classList.toggle('has', n > 0);
      const badge = el.querySelector('.slot-count');
      if (!n) {
        badge.innerHTML = '';
        el.removeAttribute('title');
        continue;
      }
      // 徽章带个垃圾桶图标 —— 光写「N 项」看着像静态标签，没人知道能点
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>'
        + `${n} 项`;
      // 悬停能看到具体文件名 + 怎么操作
      el.title = `${cat.files.map((f) => f.name).join('\n')}\n\n点击管理 / 删除这类材料`;
    }
  }

  /* ================= 对话流程 ================= */

  function setStreaming(on) {
    state.streaming = on;
    $('btnSend').classList.toggle('hidden', on);
    $('btnStop').classList.toggle('hidden', !on);
    $('input').disabled = on;
  }

  /* ================= 回滚：退回到某一条提问之前 ================= */

  /**
   * 每条提问都留一个「回滚到这里」。
   *
   * 以前只给最后一条留按钮（怕攒一堆点不清），但现在回滚是**整体还原快照** ——
   * 退到第 3 条和第 5 条是有区别的，所以每条都得留。
   */
  function markRollbackTarget(wrap, msg) {
    const col = wrap.querySelector('.msg-col');
    if (!col || col.querySelector('.rb-btn')) return;   // 已有就别重复插
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rb-btn';
    btn.title = '退回到这条之前：这条之后的对话作废，工作区还原到发送前的状态';
    btn.textContent = '回滚到这里';
    btn.addEventListener('click', () => enterEdit(wrap, msg, btn));
    col.appendChild(btn);
  }

  function enterEdit(wrap, msg, btn) {
    if (state.streaming) return;
    const col = wrap.querySelector('.msg-col');
    const bubble = col && col.querySelector('.bubble');
    if (!col || !bubble || col.querySelector('.rb-edit')) return;
    btn.remove();

    const box = document.createElement('div');
    box.className = 'rb-edit';
    box.innerHTML =
      '<textarea class="rb-input" rows="4" spellcheck="false"></textarea>' +
      '<div class="rb-actions">' +
      '<span class="rb-hint">重发后：这条之后的对话作废，工作区还原到发送前的状态</span>' +
      '<button type="button" class="btn ghost rb-cancel">取消</button>' +
      '<button type="button" class="btn primary rb-go">重发</button>' +
      '</div>';
    const ta = box.querySelector('.rb-input');
    ta.value = msg.content;
    bubble.style.display = 'none';
    col.appendChild(box);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    box.querySelector('.rb-cancel').addEventListener('click', () => {
      box.remove();
      bubble.style.display = '';
      markRollbackTarget(wrap, msg);
    });
    box.querySelector('.rb-go').addEventListener('click', () => doRollback(msg, ta.value));
  }

  async function doRollback(msg, newText) {
    const text = String(newText || '').trim();
    if (!text || state.streaming) return;
    const idx = state.messages.indexOf(msg);
    if (idx < 0) return;

    // ① 还原工作区。优先用快照 —— 它连**被覆盖的文件**都能还原回去；
    //    老会话里的消息没有 snapId，退回旧的「把新产物挪进 _backup」逻辑。
    try {
      if (msg.snapId) {
        const r = await api.snapshot.restore(msg.snapId);
        if (r && r.ok) toast(`工作区已还原到发送前（原内容存进 ${r.backup}/）`);
        else if (r && r.error) toast('工作区没还原成功：' + r.error);
      } else if (msg.at) {
        const r = await api.session.rollback(msg.at);
        if (r && r.ok && r.moved && r.moved.length) {
          toast(`已把 ${r.moved.length} 个产物移到 ${r.backup}`);
        }
      }
    } catch { /* 文件问题不该卡住对话回滚 */ }

    // ② 对话截断到这条之前；DOM 必须同步删，否则界面和 state 会对不上
    state.messages.splice(idx);
    const nodes = [...$('messages').querySelectorAll('.msg')];
    nodes.slice(idx).forEach((el) => el.remove());

    // ③ 重发
    send(text);
  }

  async function send(text, timeoutMs) {
    const content = String(text || '').trim();
    if (!content || state.streaming) return;

    if (!state.config?.hasApiKey) {
      openSettings();
      return;
    }

    $('input').value = '';
    const empty = $('messages').querySelector('.empty-state');
    if (empty) empty.remove();

    // 会话标题：第一条消息自动命名（取首行、截 20 字）。
    // 以前所有会话都叫「新会话」，侧栏和历史列表完全分不出哪个是哪个。
    if (state.sessionTitle === '新会话' || !state.sessionTitle) {
      const firstLine = content.split('\n').find((l) => l.trim()) || content;
      state.sessionTitle = firstLine.trim().slice(0, 20) || '新会话';
    }

    // 先给工作区拍一张快照 —— 回滚时用它整体还原（覆盖 / 新增 / 删除都能回去）。
    // 失败不阻断发送：快照只是后悔药，不该变成发消息的前置条件。
    let snapId = '';
    try {
      const s = await api.snapshot.create({ label: content.slice(0, 40) });
      if (s && s.ok) snapId = s.id;
    } catch { /* 拍不了就算了，回滚时会退回旧逻辑 */ }

    // ⚠️ at 只用于「回滚产物」判断文件改动时间，不会发给模型 ——
    // 主进程 sanitizeMessage 走白名单，只放行 role/content/name/tool_calls/tool_call_id。
    const userMsg = { role: 'user', content, at: Date.now(), snapId };
    state.messages.push(userMsg);
    const { wrap, bubble } = makeMsgEl('user');
    bubble.innerHTML = mdToHtml(content);
    $('messages').appendChild(wrap);
    markRollbackTarget(wrap, userMsg);

    // assistant 占位
    const a = makeMsgEl('assistant');
    a.bubble.innerHTML = '<p class="typing">思考中…</p>';
      $('messages').appendChild(a.wrap);
      state.currentAssistantEl = a;
      state.currentAssistant = { role: 'assistant', content: '', reasoning: '', tool_calls: [] };
      state.reasoningBuffer = '';
      state.toolNodes.clear();
      // 清掉上一轮的结束提示（state + DOM 都要清）
      state.turnStatus = null;
      state.assistantPushed = false;
      paintTurnStatus();
      scrollBottom(true);

    setStreaming(true);
    $('statusHint').textContent = '正在处理…';

    try {
      const res = await api.chat.send({
        // 传完整历史（含 assistant / tool 消息），让模型能看到工具调用链。
        // 注意：这里曾经写成 slice(0, -0) —— 因为 -0 === 0，它等价于 slice(0, 0)，
        // 会返回空数组，导致用户消息根本传不到主进程。
        messages: state.messages.slice(),
        sessionId: state.sessionId,
        title: state.sessionTitle,
        // 只有重试时才带 —— 平时用主进程的默认值
        timeoutMs,
      });
      if (res && res.ok && Array.isArray(res.messages)) {
        state.messages = res.messages;
        renderMessages();
        } else if (res && res.licenseBlocked) {
          // 主进程拒了（体验到期/未激活）—— 直接把激活界面推上来，
          // 别只写一行红字让用户摸不着头脑
          a.bubble.innerHTML = `<p style="color:var(--danger)">${esc(res.error)}</p>`;
          refreshLicense();
        } else if (res && res.error) {
          a.bubble.innerHTML = `<p style="color:var(--danger)">${esc(res.error)}</p>`;
        }
    } catch (err) {
      a.bubble.innerHTML = `<p style="color:var(--danger)">发送失败：${esc(err.message)}</p>`;
    } finally {
      setStreaming(false);
      state.currentAssistantEl = null;
      state.currentAssistant = null;
      $('statusHint').textContent = '';
      loadSessions();
      refreshFiles();
    }
  }

  function onChatEvent(ev) {
    const a = state.currentAssistantEl;
    switch (ev.type) {
      case 'turn_start':
        // 每一轮都要有自己的 assistant 消息对象，并且 assistantPushed 必须按轮复位。
        // 以前两者都只在 send() 里做一次：从第 2 轮起，新 assistant 不入列、
        // 它的 tool 消息却照样入列 —— 留下「没有 assistant 的孤儿 tool 消息」，
        // 只要这一轮之后出错/中断（没被主进程回灌覆盖），下一次请求就必然 400。
        state.assistantPushed = false;
        if (!state.currentAssistant) {
          state.currentAssistant = { role: 'assistant', content: '', reasoning: '', tool_calls: [] };
        }
        // 从这一刻到第一个字之间是"等模型"，要看得见在等
        startWait(`第 ${ev.iteration} 轮 · 等待模型响应`);
        break;

      case 'reasoning':
        stopWait();
        state.reasoningBuffer += ev.text;
        if (state.currentAssistant) state.currentAssistant.reasoning = state.reasoningBuffer;
        if (a) {
          // 思考文字进「思考过程」折叠块 —— 放在气泡里的话，长思考会把正文挤没，
          // 而且没法收起来。这里是它的正确归属。
          const box = getThinkBlock(a.col);
          writeReasoning(box, state.reasoningBuffer);
          refreshThinkMeta(box);
        }
        break;

      case 'delta':
        stopWait();
        if (!a) break;
        if (!state.currentAssistant) state.currentAssistant = { role: 'assistant', content: '', reasoning: '', tool_calls: [] };
        state.currentAssistant.content += ev.text;
        a.bubble.innerHTML = mdToHtml(state.currentAssistant.content);
        scrollBottom();
        break;

      case 'tool_start': {
        if (!a) break;
        const node = buildToolCard(ev.id, ev.name, ev.args);
        node.classList.add('open', 'running');   // 执行中先展开，好看到在跑什么
        // ⚠️ 必须放进 .think-body（竖向列），不能直接 append 到 .msg ——
        // .msg 是横向 flex，直接放会跟气泡并排，卡片就被挤成一条一条的
        const box = getThinkBlock(a.col);
        box.querySelector('.think-body').appendChild(node);
        box.classList.add('open');               // 跑的时候自动展开
        state.toolNodes.set(ev.id, node);
        if (state.currentAssistant) {
          // 第一次工具调用时**按引用**入列：工具消息必须排在 assistant 之后，
          // 而 tool_calls 要到这一轮结束才集齐 —— 所以先入列、再原地追加。
          if (!state.assistantPushed) {
            state.messages.push(state.currentAssistant);
            state.assistantPushed = true;
          }
          state.currentAssistant.tool_calls.push({
            id: ev.id,
            type: 'function',
            function: { name: ev.name, arguments: JSON.stringify(ev.args) },
          });
        }
        refreshThinkMeta(box);
        startWait(`执行 ${describeStep(ev.name, ev.args)}`);
        scrollBottom();
        break;
      }

      case 'tool_stream': {
        const node = state.toolNodes.get(ev.id);
        if (!node) break;
        const out = node.querySelector('.tool-out pre');
        if (out) {
          if (out.textContent === '等待结果…') out.textContent = '';
          out.textContent += ev.text;
          out.scrollTop = out.scrollHeight;
        }
        break;
      }

      case 'tool_result': {
        const node = state.toolNodes.get(ev.id);
        if (!node) break;
        node.classList.remove('running', 'pending');
        node.classList.add(ev.ok ? 'ok' : 'fail');
        // 跑完就收起来 —— 展开是"看进度"，收起是"看结论"
        node.classList.remove('open');
        const meta = node.querySelector('.meta');
        if (meta) meta.textContent = ev.ok ? `${ev.elapsed || 0} ms` : '失败';
        node.querySelector('.tool-out').innerHTML = `<pre>${esc(ev.output)}</pre>`;
        const box = node.closest('.think');
        if (box) refreshThinkMeta(box);
        // assistant 已经在第一次 tool_start 时入列了，这里只追加工具结果
        state.messages.push({ role: 'tool', tool_call_id: ev.id, content: ev.output });
        break;
      }

        case 'turn_end':
          // assistant 已在 tool_start 时入列；没有工具调用的纯文本回复则在 done 里处理
          if (state.currentAssistant && !state.assistantPushed) {
            state.messages.push(state.currentAssistant);
            state.assistantPushed = true;
          }
          state.currentAssistant = null;
          state.reasoningBuffer = '';
          addUsage(ev.usage);   // Token 仪表盘：主进程已把各家字段归一化
          // 注意：**不要在这里收折叠块** —— turn_end 是在工具执行**之前**发的，
          // 在这里收会在工具还在跑的时候把块合上。收的动作放在 done/error/aborted。
          break;

      /* ---- 三种结束事件以前完全没处理，导致界面看起来是"自己停了" ---- */

      case 'done':
        stopWait();
        // 纯文本回复（没有工具调用）在 turn_end 已入列，这里只是兜底
        if (state.currentAssistant && !state.assistantPushed) {
          state.messages.push(state.currentAssistant);
          state.assistantPushed = true;
        }
        if (a) {
          const box = a.col && a.col.querySelector(':scope > .think');
          if (box) {
            refreshThinkMeta(box);
            if (!box.dataset.userToggled) box.classList.remove('open');
          }
        }
        $('statusHint').textContent = '';
        appendTurnStatus('done', '本轮已完成');
        break;

      case 'aborted':
        stopWait();
        if (a) {
          const box = a.col && a.col.querySelector(':scope > .think');
          if (box) box.classList.remove('open');
        }
        appendTurnStatus('stopped', '已手动停止');
        break;

      case 'error':
        stopWait();
        if (a) {
          const box = a.col && a.col.querySelector(':scope > .think');
          if (box) box.classList.remove('open');
        }
        // 以前只写 statusHint，而 send() 的 finally 会把它清掉 —— 报错一闪就没
        // 超时是"可以再来一次"的错，给可操作的卡片；
        // 其他错误（配置错、参数错）重试也没用，给一行提示就够。
        if (isTimeoutError(ev.message)) {
          appendRetryCard(ev.message || '模型超时');
        } else {
          appendTurnStatus('error', ev.message || '执行出错');
        }
        break;

      default:
        break;
    }
  }

  /* ================= 命令面板（Ctrl+K） ================= */

  /**
   * 常用说法。原来是首屏的 4 张快捷卡，按用户决策从首屏撤掉、挪进命令面板 ——
   * 首屏保持干净，但「不知道该怎么开口」的人仍然有现成句式可选。
   */
  const QUICK_PROMPTS = [
    { t: '从赛题做到论文', d: '材料我分好了，走完整五步，论文出 Word 版' },
    { t: '先只做题目分析', d: '拆子问题、选模型、写假设和符号表，先看看思路对不对' },
    { t: '只画竞赛图', d: '技术路线图 + 各子问题流程图，要可编辑的源文件' },
    { t: '交卷前自检', d: '论文写完了，按十二闸过一遍，告诉我哪里必须改' },
  ];

  /** 把 query 拆成字符，看能否按顺序在 text 里找到（子序列模糊匹配） */
  function fuzzyScore(text, q) {
    const t = String(text).toLowerCase();
    const s = q.toLowerCase();
    if (!s) return 1;
    const direct = t.indexOf(s);
    if (direct === 0) return 1000;              // 前缀命中，最强
    if (direct > 0) return 500 - direct;        // 包含命中
    // 子序列：q 的字符按顺序出现在 t 里
    let i = 0;
    for (const ch of t) {
      if (ch === s[i]) i += 1;
      if (i === s.length) return 100;           // 能拼出来就给个基础分
    }
    return 0;
  }

  function buildCommands() {
    const cmds = [
      { g: '操作', t: '新建会话', k: 'Ctrl+N', run: () => newSession() },
      { g: '操作', t: '打开设置', run: () => openSettings() },
      { g: '操作', t: '运行环境（Python / draw.io）', run: () => openEnv() },
      { g: '操作', t: '切换工作区', run: () => $('btnWorkspace').click() },
      { g: '操作', t: '刷新工作区文件树', run: () => refreshFiles() },
      { g: '操作', t: '切换深色 / 浅色主题', run: () => $('btnTheme').click() },
      { g: '操作', t: 'Token 用量仪表盘', run: () => openUsageDashboard() },
    ];
    for (const p of QUICK_PROMPTS) {
      cmds.push({ g: '常用说法', t: p.t, d: p.d, run: () => { $('input').value = p.d; $('input').focus(); } });
    }
    for (const s of state.sessionCache || []) {
      cmds.push({ g: '会话', t: s.title || s.id, d: s.id === state.sessionId ? '当前会话' : '', run: () => openSession(s.id) });
    }
    return cmds;
  }

  let cmdkItems = [];   // 当前渲染出来的项（已按分数排序）
  let cmdkIndex = 0;

  function openCmdk() {
    const el = $('cmdk');
    if (!el) return;
    el.classList.remove('hidden');
    $('cmdkMask').classList.remove('hidden');
    $('cmdkInput').value = '';
    renderCmdk('');
    $('cmdkInput').focus();
  }

  function closeCmdk() {
    const el = $('cmdk');
    if (!el) return;
    el.classList.add('hidden');
    $('cmdkMask').classList.add('hidden');
  }

  function renderCmdk(q) {
    const all = buildCommands();
    const scored = all
      .map((c) => ({ c, s: Math.max(fuzzyScore(c.t, q), fuzzyScore(c.d || '', q) * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    cmdkItems = scored.map((x) => x.c);
    if (cmdkIndex >= cmdkItems.length) cmdkIndex = 0;

    const host = $('cmdkList');
    if (!cmdkItems.length) {
      host.innerHTML = '<div class="cmdk-empty">没有匹配的命令</div>';
      return;
    }
    // 按分组渲染，组内保持分数顺序
    let html = '';
    let lastG = null;
    cmdkItems.forEach((c, i) => {
      if (c.g !== lastG) {
        html += `<div class="cmdk-group">${esc(c.g)}</div>`;
        lastG = c.g;
      }
      html += `<div class="cmdk-item${i === cmdkIndex ? ' sel' : ''}" data-i="${i}">
        <span class="ci-t">${esc(c.t)}</span>
        ${c.d ? `<span class="ci-d">${esc(c.d)}</span>` : ''}
        ${c.k ? `<kbd>${esc(c.k)}</kbd>` : ''}
      </div>`;
    });
    host.innerHTML = html;
    host.querySelectorAll('.cmdk-item').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        cmdkIndex = Number(el.dataset.i);
        host.querySelectorAll('.cmdk-item').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
      });
      el.addEventListener('click', () => runCmdkItem(Number(el.dataset.i)));
    });
  }

  function runCmdkItem(i) {
    const c = cmdkItems[i];
    if (!c) return;
    closeCmdk();
    try {
      c.run();
    } catch (err) {
      toast('命令执行失败：' + err.message, 'err');
    }
  }

  function moveCmdk(delta) {
    if (!cmdkItems.length) return;
    cmdkIndex = (cmdkIndex + delta + cmdkItems.length) % cmdkItems.length;
    const host = $('cmdkList');
    host.querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('sel', i === cmdkIndex));
    const sel = host.querySelector('.cmdk-item.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  /* ================= 授权：体验倒计时 & 激活 ================= */

  let licenseState = null;
  let trialTimer = null;

  function fmtTrial(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function stopTrialTicker() {
    if (trialTimer) { clearInterval(trialTimer); trialTimer = null; }
  }

  /**
   * 倒计时用本地时间推算，**不每秒去问主进程** ——
   * 那会把 IPC 打爆，而且没意义（剩余时长是单调递减的）。
   */
  function startTrialTicker() {
    stopTrialTicker();
    const endAt = Date.now() + (licenseState?.remainingMs || 0);
    const tick = () => {
      const left = endAt - Date.now();
      const badge = $('trialBadge');
      if (!badge) return;
      if (left <= 0) { stopTrialTicker(); refreshLicense(); return; }
      badge.textContent = '体验中 ' + fmtTrial(left);
      // 剩不到 15 分钟就变黄，提醒该买卡了
      badge.classList.toggle('urgent', left < 15 * 60 * 1000);
    };
    tick();
    trialTimer = setInterval(tick, 1000);
  }

  async function openLock(state) {
    const mask = $('lockMask');
    if (!mask) return;
    mask.classList.remove('hidden');
    // 三种锁定原因要分开说 —— 用户看到"体验已结束"会以为自己没买过；
    // 而付费卡到期的人需要的是"续期"而不是"激活"。
    if (state?.mode === 'none') {
      $('lockTitle').textContent = '需要激活';
      $('lockSub').textContent = '这台电脑还没有激活，激活后即可使用。';
    } else if (state?.expiredCard) {
      $('lockTitle').textContent = '授权已到期';
      $('lockSub').textContent = `卡密 ${state.card || ''} 已过有效期。续期或购买新卡后即可继续使用。`;
    } else {
      $('lockTitle').textContent = '体验已结束';
      $('lockSub').textContent = '2 小时体验时间已用完。激活后即可继续使用。';
    }
    // 机器码
    try {
      const m = await api.license.machine();
      $('lockMachine').textContent = m.pretty || m.machine || '读取失败';
      if (m.degraded) {
        $('lockMachine').title = '这台电脑的硬件信息读取不全，机器码唯一性较弱，请联系客服';
      }
    } catch { $('lockMachine').textContent = '读取失败'; }
    // 只留微信码 —— 付款环节挪到微信里聊，软件里不再放收款码了。
    const wxImg = $('lockQrWechat');
    if (wxImg) {
      try {
        const q = await api.license.qr('wechat');
        if (q.ok) { wxImg.src = q.dataUrl; wxImg.classList.remove('hidden'); }
        else { wxImg.classList.add('hidden'); }
      } catch { wxImg.classList.add('hidden'); }
    }
    setTimeout(() => $('lockInput')?.focus(), 100);
  }

  /* ---- 二维码弹窗（侧栏点联系方式时开）---- */

  async function openQrModal() {
    const m = $('qrModal');
    if (!m) return;
    m.classList.remove('hidden');
    const img = $('qrModalImg');
    if (img && !img.src) {
      try {
        const q = await api.license.qr('wechat');
        if (q.ok) { img.src = q.dataUrl; img.classList.remove('hidden'); }
        else { img.classList.add('hidden'); }
      } catch { img.classList.add('hidden'); }
    } else if (img) {
      // 已经加载过：直接显示（首次失败时被 add('hidden') 藏起来了）
      img.classList.remove('hidden');
    }
  }

  function closeQrModal() {
    $('qrModal')?.classList.add('hidden');
  }

  function closeLock() {
    $('lockMask')?.classList.add('hidden');
    $('lockErr')?.classList.add('hidden');
  }

  async function refreshLicense() {
    try {
      licenseState = await api.license.state();
    } catch {
      // 授权状态读不出来时**不放行**：宁可让用户看到激活页，也不要默认放行
      licenseState = { mode: 'none' };
    }
    const badge = $('trialBadge');
    if (licenseState.mode === 'trial') {
      badge?.classList.remove('hidden');
      closeLock();
      startTrialTicker();
    } else if (licenseState.mode === 'activated') {
      badge?.classList.add('hidden');
      stopTrialTicker();
      closeLock();
    } else {
      badge?.classList.add('hidden');
      stopTrialTicker();
      openLock(licenseState);
    }
    paintSideLicense();
  }

  /** 侧栏页脚里显示卡号和到期日 —— 用户能看到自己买的是什么、什么时候到期 */
  function paintSideLicense() {
    const el = $('sideLicense');
    if (!el) return;
    if (licenseState?.mode === 'activated' && licenseState.card) {
      const exp = licenseState.expireAt
        ? new Date(licenseState.expireAt).toISOString().slice(0, 10)
        : '—';
      el.innerHTML = `已授权 <b>${esc(licenseState.card)}</b><br>有效期至 ${esc(exp)}`;
      el.classList.remove('hidden');
    } else if (licenseState?.mode === 'trial') {
      el.textContent = '体验版 · 未激活';
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  async function doActivate() {
    const cred = ($('lockInput')?.value || '').trim();
    const err = $('lockErr');
    const btn = $('lockActivate');
    if (!cred) {
      err.textContent = '请先粘贴卡密';
      err.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    btn.textContent = '校验中…';
    err.classList.add('hidden');
    try {
      const r = await api.license.activate(cred);
      if (r.ok) {
        toast('激活成功，感谢支持');
        await refreshLicense();
        // 激活后才派生出邀请码（取自卡号）—— 不刷新的话侧栏还显示"激活后可见"
        await refreshInvite();
        renderMessages();
      } else {
        err.textContent = r.error || '激活失败';
        err.classList.remove('hidden');
      }
    } catch (e) {
      err.textContent = '激活出错：' + e.message;
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '解 锁';
    }
  }

  /** 绑定激活界面的事件。init 里调一次 */
  function bindLicenseUI() {
    $('lockCopy')?.addEventListener('click', async () => {
      const txt = $('lockMachine').textContent || '';
      try {
        await navigator.clipboard.writeText(txt);
        toast('机器码已复制');
      } catch {
        // 剪贴板被拒时退化成选中，用户自己按 Ctrl+C
        const r = document.createRange();
        r.selectNodeContents($('lockMachine'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        toast('已选中，按 Ctrl+C 复制');
      }
    });
    $('lockActivate')?.addEventListener('click', doActivate);
    $('lockInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doActivate(); }
    });
    // 侧栏联系方式 → 弹二维码
    $('btnContact')?.addEventListener('click', openQrModal);
    $('qrModalClose')?.addEventListener('click', closeQrModal);
    $('qrModalMask')?.addEventListener('click', closeQrModal);
  }

  /* ================= 赛事日历面板 =================
   * 数据全部来自主进程（competitions:list）—— 状态与倒计时由主进程按
   * 当前时间推导，渲染层只负责画，避免两边时钟/时区算得不一样。
   */

  let compState = null;      // { list, current, prices, license }
  let compTicker = null;

  /** 毫秒 → "43 天 5 小时" / "5 小时 12 分" / "12 分 30 秒" */
  function fmtCountdown(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    if (m > 0) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
  }

  /** 时间戳 → "2026-11-20 09:00"（本地时区） */
  function fmtLocal(ts) {
    if (!ts) return '待公布';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /**
   * 赛事是否已被当前授权解锁。
   * 体验期（trial）不做赛事限制 —— 试用可以试所有赛事，这样用户才敢买。
   */
  function compUnlocked(c) {
    const lic = compState?.license;
    if (!lic || lic.mode === 'trial') return true;
    if (lic.mode !== 'activated') return false;
    const owned = lic.competition;
    return !owned || owned === 'all' || owned === c.id;
  }

  function renderCompetitions() {
    const host = $('cmpList');
    if (!host || !compState) return;
    const { list, current } = compState;
    host.innerHTML = '';

    for (const c of list) {
      const unlocked = compUnlocked(c);
      const isCurrent = c.id === current;
      const el = document.createElement('div');
      el.className = 'cmp-item' + (isCurrent ? ' active' : '');

      // 倒计时只在"报名中"显示；进行中/已结束/待公布都不显示
      const countdown = c.status === 'open' && c.countdownMs > 0
        ? `<span class="cmp-count" data-start="${c.startAt}">距开赛 ${fmtCountdown(c.countdownMs)}</span>`
        : '';

      const timeLine = c.startAt
        ? `比赛 <b>${fmtLocal(c.startAt)}</b> → <b>${fmtLocal(c.endAt)}</b>`
          + (c.regDeadline ? `<br>报名截止 <b>${fmtLocal(c.regDeadline)}</b>` : '')
          + (c.paperDeadline ? `　论文截止 <b>${fmtLocal(c.paperDeadline)}</b>` : '')
        : `时间待官方公布`;

      el.innerHTML = `
        <div class="cmp-row1">
          <span class="cmp-name">${esc(c.name)}</span>
          <span class="cmp-status ${c.status}">${esc(c.statusText)}</span>
          ${countdown}
        </div>
        <div class="cmp-full">${esc(c.fullName)}</div>
        <div class="cmp-time">${timeLine}${c.fee ? `　官方报名费 <b>¥${c.fee}</b>/队` : ''}</div>
        ${c.note ? `<div class="cmp-note">${esc(c.note)}</div>` : ''}
        <div class="cmp-row2">
          <span class="cmp-price">¥${c.price}</span>
          <span class="cmp-lock ${unlocked ? 'ok' : 'no'}">${unlocked ? '已解锁' : '未解锁'}</span>
          <span class="cmp-spacer"></span>
          <button class="cmp-btn2" data-open="${esc(c.url)}">官网</button>
          ${isCurrent
            ? '<button class="cmp-btn2" disabled>当前赛事</button>'
            : `<button class="cmp-btn2 primary" data-set="${esc(c.id)}">设为当前赛事</button>`}
        </div>
      `;
      host.appendChild(el);
    }

    // 绑定按钮（用事件委托更省，但这里条目少，逐条绑更直观）
    host.querySelectorAll('[data-set]').forEach((b) => {
      b.addEventListener('click', async () => {
        const r = await api.competitions.setCurrent(b.dataset.set);
        if (r.ok) {
          toast('已切换当前赛事');
          await refreshCompetitions();
          refreshLicense();   // 赛事变了 → 门禁可能变化
        } else {
          toast(r.error || '切换失败', 'err');
        }
      });
    });
    host.querySelectorAll('[data-open]').forEach((b) => {
      b.addEventListener('click', async () => {
        const r = await api.openExternal(b.dataset.open);
        if (!r || !r.ok) toast((r && r.error) || '打不开链接', 'err');
      });
    });
  }

  /** 倒计时每秒重算 —— 本地推算，不每秒打 IPC */
  function startCompTicker() {
    if (compTicker) clearInterval(compTicker);
    compTicker = setInterval(() => {
      const nodes = document.querySelectorAll('.cmp-count[data-start]');
      if (!nodes.length) return;
      let anyOpen = false;
      nodes.forEach((n) => {
        const left = Number(n.dataset.start) - Date.now();
        if (left > 0) {
          n.textContent = '距开赛 ' + fmtCountdown(left);
          anyOpen = true;
        } else {
          // 刚好跨过开赛时刻：状态需要重算，交给主进程
          n.textContent = '即将开赛';
          refreshCompetitions();
        }
      });
      $('btnCompetitions')?.classList.toggle('urgent', anyOpen);
    }, 1000);
  }

  async function refreshCompetitions() {
    try {
      compState = await api.competitions.list();
    } catch {
      compState = null;
    }
    const btn = $('btnCompetitions');
    if (btn && compState) {
      const soon = compState.list.find((c) => c.status === 'open' && c.countdownMs > 0);
      btn.classList.toggle('urgent', Boolean(soon));
      // 按钮上带出最近一场的天数，不用点开就知道时间
      const label = btn.querySelector('span');
      if (label) {
        label.textContent = soon
          ? `${soon.name} ${Math.ceil(soon.countdownMs / 86400000)}天`
          : '赛事';
      }
    }
    renderCompetitions();
    startCompTicker();
  }

  function openCompetitions() {
    $('cmpMask')?.classList.remove('hidden');
    $('cmpPanel')?.classList.add('open');
    refreshCompetitions();
  }

  function closeCompetitions() {
    $('cmpMask')?.classList.add('hidden');
    $('cmpPanel')?.classList.remove('open');
  }

  function bindCompetitionUI() {
    $('btnCompetitions')?.addEventListener('click', openCompetitions);
    $('cmpClose')?.addEventListener('click', closeCompetitions);
    $('cmpMask')?.addEventListener('click', closeCompetitions);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('cmpPanel')?.classList.contains('open')) closeCompetitions();
    });
    // AI 声明草稿：按当前赛事规定写到工作区 reports/
    $('cmpAiDraft')?.addEventListener('click', async () => {
      const r = await api.aiDeclare.draft({});
      if (r && r.ok) {
        toast(`已生成：${r.file}（用途与提示方式请自行核实填写）`);
        await refreshFiles();
      } else if (r && r.licenseBlocked) {
        closeCompetitions();
        refreshLicense();
      } else {
        toast((r && r.error) || '生成失败', 'err');
      }
    });
  }

  /* ================= 邀请码 =================
   * 邀请码 = 卡号后 6 位，由主进程派生（invite:info）。
   * ⚠️ 这里**不做本地计数、不做自动解锁** —— 纯离线应用统计不了
   * "朋友用了我的码"，本地记数删个文件就重置了。所以界面只负责
   * **显眼展示 + 一键复制**，减价与送卡由卖家在微信里确认发放。
   */

  let inviteInfo = null;

  async function refreshInvite() {
    try {
      inviteInfo = await api.invite.info();
    } catch {
      inviteInfo = null;
    }
    // 侧栏入口上的码：没激活时显示占位
    const el = $('sfInviteCode');
    if (el) el.textContent = inviteInfo?.code || '激活后可见';
    if ($('invCode')) renderInvitePanel();
  }

  function renderInvitePanel() {
    const codeEl = $('invCode');
    const rulesEl = $('invRules');
    if (!codeEl || !inviteInfo) return;

    const r = inviteInfo.rules || { friendDiscount: 5, threshold: 3, reward: '一期比赛的使用权' };
    codeEl.textContent = inviteInfo.code || '激活后可见';

    if (rulesEl) {
      rulesEl.innerHTML = `
        <div class="inv-rule">
          <span class="ir-n">1</span>
          <span>把邀请码发给同学，他购买时报这个码，<b>立减 ¥${r.friendDiscount}</b>。</span>
        </div>
        <div class="inv-rule">
          <span class="ir-n">2</span>
          <span>你每成功推荐 1 人记 1 次；累计满 <b>${r.threshold} 人</b>，送你 <b>${esc(r.reward)}</b>。</span>
        </div>
        <div class="inv-rule">
          <span class="ir-n">3</span>
          <span>推荐记录由客服核对后发放，<b>软件里不需要你操作什么</b>；
                截图发给客服即可对账。</span>
        </div>
        ${inviteInfo.activated ? '' : `
        <div class="inv-rule">
          <span class="ir-n">!</span>
          <span>你现在是体验版，<b>激活后才有专属邀请码</b>（邀请码取自你的卡号）。</span>
        </div>`}
      `;
    }
  }

  function openInvite() {
    $('invMask')?.classList.remove('hidden');
    $('invPanel')?.classList.add('open');
    refreshInvite();
  }

  function closeInvite() {
    $('invMask')?.classList.add('hidden');
    $('invPanel')?.classList.remove('open');
  }

  /** 复制文本，剪贴板被拒时退化成"选中提示" */
  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg || '已复制');
    } catch {
      toast('复制失败，请手动选中复制', 'err');
    }
  }

  function bindInviteUI() {
    $('btnInvite')?.addEventListener('click', openInvite);
    $('invClose')?.addEventListener('click', closeInvite);
    $('invMask')?.addEventListener('click', closeInvite);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('invPanel')?.classList.contains('open')) closeInvite();
    });

    $('invCopy')?.addEventListener('click', () => {
      const code = inviteInfo?.code;
      if (!code) { toast('激活后才有邀请码', 'err'); return; }
      copyText(code, '邀请码已复制');
    });

    $('invCopyMsg')?.addEventListener('click', () => {
      const code = inviteInfo?.code;
      if (!code) { toast('激活后才有邀请码', 'err'); return; }
      const r = inviteInfo.rules || { friendDiscount: 5 };
      copyText(
        `我在用「阿一古数模」做数模竞赛，从赛题到论文一条龙，代码在本机真跑。\n`
        + `用我的邀请码 ${code} 购买可以立减 ¥${r.friendDiscount}，你省钱我也攒次数，谢啦～`,
        '分享文案已复制'
      );
    });
  }

  /* ================= 会话 ================= */

  async function loadSessions() {
    const list = await api.session.list();
    state.sessionCache = list;   // 命令面板要用（切会话）
    const host = $('sessionList');
    host.innerHTML = '';
    if (!list.length) {
      host.innerHTML = '<li style="padding:8px 9px;font-size:12px;color:var(--text-faint)">暂无历史会话</li>';
      return;
    }
    for (const s of list) {
      const li = document.createElement('li');
      li.className = `session-item${s.id === state.sessionId ? ' active' : ''}`;
      li.innerHTML = `<span class="name" title="${esc(s.title)}">${esc(s.title)}</span><span class="del" title="删除">✕</span>`;
      li.addEventListener('click', async (e) => {
        if (e.target.classList.contains('del')) {
          e.stopPropagation();
          await api.session.remove(s.id);
          if (state.sessionId === s.id) newSession();
          loadSessions();
          return;
        }
        openSession(s.id);
      });
      host.appendChild(li);
    }
  }

  /** 切到指定会话。从 loadSessions 的点击逻辑里抽出来，命令面板复用 */
  async function openSession(id) {
    const data = await api.session.load(id);
    if (!data) return;
    state.sessionId = data.id;
    state.sessionTitle = data.title;
    state.messages = data.messages || [];
    // Token 统计按会话独立 —— 切过来时清零重算（历史用量没落盘）
    state.usage = emptyUsage();
    paintTokenBar();
    renderMessages();
    loadSessions();
  }

  function newSession() {
    state.sessionId = `session-${Date.now()}`;
    state.sessionTitle = '新会话';
    state.messages = [];
    // Token 统计按会话独立计数
    state.usage = emptyUsage();
    paintTokenBar();
    renderMessages();
    $('statusHint').textContent = '';
    loadSessions();
  }

  /* ================= 文件树 ================= */

  async function refreshFiles() {
    const items = await api.workspace.list('');
    const host = $('fileTree');
    host.innerHTML = '';
    if (!items.length) {
      host.innerHTML = '<li style="padding:8px 9px;font-size:12px;color:var(--text-faint)">工作区为空</li>';
      return;
    }
    for (const it of items) {
      host.appendChild(makeTreeRow(it, 0));
    }
  }

  /**
   * 文件图标。**只用一个几何符号族**（U+25xx 区段），按类别分。
   *
   * 原来混了 emoji（🐍📝📕）、几何符号（▸ ⚙ ▦）和数学斜体（𝑇 Ⓜ）三种语言，
   * 挤在 14px 宽的一列里非常杂。统一成一套后，靠"形状"而不是"颜色/画风"区分类别。
   */
  function iconFor(name, isDir) {
    if (isDir) return '▸';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      // 文档
      md: '▤', txt: '▤', docx: '▤', doc: '▤', tex: '▤',
      // 数据
      csv: '▦', xlsx: '▦', xls: '▦', json: '▦',
      // 代码
      py: '◈', m: '◈', js: '◈',
      // 图
      png: '◨', jpg: '◨', jpeg: '◨', svg: '◨', drawio: '◨',
      // PDF
      pdf: '▣',
    };
    return map[ext] || '·';
  }

  function makeTreeRow(item, depth) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = `tree-row${item.isDir ? ' dir' : ''}`;
    row.style.paddingLeft = `${9 + depth * 12}px`;
    row.innerHTML = `<span class="ic">${iconFor(item.name, item.isDir)}</span><span class="nm" title="${esc(item.rel)}">${esc(item.name)}</span>`;
    li.appendChild(row);

    if (item.isDir) {
      let expanded = false;
      const sub = document.createElement('ul');
      sub.style.listStyle = 'none';
      sub.style.margin = '0';
      sub.style.padding = '0';
      li.appendChild(sub);
      row.addEventListener('click', async () => {
        expanded = !expanded;
        row.querySelector('.ic').textContent = expanded ? '▾' : '▸';
        sub.innerHTML = '';
        if (expanded) {
          const children = await api.workspace.list(item.rel);
          for (const c of children) sub.appendChild(makeTreeRow(c, depth + 1));
        }
      });
    } else {
      row.addEventListener('click', () => openPreview(item));
    }
    return li;
  }

  /* ================= 预览 ================= */

  const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
  const TEXT_EXT = ['md', 'txt', 'json', 'py', 'm', 'tex', 'csv', 'js', 'ts', 'html', 'css', 'drawio', 'xml', 'yml', 'yaml', 'log'];

  async function openPreview(item) {
    const ext = (item.name.split('.').pop() || '').toLowerCase();
    const body = $('previewBody');
    $('previewTitle').textContent = item.rel;
    state.lastPreview = item.rel;
    document.querySelector('.app').classList.add('with-preview');
    $('previewPane').classList.remove('hidden');
    body.innerHTML = '<p style="color:var(--text-faint);font-size:12.5px">加载中…</p>';

    if (IMG_EXT.includes(ext)) {
      const url = await readAsDataUrl(item.rel);
      body.innerHTML = `<img src="${url}" alt="${esc(item.name)}">`;
    } else if (ext === 'drawio') {
      body.innerHTML = '<p style="color:var(--text-faint);font-size:12.5px">正在用 draw.io 渲染…</p>';
      const r = await api.drawio.export({ file: item.rel, format: 'png', scale: 1.5 });
      if (r && r.ok) {
        const url = await readAsDataUrl(r.file);
        body.innerHTML = url
          ? `<img src="${url}" alt="${esc(item.name)}">`
          : '<p style="color:var(--text-faint);font-size:12.5px">已导出，但预览图读取失败。</p>';
      } else {
        body.innerHTML = `<p style="color:var(--danger);font-size:12.5px;line-height:1.7">${esc(
          r?.error || '渲染失败'
        )}</p>`;
      }
    } else if (TEXT_EXT.includes(ext)) {
      const text = await readText(item.rel);
      if (ext === 'md') body.innerHTML = `<div class="md">${mdToHtml(text)}</div>`;
      else body.innerHTML = `<pre>${esc(text)}</pre>`;
    } else if (ext === 'pdf') {
      const url = await readAsDataUrl(item.rel);
      body.innerHTML = `<iframe src="${url}"></iframe>`;
    } else {
      body.innerHTML = `<p style="color:var(--text-faint);font-size:12.5px">该类型不支持内嵌预览，请用系统程序打开。</p>`;
    }
  }

  async function readText(rel) {
    const r = await api.workspace.read?.(rel);
    return r ?? '（无法读取）';
  }

  async function readAsDataUrl(rel) {
    const r = await api.workspace.dataUrl?.(rel);
    return r || '';
  }

  /* ================= 设置抽屉 ================= */

  function openDrawer(title, html, after) {
    $('drawerTitle').textContent = title;
    $('drawerBody').innerHTML = html;
    $('drawer').classList.remove('hidden');
    $('mask').classList.remove('hidden');
    if (after) after();
  }

  function closeDrawer() {
    $('drawer').classList.add('hidden');
    $('mask').classList.add('hidden');
  }

  function openSettings() {
    const c = state.config || {};
    const opts = state.providers
      .map((p) => `<option value="${p.id}"${p.id === c.provider ? ' selected' : ''}>${esc(p.label)}</option>`)
      .join('');

    openDrawer(
      '设置',
      `
      <div class="field">
        <label>服务商</label>
        <div class="desc">选择预设会自动填入 API 地址与候选模型；任何 OpenAI 兼容网关都可用「自定义」。</div>
        <select id="fProvider">${opts}</select>
      </div>

      <div class="field">
        <label>API 地址（Base URL）</label>
        <input type="text" id="fBaseUrl" value="${esc(c.baseUrl || '')}" placeholder="https://api.deepseek.com/v1">
      </div>

      <div class="field">
        <label>API Key</label>
        <div class="desc" id="keyHint">${
          c.hasApiKey ? `已配置（尾号 ${esc(c.apiKeyTail)}），留空表示不修改` : '尚未配置，请填入你的 API Key'
        }</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="password" id="fApiKey" style="flex:1" placeholder="${c.hasApiKey ? '留空则保持不变' : 'sk-...'}">
          ${c.hasApiKey ? '<button class="btn sm" type="button" id="btnClearKey" title="清除已保存的 Key">清除</button>' : ''}
        </div>
      </div>

      <div class="field">
        <label>模型</label>
        <input type="text" id="fModel" value="${esc(c.model || '')}" placeholder="deepseek-chat">
        <div class="chip-row" id="modelChips"></div>
      </div>

      <div class="field">
        <label>采样温度 <span id="tempVal" style="color:var(--brand)">${c.temperature ?? 0.3}</span></label>
        <input type="range" id="fTemp" min="0" max="1.5" step="0.05" value="${c.temperature ?? 0.3}" style="width:100%">
      </div>

      <div class="field">
        <label>单次最大输出 Token</label>
        <input type="number" id="fMaxTokens" value="${c.maxTokens || 8192}" min="256" step="256">
      </div>

      <div class="field">
        <label>最大工具迭代轮数</label>
        <div class="desc">复杂建模任务建议 80–150。</div>
        <input type="number" id="fMaxIter" value="${c.maxIterations || 80}" min="5" step="5">
      </div>

      <div id="testResult"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn" id="btnTest">测试连通性</button>
        <button class="btn primary" id="btnSaveCfg">保存</button>
      </div>
      `,
      () => {
        const providerSel = $('fProvider');
        const syncChips = () => {
          const p = state.providers.find((x) => x.id === providerSel.value);
          const host = $('modelChips');
          host.innerHTML = '';
          (p?.models || []).forEach((m) => {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.textContent = m;
            chip.addEventListener('click', () => {
              $('fModel').value = m;
            });
            host.appendChild(chip);
          });
        };
        providerSel.addEventListener('change', () => {
          const p = state.providers.find((x) => x.id === providerSel.value);
          if (p && p.baseUrl) $('fBaseUrl').value = p.baseUrl;
          if (p && p.models?.length) $('fModel').value = p.models[0];
          syncChips();
        });
        syncChips();
        $('fTemp').addEventListener('input', (e) => {
          $('tempVal').textContent = e.target.value;
        });

        $('btnTest').addEventListener('click', async () => {
          const box = $('testResult');
          box.innerHTML = '<div class="status-box info">正在测试…</div>';
          const override = {
            baseUrl: $('fBaseUrl').value.trim(),
            model: $('fModel').value.trim(),
          };
          const key = $('fApiKey').value.trim();
          if (key) override.apiKey = key;
          const r = await api.config.test(override);
          box.innerHTML = r.ok
            ? `<div class="status-box ok">连接成功 ✓ 模型：${esc(r.model)}<br>回复：${esc(r.reply || '(空)')}</div>`
            : `<div class="status-box err">连接失败：${esc(r.error || '未知错误')}</div>`;
        });

        $('btnSaveCfg').addEventListener('click', async () => {
          const patch = {
            provider: $('fProvider').value,
            baseUrl: $('fBaseUrl').value.trim(),
            model: $('fModel').value.trim(),
            temperature: Number($('fTemp').value),
            maxTokens: Number($('fMaxTokens').value),
            maxIterations: Number($('fMaxIter').value),
          };
          const key = $('fApiKey').value.trim();
          if (key) patch.apiKey = key;
          state.config = await api.config.save(patch);
          updateHeader();
          $('testResult').innerHTML = '<div class="status-box ok">已保存 ✓</div>';
          setTimeout(closeDrawer, 500);
        });

        // 清除已保存的 Key：传 '' 才是显式清空（主进程按 undefined/'' 区分）
        $('btnClearKey')?.addEventListener('click', async () => {
          state.config = await api.config.save({ apiKey: '' });
          $('fApiKey').value = '';
          $('keyHint').textContent = '已清除，请重新填入你的 API Key';
          $('testResult').innerHTML = '<div class="status-box info">已清除 API Key</div>';
          updateHeader();
          toast('已清除 API Key');
        });
      }
    );
  }

  function openEnv() {
    openDrawer('运行环境', '<p style="color:var(--text-faint);font-size:12.5px">正在检测…</p>', null);

    Promise.all([api.python.status(), api.drawio.status()]).then(([st, dw]) => {
      const deps = st.deps;
      const missing = (deps?.missing || []).map((m) => `${m.label}（${m.pip}）`).join('、') || '无';
      const okList = (deps?.installed || []).map((m) => m.label).join('、') || '无';
      const interpreters = st.interpreters
        .map((i) => `<option value="${esc(i.exe)}"${i.exe === st.active ? ' selected' : ''}>${esc(i.exe)}${i.version ? ` (${i.version})` : ' [应用环境]'}</option>`)
        .join('');

      openDrawer(
        '运行环境',
        `
        <h3 style="margin:0 0 10px;font-size:13.5px;font-weight:600">Python 运行时</h3>
        <div class="status-box ${deps?.ok ? 'ok' : 'err'}">
          ${deps?.ok ? '依赖齐备 ✓ 画图 / Excel / Word / 论文检索均可用' : '缺少依赖，部分功能（画图、Excel、Word）不可用'}
        </div>

        <div class="field">
          <label>解释器</label>
          <div class="desc">应用会优先使用自己创建的独立环境，避免污染系统 Python。</div>
          <select id="fPy">${interpreters || '<option value="">未检测到 Python</option>'}</select>
        </div>

        <div class="kv"><span class="k">独立环境目录</span><span class="v">${esc(st.venvDir || '')}</span></div>
        <div class="kv"><span class="k">已安装</span><span class="v">${esc(okList)}</span></div>
        <div class="kv"><span class="k">缺失</span><span class="v">${esc(missing)}</span></div>

        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button class="btn primary" id="btnPySetup">创建独立环境并安装依赖</button>
          <button class="btn" id="btnPyUse">使用所选解释器</button>
        </div>
        <div id="pyLog"></div>

        <hr style="border:none;border-top:1px solid var(--line);margin:22px 0 18px">

        <h3 style="margin:0 0 10px;font-size:13.5px;font-weight:600">draw.io 桌面版</h3>
        <div class="status-box ${dw.available ? 'ok' : 'err'}">
          ${dw.available ? '已检测到 ✓ 竞赛图可导出论文可引用的矢量 PDF' : '未检测到 —— 竞赛模式只能出 .drawio 源文件，无法导出 PDF'}
        </div>
        <div class="kv"><span class="k">可执行文件</span><span class="v">${esc(dw.path || '—')}</span></div>
        <div class="desc" style="margin-top:12px;line-height:1.65">
          用于把竞赛图（技术路线图 / 子问题流程图 / 模型结构图）导出成矢量 PDF。
          应用启动时自动探测，无需手动配置路径；未安装时可从
          github.com/jgraph/drawio-desktop/releases 获取。
        </div>

        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn" id="btnRecheck">重新检测</button>
        </div>
        `,
        () => {
          $('btnPySetup').addEventListener('click', async () => {
            $('pyLog').innerHTML = '<div class="log-box" id="pyLogBox">开始创建环境…（首次安装约需几分钟）</div>';
            $('btnPySetup').disabled = true;
            const off = api.chat.onEvent((ev) => {
              if (ev.type === 'python:output') {
                const box = $('pyLogBox');
                if (box) {
                  box.textContent += ev.text;
                  box.scrollTop = box.scrollHeight;
                }
              }
            });
            const r = await api.python.setup($('fPy').value);
            off();
            $('btnPySetup').disabled = false;
            const box = $('pyLogBox');
            if (box) box.textContent += r.ok ? '\n\n完成 ✓ 依赖已就绪。' : `\n\n失败：${r.error || '安装未成功，请检查网络'}`;
            state.config = (await api.config.get()).config;
          });

          $('btnPyUse').addEventListener('click', async () => {
            await api.python.setPath($('fPy').value);
            state.config = (await api.config.get()).config;
            openEnv();
          });

          $('btnRecheck').addEventListener('click', openEnv);
        }
      );
    });
  }

  /* ================= 顶栏与初始化 ================= */

  function updateHeader() {
    const c = state.config || {};
    const badge = $('modelBadge');
    if (c.hasApiKey && c.model) {
      badge.textContent = c.model;
      badge.classList.add('on');
    } else {
      badge.textContent = c.hasApiKey ? '未选模型' : '未配置 API';
      badge.classList.remove('on');
    }
    $('wsPath').textContent = state.workspace || '未设置工作区';
    $('wsPath').title = state.workspace || '';
  }

  async function init() {
    // 整体兜底：init 里任何一步抛错都会让界面停在半初始化状态
    // （按钮没绑、会话没加载），而且控制台之外看不到任何提示。
    // 这里至少把错误显示出来，让用户能反馈。
    try {
      await initBody();
    } catch (err) {
      console.error('[init] 初始化失败：', err);
      const host = $('messages');
      if (host) {
        host.innerHTML = `<div style="padding:24px;color:var(--danger);font-size:13px;line-height:1.8">
          <b>初始化失败</b><br>${esc(err && err.message ? err.message : String(err))}<br>
          <span style="color:var(--text-faint)">请截图反馈给客服；重启应用通常可恢复。</span>
        </div>`;
      }
    }
  }

  async function initBody() {
    const info = await api.config.get();
    state.config = info.config;
    state.providers = info.providers || [];
    state.skillsRoot = info.skillsRoot || '';
    state.workspace = await api.workspace.ensure();

    updateHeader();
    newSession();
    await loadSessions();
    await refreshFiles();

    api.chat.onEvent(onChatEvent);

    $('btnSend').addEventListener('click', () => send($('input').value));
    $('btnStop').addEventListener('click', () => api.chat.abort());
    $('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send($('input').value);
      }
    });

    $('btnSettings').addEventListener('click', openSettings);
    $('btnEnv').addEventListener('click', openEnv);
    $('btnWorkspace').addEventListener('click', async () => {
      const ws = await api.workspace.choose();
      if (ws) {
        state.workspace = ws;
        state.messages = [];
        updateHeader();
        newSession();
        await refreshFiles();
      }
    });
    $('btnNewSession').addEventListener('click', newSession);
    // 用可选链兜底：这个元素万一不在（老版本 HTML / 测试桩漏了），
    // 直接 $('tokenBar').addEventListener 会抛错，把整个 init 带崩
    $('tokenBar')?.addEventListener('click', openUsageDashboard);

    /* ---- 授权 ---- */
    bindLicenseUI();
    // 显式 catch：函数内部虽已兜底，但万一后续改动引入抛错路径，
    // 未处理的 rejection 会静默中断后面的初始化
    refreshLicense().catch((e) => console.error('[license] 状态刷新失败：', e));

    /* ---- 赛事日历 ---- */
    bindCompetitionUI();
    refreshCompetitions().catch((e) => console.error('[competitions] 刷新失败：', e));

    /* ---- 邀请码 ---- */
    bindInviteUI();
    refreshInvite().catch((e) => console.error('[invite] 刷新失败：', e));

    /* ---- 命令面板（Ctrl+K）---- */
    $('btnCmdk')?.addEventListener('click', openCmdk);
    $('cmdkMask')?.addEventListener('click', closeCmdk);
    $('cmdkInput')?.addEventListener('input', (e) => {
      cmdkIndex = 0;
      renderCmdk(e.target.value);
    });
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const panelOpen = $('cmdk') && !$('cmdk').classList.contains('hidden');

      // Ctrl+K 开关面板（面板开着时也认，等于"再按一次关掉"）
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (panelOpen) closeCmdk(); else openCmdk();
        return;
      }
      if (panelOpen) {
        if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); moveCmdk(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveCmdk(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); runCmdkItem(cmdkIndex); }
        return;
      }
      // 面板没开时的全局快捷键
      if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
    });
    $('btnRefreshFiles').addEventListener('click', refreshFiles);

    setupTheme();
    setupDropImport();

    $('btnDrawerClose').addEventListener('click', closeDrawer);
    $('mask').addEventListener('click', closeDrawer);

    $('btnPreviewClose').addEventListener('click', () => {
      document.querySelector('.app').classList.remove('with-preview');
      $('previewPane').classList.add('hidden');
    });
    $('btnPreviewOpen').addEventListener('click', () => {
      if (state.lastPreview) api.workspace.openPath(state.lastPreview);
    });

    // 首次使用引导
    if (!state.config.hasApiKey) setTimeout(openSettings, 350);
  }

  /* ================= 材料导入（拖拽 / 点选） =================
   * 客户把四类材料一起拖进来，统一落到工作区 input/，不分类不分槽位。
   * 导入完成后往对话里插一条记录 —— 这样 Agent 下一轮就知道有什么材料了。
   */

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 4600);
  }

  async function reportImport(r) {
    const ok = (r.files || []).filter((f) => f.ok);
    const bad = (r.files || []).filter((f) => !f.ok);
    await refreshSlots();
    if (ok.length) {
      const label = { 赛题: '竞赛赛题', 规范: '格式规范', 模板: '论文模板', 数据: '赛题数据' }[r.cat] || r.cat;
      toast(`已导入「${label}」${ok.length} 项`, 'ok');
    }
    if (bad.length) {
      toast(`有 ${bad.length} 项导入失败：${bad.map((f) => `${f.name}（${f.error}）`).join('；')}`, 'err');
    }
    return { ok, bad };
  }

  /** 拖进来的 FileList → 取真实路径 → 交给主进程复制到对应分类 */
  async function importDropped(cat, fileList) {
    const paths = [];
    for (const f of fileList) {
      try {
        const p = api.input.pathForFile(f);
        if (p) paths.push(p);
      } catch {
        /* 取不到路径的项跳过，最后按失败项报出来 */
      }
    }
    if (!paths.length) {
      toast('没能读到文件路径，请改用「点一下选文件」', 'err');
      return;
    }
    await reportImport(await api.input.import(cat, paths));
  }

  /* ================= 拖放共用状态 =================
   * 抽到外面是因为 bindSlots() 和 setupDropImport() 都要用 ——
   * 前者负责槽位，后者负责全局遮罩。
   */
  let dropOverlay = null;
  let dragDepth = 0;

  const hasFiles = (e) =>
    !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));

  function hideDropOverlay() {
    dragDepth = 0;
    if (dropOverlay) dropOverlay.classList.remove('show');
  }

  /**
   * 把事件绑到给定根节点里的槽位上。
   *
   * ⚠️ **必须由 buildEmptyState() 调用，不能在 init 里绑一次了事。**
   * renderMessages() 每次都会 `host.innerHTML = ''` 重建空态，
   * 槽位是全新的 DOM —— 绑在旧节点上的处理会随之一并丢掉。
   * 之前就是在 init 里 querySelectorAll('.slot') 绑一次，一旦重渲染就点不动了。
   */
  function bindSlots(root) {
    const host = (root || document).querySelector('#slots');
    if (!host) return;

    host.querySelectorAll('.slot').forEach((el) => {
      const cat = el.dataset.cat;

      el.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('over'));
      el.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();                    // 别让全局遮罩也收到
        el.classList.remove('over');
        hideDropOverlay();
        if (e.dataTransfer && e.dataTransfer.files.length) {
          await importDropped(cat, e.dataTransfer.files);
        }
      });

      // 点槽位：
      //   已有材料 → 打开管理面板（里面能删、能继续添加）
      //   空槽位   → 直接走系统选择框
      // 之前是"只有点徽章才开面板"，徽章长得像静态标签，没人会去点它。
      el.addEventListener('click', async () => {
        if (el.classList.contains('has')) {
          const name = el.querySelector('.slot-body b');
          await openCatFiles(cat, name ? name.textContent : cat);
          return;
        }
        try {
          await reportImport(await api.input.pick(cat));
        } catch (err) {
          toast('打开文件选择框失败：' + err.message, 'err');
        }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          el.click();
        }
      });
    });
  }

  function setupDropImport() {
    // 全局遮罩：只提示"拖到对应的分类里"，不再自己接收 —— 分类必须由用户指定
    const overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.innerHTML = '<div class="do-box"><b>拖到对应的分类里</b><i>赛题 / 规范 / 模板 / 数据，各归各位</i></div>';
    document.body.appendChild(overlay);
    dropOverlay = overlay;

    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth += 1;
      overlay.classList.add('show');
    });
    document.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();      // 不 preventDefault 的话 drop 不会触发
    });
    document.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) overlay.classList.remove('show');
    });
    /**
     * ⚠️ document 级 drop 兜底 —— 没有它，文件落在**槽位以外的任何地方**
     * （对话区、侧栏、顶栏）会走浏览器默认行为：把整个界面导航成那个文件
     * （拖张图进来 = 应用变成图片查看器，只能重启）。
     *
     * 槽位自己的 drop 已经 stopPropagation，所以这里只会收到"落空"的那些：
     * 一律 preventDefault 掉，然后提示用户拖到分类槽位里。
     */
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      overlay.classList.remove('show');
      // 落在槽位上时事件已被槽位消费（stopPropagation），不会走到这里；
      // 能走到这里就是落空了 —— 给一句明确指引，别让用户以为拖成功了
      toast('请拖到「赛题 / 规范 / 模板 / 数据」对应的分类槽位里', 'err');
    });
  }

  /* ================= 主题切换 =================
   * 初值由 theme.js 在 <head> 里设好（避免闪一帧）。
   * 这里只管切换与持久化 —— 用户选过就记住，不再跟系统走。
   */

  function setupTheme() {
    const btn = $('btnTheme');
    if (!btn) return;
    const root = document.documentElement;

    const paint = () => {
      const dark = root.dataset.theme !== 'light';
      // 显示的是"点下去会变成什么"，不是当前状态
      btn.textContent = dark ? '☀' : '☾';
      btn.title = dark ? '切换到浅色主题' : '切换到深色主题';
    };
    paint();

    btn.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem('mcm-theme', root.dataset.theme);
      } catch {
        /* localStorage 不可用时只是不记忆，不影响切换 */
      }
      // 同时写进配置：主进程下次启动要用它决定窗口底色
      api.config.save({ theme: root.dataset.theme }).catch(() => {});
      paint();
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  /* 集成测试钩子：只有 URL 带 __test 时才暴露内部状态。
     正常启动（file://.../index.html）不带这个参数，等于没有。
     有它才能断言 state.messages 的结构 —— 光看 DOM 看不出消息顺序对不对。 */
  if (location.search.includes('__test')) {
    window.__mcmTest = { state, onChatEvent, describeStep, openCmdk, closeCmdk, renderCmdk };
  }
})();
