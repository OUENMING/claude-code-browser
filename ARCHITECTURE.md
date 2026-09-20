# 架构评审 · claude-code-browser

> 评审日期 2026-09-18 · 基线 `ee71e50`（clean tree，14 commits，最后活动 2026-09-14）
> 词汇约定：**模块 (module)** / **接口 (interface)** / **深度 (depth)** / **seam** / **adapter** / **leverage** / **locality**。本文严格只用这几个词描述结构，不用「组件 / 服务 / API / 边界」。
>
> **复核 2026-09-20（基线 `692d557`）** —— 本文写于 `ee71e50`，此后接口面动过，读 §4/§5/§7 前先套用这四条：
> 1. **工具是 16 个**（`resolve_actions` 在 `cff5110` 加入）：下文所有「15 个」按 16 读。`TOOLS` 现在 `mcp-server/index.js:310-327`；扩展 `TOOL_DEFINITIONS`（`background.js:25-41`）仍是 15 条、**少了 `resolve_actions`** ⇒ §5.1(a) 那句「两份 15 条完全一致」已不成立，漂移换了个方向。
> 2. **D4 已落地**（见下），并修正了它两处前提：CDP 其实有 `Runtime.evaluate {timeout}` 与 `Runtime.terminateExecution`（不必只靠扩展侧放弃等待）；progress 通知**不**延长 Claude Code 的硬墙钟。落地方案、实测证据与未决问题见 `PLAN-DEADLINE-20260920.md`。
> 3. §7.1 的两条失效机制已不成立：「CDP 调用无超时、无取消」现在是「有 deadline + CDP timeout，取消仍不可用」；「Stop 是单向开关」于 `692d557` 修（见 `CLAUDE.md` T3）。
> 4. 行号普遍下移：`processQueue` `:145`、`executeToolBounded` `:198`、`ensureContentScripts` `:352`、`handleJavaScript` `:1149`、`TOOL_HANDLERS` `:1402`。

---

## 1. 这是什么

一个让 Claude Code 直接驱动**用户真实、已登录的浏览器**的工具。它由两个模块组成：

- **Chrome/Edge 扩展**：长驻在浏览器里，持有 `chrome.debugger` 权限，是唯一能说 CDP 的一方。
- **MCP server**（Node）：Claude Code 通过 stdio 拉起的子进程，把 MCP 工具调用翻译成往扩展发的 WebSocket 帧。

它解决的是「agent 有登录态、有反爬对抗、有后台操作需求」这一类问题：不启动第二个无头浏览器、不复制 cookie、不碰验证码。因为走的是用户本机 Chrome/Edge 的真实会话，所以对小红书/知乎/内部后台这类**登录墙 + 反自动化**的站点有效。

**安装**（README.md:95-117）：

```bash
# 1) 注册 MCP server（stdio）
claude mcp add -s user browser -- node /path/to/claude-code-browser/mcp-server/index.js
# 2) 浏览器扩展：edge://extensions 或 chrome://extensions
#    → 开发者模式 → 加载解压缩的扩展 → 选 extension/ 目录
```

前置：Node ≥ 18、已认证的 Claude Code CLI。无构建步骤（README.md:206-209），改完文件重载扩展即可。

**使用**：Claude Code 里出现 `browser` 的 15 个工具（`navigate` / `read_page` / `computer` / `form_input` / …）。扩展 popup 显示连接状态、可改端口、可一键断开 CDP。

---

## 2. 技术栈与框架

三层，边界清晰（这一点做得好）：

| 层 | 位置 | 版本 / 入口 |
|---|---|---|
| 浏览器扩展 | `extension/` | Manifest V3；`manifest.json:7` 声明 `background.service_worker = background.js`（`type: module`） |
| 内容脚本 | `extension/content-scripts/` | 4 个，各自 IIFE + 全局单例（`manifest.json:9-14`） |
| MCP server | `mcp-server/index.js` | ESM，345 行；`@modelcontextprotocol/sdk` 锁定 **1.29.0**（`package-lock.json`），`ws ^8.16.0` |
| 传输 | 双向 WebSocket | `ws://127.0.0.1:19222`（`mcp-server/index.js:9`，`extension/background.js:3`） |
| 页面控制 | CDP v1.3 | `chrome.debugger.attach(..., '1.3')`（`background.js:157`）；用到的域：`Page` / `Runtime` / `Network` / `DOM` / `Emulation` / `Input` |

**关键权限**（`manifest.json:5-6`）：

```json
"permissions": ["debugger","tabs","tabGroups","activeTab","scripting","storage","alarms"],
"host_permissions": ["http://127.0.0.1/*","http://localhost/*","<all_urls>"]
```

**架构上的三条要点**：

1. **只有扩展碰 CDP**。MCP server 完全不懂 CDP（`index.js` 里没有一处 CDP 字样），这是整套设计里最干净的一条 seam。
2. **MCP server 是双模的**：抢到 19222 端口就是 server，抢不到就降级成 client 连到已存在的 server（`index.js:142-263`）。目的是多个 Claude Code 会话共享同一个扩展连接。
3. **无构建、无依赖注入、无测试**：`package.json` 无 `scripts`，仓库无任何测试文件、无 CI。

---

## 3. 数据流与代码逻辑

### 3.1 一次 `read_page` 的完整路径

```
Claude Code
  │  stdio JSON-RPC: tools/call {name:"read_page", arguments:{filter:"interactive"}}
  ▼
mcp-server/index.js:308  CallToolRequestSchema handler
  │  不是 health_check → index.js:329 callExtension("read_page", args)
  │  index.js:268-279  生成 id、挂 30s 定时器、pending.set(id)
  │  extWs.send({type:"tool_call", id, tool:"read_page", args})
  ▼  ws://127.0.0.1:19222
extension/background.js:63  ws.onmessage
  │  background.js:67  msg.type === 'tool_call' → enqueueToolCall(id, tool, args)
  │  background.js:113 压入 state.commandQueue，processQueue()
  │  background.js:118 FIFO：同一时刻只跑一个工具
  ▼
background.js:275  executeTool("read_page", args)
  │  无 tabId → getActiveTabId()（background.js:285）
  ▼
background.js:363  handleReadPage
  ├─ 364 ensureContentScripts(tabId)      → 探针 executeScript（background.js:255-272）
  ├─ 366 callContentScript(...)           → 240 又调一次 ensureContentScripts（重复）
  │                                                     → 242 executeScript 注入函数
  ▼  注入到页面 → accessibility-tree.js
content-scripts/accessibility-tree.js:87  generate('interactive', 15, 50000, …)
  │  walk() 递归 DOM + shadowRoot + 同源 iframe（:102-107）
  │  每个元素 getRefForElement() 分配 ref_N（WeakRef 双向映射，:3-17）
  │  逐行拼字符串，超 maxChars 截断并提示 ref_id
  ▼  返回 {tree, elementCount, truncated, readyState}
background.js:378-422  handleReadPage 后处理
  │  拼：dialog 警告 + 页面 readyState + ISO 时间戳 + Live Diagnostics（console/network 缓冲，:390-401）
  │  diff 分支：computeDiff(上一次快照, 本次 tree)（:335-361，按 ref 做集合差）
  ▼
background.js:142  sendResponse(id, result, null)
  │  ws.send({id, result})          ← result 已经是 MCP content block 形状
  ▼
mcp-server/index.js:100  handleUpstreamMessage → pending 命中 → resolve(msg.result)
  │  index.js:334  return result   ← 原样透传，一个字节都不改
  ▼
Claude Code 收到 {content:[{type:"text", text:"..."}]}
```

### 3.2 一次 `computer(left_click)` 的路径（多了两件事）

同上到 `background.js:525 handleComputer`，然后：

1. **验证前置采样**：`getBaselineSignature`（:465）连采两次 `signature()`，第二次晚 180ms，用于识别「页面自己在变」（计数器/视频/轮播）→ 标 `noisy`。
2. **真正的动作**：`dispatchComputer`（:540）→ `handleClick`（:592）→ `ensureAttached` → 有 `ref` 就先 executeScript 取坐标（:596-603），然后三次 `Input.dispatchMouseEvent`（move/press/release，各间隔 50ms）。
3. **验证后置**：`verifyAction`（:474）在 1200ms 内每 150ms 采一次 `signature()`，比较 `sig`/`url`/`title`，把结论文本追加到返回的 content[0] 里；若 DOM 变了且有旧快照，还能附一段 diff（:503-520）。
4. `verifyAction` 在 :517 **写回 `state.snapshots`** —— 这是一个隐藏副作用，见 §5.4。

### 3.3 反方向的帧

- 扩展 → server 唯一主动帧是 `{type:'extension_info', version, capabilities}`（`background.js:56-60`），server 只用它判定角色（`index.js:209`），`version` 和 `capabilities` **被读取后丢弃**。
- 保活：server 每 20s 发 `{type:'ping'}`（`index.js:57-63`）↔ 扩展回 `pong`（`background.js:66`）；扩展另有双轨自保活（25s `setInterval` + 0.5min `chrome.alarms`，`background.js:83-101`），因为 MV3 service worker 会被回收。
- 角色判定在 server 侧**靠第一帧**：`extension_info` → extension 角色，其它 → client 角色（`index.js:208-218`）。

---

## 4. 架构：模块 · 接口 · 深度

### 4.1 模块清单

| 模块 | 接口（调用者必须知道的一切） | 深度判定 |
|---|---|---|
| `mcp-server/index.js` — **MCP 面** | `TOOLS` 15 个 schema（:281-297）+ `tools/call` 语义 | **中**：`ListTools` 是纯数据，`CallTool` 是 30 行转发 |
| `mcp-server/index.js` — **路由/多路复用** | 抢占端口 → server 模式；EADDRINUSE → client 模式；`routeTable` 重写 id | **深**：约 200 行（:142-263）实现了「多会话共享一条扩展连接」，对外只暴露「能连上」 |
| `extension/background.js` — **CDP 会话** | `ensureAttached(tabId)` / `ensureContentScripts(tabId)` / `callContentScript(tabId, fn, args)` | **中深**：`callContentScript`（:239-253）把「注入失败就退回 CDP eval」藏在一个调用后面，这是最值钱的抽象之一 |
| `extension/background.js` — **命令队列** | `enqueueToolCall` / `processQueue`，单线程 FIFO | **浅**：23 行，接口几乎等于实现；但它承载了全局串行这一重量级不变式（见 §7） |
| `extension/background.js` — **工具 dispatch** | `TOOL_HANDLERS` 名字→函数表（:1176-1192） | **浅**：纯查表 |
| `content-scripts/accessibility-tree.js` | `generate(filter, maxDepth, maxChars, focusRef, keywords)` + `signature()` + ref 双向映射 | **深**：218 行藏在 2 个方法后；ref 稳定性、截断策略、shadow/iframe 穿透全在里面 |
| `content-scripts/page-bridge.js` | `getPageText` / `fillForm` / `searchElements` | **深**：`fillForm`（:21-71）把 React/Vue 受控组件需要的那一整套 focus→native setter→input→change→blur 链条收在一个方法里 |
| `content-scripts/auto-capture.js` | `generateMarkdown(maxChars)` | **深**：121 行转换器（列表/表格/DL/Details 递归）藏在 1 个方法后 |
| `content-scripts/visual-indicator.js` | 6 个 `SHOW_*`/`HIDE_*` runtime 消息 | **浅**：纯 UI，Shadow DOM 隔离做得对 |
| `extension/popup.js` | 4 条 runtime 消息（`POPUP_GET_STATUS`/`RECONNECT`/`DISCONNECT_TAB`/`STOP_TOOL_EXECUTION`） | **浅**，合理 |

### 4.2 15 个工具逐个判定（重点）

这里的「接口」= Claude Code 看到的 schema + 结果语义 + 未言明的约束。

| 工具 | 接口宽度 | 背后的实现 | 深度 |
|---|---|---|---|
| `navigate` | 2 参 | URL 归一化 + goBack/goForward + 10s 加载轮询（:292-320） | **深而薄**：删掉它复杂度会回到每个调用者身上（要用点击地址栏代替），但实现本身只是 `tabs.update` + 轮询 |
| `read_page` | 7 参 | 树生成 + ref 分配 + 截断 + 快照 + diff + 诊断拼装 | **深**（全套里最有 leverage 的一个）。但它藏了 3 条未声明不变式（§5.4） |
| `find` | 2 参 | TreeWalker + 多维打分排序（`page-bridge.js:98-118`） | **中**：删掉的话调用者是「read_page 后自己 grep」，会多花 token |
| `wait_for` | 3 参 | **页面内**轮询 Promise（`background.js:1062-1090`） | **中**：把轮询放进页面省掉 N 次跨进程往返，是真 leverage；但它唯一的实现是「一次注入跑到底」，无取消 |
| `dismiss_dialog` | 2 参 | CDP `Page.handleJavaScriptDialog` + CDP 事件维护的 `pendingDialogs`（:226-235） | **深**：把原生弹窗这个「页面上看不见的东西」变成可操作对象。删掉它，调用者得自己订阅 `Page.javascriptDialogOpening` |
| `computer` | **14 action × 15 参** | 每种 action 一段 CDP 序列 + 坐标换算 + 验证 | **宽而浅**：接口比实现面还大，参数适用性无声明（§6.5） |
| `form_input` | 2 参（单/批） | 原生 setter + 事件链 + file 走 CDP `DOM.setFileInputFiles`（:862-909） | **深**：受控组件兼容是隐藏的大实现 |
| `get_page_text` | 2 参 | 11 个候选容器启发式打分（`page-bridge.js:4-19`） | **中** |
| `get_page_markdown` | 2 参 | 20+ 标签转换器 | **深**：121 行实现 / 2 个参数 |
| `javascript_tool` | 1 参 | eval，两条路径 | **浅（危险地浅）**：几乎纯透传，且两条路径的执行上下文不同（§7.4） |
| `tabs_context` | 0 参 | `chrome.tabs.query` 格式化 | **浅**：纯格式化。server 还替它打补丁（`index.js:331-339`）—— 这是 seam 泄漏的证据 |
| `tabs_create` | 0 参 | `tabs.create` + 标题加 `[AI]` 前缀（:981-991） | **浅** |
| `read_console_messages` | 5 参 | CDP 事件缓冲 + onlyErrors/pattern/limit（:994-1013） | **中偏浅**：缓冲区「只含 attach 之后的事件」这条关键语义没写在接口里 |
| `read_network_requests` | 5 参 | 同上（:1015-1036） | **中偏浅**，同样问题 |
| `health_check` | 0 参 | 逐跳探测 + 主动规避不可脚本化页面（`isScriptable`，:1105-1111） | **深**：把「链路哪一跳断了」这个横跨 server/WS/注入/CDP 四层的问题压成一个零参接口，是全套里 depth-as-leverage 最高的 |

**小结**：15 个工具里 **5 个深**（`read_page` / `dismiss_dialog` / `form_input` / `get_page_markdown` / `health_check`），**4 个中**，**4 个浅**，**1 个宽而浅**（`computer`）。整体接口设计水平高于一般副业项目——问题不在单个工具，在两个**跨 seam** 的地方。

---

## 5. Seam 与职责边界（重点）

### 5.1 契约到底在哪

物理上只有 **一条** WebSocket，但**协议语义在两个地方各自定义了一遍**：

```
                 ┌──────────── 名义上的 seam（线上协议）────────────┐
Claude Code ◄──stdio──► mcp-server/index.js          ◄──ws──►   extension/background.js
                        │                                        │
                        ├ TOOLS             :281-297   ◄─ 重复 ─► ├ TOOL_DEFINITIONS :22-38
                        ├ CallTool handler  :308-342             ├ TOOL_HANDLERS    :1176-1192
                        ├ 信封解析          :100-121             ├ 信封解析          :63-70
                        └ 信封产出          :277                 └ 信封产出          :142-146
```

线上信封（这一层**是**单一、清晰、两侧一致的）：

| 方向 | 帧 |
|---|---|
| 扩展 → server | `{type:'extension_info', version, capabilities}`、`{type:'pong'}`、`{id, result?, error?}` |
| server → 扩展 | `{type:'tool_call', id, tool, args}`、`{type:'ping'}` |

**真正的问题不在信封，在信封里的 `tool` 和 `result`** —— 它们没有单一 owner：

**(a) `tool` 的接口被定义了两遍，而且已经漂移。** 逐字对比 `mcp-server/index.js:281-297` 与 `extension/background.js:22-38`：15 个名字和顺序完全一致，但 **15 条 description 里有 6 条已经不一样**：

| 工具 | 差异 |
|---|---|
| `find` | 扩展多一句「供 computer/form_input 使用」 |
| `wait_for` | 扩展多一句「navigate 后页面加载中自动等待 body 出现」 |
| `dismiss_dialog` | 扩展多一句「prompt 类型用 promptText 填入文本」 |
| `computer` | 「逐字符输入带 20ms 延迟」vs「…模拟人类」；「ref 精确定位」vs「ref 精确定位（来自 read_page）」 |
| `get_page_text` | 「最完整不丢内容」vs「最完整，不会漏内容」 |
| `get_page_markdown` | 「适合博客、文档、产品页」这句在两处位置不同 |

漂移方向值得注意：**扩展侧描述更准**（它才是实现方），但 Claude Code 看到的是 **server 侧**那一份 —— 也就是说，用户读到的工具说明已经是过期的那一版。

更彻底的是：**扩展侧那份 schema 根本没人用**。`TOOL_DEFINITIONS` 唯一的消费者是 `background.js:68` 的 `list_tools` 分支，而全仓库没有任何地方发过 `list_tools`（已 grep 确认）。整个 15 条 schema 在扩展里是**死数据**；dispatch 只用 `name`（`TOOL_HANDLERS`）。

**(b) `result` 的形状泄漏到了最底层。** 扩展的每个 handler 直接产出 MCP wire format：

```js
// background.js:311
return { content: [{ type: 'text', text: `Navigated to: ${tab.url}\nTitle: ${tab.title}` }] };
// background.js:376
return { content: [{ type: 'text', text: String(r.error) }], isError: true };
```

server 侧 `index.js:334` 是 `return result;` —— **一个字节都不改**。于是 MCP 协议成了内部 seam 的方言，而 adapter 的角色被拆散在 seam 两侧：没有一处代码负责「把内部结果翻译成 MCP」这件事。

证据就是 server 被迫反解 MCP 结构来做特例：

- `index.js:320` —— health_check 要 `r?.content?.find(c => c.type === 'text')?.text` 才能拿到扩展的文本；
- `index.js:331-333` —— 给 `tabs_context` 的结果 `unshift` 一个 text block；
- `index.js:337-339` —— 扩展断连时**伪造**一个 `tabs_context` 结果返回。

这三处都是同一个病灶：**server 不知道内部结果长什么样，只好按 MCP 的形状去猜。**

### 5.2 应该在哪切

理想切法（**一条 seam，一个 adapter**）：

```
Claude Code ◄──stdio+JSON-RPC──► [ MCP adapter 模块 ]  ◄──domain 结果──►  extension
                                    唯一懂 content block 的地方
```

- server 侧新增一个薄 **MCP adapter 模块**：`{ok, text?, image?, error?}` → `{content:[...], isError?}`。
- 扩展侧所有 handler 改成产出这个 domain 结果，**不再出现 `content` / `isError` 字样**。
- `index.js:320/331-339` 三个特例随之消失（它们变成 adapter 的正常职责）。
- `TOOL_DEFINITIONS` 与 `list_tools` 分支删除；`mcp-server/index.js:281-297` 成为工具接口的**唯一**定义处。
- 若将来要按 capability 裁剪工具（扩展已经在上报 `capabilities` 但被丢弃），让扩展只上报 `{name, capability}`，schema 仍留在 server。

### 5.3 CDP 假设往哪里漏

扩展整体把 CDP 包得不错，但有 6 处漏出来了，按严重度排：

| # | 泄漏点 | 说明 |
|---|---|---|
| 1 | `read_console_messages` / `read_network_requests` 的**缓冲语义** | 缓冲区由 CDP `Runtime.enable` / `Network.enable` 之后的事件填充（`background.js:167-169, 194-236`）。接口读起来像「读控制台历史」，实际是「读自我 attach 以来的事件」。首次调用这两个工具前必须先触发一次 attach，否则返回空。**这条不变式没写在 schema 里** |
| 2 | `computer` 的 `coordinate` 语义取决于**是否先截过图** | `takeScreenshot` 会把视口改成 1280 宽（`Emulation.setDeviceMetricsOverride`，:768-773），并把缩放系数记进 `state.screenshotContexts`（:794-798）；`handleClick` 在 :606-610 用这个系数把坐标换算回真实视口。所以同一组 `(x,y)`，截过图和没截过图含义不同。**这是 CDP 的 `Emulation` 域假设漏进了工具接口** |
| 3 | `dismiss_dialog` 的可用性依赖 attach | `pendingDialogs` 只由 CDP 事件填充（:226-235）。tab 未 attach 时，原生弹窗既不会被发现也 dismiss 不掉 |
| 4 | `takeScreenshot` 改变**真实页面布局** | `Emulation.setDeviceMetricsOverride` 会让页面按 1280 宽重排，因此所有已发出的 `ref_N` 坐标在截图瞬间失效。这是「读操作有副作用」的经典泄漏 |
| 5 | 文件上传的路径参数 | `form_input` 的文件分支（:829-834）最终落到 `DOM.setFileInputFiles`，参数是**MCP server 进程所在机器的绝对路径**（:904）。接口上它看起来像 `form_input(ref, value)`，实际语义是「CDP 让浏览器读本机某文件」，跨机器/容器即失效 |
| 6 | `navigate` 不做受限 URL 检查 | `BLOCKED_URLS` 只在 `ensureAttached`（:152-153）里检查；`handleNavigate`（:292-312）直接 `tabs.update`，绕过唯一的守卫 |

### 5.4 其它未被声明的接口不变式（都是 locality 问题）

1. **`read_page(diff=true)` 的基线会被 `computer` 悄悄推进。** `verifyAction` 在 :517 写回 `state.snapshots`。调用者以为自己只做了「点一下」，实际上一张新快照被安装了，下一次 `read_page(diff=true)` 会相对这个它没请求过的基线做 diff。
2. **快照跨导航不失效。** `state.snapshots` 只在 tab 关闭（:179）和 CDP detach（:189）时清；`navigate` 之后不清。于是 `navigate` → `read_page(diff=true)` 会把两个不同页面的树相互 diff，输出「全删 + 全增」的噪音。
3. **`tabId` 缺省 = 「当前活动标签页」。** 这个隐式默认（`background.js:279-281`）意味着用户切一下窗口，同一个工具调用就换个对象；多标签页场景下没有稳定性保证。

---

## 6. 摩擦与深化机会（按价值排序）

### D1 · 让工具契约只有一个 owner —— **Strong**

- **问题**：`TOOLS`（server）与 `TOOL_DEFINITIONS`（扩展）是同一接口的两份拷贝，已漂移 6/15；扩展侧那份还是死代码。见 §5.1(a)。
- **方案**：删 `TOOL_DEFINITIONS`（`background.js:22-38`）与 `list_tools` 分支（:68）；`mcp-server/index.js:281-297` 成为唯一定义。扩展只保留 `TOOL_HANDLERS` 的 `name → 函数` 映射。
- **leverage**：Claude Code 看到的说明永远等于实现方的说明。
- **locality**：改一处描述即生效；「schema 与 dispatch 不一致」这整类 bug 消失。
- **删掉测试（deletion test）**：删除 `TOOL_DEFINITIONS` 后，复杂度**不会**在任何调用者重现（唯一 consumer 是死分支）→ 通过，确认它是 pass-through。
- **测试性**：改完后，两侧的「名字集合一致」可以用一个 3 行断言覆盖（现在是靠人眼维持）。

### D2 · 给内部 seam 一个自己的结果接口 —— **Strong**

- **问题**：MCP wire format 出现在扩展最底层；server 只好按 MCP 形状反解（3 处特例）；没有单一 adapter。见 §5.1(b)。
- **方案**：内部结果定为 `{ok, text?, image?:{data,mimeType}, error?:{code,message}}`；扩展 handler 只产出它；**新增一个 MCP adapter 模块**（放 `mcp-server/` 内）做 `domain → content block` 的翻译。`index.js:320/331-339` 的特例并入 adapter。
- **leverage**：MCP 协议版本升级只动一个模块。
- **locality**：`content` / `isError` 这两个词从 1278 行的 `background.js` 里彻底消失。
- **删掉测试**：删除 adapter 后，翻译逻辑会在 15 个 handler + 3 个特例里重现 → 通过，它确实在赚饭吃。
- **测试性**：扩展 handler 变成纯数据函数，可以在不启动浏览器的情况下断言返回值——**这是目前唯一可行的测试切入点**。

### D3 · 把「一张标签页的会话状态」收进一个模块 —— **Strong**

- **问题**：per-tab 状态散落在 6 个容器里（`background.js:6-12`：`attachedTabs` / `enabledDomains` / `screenshotContexts` / `tabEventBuffers` / `pendingDialogs` / `snapshots`），清理逻辑被复制两遍且内容完全相同（`tabs.onRemoved` :173-180 与 `debugger.onDetach` :182-191），第三处（`DISCONNECT_TAB` :1207-1219）还**漏清了 `snapshots`**。再叠上 §5.4 的 1、2 两条：快照的生命周期谁也说不清。
- **方案**：一个 `TabSession` 模块，接口约 5 个方法：`attach(tabId)` / `detach(tabId)` / `resetForNavigation(tabId)` / `getSnapshot(tabId)` / `setSnapshot(tabId, tree)`。所有 per-tab 容器移进去，`clear()` 只写一次。
- **leverage**：`handleReadPage` / `verifyAction` / `handleHealth` 不再各自拼装状态。
- **locality**：**这一条直接修掉 §5.4 的两个 bug**：`resetForNavigation` 在 `handleNavigate` 里调一次，导航后基线自动失效；`verifyAction` 的写回变成显式的 `setSnapshot`，可以被审计。
- **删掉测试**：删除 `TabSession` 后「清理」这件事要在 3 处重现且会继续漏项 → 通过。

### D4 · deadline 是这条 seam 缺的字段 —— **Worth exploring**（直接对应「高负载超时」）· **已落地 2026-09-20**

> 落地版本与本文的差异：`deadline` 用绝对时间戳随信封发（`mcp-server/index.js:304`），扩展侧 `remainingMs()` 推导兜底（`background.js:198`），server 预算按工具声明（`TOOLS` 里的 `budgetFor`）；**未做**本文设想的通用 `deadline` 参数透传 —— 预算表就是那张表。实测证据：`PLAN-DEADLINE-20260920.md`。

- **问题**：`callExtension(tool, args, timeoutMs = 30000)`（`index.js:268`）的超时**只活在 seam 的这一侧**。扩展的 FIFO 队列（`background.js:113-140`）对调用者还剩多少预算一无所知，因此：
  - 队列里的等待时间对调用者不可见 → 一次 3 秒的操作可能因为前面排了 5 个调用而在第 30 秒被判超时；
  - **单队列全局串行**：`processQueue` 的 `while` 保证同一时刻只有一个工具在跑。慢工具会阻塞一切，包括 `read_page` 和 `navigate`；
  - 两侧都没有**取消**：CDP 调用没有一处带超时（全仓库 `chrome.debugger.sendCommand` 无 timeout 参数），server 那侧的 30s 拒绝只是「不再等」，扩展仍会把活干完并把结果丢给一个已失效的 id。
- **schema 与传输层已经互相矛盾**：`wait_for` 的 `timeout` 上限是 30000（`index.js:285`），而传输默认超时也是 30000 → `wait_for(timeout=30000)` **必然**先被判传输超时。
- **方案**：
  1. 请求信封加 `deadline`（绝对时间戳，随 `{type:'tool_call'}` 一起发）；
  2. 扩展侧在 4 处循环里检查剩余预算：`waitForLoad`（:314）、`handleWaitFor` 的页面内轮询（:1062）、`verifyAction`（:478）、`handleType` 的 run 循环（:671）；
  3. 超时错误带上 `stage: 'queued' | 'executing'`，这样「排队久」和「页面卡」可区分；
  4. server 的默认超时改成**按工具声明**（`read_page` 60s、`wait_for` = 参数 + 5s 余量、`tabs_context` 5s）。
- **leverage**：一次改动修掉一整类超时；`health_check` 已经报的 `commandQueue backlog`（`background.js:1118-1120`）从提示变成可执行的诊断。
- **测试性**：deadline 是纯数据，可以在不碰浏览器的情况下测「队列等待是否提前失败」。

### D5 · `computer` 是宽而浅的接口 —— **Worth exploring**

- **问题**：14 个 action、15 个参数塞在一个接口里，**参数与 action 的适用关系**这条不变式没有任何地方声明：`coordinate` 仅在无 `ref` 时生效（:604-613）；`region` 只对 `zoom` 有意义（:567-575）；`scroll_direction`/`scroll_amount` 只对 `scroll`；`quality` 只对 `screenshot`；`duration` 只对 `wait`；`start_coordinate` 只对 `left_click_drag`。调用者必须自己知道这张对照表。
- **旁证（代码逻辑问题）**：`dispatchComputer:543` 里的 `act === 'hover' ? 'left_click' : act` 是**死三元组** —— 该分支的 `includes` 列表里不可能出现 `hover`，它已经被 :545 提前接走。这正是「一个大 enum + 分支树」容易长出的东西。
- **方案**：拆成 `click` / `type_text` / `key` / `screenshot` / `scroll` / `drag` / `hover` 若干小接口，共享隐藏的 CDP transport 与 verify 实现；或者至少用 discriminated union 让非法参数组合在类型层面不可表达。
- **为什么排后面**：MCP 的 tool 粒度是**对 Claude Code 可见**的，拆成 7 个 tool 会让 `tools/list` 的 token 成本上升（这正好和本项目的省 token 取向相反）。**先做 D4；D5 需要和 token 预算一起权衡。**

### D6 · 验证的成本没有预算 —— **Speculative**

- **事实**：一次 `left_click` 的最坏路径 —— `getBaselineSignature` = 2 × `getSignature`；每次 `getSignature` 实际是 **3 次** executeScript（:451 的 `ensureContentScripts` + :240 里**又**一次 + :242 真正的执行）；`verifyAction` 最多 8 轮 × 3；再加 DOM 变化时的 diff 快照 3 → **最坏约 35 次跨进程注入**，全部串行，全部在一个 30s 预算里。
- **同样的问题**：`handleReadPage` 在 :364 调 `ensureContentScripts`，紧接着 :366 的 `callContentScript` 在 :240 又调一次 —— 每次调用都重复探测。
- **方案**：(1) `ensureContentScripts` 改成 per-tab 记忆化（现在每次调用都重探）；(2) `signature()` 改成一次注入返回两次采样，而不是两次注入；(3) 让 verify 的预算成为接口的一部分（`computer` 增一个 `verify_budget_ms`，默认 1200）。
- **备注**：这一条**不改变任何对外行为**，纯属把已经写好的东西做得更省；所以排最后。

---

## 7. 风险与债务

### 7.1 可靠性

**最主要的失效模式是「全局卡死」，而不是「某个工具不好用」。** 三条机制叠加：

| 机制 | 位置 | 后果 |
|---|---|---|
| 单队列全局串行 | `background.js:145-178` | 任一工具慢，全部工具慢（**排队时间现在计入调用者自己的预算**，见 D4） |
| ~~CDP 调用无超时、无取消~~ → **deadline + CDP timeout**（2026-09-20） | `background.js:145-205`、`deadline.js` | 页面主线程卡住 → 超时**在扩展侧**以 `DEADLINE_EXCEEDED` 返回，队列放行；**取消仍不可用**（页面里的活会继续跑，必须说清） |
| ~~Stop 是**单向开关**~~ → **两条路都复位**（`692d557` 修） | `background.js:145-178`、`:1364` | 用户点一次停止按钮不再永久杀死队列（见 `CLAUDE.md` T3） |

**关于「`javascript_tool` / `read_page` / `navigate` 在高负载下超时」—— 这是架构症状，不是这三个工具的 bug。** 具体地：

- `javascript_tool`：CDP `Runtime.evaluate` 无超时（:952），页面跑一个同步死循环就永久挂住；而 `executeScript` 那条快路径的失败是**静默吞掉**的（:950 `catch {}`），所以调用者不知道自己在走哪条路。
- `read_page`：树生成在**页面主线程**跑，且 `isVisible` 对每个元素调 `getComputedStyle`（`accessibility-tree.js:75-79`）—— 密集页面上这一步本身就慢；再加上 :364/:240 的重复探针。
- `navigate`：`waitForLoad` 轮询最长 10s（:314-320），慢站上会烧满预算，之后 `read_page` 仍读到 `readyState !== 'complete'`。

三者共同点是**都没有 deadline、都不能被取消**（D4）。所以正确的修法是 D4，不是给这三个工具单独加 timeout。

其它可靠性缺口：

- **Service worker 回收**：per-tab 状态在内存里，只有 `tabEventBuffers` 做了持久化（:1261-1275，每 15s 存 session storage），`snapshots` / `screenshotContexts` / `attachedTabs` 的**重启恢复是半成品** —— `init()`（:1230-1258）会读 `persistedTabs` 并重新 attach，但 `state.snapshots` 永远丢失。
- **`screenshot` 无 try/finally**：`takeScreenshot`（:752-800）设了 `Emulation.setDeviceMetricsOverride`（:768-773）之后，只在 :790-792 的**成功路径**清除。若 `Page.captureScreenshot` 抛异常，页面会**永久**停在 1280 宽的模拟视口里，直到下一次截图（`handleScreenshotElement` 在 :717 才会主动 clear）。这是一个用户可见的 bug。
- **合盖/休眠**：README.md:249-251 已记录（电池睡眠时 Chrome 暂停 CDP）。这是浏览器行为，无法在扩展侧修，但 `health_check` 应该把它识别为一种已知状态而不是笼统的 DISCONNECTED。

### 7.2 浏览器版本耦合（已知约束）

- **为什么必须走扩展**：Chrome 136 起，`--remote-debugging-port` 对默认 profile 被堵死；Chrome 同时禁止 `chrome.debugger` 之外的进程接管已登录会话。所以「扩展 + `chrome.debugger`」不是偏好，**是唯一可行路径**。这个约束本身是稳固的。
- **代价（耦合点）**：
  - 绑定 MV3 service worker 生命周期 → 需要双轨保活（`background.js:83-101`：25s `setInterval` + 0.5min `chrome.alarms`）。这套保活本身就是脆弱的（`chrome.storage.local.set` 只为「触摸」SW）。
  - 绑定 `chrome.debugger` 的**独占性**：DevTools（F12）一开，同一 tab 就 attach 失败，代码里专门为此产生了错误文案（:159-162「Another debugger is already attached」）。
  - 绑定 CDP 1.3 的 6 个域。其中 `Emulation` 域用的是「改视口」这种重手段（§5.3 第 4 条）。
  - 会出现「调试横幅」——`handleHealth` 在 :1165 明确说「不主动 attach 以避免 debugger banner」，说明这是已知的用户体验成本。
- **无版本协商**：扩展上报 `version: '1.0.0'` 和 `capabilities: ['cdp','content-scripts','tab-management']`（`background.js:56-60`），server **两者都读完即丢**（`index.js:209` 只取 `type`）。因此**扩展与 server 的版本漂移无法被检测**。配合 D1 的双份 schema，这就是为什么两侧已经漂了 6 条 description 而没人发现。

### 7.3 安全面

作用对象是**用户已登录的真实浏览器**，所以这一节的权重高于普通项目。

| 严重度 | 问题 | 位置 |
|---|---|---|
| **高** | **WebSocket 无任何鉴权。** server 端 `new WebSocketServer({port, host:'127.0.0.1'})` 没有 `verifyClient`、没有 origin 校验、没有共享 token（`index.js:143`）；扩展连接时也不带凭证（`background.js:50`）。**同机任意进程**只要连上 19222 并先发一帧 `{type:'extension_info'}`，就抢占 extension 角色（`index.js:208-218` 先到先得），从而收到后续**所有**工具调用（其中包含被 `javascript_tool` 执行的代码、被 `form_input` 填的表单值、页面截图）。反向亦可：冒充 client 直接驱动用户的浏览器 | `index.js:143,208-218` |
| **高** | **`javascript_tool` = 在已登录页面任意执行 JS**，且接口自己的描述就承认了风险（「⚠️ 不要用它提取密码/token/敏感数据」，`index.js:291`）—— 靠提示词约束，没有技术约束 | `background.js:937-959` |
| **中** | **执行上下文不确定**（§5.3 的同类问题）：`chrome.scripting.executeScript` 默认跑 **ISOLATED** world（:944-948），而兜底的 CDP `Runtime.evaluate` 默认跑 **main** world（:952-955）。同一个接口在两种语义间摇摆，且切换是**静默**的（:950 `catch {}`）。需要在 main world 访问 `window.React` / `jQuery` 的脚本，可能因为走了快路径而失败，也可能因为走了慢路径而成功 —— 不可复现。同一模式也出现在 `callContentScript` 的兜底（:245-251） | `background.js:944-955, 245-251` |
| **中** | **`<all_urls>` + 4 个内容脚本注入到每个页面**（`manifest.json:6,9-14`），**不管 MCP server 是否在运行**。每个 http/https 页面都会挂上 `__ccAccessibilityTree` / `__ccBridge` / `__ccAutoCapture` / `__ccVisualIndicator` 四个全局对象（IIFE 内，不污染页面作用域，但对本站脚本可见）→ 指纹面扩大，且这是 24/7 的常驻成本 | `manifest.json:6,9-14` |
| **低** | **PID 文件路径可预测且全局共享**：`/tmp/claude-browser-mcp.pid`（`index.js:11`）。多用户机器上可被抢占/伪造；`claimPidFile` 的「清理陈旧文件」逻辑（:26-35）在 `EPERM` 时会删除他人持有的文件 | `index.js:11-40` |
| **低** | `navigate` 不做 `BLOCKED_URLS` 检查（§5.3 第 6 条） | `background.js:292-312` |

**做对的地方**（应当保留）：`BLOCKED_URLS` 拦截（:21，虽然覆盖不全）；`read_page` 不回显 password 字段值（`accessibility-tree.js:142`）；`visual-indicator.js` 用 Shadow DOM + `all: initial` 隔离 UI（:12）；CDP 只经扩展、不对外暴露调试端口。

### 7.4 结构性债务

1. **无测试、无 CI、无构建**。仓库里没有任何测试文件，`package.json` 无 `scripts`。按「one adapter means a hypothetical seam」原则：**现在几乎每个 seam 都只有一个 adapter（唯一实现），因此它们大多是假设的 seam —— 不可替换、不可测**。这是本项目最大的结构债，也是 D1/D2 的价值来源：D2 做掉之后，扩展 handler 变成纯数据函数，才第一次有了便宜的测试面。
2. **`health_check` 是唯一的跨层观测手段**，而它本身依赖被观测的链路（`index.js:319` 通过 `callExtension` 去问扩展）。链路断时它只能给出 `UNREACHABLE` —— 这正是它被设计成的行为（:312-326 的注释解释了为什么它 never throws），可以接受，但意味着 `health_check` **不能**用来诊断「WS 层能不能通」。
3. **client 模式的语义模糊**：client 模式的进程把自己的工具调用交给另一个进程转发（`index.js:189-199`）。若 server 进程在调用中途退出，client 的 `handleClose` 会重连（:132-135），但**在途的 `pending` 已被 reject**（:126）。这个体验（一次工具调用莫名失败，然后一切正常）在架构上是可解释的，但没有暴露给调用者。

---

## 8. 一页速览

给要改这个仓库的 agent 读的表。

| 路径 | 是什么 | 接口 | 动它之前必须知道 |
|---|---|---|---|
| `mcp-server/index.js:281-297` | **工具接口的唯一权威定义**（D1 后） | `TOOLS[15]` | 这里的 description 就是 Claude Code 看到的那一份；扩展侧那份 `TOOL_DEFINITIONS` 是死数据，已漂移 6 条 |
| `mcp-server/index.js:268-279` | 唯一的请求出口 | `callExtension(tool, args, timeoutMs=30000)` | 超时只在这一侧；**没有 deadline、没有取消**（D4）。page/lifecycle 相关工具的超时要在调用处覆盖 |
| `mcp-server/index.js:100-121` / `165-243` | 信封解析 + 多会话路由 | 帧类型：`extension_info` / `ping` / `pong` / `tool_call` / `{id,result,error}` | 角色靠**第一帧**判定，先到先得；改帧格式必须两侧同时改 |
| `mcp-server/index.js:331-339, 320` | 3 处 MCP 形状反解特例 | — | 这些都是 D2 要消灭的；新增工具时**不要**再加特例 |
| `extension/background.js:22-38` | 死 schema 拷贝 | — | 不要在这里改工具描述；D1 后应删除 |
| `extension/background.js:1176-1192` | 工具 dispatch 表 | `name → handler(tabId, args)` | 新增工具要改**三处**：这里 + server 的 `TOOLS` + handler 实现 |
| `extension/background.js:63-70` | 线上帧入口 | — | `list_tools` 分支（:68）是死代码 |
| `extension/background.js:118-140` | FIFO 命令队列 | `enqueueToolCall` | **全局串行**：慢工具阻塞一切。`stopRequested` 是**单向**开关（:1221），点了「停止」后队列永久死亡直到重载扩展 |
| `extension/background.js:149-171` | CDP attach 的唯一入口 | `ensureAttached(tabId)` | 会开 `Page`/`Runtime`/`Network` 三个域（:167-169）—— 这是 console/network 缓冲能工作的前提；DevTools 打开时 attach 会失败 |
| `extension/background.js:239-272` | 注入 + CDP 兜底 | `callContentScript(tabId, fn, args)` / `ensureContentScripts(tabId)` | 兜底会**静默切换执行上下文**（ISOLATED → main world）；`ensureContentScripts` 无记忆化，每次调用都重探（D6） |
| `extension/content-scripts/accessibility-tree.js:87,169,214` | 元素树的单一实现 | `generate(...)` / `signature()` / `getElementByRef` | ref 靠 WeakRef 稳定；`generate` 在页面主线程跑，密集页面上会慢；`signature()` 是 verify 的全部依据 |
| `extension/background.js:445-538` | 动作后验证 | `handleComputer` | **`verifyAction` 会写回 `state.snapshots`（:517）** —— 一次点击会推进 `read_page(diff=true)` 的基线 |
| `extension/background.js:363-423` | `read_page` + diff | `handleReadPage` | 快照**不随导航失效**（只在 tab 关闭 / detach 时清）；`keywords`/`ref_id` 是部分视图，不参与 diff |
| `extension/background.js:752-800` | 截图 | `takeScreenshot` | 会改真实视口（`Emulation.setDeviceMetricsOverride`）且**无 try/finally**（:768-792）；异常会把页面留在模拟视口里 |
| `extension/manifest.json:5-14` | 权限与注入点 | — | `debugger` + `<all_urls>` + 4 个常驻内容脚本；改这个等于改安全面 |
| 全仓库 | 测试 | **无** | 无测试、无 CI、无构建；D2 完成后扩展 handler 才第一次可测 |

**改动前的最低检查清单**：改工具 → 三处同步 + 两侧 description 逐字一致；改帧格式 → 两侧同步 + `health_check`；改 per-tab 状态 → 三处清理点（`onRemoved:173` / `onDetach:182` / `DISCONNECT_TAB:1207`）；改超时相关 → 先读 D4。

---

## 附：Top 3 深化机会（若只做三件事）

1. **D2**（内部结果接口 + 单一 MCP adapter）—— 一次改动同时修好「MCP 泄漏到最底层」「server 三处反解特例」「扩展 handler 不可测」三件事，杠杆最高。
2. **D1**（工具契约单 owner）—— 最小改动（删两处），消除已经发生的漂移；与 D2 天然同批做。
3. **D4**（seam 上补 deadline + 取消）—— 直接消灭「高负载下超时」这一整类症状，并让 `stopRequested` 的单向 bug 变得无处可藏。

D3（`TabSession`）紧随其后：它成本中等，但能顺手修掉两个已确认的 bug（验证写回快照、快照跨导航失效）。
