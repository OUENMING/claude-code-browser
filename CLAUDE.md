# CLAUDE.md · claude-code-browser

Chrome/Edge 扩展 + MCP server，让 Claude Code 驱动**用户真实、已登录的浏览器**（导航/点击/输入/填表/截图/提取）。15 个 MCP 工具，无构建、无 CI，改完文件重载扩展即生效。架构评测（模块深度、seam 泄漏、深化机会）见 `ARCHITECTURE.md`——本文件只给指针与雷区，不重复它。

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
| 新增/修改工具契约 | `mcp-server/index.js:281-297` | `TOOLS`——**Claude Code 实际看到的那一份**，工具的单一权威定义 |
| 同上（第二份拷贝，已漂移） | `extension/background.js:22-38` | `TOOL_DEFINITIONS`——同一接口的拷贝，**死数据**，唯一消费者是死分支 `list_tools` |
| 新增工具要挂实现 | `extension/background.js:1176-1192` | `TOOL_HANDLERS`：`name → handler(tabId, args)` |
| 改 WS 帧 / 传输 / 多会话路由 / 角色判定 | `mcp-server/index.js:100-279` | 信封解析、`callExtension`（唯一请求出口）、双模与 `routeTable` |
| 改后台状态 / 命令队列 / attach 生命周期 / 保活 | `extension/background.js` | `state`、FIFO 队列 `processQueue`、`ensureAttached`、双轨保活 |
| 改 CDP 命令 / 某个工具的实现 | `extension/background.js:275-1174` | `executeTool` 入口 + 每个 `handleXxx`；用到的 CDP 域：`Page`/`Runtime`/`Network`/`DOM`/`Emulation`/`Input` |
| 改页面内提取 / 表单填写 / 元素树 | `extension/content-scripts/` | 元素树 `accessibility-tree.js`（`generate`/`signature`/ref 映射）、`page-bridge.js`、`auto-capture.js`、`visual-indicator.js` |
| 改权限 / 注入点 / 安全面 | `extension/manifest.json` | `permissions`（含 `debugger`）+ `host_permissions`（含 `<all_urls>`）+ 4 个内容脚本注入 |
| 改 popup 行为 | `extension/popup.js` | 状态查询 / 重连 / 断开 CDP / 停止执行 |
| 想知道某处为什么这样设计 | `ARCHITECTURE.md` | 架构评审：模块深度、seam 泄漏、深化机会 D1–D6 |
| 安装 / 使用 / 已知限制 | `README.md` | 安装步骤、15 工具说明、合盖休眠限制 |

## 本仓库特有雷区

改动前逐条对照；这些都是「读完代码才发现」的不变式。

**T1 · 工具契约定义了两遍，且已漂移。** `TOOLS`（server）与 `TOOL_DEFINITIONS`（扩展）逐字对比，15 条 description 有 6 条已不同。Claude Code 看到的是 **server** 那一份；扩展侧那份还被 `list_tools` 死分支占着（全仓库无人发 `list_tools`）。**改工具描述 = 只改 server 侧；扩展侧不是实现方该维护的东西。**

**T2 · WS 无任何鉴权。** `mcp-server/index.js:143` 无 `verifyClient`、无 origin 校验、无 token；**角色由第一帧自报类型决定**（`extension_info` → extension 角色，其它 → client，先到先得，`mcp-server/index.js:208-218`）。同机任意进程连上 19222 先发一帧，即可冒充扩展并收到后续**全部**工具调用。不要把它当可信 seam 来设计。

**T3 · `stopRequested` 是单向开关。** 全仓库只在 `extension/background.js:1221` 置 `true`，**没有任何地方置回 `false`**。用户在页面 stop 按钮上点一次，命令队列就永久死亡，直到扩展重载。碰队列相关的任何改动，这是首要陷阱。

**T4 · 命令队列全局串行，无超时、无取消。** `processQueue`（`extension/background.js:118-140`）同一时刻只跑一个工具：任一工具慢，全部工具慢。CDP 调用（`chrome.debugger.sendCommand`）全仓库无 timeout；server 侧 30s 只是「不再等」，扩展仍会把活干完。**`javascript_tool`/`read_page`/`navigate` 在高负载下超时是这条架构症状，不要给单个工具打补丁。**

**T5 · `wait_for` 必然先超时。** schema 上限 30000（`mcp-server/index.js:285`）= 传输默认超时 30000（`mcp-server/index.js:268`）→ `wait_for(timeout=30000)` 永远被传输层先判失败。

**T6 · Chrome 136 封死远程调试。** `--remote-debugging-port` 对默认 profile 被堵死，Chrome 也禁止 `chrome.debugger` 之外的进程接管已登录会话。**「扩展 + `chrome.debugger`」不是偏好，是唯一可行路径**——任何「改用 CDP 直连 / 无头浏览器」的方案在动工前就作废。

**T7 · 新增一个工具要改三处：** server `TOOLS` + 扩展 `TOOL_HANDLERS` + handler 实现。漏一处即静默失效或漂移。

## 当前状态

状态**从不抄进 always-loaded 文档**——数值随下一次 commit 过期，而过期的一行比缺一行更坏。用命令取实时值：

```bash
git -C /Users/owen/WorkBuddy/claude-code-browser status
git -C /Users/owen/WorkBuddy/claude-code-browser log --oneline -15
```

`ARCHITECTURE.md` 开头的基线 commit 与日期同理，以 `git log` 为准。

## 完成判据

本仓库**无测试、无 CI、无构建**（`package.json` 无 `scripts`），所以「改完」不等于「验证完」。一次改动算完成，当且仅当：

1. 动了工具契约：`mcp-server/index.js` 的 `TOOLS` 与 `extension/background.js` 的 `TOOL_HANDLERS` 名字集合逐字一致，且描述只有 server 侧一份。
2. 动了 WS 帧：两侧同时改，手动跑一次 `health_check`，链路逐跳为通。
3. 动了 per-tab 状态：三处清理点（`tabs.onRemoved` / `debugger.onDetach` / `DISCONNECT_TAB`）都清到，无一处漏项。
4. 在真实浏览器里手动跑一次受影响的工具（重载扩展后），确认返回内容与改动前的语义一致。
