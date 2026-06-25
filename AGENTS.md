# AGENTS.md — knowledge-clips 冷启动手册

给接手本项目的 AI agent。读完这一份就能开始干活。用户视角看 `README.md`，“agent 如何读用户的知识库”看 `AGENT_CONNECT.md`。

## 1. 这是什么

一个 Chrome 扩展（Manifest V3）：在网页上划词 → 写下「我的想法」→ 存成本地 Markdown 知识库，供 AI agent 二次创作。
**本地优先**：数据写进**用户自己选的本地文件夹**（File System Access API），无服务器、无账号、无端口、无云。
设计系统：**荧光手帐 / Highlighter Journal**（暖纸 `#FFFDF9` + 单一柿子橙强调色 `#E8623C`）。

## 2. 架构一图

```
划词保存：content.js(页面 shadow DOM 浮层) ──save-clip──> background.js(SW)
            └─> offscreen.js 持句柄写盘  ──失败──> 入队 chrome.storage.local(kcQueue)，侧边栏连接后回灌
侧边栏：   popup.js 持 DirectoryHandle ──直接 FSA──> 用户文件夹   (列表/编辑/删除/读)
存储格式： clip-format.js = 单一事实源（浏览器 + Node 共用）；fsstore.js 用它 + 句柄做 FSA 读写
```

- 扩展**不再有常驻服务（曾用过 HTTP helper、Native Messaging，均已废弃）**。`server/*` 现在只是给「能跑命令的 power-user / agent」的 CLI，和扩展走同一套磁盘格式。
- 句柄持久化在 IndexedDB（`handle-store.js`）。用户手动选过文件夹后，侧边栏打开时必须优先自动恢复同一个文件夹；浏览器若把权限退回 `prompt`，先自动 `requestPermission()`，仍需用户确认时才展示确认按钮。其间保存进 `kcQueue`，连接后回灌，**不丢数据**。

## 3. 文件地图

### extension/（真正的产品，FSA，纯前端）
| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3。permissions: storage/activeTab/scripting/tabs/sidePanel/**offscreen**；host_permissions 只有 http/https（content script 注入）；有固定 `key`（钉死扩展 ID）；side_panel=popup.html；SW=background.js（**classic，非 module**） |
| `popup.html/.js/.css` | 侧边栏。`popup.js` 持 `dirHandle`，直接用 `fsstore` 列表/编辑/删除；管理文件夹连接生命周期（query/requestPermission/选择/更换）；连接后回灌 `kcQueue`。`popup.css` = 荧光手帐设计系统（**整文件由外部设计稿覆盖,改动需对齐设计**）。 |
| `content.js` | 注入到网页。划词 + 保存浮层 `renderPopover()`（shadow DOM，自带 `<style>`，亮/暗自适应）。发 `save-clip` 给 background。 |
| `background.js` | SW。`save-clip` → 确保 offscreen → 写盘；失败入队 `kcQueue`。还管 content script 注入、快捷键(`Alt+Shift+S`)、sidePanel 行为。 |
| `offscreen.html/.js` | 无界面文档。侧边栏没开时，从 IndexedDB 取句柄写盘。 |
| `clip-format.js` | **UMD 单一事实源**：normalize/哈希(Web Crypto，故 `normalizeClip` 异步)/`clipMarkdown`/`articleHeader`/`cardIndexLine`/`buildCardIndex`。浏览器挂 `globalThis.KCFormat`，Node 可 `require`。 |
| `fsstore.js` | FSA IO 层：用 clip-format + DirectoryHandle 实现 `saveClip/loadClips/recentClips/updateClip/deleteClip`，每次写入后自动刷新 `index/cards.index.md`。 |
| `handle-store.js` | IndexedDB 存/取 DirectoryHandle。 |
| `fonts/*.woff2` | 本地 Bricolage Grotesque + Caveat（latin 子集，变量字重），`popup.css` 用 `@font-face` 引用。中文走系统 PingFang。 |
| `icons/icon.svg` + `icon-{16,32,48,128}.png` | 图标矢量源 + 导出位图。 |

### server/（Node CLI，legacy / power-user；扩展不依赖）
| 文件 | 用途 |
|---|---|
| `store.js` | Node fs 版存储。**`clipMarkdown`/`articleHeader` 必须与 `extension/clip-format.js` 逐字一致**（漂移守卫测试保证）。 |
| `search.js` | `npm run search -- "词"`（关键词检索）。 |
| `export-agent-context.js` | `npm run export:agent -- "词"` → `exports/agent-context.md`。 |
| `build-index.js` | `npm run index` → 生成 `index/cards.index.md`（给老库补索引；新卡由扩展自动维护）。 |
| `card.js` | `npm run card -- "<id>"` → 打印单卡（agent 渐进式披露取卡）。 |
| `helper.js` | `npm start`，旧 HTTP 助手，监听 127.0.0.1:47321。**legacy，扩展不再用**。 |

所有 CLI 用环境变量 `KNOWLEDGE_CLIPS_DIR="<文件夹绝对路径>"` 指向用户的库（默认 `~/KnowledgeClips`）。

## 4. 磁盘数据格式（扩展与 CLI 共用的契约）

用户文件夹内：
- `notes/<slug>-<key8>.md` —— 每篇文章一个文件，多次摘录追加；卡片含「原文片段 / 我的想法 / 上下文(用 `[……]` 标记选中句位置，**不重复**选中句)」，**无模板**。
- `index/clips.jsonl` —— 一行一条完整 JSON（权威机器索引）。
- `index/articles.json` —— articleKey → 相对文件路径 的映射。
- `index/cards.index.md` —— 一行一卡的轻量目录（给 agent 渐进式披露：`日期 · #标签 · 我的想法 · 「原文摘要」· id · 文件`）。
- `exports/agent-context.md` —— 检索导出的精简上下文。

## 5. 运行 / 验证

```bash
npm run check     # node --check 所有 server + extension JS（语法）
npm test          # 24 个测试：store.test + clip-format(纯函数+漂移守卫) + fsstore(内存版 FSA mock)
```
加载扩展：`chrome://extensions` → 开发者模式 → 加载已解压 → 选 `extension/` 目录。
首次使用：打开侧边栏 → 设置 → 「选择知识库文件夹」。
**改了 content.js 后**：重新加载扩展 **并刷新文章页**（Chrome 不会替换旧页面里的 content script）。
导出图标（改了 `icon.svg` 后）：用 headless Chromium 渲染（无 rsvg/inkscape 时）；16px 用简化版参数（更粗笔触、单行文字）。Playwright 的 Chromium 在 `~/Library/Caches/ms-playwright/chromium-*/.../Chromium`。

## 6. 铁律 / 约定（破坏会出事）

1. **`extension/clip-format.js` 与 `server/store.js` 的 `clipMarkdown`/`articleHeader` 必须逐字一致**——改一个就改另一个，`test/clip-format.test.js` 的 byte-for-byte 漂移守卫会拦截。理由：扩展(FSA)和 Node CLI 读写**同一个文件夹**，格式必须同构。
2. **磁盘格式是契约**。改卡片/索引格式前想清楚对已有库和 CLI 的影响（旧卡不会自动回改）。
3. **FSA 拿不到文件夹的系统绝对路径**（只有 `.name`）。Agent 提示里的路径靠用户在设置页填一次（存 `chrome.storage.local.libraryDirPath`）。别试图自动获取。
4. **FSA / 浮层无法 headless 端到端自动测**（需用户手势）。逻辑层用 `clip-format`/`fsstore`(mock) 单测覆盖；UI 必须在真实 Chrome 里看。
5. **设计：全局只有一个柿子橙强调色**。新 UI 沿用 `popup.css` 的 token，别引入第二个彩色。
6. `kc-key.pem`（钉死扩展 ID 的私钥）已在 `.gitignore`，**不要提交/泄露**。
7. 卡片 Markdown 每张以空行结尾——否则下一张的 `---` 会把上一段渲染成 setext 标题（曾踩过）。

## 7. 已知坑

- 浏览器重启后 FSA 权限可能回到 `prompt` → 侧边栏先自动恢复上次文件夹；只有浏览器仍要求确认时才让用户点一次确认。保存期间走 `kcQueue` 兜底。
- Caveat 字体只含 Latin；中文「手写」副标实际走 `cursive` 回退（Mac 上=楷体），看着也像手写，非 bug。
- Google Fonts 在国内常被墙，所以字体**打包本地**，勿改回 `@import`。
- 浮层在网页 shadow DOM 里，**不加载** `popup.css` 的本地字体（用系统栈）；这是预期。

## 8. 当前状态 & 可能的下一步

- ✅ 已完成：FSA 本地优先架构、卡片瘦身 + 一行流索引 + agent 渐进式披露协议、荧光手帐 UI、Agent 提示（路径可填一次自动补全）。`npm test` 24/24。
- 🔲 可选下一步：上架 Chrome Web Store（$5 开发者费，**不需要服务器**）；设置页「连接到 Agent」目前只有 1 个按钮（FSA 无绝对路径，旧「复制知识库路径」已删），如需第二个按钮要配真功能；把本机绝对路径做成一键复制。

## 9. 边界

只要不是用户明确要求，**别**：碰业务逻辑/存储/FSA 流程时不写测试、提交 git、引入云端依赖、破坏“本地优先 + 用户拥有数据”的产品内核。
