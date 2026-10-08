'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app } = require('electron');

/**
 * 技能资源根目录。
 *
 * ⚠️ **优先用 userData/skills，而不是随包目录。**
 * 便携版（portable target）每次启动都解压到一个**新的** %TEMP%\<随机名>\ 下，
 * 随包目录的路径每次都变。而会话历史是落盘的，下次启动时会带着上一轮的
 * 旧路径重放 —— Agent 照着旧路径跑命令必然 "No such file or directory"。
 *
 * 所以启动时先 syncSkills() 把随包技能复制到固定的 userData/skills，
 * 之后所有路径都是稳定的。
 */
function getSkillsRoot() {
  const stable = path.join(getUserDataDir(), 'skills');
  if (fs.existsSync(stable)) return stable;

  const bundled = bundledSkillsDir();
  if (fs.existsSync(bundled)) return bundled;
  return stable;
}

/** 随包技能目录（打包后 <resources>/skills，开发态 <project>/resources/skills） */
function bundledSkillsDir() {
  // ⚠️ 开发态必须先认仓库目录。
  // 未打包时 process.resourcesPath 指向 electron 自己的 dist/resources，那边根本没有 skills，
  // 于是老写法在开发态会一路落到 userData/skills 的旧副本上 ——
  // 改完 resources/skills 跑起来却看不见效果，还以为改动生效了。
  const dev = path.join(__dirname, '..', '..', 'resources', 'skills');
  if (!app.isPackaged && fs.existsSync(dev)) return dev;
  return process.resourcesPath ? path.join(process.resourcesPath, 'skills') : dev;
}

/**
 * 整棵技能目录的内容指纹：版本号 + 每个文件的（相对路径, 大小, mtime）。
 *
 * ⚠️ 不能用「技能目录本身的 mtime」当指纹 —— 改目录里某个文件的内容**不会**改动
 * 父目录的 mtime，结果就是同步永远不触发：开发时改了技能脚本（尤其体验版水印那两处），
 * 应用跑的却还是 userData 里的旧副本；发布时不 bump 版本号，老用户装的也还是旧技能库。
 * 167 个文件递归 stat 一遍是毫秒级，每次启动都算得起。
 */
function treeDigest(dir) {
  const h = crypto.createHash('sha1');
  h.update(`v${app.getVersion()}`);
  const walk = (rel) => {
    const entries = fs
      .readdirSync(path.join(dir, rel), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, r);
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const st = fs.statSync(abs);
        h.update(`${r}|${st.size}|${Math.round(st.mtimeMs)}\n`);
      }
    }
  };
  walk('');
  return h.digest('hex');
}

/**
 * 把随包技能同步到 userData/skills，让路径跨启动稳定。
 *
 * 指纹一致就跳过（正常启动几乎零开销）；不一致才重新复制。
 * 复制先落到 `<dst>.new` 再整体换上 —— 中途失败（磁盘满、被占用）不会留下半套技能库。
 * 同步失败不抛错：退回用随包目录，至少这次能跑。
 */
function syncSkills() {
  const src = bundledSkillsDir();
  const dst = path.join(getUserDataDir(), 'skills');
  if (!fs.existsSync(src)) return dst;

  let stamp = '';
  try {
    stamp = treeDigest(src);
    const stampFile = path.join(dst, '.stamp');
    if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp) return dst;

    const staging = `${dst}.new`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.cpSync(src, staging, { recursive: true });
    fs.writeFileSync(path.join(staging, '.stamp'), stamp, 'utf8');

    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(staging, dst);
  } catch (err) {
    // 同步失败不影响本次运行，退回用随包目录
    console.error('[skills] 同步到 userData 失败，本次使用随包目录:', err.message);
    try {
      fs.rmSync(`${dst}.new`, { recursive: true, force: true });
    } catch { /* 清不掉也不再加一层错误 */ }
  }
  return dst;
}

/** 用户配置目录 */
function getUserDataDir() {
  return app.getPath('userData');
}

/**
 * 品牌改名后的 userData 迁移（**必须在 app ready 之前调用一次**）。
 *
 * 背景：Electron 的 userData 路径默认由 productName 决定。
 * 「数模工坊」→「阿一古数模」之后，路径从
 *   %APPDATA%\数模工坊  →  %APPDATA%\阿一古数模
 * 如果不处理，老用户升级后会发现：
 *   - **卡密失效**（license.json 在旧目录）→ 要他重新激活，必被投诉
 *   - 设置全丢（config.json 在旧目录）
 *   - Python 环境要重装（python-env 在旧目录，几百 MB）
 *
 * 做法：新目录不存在、旧目录存在 → **直接把 userData 指回旧目录**（零拷贝）。
 * 不复制文件的原因：python-env 有几百 MB，复制既慢又可能中途失败留下半套环境；
 * 而且复制后两份环境会各自更新，反而更难维护。
 *
 * 新装用户（两个目录都没有）走新名，正常。
 */
function migrateLegacyUserData() {
  try {
    const current = app.getPath('userData');
    if (path.basename(current) !== '阿一古数模') return;   // 用户自定义过路径 → 不动

    const appData = app.getPath('appData');
    const legacy = path.join(appData, '数模工坊');
    if (fs.existsSync(current) || !fs.existsSync(legacy)) return;

    app.setPath('userData', legacy);
    console.log('[paths] 检测到旧版数据目录，继续沿用：' + legacy);
  } catch (err) {
    console.error('[paths] userData 迁移检查失败（不影响启动）:', err.message);
  }
}

function getConfigPath() {
  return path.join(getUserDataDir(), 'config.json');
}

/** 应用私有 Python 环境目录 */
function getPythonEnvDir() {
  return path.join(getUserDataDir(), 'python-env');
}

/**
 * 默认工作区：文档/阿一古数模工作区
 *
 * ⚠️ **兼容旧名**：品牌从「数模工坊」改名为「阿一古数模」后，
 * 老用户的成果还在 `数模工坊工作区` 里。如果新目录不存在、旧目录存在，
 * 就继续用旧目录 —— 否则用户升级后会以为"工作区空了、我跑的题和论文全丢了"
 * （其实没丢，只是程序换了个地方去找）。
 * 用户主动选过工作区的话走 config.workspace，不受这里影响。
 */
function getDefaultWorkspace() {
  const docs = app.getPath('documents');
  const fresh = path.join(docs, '阿一古数模工作区');
  const legacy = path.join(docs, '数模工坊工作区');
  if (!fs.existsSync(fresh) && fs.existsSync(legacy)) return legacy;
  return fresh;
}

function isDev() {
  return !app.isPackaged;
}

/**
 * 品牌素材目录（收款码等）。
 * 打包后 <resources>/brand，开发态 <project>/resources/brand —— 和技能库同一套路子。
 */
function getBrandDir() {
  // ⚠️ 和 bundledSkillsDir 同一个坑：未打包时 process.resourcesPath 指向
  // electron 自己的 dist/resources，那边根本没有 brand/ ——
  // 结果就是开发态二维码一直读不到，还以为是图坏了。
  const dev = path.join(__dirname, '..', '..', 'resources', 'brand');
  if (!app.isPackaged && fs.existsSync(dev)) return dev;
  return process.resourcesPath ? path.join(process.resourcesPath, 'brand') : dev;
}

module.exports = {
  getSkillsRoot,
  syncSkills,
  getUserDataDir,
  getConfigPath,
  getPythonEnvDir,
  getDefaultWorkspace,
  getBrandDir,
  isDev,
  migrateLegacyUserData,
};
