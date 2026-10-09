# 阿一古数模 · 开发与发版 SOP

> **这是一份活文档。** 每次踩到新坑、加了新脚本、改了流程，就回来更新对应小节。
> 文中的命令与数字都来自实际运行（不是凭记忆写的），改动后请重新核对。
>
> - 项目：`mcm-agent`（Electron 桌面应用，Windows 10+ x64）
> - 文档基准：v1.1.1 / 29 次提交 / 322 个跟踪文件 / 23 套离线测试
> - 最后更新：2026-10-09

---

## 零、三条不可动摇的纪律

这三条是本轮反复返工换来的，写在最前面。

### 1. 不许凭记忆断言事实

本轮的返工几乎都源于此：我写过"28 个预览桩"（实际 30）、"5 项断言"（实际 4）、
"README 版本已同步"（实际没同步）。**每个数字、每个路径、每个命令，都要跑一遍再写。**

反例与代价：

| 凭记忆写的 | 实测 | 代价 |
|---|---|---|
| 图标已更新 | `build/icon.png` 还是旧的 ∑ | 差点带着旧图标发版 |
| 赛事定价已统一 | keygen.html 里亚太赛还是 ¥49 | 按旧价收钱 |
| 文档路径已修 | 还有 30 处相对路径 | 模型照抄必失败 |

### 2. 一个事实只能有一处真源

本项目因"手抄多份"踩过 **5 次**，每次都是改了 A 忘了 B：

| 事实 | 曾经抄了几份 | 现在唯一真源 |
|---|---|---|
| 赛事时间/定价 | 3 份（issue.js / issuer.js / keygen.html） | `src/main/competitions.js` |
| 品牌标记形状 | 3 份（icon.js / index.html / horse-path.json） | `src/main/brand-mark.js` |
| 标题截断规则 | 2 份（渲染层 / 主进程） | `src/main/agent/session-title.js` |
| 包内资源清单 | 手写文件名列表 | 从 `index.html` 反查 |
| 版本号 | README 手改 | `package.json` + 一致性校验 |

配套手段：**能生成的就别手写**，生成不了的就加 `--check` 守卫（见第四节）。

### 3. 开发态绿 ≠ 包里能跑

打包产物是 GUI 子系统程序，Windows 下看不到 stdout；且打包会过滤文件、
走 asar、受 CSP 约束。**发版前必须跑 `npm run smoke:packaged`。**

本轮实证：开发态冒烟 74 项全绿，但打包产物里曾缺 `drafts.js` / `refs.js`
（新增脚本没进包 → `window.createDrafts` 未定义 → 功能静默消失）。

---

## 一、环境特有的坑（换机器可能失效，但同类环境仍会踩）

> ⚠️ 这一节的坑**只在特定环境下出现**。换台机器可能不复现，
> 但如果你看到相同的错误信息，直接对号入座。

### 1.1 `ELECTRON_RUN_AS_NODE=1` 被注入

**症状**：打包出的 exe 启动后立刻退出、**退出码 9**、什么都不写。
看起来像"打包的 exe 坏了"。

**根因**：某些环境（CI / 沙箱 / agent 集成终端）会注入 `ELECTRON_RUN_AS_NODE=1`，
此时 electron.exe **退化成纯 Node**，不加载 app.asar，
`--smoke` 被当成非法 node 参数。

**验证**：`echo $env:ELECTRON_RUN_AS_NODE`，值为 `1` 就是它。

**处理**：已在 `scripts/dev.js`、`scripts/smoke-packaged.js`、`scripts/run-electron.js`
里统一清掉。自己写新脚本调 electron 时要照做。

### 1.2 `node` 被 Electron 包装

**症状**：`electron-builder` 报 `Invalid package ... default_app.asar`；
或 CLI 报 `Unknown argument`。错误信息完全指不到根因。

**根因**：PATH 里的 `node` 实际是 Electron 可执行文件。Electron 给 `fs` 打了补丁，
凡路径以 `.asar` 结尾都按归档处理。

**验证**：
```powershell
node -p "process.versions.electron ? 'Electron包装' : '真Node'"
```

**处理**：`scripts/build.js` 的 `ensureRealNode()` 会自动检测并用真 Node 重启自己。
手动兜底：`& "C:\Program Files\nodejs\node.exe" scripts/build.js`

> ⚠️ 探测候选时可执行文件**必须带** `ELECTRON_RUN_AS_NODE=1`，
> 否则 `-p` 会被当成普通启动参数**直接弹出 GUI 窗口**。

### 1.3 打包撞 `EBUSY: resource busy or locked`

**症状**：拷贝 `resources/brand/*.png` 时 EBUSY。

**根因**：杀毒实时扫描 / 资源管理器预览 / agent 文件索引**临时**抓住句柄几秒。

**关键教训**：**"打包前等它解锁"没用** —— 实测预检查全过，几分钟后拷贝照样 EBUSY。
瞬时锁只能靠**整轮重试**。

**处理**：`build.js` 的 `buildWithRetry()` 只对锁定类错误
（EBUSY/EPERM/EACCES/ENOTEMPTY）重试整轮，最多 3 次、间隔 8s。
本轮实测救回 **4 次**。

### 1.4 无 GPU 环境截图失败

**症状**：`webContents.capturePage()` 报 `ERR_FAILED` / `UnknownVizError`。

**后果（曾真实发生）**：图标生成脚本**静默失败**，
`build/icon.png` 停在旧图上，打包照常发出 → exe 图标与品牌不符。

**处理**：`webPreferences.offscreen: true` 走软件合成器可正常截图
（见 `scripts/make-icon-lib.js`）。

**另一个坑**：每渲染一张就 `destroy` 窗口 → 关掉最后一个窗口会触发
Electron 默认"所有窗口关闭即退出"，**第二张起全部 ERR_FAILED**。
必须 `app.on('window-all-closed', e => e.preventDefault())`。

**还有**：窗口有最小尺寸（要 16px 实际给 33×39）→ 小尺寸一律大图降采样。

### 1.5 PowerShell 会破坏中文与正则

**症状 A（编码损坏）**：`Get-Content` / `Set-Content` 按系统 ANSI 码页解读 UTF-8，
中文双重编码损坏。**曾损坏 7 个技能文档**（靠 git 恢复）。

**症状 B（正则失效）**：内联 `-Pattern` / `-replace` 里的 `$`、`\b`、引号会被
shell 先解析一轮，导致**假阴性**。本轮踩了 **6 次**，
其中一次让我误判"图标选项没渲染"，白查半天。

**规矩**：
- 批量改文件 → 写 Node 脚本（`fs.readFileSync(p,'utf8')`）
- 搜索 → 用 grep 工具或写成 `.js`/`.ps1` 文件，**不写内联正则**
- `.ps1` 文件保持纯 ASCII（PS 5.1 按 ANSI 解码无 BOM 文件，中文注释会让解析器报错）

### 1.6 `github.com` 被代理间歇性拦截

**症状**：`git push` 报 `Connection was reset`；
`curl https://github.com` 返回 `000`。

**关键**：同一时刻 `api.github.com` **可能是通的**。

**判断方法**（别只看一个域名）：
```powershell
foreach($h in 'github.com','api.github.com','codeload.github.com'){
  "$h  $(curl.exe -s -o NUL -w '%{http_code}' --max-time 10 https://$h)"
}
```

| 结果 | 含义 | 处理 |
|---|---|---|
| 全挂 | 代理整体故障 | 只能等 |
| 只有 github.com 挂 | 只拦主域 | 走 REST API 推送 / 用 api 通道验证 |

**本项目实际遇到的是间歇性的**：等 1–5 分钟重试即可，**不要改任何 git 配置**。

> ⚠️ 判断"链接是否可用"时，若 github.com 不通，可改用 api.github.com 验证：
> 匿名读 Release 返回 200 = 外部可见；附件返回 206 + `MZ` 头 = 内容完好。
> 这样不会因为本地网络问题误报"发布失败"。

---

## 二、日常开发

```powershell
npm install
npm start              # 启动（无 GPU 环境用 npm run start:nogpu）
```

**改完代码后的自检顺序**（从快到慢）：

```powershell
npm test                    # 23 套离线测试，秒级，不需要图形界面
npm run smoke               # 开发态端到端（UI + IPC + 真实导出），约 3 分钟
npm run selftest:runtimes   # 技能脚本两条执行路径（需真实 Electron）
```

---

## 三、发版流程（照抄即可）

### 步骤 1 · 改版本号

```powershell
# 手动改 package.json 的 version（语义化：修 bug 用 patch）
```

### 步骤 2 · 同步文档并自检

```powershell
npm run clean:dist -- --apply   # 清掉可再生的中间产物（省 ~390MB）
node scripts/check-version-consistency.js
```

若报版本不一致：
```powershell
node scripts/check-version-consistency.js --fix
```

### 步骤 3 · 全量测试

```powershell
npm test
```

### 步骤 4 · 打包

```powershell
npm run dist
```
产物在 `dist/`：`阿一古数模 Setup <版本>.exe` + `阿一古数模-便携版-<版本>.exe`

> 打包失败先看 `dist/build-error.log`（脚本会把错误原文落盘，
> 因为终端管道很容易把堆栈吞掉）。

### 步骤 5 · 包内验收（**必做**）

```powershell
npm run verify:package   # 该进的进了、私钥/签发器没进、内容是当前代码
npm run verify:icon      # 从 exe 反查内嵌图标是不是当前品牌图标
npm run smoke:packaged   # ★ 对打包出的 exe 跑冒烟（约 5 分钟）
```

`smoke:packaged` 会核对报告里的 `packaged=true` 与 `execPath`，
**确认跑的是包里的 exe**，而不是不小心用源码跑的。

### 步骤 6 · 发布 Release

```powershell
# 1) 建草稿 Release（draft=true，此时对外不可见，可随时丢弃）
# 2) 上传附件 —— ⚠️ 附件名必须用英文
# 3) 验证：state=uploaded、sha256 与本地逐字节一致、匿名 API 返回 200
# 4) 置 draft=false 公开
```

**⚠️ 附件名不要用中文。** GitHub 会吃掉中文名（实测存成 `-.-1.0.0.exe`），
事后 `PATCH` 改名返回 200 但纹丝不动。中文说明写进 Release body。

**上传用 curl**（比 Node fetch 稳，会走系统代理）：
```powershell
curl.exe -X POST -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/octet-stream" `
  --data-binary "@dist/阿一古数模 Setup 1.1.1.exe" `
  "https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=ayigu-mcm-agent-setup-1.1.1.exe"
```

### 步骤 7 · 验证下载链接

```powershell
# 直链应返回 206（支持断点续传）
curl.exe -s -o NUL -w "%{http_code}" -L -r 0-2047 `
  "https://github.com/<owner>/<repo>/releases/download/v<版本>/<附件名>"
```

### 步骤 8 · 提交

```powershell
git add -A
git commit -F <消息文件>    # 消息含反引号时不能用 -m（shell 会解析）
git push origin main
```

推送后**独立核实**远端 SHA（不要只信 push 的输出，管道会吃掉退出码）：
```powershell
node -e "(async()=>{const r=await fetch('https://api.github.com/repos/<owner>/<repo>/git/ref/heads/main',{headers:{'User-Agent':'v'}});console.log((await r.json()).object.sha)})()"
git rev-parse HEAD   # 两者必须一致
```

---

## 四、守卫清单（`npm test` 会自动跑）

这些 `--check` 脚本的作用是：**让"忘了同步"变成测试失败**，而不是靠人记。

| 守卫 | 防的是什么 |
|---|---|
| `sync-brand-mark.js --check` | 改了马头形状但界面没同步 |
| `scrub-legacy-mark.js --check` | 旧品牌符号 `∑` 复活（曾在头像/激活页残留 30 个文件） |
| `fix-skill-relpaths.js --check` | 技能文档写相对路径（模型照抄必 `No such file`） |
| `scrub-preview-userpath.js --check` | 预览桩里残留开发机用户名（做宣传图会暴露身份） |
| `check-version-consistency.js` | README 下载链接版本与 package.json 不一致 |
| `sync-keygen-options.js --check` | 签发器赛事选项与定价漂移（曾漏 3 个赛事、亚太赛还是旧价） |
| `icon-check.js` | 图标形状退化 / 产物过期（用**内容指纹**，不用 mtime） |

**孤儿守卫**：`run-all-tests.js` 会检查 `scripts/*-test.js` 是否都挂进了套件列表，
漏挂直接失败。上线当天就抓到一个从未被执行过的 `path-resolve-test.js`。

**新增守卫时请照此模式**：`--check` 模式 + 反向验证（故意注入违规，确认会红）。

---

## 五、本轮修复的缺陷（供回顾，避免重犯）

### 会漏钱/影响生意的

| 缺陷 | 后果 |
|---|---|
| 签发器不透传 `competition` | 卖 ¥39 单赛卡签成 ¥168 全能包权限，台账上看不出 |
| keygen.html 缺 3 个新赛事、亚太赛旧价 | 买家买大数据赛卡时你**选不出来** |
| keygen 用自己计数器排号 | 卡号重复 → 邀请码撞车 → 推荐奖励记给错人 |
| 签发器台账按下标取列 | GUI"已签发"表格全空行，看不见发过哪些卡 |
| 旧品牌包曾是最新 Release | 用户下载到的包不含任何新功能 |

### 会让功能静默失效的

| 缺陷 | 后果 |
|---|---|
| 技能文档 30 处相对路径 + `python3` 占位器 | 出图功能实际不可用，模型照抄必失败 |
| `run_python` 不认 `%MCM_SKILL_ROOT%` | 同一份文档只有一条执行路径能用 |
| `build/icon.png` 停在旧图 | exe 图标与品牌不符（静默发版） |
| 新增脚本没进包 | 功能静默消失（`window.createDrafts` 未定义） |
| 冒烟判定器正则含 `\b` | 所有 `=> ✗` 格式的失败**全部漏判**（端到端断言正是这格式） |

### 工程纪律类的

| 缺陷 | 后果 |
|---|---|
| `cleanStale` 归档可再生物 | dist 白占 393MB（涨到 1.2GB） |
| README 写死 SHA256 | 重建包后当场失效 |
| 打包失败错误被管道吞掉 | 根因无从追查 |

---

## 六、已知限制（不是 bug，是设计取舍）

| 项 | 说明 |
|---|---|
| exe 未做代码签名 | SmartScreen 会提示"未知发布者"，用户点"更多信息 → 仍要运行"。买 OV 证书（¥1000–3000/年）也要攒下载量才消警告 |
| 未接自动更新 | 用户需手动下载新包；`latest.yml` 是 electron-builder 默认产物，当前无人读 |
| 卡密无吊销机制 | 离线验签架构的固有约束。私钥泄漏 = 任何人都能签永久授权，且无法召回 |
| 邀请码奖励靠人工 | 纯离线应用本地计数删文件就重置，所以只展示码、由卖家记账发放 |
| 试用锚点可被清 | 已绑机器码存 `machine.json`，但两文件同删仍算新机器（离线架构限制） |

---

## 七、待办 / 下一步

- [ ] **私钥离线备份**（`keys/license-private.pem` 只在这一台机器，丢了生意就断了）
- [ ] 代码签名证书（等有用户因警告放弃购买，或出现杀软误报投诉）
- [ ] 支付合规（个人收款码不得用于经营性收款 —— 见卖家手册第十节）
- [ ] 若接自动更新：注意 `latest.yml` 里的文件名是 `mcm-agent-setup-*.exe`，
      与实际产物 `阿一古数模 Setup *.exe` 不一致，接之前要先解决

---

## 附：文件速查

| 想改什么 | 改哪里 |
|---|---|
| 赛事时间 / 定价 | `src/main/competitions.js` |
| AI 声明措辞 | `src/main/agent/ai-declare.js` |
| 品牌标记形状 | `src/main/brand-mark.js`（改完跑 `npm run brand && npm run icon`） |
| 系统提示词 / 技能路由 | `src/main/agent/prompt.js` |
| 会话标题规则 | `src/main/agent/session-title.js` |
| 界面风格 | `src/renderer/styles.css` 的 `:root` 设计令牌 |
| 加新工具 | `src/main/agent/tools.js` 的 `TOOL_DEFS` + `executeTool` |
| 加服务商预设 | `src/main/store.js` 的 `PROVIDERS` |
| 内置技能 | 覆盖 `resources/skills/`，重新打包 |
| 邀请码规则 | `src/main/competitions.js` 的 `inviteCodeFromCard` + `tools/issue.js` |
