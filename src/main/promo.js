'use strict';

/**
 * 宣传素材截图（由 --promo-shots 开关触发，与 --smoke 同一套启动路径）。
 *
 * 起一个按剧本回答的 mock LLM，让应用真实跑一轮「接料 → 分析 → 出图」，
 * 再从真实 UI 抓 1920x1080 截图到临时目录。
 *
 * 诚实性约定：截图全部来自真实运行的应用 —— mock 的只是 LLM 响应，
 * 工具调用（write_file / run_python）走真执行器，图是 matplotlib +
 * mcm_style 真画出来的。
 *
 * 跑完恢复 config.json / license.json 原状（体验计时不受影响）。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { app } = require('electron');

const store = require('./store');
const license = require('./license');
const paths = require('./paths');

const OUT_DIR = path.join(os.tmpdir(), 'mcm-promo-shots');
// 演示工作区放个"像真的"的路径 —— 标题栏会显示它
const WS = 'D:\\阿一古数模演示\\2026国赛C题';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- */
/* 演示工作区素材                                                     */
/* ---------------------------------------------------------------- */

function seedWorkspace() {
  fs.rmSync(WS, { recursive: true, force: true });
  for (const d of ['figures', 'code', 'results', 'reports', 'input/赛题', 'input/数据']) {
    fs.mkdirSync(path.join(WS, d), { recursive: true });
  }
  fs.writeFileSync(
    path.join(WS, 'input', '赛题', '赛题摘要.md'),
    [
      '# 某地区农作物种植策略优化',
      '',
      '某乡镇共有 1200 亩耕地，分布在 4 类地块上，计划在两个种植季中从 8 种',
      '作物中选择种植组合。已知各地块单位产量、作物种植成本、售价与预期销量',
      '上下界（见附件 1）。要求：',
      '',
      '1. 建立「作物选择 + 面积分配」的优化模型，使两季总利润最大；',
      '2. 讨论气候波动（产量 ±15%）下的稳健性；',
      '3. 给出可解释的种植方案与灵敏度分析。',
    ].join('\n'),
    'utf8'
  );

  // 确定性伪随机生成附件数据（地块 × 作物）
  let s = 42;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const crops = ['小麦', '玉米', '大豆', '马铃薯', '白菜', '西红柿', '辣椒', '食用菌'];
  const rows = ['地块,作物,面积_亩,单产_公斤每亩,成本_元每亩,售价_元每公斤'];
  for (const plot of ['平旱地', '梯田', '水浇地', '普通大棚']) {
    for (const c of crops) {
      rows.push(
        `${plot},${c},${20 + Math.floor(rand() * 60)},${1800 + Math.floor(rand() * 2200)},${300 + Math.floor(rand() * 900)},${(2 + rand() * 6).toFixed(1)}`
      );
    }
  }
  fs.writeFileSync(path.join(WS, 'input', '数据', '附件1.csv'), '\ufeff' + rows.join('\n'), 'utf8');
}

/* ---------------------------------------------------------------- */
/* mock LLM：按剧本三步走                                             */
/* ---------------------------------------------------------------- */

/**
 * mock LLM：按剧本返回固定响应。
 *
 * 刻意**不接收 skillsRoot**：早先版本把它插进演示代码里，
 * 导致截图带上真实的 C:\Users\<用户名>\... 路径（见 chartCode 的注释）。
 * 演示代码改用 %MCM_SKILL_ROOT% 占位符后，这个参数就没有用处了。
 */
function startMockLlm() {
  const received = [];
  const report = [
    '# 题目分析报告',
    '',
    '## 一、问题重述',
    '在 4 类地块、两个种植季的约束下，从 8 种作物中选择种植组合并分配面积，',
    '使两季总利润最大；同时要求方案在产量波动 ±15% 下保持稳健。',
    '',
    '## 二、决策变量与目标',
    '- 决策变量：x[i][j][k] = 地块 i 在第 k 季种作物 j 的面积（亩）',
    '- 目标函数：max Σ (单产 × 售价 − 成本) × 面积 − 超产滞销惩罚',
    '- 核心约束：地块面积上限、作物销量上下界、豆类轮作要求',
    '',
    '## 三、模型选择',
    '**0-1 混合整数规划**（选种组合）+ **线性规划**（面积分配），',
    '辅以**蒙特卡洛灵敏度分析**验证 ±15% 波动下的稳健性。',
    '',
    '## 四、可解性初判',
    '决策变量规模约 4×8×2 = 64 个，规模小，分支定界可在秒级求解。',
  ].join('\n');

  const chartCode = [
    "import os, sys",
    "import pandas as pd",
    "import matplotlib",
    "matplotlib.use('Agg')",
    "import matplotlib.pyplot as plt",
    "ROOT = os.environ.get('MCM_WORKSPACE') or os.getcwd()",
    // ⚠️ 这里必须用**占位符**，不能插真实 skillsRoot。
    //    这段代码会原样出现在宣传截图里并发布到 GitHub，
    //    而 skillsRoot 的真实值是
    //    C:\Users\<你的用户名>\AppData\Roaming\<品牌>\skills ——
    //    插进去等于把 Windows 用户名（有时还有旧品牌目录名）印在公开截图上。
    //    实测踩过：第一版截图里赫然写着 C:\Users\92182\AppData\Roaming\数模工坊\skills。
    //    占位符反而更贴近真实用户写法：技能文档教的就是 %MCM_SKILL_ROOT% 这一套。
    "SKILLS = os.environ.get('MCM_SKILL_ROOT', '')",
    "sys.path.insert(0, os.path.join(SKILLS, 'mcm-figure', 'scripts'))",
    "import mcm_style; mcm_style.apply()",
    "df = pd.read_csv(os.path.join(ROOT, 'input', '数据', '附件1.csv'))",
    "print(df.groupby('作物').size())",
    "import time; time.sleep(6)",
    "g = df.groupby('作物')['单产_公斤每亩'].mean().sort_values(ascending=False)",
    "fig, ax = plt.subplots(figsize=(6.3, 3.6))",
    "g.plot.bar(ax=ax, width=0.62)",
    "ax.set_xlabel('')",
    "ax.set_ylabel('平均单产（公斤/亩）')",
    "ax.set_title('八类作物平均单产概览（附件 1）')",
    "plt.setp(ax.get_xticklabels(), rotation=20, ha='right')",
    "mcm_style.save(fig, os.path.join(ROOT, 'figures', 'result_q1_1'))",
    "print('min_cost_per_mu =', int(df['成本_元每亩'].min()), 'max_price =', round(df['售价_元每公斤'].max(), 1))",
  ].join('\n');

  const script = [
    { tool: 'write_file', args: { path: 'reports/题目分析报告.md', content: report } },
    { tool: 'run_python', args: { code: chartCode } },
  ];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const step = received.length;
      received.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const contentChunks = (text) => {
        for (const ch of text.match(/[\s\S]{1,24}/g) || []) {
          send({ choices: [{ delta: { content: ch } }] });
        }
      };
      const toolCallChunk = (idx, name, args) => {
        send({
          choices: [{
            delta: {
              tool_calls: [{
                index: idx, id: `call_promo_${idx}`, type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              }],
            },
          }],
        });
      };
      const finish = (reason) => {
        send({ choices: [{ delta: {}, finish_reason: reason }] });
        res.write('data: [DONE]\n\n');
        res.end();
      };

      if (step === 0) {
        contentChunks(
          '收到。我先清点 input/ 下的四类材料：赛题 ✓、数据 ✓，规范与模板暂缺——先按通用规范推进。\n\n' +
          '**计划**：\n1. 通读赛题与附件，定决策变量与目标；\n2. 建 0-1 规划 + 灵敏度分析模型；\n3. 用真实数据验证可解性。\n\n先把分析报告落到 reports/：'
        );
        toolCallChunk(0, script[0].tool, script[0].args);
        finish('tool_calls');
      } else if (step === 1) {
        contentChunks('报告已写入 reports/。下面用附件 1 的真实数据做规模与量纲验证，并出一张数据概览图：');
        toolCallChunk(0, script[1].tool, script[1].args);
        finish('tool_calls');
      } else {
        contentChunks(
          '分析完成，两个交付物都在工作区里：\n\n' +
          '- `reports/题目分析报告.md` —— 问题重述、决策变量、模型选择与可解性初判；\n' +
          '- `figures/result_q1_1.png` —— 八类作物平均单产概览（PDF + PNG 双格式）。\n\n' +
          '**下一步**进入求解阶段：按 0-1 规划写可复现代码，跑出真实结果后再按模板成稿。要继续的话直接说。'
        );
        finish('stop');
      }
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received })));
}

/* ---------------------------------------------------------------- */
/* 截图驱动                                                           */
/* ---------------------------------------------------------------- */

async function capture(win, name) {
  await sleep(400);
  const img = await win.webContents.capturePage();
  const abs = path.join(OUT_DIR, name);
  fs.writeFileSync(abs, img.toPNG());
  console.log('SHOT =>', abs, `${img.getSize().width}x${img.getSize().height}`);
}

/** 轮询等待页面出现全部指定文本（超时抛错）。
 *  用 textContent 而不是 innerText —— 工具卡片完成后会折叠，innerText 拿不到折叠内容 */
async function waitForText(win, texts, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const has = await win.webContents.executeJavaScript(
      `(${JSON.stringify(texts)}).every(t => document.body.textContent.includes(t))`
    );
    if (has) return;
    await sleep(500);
  }
  throw new Error('等待超时：' + texts.join(' / '));
}

async function runPromoShots(win) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  seedWorkspace();

  // 备份配置与授权状态，跑完恢复
  const cfgFile = paths.getConfigPath();
  const licFile = path.join(paths.getUserDataDir(), 'license.json');
  const cfgBackup = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
  const licBackup = fs.existsSync(licFile) ? fs.readFileSync(licFile, 'utf8') : null;

  // 给开发机签一张临时演示凭证（activated 模式，图表不带体验水印）
  const machine = license.getMachineCode(paths.getUserDataDir());
  const priv = fs.readFileSync(path.join(__dirname, '..', '..', 'keys', 'license-private.pem'), 'utf8');
  const body = Buffer.from(JSON.stringify({
    card: 'MCM-2026-8823',
    machine: machine.code,
    edition: 'pro',
    issuedAt: Date.now(),
    expireAt: Date.now() + 24 * 3600 * 1000,
  })).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), priv).toString('base64url');
  license.writeState(paths.getUserDataDir(), { credential: `${body}.${sig}` });

  const { server, received } = await startMockLlm();
  const port = server.address().port;

  // 会话期间配置指向 mock LLM 与演示工作区（模型名展示用真实系列名，mock 不校验）
  store.writeConfig({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'promo-mock',
    model: 'deepseek-chat',
    workspace: WS,
    maxIterations: 6,
    pythonPath: path.join(paths.getPythonEnvDir(), 'Scripts', 'python.exe'),
  });

  // 成败标记：任何一步抛错都保持 true（见 finally 的退出码）
  let failed = true;
  try {
    // 配置是页面加载时读进去的，改完必须 reload 才生效（与 smoke 同款处理）
    win.webContents.reload();
    await sleep(3500);

    // 统一 1920x1080 内容区
    win.setContentSize(1920, 1080);
    await sleep(800);

    await capture(win, 'shot0_空工作台.png');

    // ── 第一轮：题目分析报告（write_file）──
    await win.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('input');
      input.value = '这道题是农作物种植策略优化，请先做题目分析，给出建模方案。';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnSend').click();
    })()`);
    // ── 抓「真实执行中」特写：run_python 卡片已开、统计表已打印、图还在画 ──
    // （演示脚本在打印后内置 6 秒停顿，保证这个窗口一定抓得到）
    await waitForText(win, ['运行 Python 片段'], 90000);
    await sleep(4200);
    await capture(win, 'shot2_真实执行出图.png');

    // ── 等全部跑完 → 完整对话帧 ──
    await waitForText(win, ['退出码：0', '分析完成'], 150000);
    await sleep(1500);
    await capture(win, 'shot1_分析与写文件.png');

    // ── 点击文件树预览真实生成的图 ──
    // ⚠️ 刷新是**异步**的（走 IPC 读目录），固定 sleep 猜时长会踩空。
    //    更关键的是：文件树**只列顶层**，figures/ 是目录，
    //    必须先点开它才能看到里面的 result_q1_1.png ——
    //    原来直接找文件行，rows.find 永远返回 undefined，
    //    预览没打开、shot3 与 shot1 成了同一画面（差 18 字节），
    //    而日志只打一句 "preview 点击 => false" 就继续了 —— 静默产出废图。
    //    现在：展开目录 → 轮询等文件行 → 拿不到就抛错。
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('btnRefreshFiles')?.click();
      return true;
    })()`);

    const previewOpened = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const hit = await win.webContents.executeJavaScript(`(() => {
          const rows = [...document.querySelectorAll('.tree-row')];
          // ① 先确保 figures/ 目录已展开（未展开则点它，下一轮再来）
          const dir = rows.find(r => r.querySelector('.nm')?.textContent.trim() === 'figures');
          if (dir && dir.querySelector('.ic')?.textContent.trim() === '▸') {
            dir.click();
            return false;
          }
          // ② 目录展开后再找目标文件
          const t = rows.find(r => r.textContent.includes('result_q1_1.png'));
          if (!t) return false;
          t.click();
          return true;
        })()`);
        if (hit) return true;
        await sleep(500);
      }
      return false;
    })();

    if (!previewOpened) {
      throw new Error(
        '截图失败：文件树里找不到 figures/result_q1_1.png，预览没打开 —— '
        + 'shot3 会与 shot1 重复。检查演示脚本是否真的产出了该文件，'
        + '或渲染层的 .tree-row / 目录展开逻辑是否变了。',
      );
    }
    console.log('preview 点击 =>', previewOpened);
    // 等图片解码完再截，否则抓到空白预览区
    await sleep(3000);
    await capture(win, 'shot3_文件树与图表预览.png');

    // ── 设置抽屉：先恢复真实配置再截，展示的是用户自己的服务商与模型 ──
    if (cfgBackup === null) fs.rmSync(cfgFile, { force: true });
    else fs.writeFileSync(cfgFile, cfgBackup, 'utf8');
    store.cache = null;
    win.webContents.reload();
    await sleep(3500);
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('btnSettings').click();
    })()`);
    await sleep(1500);
    await capture(win, 'shot4_设置自选模型.png');

    console.log(`mock 请求数 = ${received.length}`);
    console.log('演示工作区 =>', WS);

    // ── 最后一道保险：五张截图内容必须互不相同 ──
    // 直接源于本轮教训：预览没打开时 shot3 与 shot1 是同一画面（差 18 字节），
    // 差点把"声称展示图表预览、实际是重复图"的素材发到公开 README。
    // 光看 preview 布尔值不够 —— 真图不同才是硬证据。
    const shotFiles = [
      'shot0_空工作台.png', 'shot1_分析与写文件.png', 'shot2_真实执行出图.png',
      'shot3_文件树与图表预览.png', 'shot4_设置自选模型.png',
    ];
    const digests = new Map();
    for (const f of shotFiles) {
      const abs = path.join(OUT_DIR, f);
      if (!fs.existsSync(abs)) throw new Error(`截图缺失：${f}`);
      const h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      if (digests.has(h)) {
        throw new Error(`截图内容重复：${f} 与 ${digests.get(h)} 字节级相同 `
          + '—— 说明某一步界面没真正变化（如预览没打开），这张不能用作宣传素材');
      }
      digests.set(h, f);
    }
    console.log('✓ 五张截图内容互不相同（sha256 各不同）');

    failed = false; // 五张截图全部产出、预览确认真的打开了、且内容互不重复
  } finally {
    server.close();
    if (cfgBackup === null) fs.rmSync(cfgFile, { force: true });
    else fs.writeFileSync(cfgFile, cfgBackup, 'utf8');
    if (licBackup === null) fs.rmSync(licFile, { force: true });
    else fs.writeFileSync(licFile, licBackup, 'utf8');
    store.cache = null;
    // ⚠️ 退出码必须反映成败：index.js 的 unhandledRejection 兜底只打日志、
    //    不改退出码 —— 实测预览抛错那次进程照样 exit=0，
    //    调用方（npm 脚本 / CI / 人）完全无法从退出码发现问题。
    //    截图是"素材生产"，废图混进素材库的代价是发到公开 README 上。
    setTimeout(() => app.exit(failed ? 1 : 0), 500);
  }
}

module.exports = { runPromoShots };
