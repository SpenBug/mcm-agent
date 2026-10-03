#!/usr/bin/env node
/**
 * 用 GitHub REST API 推送当前暂存区到远端。
 *
 * 为什么需要这个：本机 `github.com` 会被代理间歇性拦掉（HTTP 000），
 * `git push` 走的就是 github.com，被拦时完全没辙。
 * 但 `api.github.com` 通常还通，而 GCM 里存的令牌有 repo scope，
 * 于是可以手工重建提交绕过。
 *
 * 用法：
 *   git add -A
 *   node scripts/gh-push.mjs <owner>/<repo> [branch] [commit message]
 *
 * 注意：
 * - 提交 SHA 与本地必然不同（GitHub 会把时区归一为 UTC）
 * - 中文路径要用 `-z` 读，否则 core.quotepath 转义会造出假文件
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = process.argv[2];
const BRANCH = process.argv[3] || 'main';
const MESSAGE = process.argv[4] || 'chore: 更新';
if (!REPO) {
  console.error('用法: node scripts/gh-push.mjs <owner>/<repo> [branch] [message]');
  process.exit(1);
}

const ROOT = process.cwd();

/* ---------- token 从环境变量读 ----------
 * 沙箱环境里 Node spawn 任何子进程都会 EBUSY（连 git.exe 绝对路径也不行），
 * 所以脚本自身不调用 git，所需数据全部从外部传入：
 *   GH_TOKEN   —— 令牌
 *   stdin      —— NUL 分隔的待提交文件列表（git diff --cached --name-only -z 的输出）
 */
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('缺少 GH_TOKEN。用法：');
  console.error('  TOKEN=$(printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill | sed -n "s/^password=//p")');
  console.error('  git diff --cached --name-only -z | GH_TOKEN="$TOKEN" node scripts/gh-push.mjs <owner>/<repo> [branch] [message]');
  process.exit(1);
}

const API = 'https://api.github.com';

/**
 * Node 的 fetch(undici) 不读 http_proxy，直连常被断（other side closed），
 * 且代理本身是间歇性的。所以网络类错误重试，HTTP 语义错误（401/409）直接抛。
 */
async function gh(pathname, init = {}, retries = 4) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const res = await fetch(API + pathname, {
        ...init,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'mcm-agent-push',
          ...(init.headers || {}),
        },
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (!res.ok) {
        throw new Error(`${init.method || 'GET'} ${pathname} => ${res.status} ${json.message || text.slice(0, 200)}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e.cause?.message || e.cause?.code || '');
      const isNetwork = /fetch failed|socket|timeout|ECONNRESET|closed|UND_ERR/i.test(msg);
      if (!isNetwork || i === retries) throw e;
      const wait = 1500 * (i + 1);
      console.log(`  网络抖动（${msg.slice(0, 40)}），${wait}ms 后重试 ${i + 1}/${retries}…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/* ---------- 从 stdin 读暂存文件列表（NUL 分隔，避免中文路径被转义成假文件） ---------- */
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const files = Buffer.concat(chunks)
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter((p) => fs.existsSync(path.join(ROOT, p)) && fs.statSync(path.join(ROOT, p)).isFile());

if (!files.length) {
  console.log('暂存区没有文件，先 git add');
  process.exit(0);
}
console.log(`暂存文件: ${files.length} 个`);

const tree = [];
let totalBytes = 0;
for (const rel of files) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  totalBytes += buf.length;
  const isText = !/\.(png|jpg|jpeg|gif|ico|pdf|zip|exe|dll|woff2?|ttf|pyc)$/i.test(rel);
  tree.push({
    path: rel.replace(/\\/g, '/'),
    mode: '100644',
    type: 'blob',
    ...(isText ? { content: buf.toString('utf8') } : { content: buf.toString('base64'), encoding: 'base64' }),
  });
}
console.log(`总大小: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

/* ---------- 定位远端状态 ---------- */
const refGet = `/repos/${REPO}/git/ref/heads/${BRANCH}`;
let parentSha = null;
let baseTree;
try {
  const ref = await gh(refGet);
  parentSha = ref.object.sha;
  baseTree = (await gh(`/repos/${REPO}/git/commits/${parentSha}`)).tree.sha;
  console.log(`远端 ${BRANCH} = ${parentSha.slice(0, 8)}`);
} catch {
  console.log(`远端还没有 ${BRANCH}（空仓库）`);
}

// 空仓库直接用 trees API 会 409，必须先用 contents API 落一个文件建首个 commit
if (!parentSha) {
  const seed = Buffer.from('# init\n', 'utf8').toString('base64');
  await gh(`/repos/${REPO}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'chore: init repository', content: seed, branch: BRANCH }),
  });
  const ref = await gh(refGet);
  parentSha = ref.object.sha;
  baseTree = (await gh(`/repos/${REPO}/git/commits/${parentSha}`)).tree.sha;
  console.log(`✓ 已建首个 commit，base_tree = ${baseTree.slice(0, 8)}`);
}

/* ---------- 建树 → 建提交 → 更新 ref ---------- */
const treeRes = await gh(`/repos/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify(baseTree ? { base_tree: baseTree, tree } : { tree }),
});
console.log(`✓ 树 ${treeRes.sha.slice(0, 8)}`);

const commitRes = await gh(`/repos/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message: MESSAGE,
    tree: treeRes.sha,
    parents: parentSha ? [parentSha] : [],
    author: { name: 'SpenBug', email: '921828874@qq.com' },
    committer: { name: 'SpenBug', email: '921828874@qq.com' },
  }),
});
console.log(`✓ 提交 ${commitRes.sha.slice(0, 8)}`);

// ⚠️ PATCH 要用复数 /git/refs/，用单数 /git/ref/ 会 404
await gh(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commitRes.sha, force: false }),
});
console.log(`✓ refs/heads/${BRANCH} 已更新`);
console.log(`\n完成：https://github.com/${REPO}/tree/${BRANCH}`);
