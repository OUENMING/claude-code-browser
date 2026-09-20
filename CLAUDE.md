# CLAUDE.md · claude-code-browser

Chrome/Edge 扩展 + MCP server，让 Claude Code 驱动**用户真实、已登录的浏览器**（导航/点击/输入/填表/截图/提取）。16 个 MCP 工具，无构建、无 CI（两份零依赖回归测试：解析器 `test/action-resolver.test.cjs`、deadline `test/deadline.test.cjs`），改完文件重载扩展即生效。架构评测（模块深度、seam 泄漏、深化机会）见 `ARCHITECTURE.md`——本文件只给指针与雷区，不重复它。

## 三层与唯一物理 seam

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `extension/` | **独占 CDP**（`chrome.debugger`），唯一能说 CDP 的一方 | Manifest V3；`background.service_worker = background.js`（`type: module`） |
| `extension/content-scripts/`（4 个） | 页面内实现：元素树 / 表单 / Markdown / UI | 各自 IIFE，挂 `globalThis.__cc*` 单例 |
| `mcp-server/index.js` | 把 MCP 工具调用翻译成 WS 帧 | **完全不懂 CDP**——全文件无 CDP 字样，这是最干净的一条 seam |

**唯一物理 seam = `ws://127.0.0.1:19222`**（`mcp-server/index.js:9` ↔ `extension/background.js:3`）。**双模**：抢到端口 = server；`EADDRINUSE` = 降级 client 连已有 server，为的是多 Claude 会话共享同一条扩展连接（`mcp-server/index.js:142-263`）。线上信封本身单一清晰；信封里的 `tool` 与 `result` **不是**——见雷区 T1。

## 文件地图

| 触发条件（分支） | 读哪个文件 | 里面是什么 |
|---|---|---|
| 新增/修改工具契约 | `mcp-server/index.js:294-311` | `TOOLS`——**Claude Code 实际看到的那一份**，工具的单一权威定义 |
| 同上（第二份拷贝，已漂移） | `extension/background.js:25-41` | `TOOL_DEFINITIONS`——同一接口的拷贝，**死数据**，唯一消费者是死分支 `list_tools` |
| 改每次调用的预算 / deadline | `mcp-server/budget.js` ↔ `extension/background.js:117-205` | server 侧预算表 + 边界归一化（有单测 `test/budget.test.cjs`）；扩展侧 `remainingMs()` / `deadlineError()` / `executeToolBounded` 兜底。**两侧是一对，改一边必须改另一边**（见 T4） |
| 新增工具要挂实现 | `extension/background.js:1441-1458` | `TOOL_HANDLERS`：`name → handler(tabId, args)` |
| 改 WS 帧 / 传输 / 多会话路由 / 角色判定 | `mcp-server/index.js:100-312` | 信封解析、`callExtension`（唯一请求出口）、双模与 `routeTable` |
| 改后台状态 / 命令队列 / attach 生命周期 / 保活 | `extension/background.js` | `state`、FIFO 队列 `processQueue`、`ensureAttached`、双轨保活 |
| 改 CDP 命令 / 某个工具的实现 | `extension/background.js:404-1400` | `executeTool` 入口 + 每个 `handleXxx`；用到的 CDP 域：`Page`/`Runtime`/`Network`/`DOM`/`Emulation`/`Input` |
| 改页面内提取 / 表单填写 / 元素树 | `extension/content-scripts/` | 元素树 `accessibility-tree.js`（`generate`/`signature`/ref 映射，另导出 `getRole`/`getAccessibleName`/`isVisible`/`isInteractive` 供 resolver 复用）、`page-bridge.js`、`action-resolver.js`、`auto-capture.js`、`visual-indicator.js` |
| 跑解析器回归测试 | `test/action-resolver.test.cjs` | 零依赖（手搓 DOM 桩，无 jsdom/jest），14 条断言覆盖 `resolve_actions` 的 resolved/ambiguous/missing 三态与各 pick 模式。`node test/action-resolver.test.cjs`，退出码 0 = 全过 |
| 跑 deadline 回归测试 | `test/deadline.test.cjs` | 零依赖，36 条断言覆盖 `extension/deadline.js` 的四条不变式（用户代码只被包一次 / 超时走 resolve / 三态可区分 / 探测失败时保守）。`node test/deadline.test.cjs`，退出码 0 = 全过 |
| 跑预算表边界测试 | `test/budget.test.cjs` | 零依赖，19 条断言锁 `mcp-server/budget.js` 的两处「只有客户端不守 schema 才踩到」的边界（非数值 timeout、`'constructor'` 走原型链），外加两条跨工具不变式。`node test/budget.test.cjs`，退出码 0 = 全过 |
| 改权限 / 注入点 / 安全面 | `extension/manifest.json` | `permissions`（含 `debugger`）+ `host_permissions`（含 `<all_urls>`）+ 4 个内容脚本注入 |
| 改 popup 行为 | `extension/popup.js` | 状态查询 / 重连 / 断开 CDP / 停止执行 |
| 想知道某处为什么这样设计 | `ARCHITECTURE.md` | 架构评审：模块深度、seam 泄漏、深化机会 D1–D6 |
| 安装 / 使用 / 已知限制 | `README.md` | 安装步骤、16 工具说明、合盖休眠限制 |

## 本仓库特有雷区

改动前逐条对照；这些都是「读完代码才发现」的不变式。

**T1 · 工具契约定义了两遍，且已漂移。** `TOOLS`（server，16 条）与 `TOOL_DEFINITIONS`（扩展，15 条）逐字对比：扩展侧**整个少了 `resolve_actions`**，另有若干条 description 不同。Claude Code 看到的是 **server** 那一份；扩展侧那份还被 `list_tools` 死分支占着（全仓库无人发 `list_tools`）。**改工具描述 = 只改 server 侧；扩展侧不是实现方该维护的东西。**

**T2 · WS 无任何鉴权。** `mcp-server/index.js:143` 无 `verifyClient`、无 origin 校验、无 token；**角色由第一帧自报类型决定**（`extension_info` → extension 角色，其它 → client，先到先得，`mcp-server/index.js:208-218`）。同机任意进程连上 19222 先发一帧，即可冒充扩展并收到后续**全部**工具调用。不要把它当可信 seam 来设计。

**T3 · `stopRequested` 两条路都会复位（2026-09-19 修，之前是单向开关）。** 原来置 `true` 后全仓库无人复位，用户点一次页面上的停止按钮，命令队列就永久死亡，直到重载扩展。现在：`processQueue`（`extension/background.js:145-186`）在队列转为空闲时复位（此刻 stop 已兑现——排队项已丢弃、在飞的工具已返回）；STOP 到达而**没有在飞的活**时立即复位（否则没人会替它复位）。被丢弃的排队调用会收到 `{ code: 'STOPPED' }`，不再让客户端干等传输超时。**碰队列代码时确认这两条复位路径都在**——漏掉任一条就退回原病。

**T4 · deadline 是这条 seam 缺的那个字段，2026-09-20 补上 —— 两侧数字是一对，只能一起改。**
不变式：**扩展侧放弃必须早于 server 预算，且预算要小于 Claude Code 的容忍度**。

```
扩展 deadline = server 预算 − DEADLINE_MARGIN_MS(3000)      两侧都在代码里，别各改一边
server 计时器 = server 预算 + QUEUE_ALLOWANCE_MS(20000)      存活界，不是调度策略
server 预算   = 按工具声明（javascript_tool/read_page/computer 45s、navigate 20s、
                wait_for = args.timeout + 5s、health_check 15s、默认 30s）
上限 60000    ← Claude Code 会把超过 2 分钟的调用转到后台，再长就不该指望一次调用跑完
```
预算表、边界归一化（非数值 `timeout`、`'constructor'` 走原型链）都在 **`mcp-server/budget.js`**，由 `test/budget.test.cjs` 覆盖。
- **为什么 server 计时器还要多 20s**：扩展要等前一个工具跑完才能开口报 `queued`，而排队时间不计入它自己的执行预算。给短预算的工具（`tabs_context` 10s）不预留这段，它排在长工具后面就会死在传输层——正是这次要消灭的那种超时。残留风险：队列里叠了两个长工具时仍可能传输层超时，那要等 job/队列协议才能根治。
- **别在调用点写死预算**：`callExtension` 的第三个参数会**绕过** `TOOL_BUDGET_MS`。`health_check` 曾被写死成 8000，于是信封 deadline 只剩 5s（比扩展自己的 8s 探针上限还短），诊断工具反而先报超时。
- **为什么**：旧版两侧各写死一个数（server 30000、扩展 60000），而 60 > 30 ⇒ 任何超过 30s 的工具**必然**先报 `Timeout calling X`，扩展还在跑，排在它后面的调用（含 `navigate`）一起超时。这是小红书抓帖第 4 篇那次连锁超时的机制，不是偶发。
- 现在超时总是**先在扩展侧**以 `{ code: 'DEADLINE_EXCEEDED', stage: 'queued' | 'executing' }` 返回，`stage` 区分「前面有慢工具」与「这一步本身慢」。
- 扩展侧不再有独立常数：`remainingMs()` 从信封推导，`executeToolBounded` 的兜底是 `剩余 + 2s`（`HANG_GRACE_MS`），只防「扩展自己没算准」。
- `wait_for`（`mcp-server/budget.js`）的预算必须大于它自己的 `timeout` 参数——曾因为两者都等于 30000 而必然失败（见 T5）。
- 队列串行仍然在：任一工具慢，其它仍要排队。但排队时间**计入调用者自己的预算**了，所以排太久会得到 `stage:'queued'` 而不是静默超时。
- 长任务怎么跑：**拆成多次短调用**，状态挂在页面的 `window` 上。配方见 `README.md`「长提取怎么拆」。

**T5 · `wait_for` 曾必然先超时（2026-09-20 修）。** 原来 schema 上限 30000 正好等于传输默认超时 30000 → `wait_for(timeout=30000)` 永远被传输层先判失败。现在它的预算 = `args.timeout + 5000`，页面内轮询再被 `remainingMs()` 压一次。**改任何工具的 timeout 参数上限时，回头看 `mcp-server/budget.js` 的 `budgetFor()`。**那里的 timeout 按 schema 声明的 [500, 30000] 归一化——客户端传什么都不能让它变成 NaN。

**T6 · Chrome 136 封死远程调试。** `--remote-debugging-port` 对默认 profile 被堵死，Chrome 也禁止 `chrome.debugger` 之外的进程接管已登录会话。**「扩展 + `chrome.debugger`」不是偏好，是唯一可行路径**——任何「改用 CDP 直连 / 无头浏览器」的方案在动工前就作废。

**T7 · 新增一个工具要改三处：** server `TOOLS` + 扩展 `TOOL_HANDLERS` + handler 实现。漏一处即静默失效或漂移。（部署时还有第四处：扩展未重载 → server 已能列出工具、调用却返回 `Unknown tool`。）

**T8 · 注入无超时，一个休眠标签页能冻死整条队列（2026-09-19 已修）。** `chrome.scripting.executeScript` 在 Edge 内存节省器冻结的标签页上**永不 settle**；`ensureContentScripts`（`extension/background.js:360`）被**每个碰标签页的工具**调用，而 `processQueue` 全局串行 → 一个永不返回的 `await` 让 `queueRunning` 恒为 `true`，**所有 client 的每次调用全部超时**，只能靠重载扩展恢复。`try/catch` 挡不住它——**挂住不是异常**。触发条件很宽：活动标签是 `edge://` 或任何不可注入页时，`health_check` 会转去探**另一个**标签，撞上休眠页即可。
- 两层界：`INJECT_TIMEOUT_MS=8000`（注入本身，超时抛错并提示标签页可能在休眠；**再被 `remainingMs()` 压一次**，见 T4）+ `HANG_GRACE_MS=2000`（`executeToolBounded` 的队列兜底 = 剩余预算 + 2s，覆盖 CDP 命令那条同样无取消的路）
- **反例（别再犯）**：不要为新内容脚本去放宽**共享就绪探针**——那会让每个已有标签页都重新注入一次，把「偶发踩雷」变成「必发」。新脚本用独立的 `ensureXxx` 按需注入
- 诊断：扩展 SW console 在 `edge://extensions` → 该扩展 → **service worker / 检查视图**；用 Node 22 内建 `WebSocket` 直连 `ws://127.0.0.1:19222` 发 `{type:'tool_call',id:1,tool:'tabs_context',args:{}}`，可区分「扩展坏了」与「某条 client 路由坏了」

## 当前状态

状态**从不抄进 always-loaded 文档**——数值随下一次 commit 过期，而过期的一行比缺一行更坏。用命令取实时值：

```bash
git -C /Users/owen/WorkBuddy/claude-code-browser status
git -C /Users/owen/WorkBuddy/claude-code-browser log --oneline -15
```

`ARCHITECTURE.md` 开头的基线 commit 与日期同理，以 `git log` 为准。

## 完成判据

本仓库**无 CI、无构建**（`package.json` 无 `scripts`），自动化验证只有两份测试：`test/action-resolver.test.cjs` 与 `test/deadline.test.cjs`。其余仍是手动，「改完」不等于「验证完」。一次改动算完成，当且仅当：

1. 动了 `action-resolver.js`（或它依赖的 `accessibility-tree.js` 导出）：`node test/action-resolver.test.cjs` 全过，退出码 0。
2. 动了 `extension/deadline.js`、`mcp-server/budget.js`、`handleJavaScript`、`processQueue` 或任何预算常数：`node test/deadline.test.cjs` 与 `node test/budget.test.cjs` 全过，退出码 0，**且两侧数字仍满足 T4 的不变式**（扩展 deadline < server 预算 ≤ 60000）。
3. 动了工具契约：`mcp-server/index.js` 的 `TOOLS` 与 `extension/background.js` 的 `TOOL_HANDLERS` 名字集合逐字一致，且描述只有 server 侧一份。
4. 动了 WS 帧：两侧同时改，手动跑一次 `health_check`，链路逐跳为通；**信封新增字段要容忍对侧没有它**（老 server 不发 `deadline`、老扩展不理它，两个方向都必须还能用）。
5. 动了 per-tab 状态：三处清理点（`tabs.onRemoved` / `debugger.onDetach` / `DISCONNECT_TAB`）都清到，无一处漏项。
6. 在真实浏览器里手动跑一次受影响的工具（重载扩展后），确认返回内容与改动前的语义一致。**修订顺序**：改内容脚本 → `edge://extensions` 重载 → **再刷新页面**。只刷新页面拿不到新脚本（实测：跑的还是旧代码）；只重载扩展则已注入的脚本全部失效。**注意先确认目标标签页不是休眠状态**（见 T8），否则会看到超时而非真实结果。
7. 改 `javascript_tool` 时额外验三条（用页面计数器数执行次数）：能 resolve 的片段返回其值且**只执行一次**；以 rejection 结尾的片段返回 `JS_ERROR` 且**只执行一次**；同步 throw 的片段返回 `JS_ERROR`。旧实现在这三条上分别是「一次 / 两次且只返回字符串 `undefined` / 两次」。
