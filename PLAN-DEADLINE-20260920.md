# PLAN · 超时与取消（deadline seam）

> 状态：**已落地（`0ae1de5` 已提交推送）+ 按 ocr 复核补了 11 处（见 §8 / §9）** · 写于 2026-09-20 · 起因：小红书抓帖第 4 篇 `Timeout calling javascript_tool`（见 `~/Obsidian/SecondBrain/Projects/claude-code-browser-浏览器MCP.md` 的「实测事故」）
> 关联：`ARCHITECTURE.md` §D4（本文是它的落地版，并修正了它两处前提）+ §7.1（可靠性）

---

## 0. 结论先讲

**D4 的方向（给 seam 加 deadline）是对的，而且是唯一可行的方向。** 但要改三处：

| # | D4 的说法 | 本次调研后 |
|---|---|---|
| 1 | 「CDP 调用没有一处带超时」→ 只能靠扩展侧 `Promise.race` 放弃等待 | **CDP 自带两个取消原语**：`Runtime.evaluate` 的 `timeout` 参数（超时**终止执行**）与 `Runtime.terminateExecution`。它们能停掉**页面里的活**，而不只是「不再等」 |
| 2 | 靠 MCP progress 通知延长预算 | **不行**。Claude Code 文档明说「per-server `timeout` 是硬墙钟，progress 通知不会延长它」（progress 只重置 idle 计时器） |
| 3 | 只提「加超时」 | 还有一条**放大器**必须先修：一次失败的 `javascript_tool` 会**执行两遍**，且失败被吞成 `undefined`。长循环 ×2 才是第 4 篇跨过 30s 的直接原因 |

另外确认一条**对本次事故的定性**：30s 这个数字**不是客户端逼的**，是仓库自己写死的（`mcp-server/index.js:268`）。stdio 的 MCP server 在 Claude Code 侧没有 per-request 计时器，`MCP_TOOL_TIMEOUT` 默认约 28 小时，idle 超时 30 分钟。**所以「改这个数字」是自由的**，只是改完仍不能解决「页面里的活停不下来」。

---

## 1. 证据链

| # | 事实 | 类型 | 来源 |
|---|---|---|---|
| E1 | `Runtime.evaluate` 有 `timeout: TimeDelta` 参数，语义「Terminate execution after timing out (number of milliseconds)」，标记 Experimental | 文档 | CDP Runtime 域（[tot](https://chromedevtools.github.io/devtools-protocol/tot/Runtime)、[1-3](https://chromedevtools.github.io/devtools-protocol/1-3/Runtime)） |
| E2 | `Runtime.terminateExecution`：「Terminate current or next JavaScript execution. Will cancel the termination when the outer-most script execution ends.」 Experimental | 文档 | 同上 + [cdproto runtime.go](https://github.com/chromedp/cdproto/blob/master/runtime/runtime.go) |
| E3 | `timeout` 生效时 evaluate 会**返回错误**（"Execution was terminated"），不是挂住 | 旁证 | [SO 77359657](https://stackoverflow.com/questions/77359657/) |
| E4 | MV3 **没有**取消 API：`chrome.scripting.executeScript` 无 AbortSignal；W3C 的提案里，官方建议的替代法就是「把 deadline 传进内容脚本」 | 文档 | [w3c/webextensions#415](https://github.com/w3c/webextensions/issues/415) |
| E5 | Claude Code：per-server `timeout`（`.mcp.json`）是**硬墙钟**，progress 不延长；未设置的 `MCP_TOOL_TIMEOUT` 默认约 28 小时；**stdio / WebSocket server 没有 per-request 计时器**；stdio 的 idle 窗口默认 30 分钟；单次调用超过 2 分钟会先转后台任务 | 文档 | [Claude Code MCP](https://code.claude.com/docs/en/mcp)、[env-vars](https://code.claude.com/docs/en/env-vars) |
| E6 | MCP 生态的公认痛点就是客户端硬超时长工具调用；结构性修法是 SEP-1686 Tasks / `resetTimeoutOnProgress`，**Claude Code 目前都不支持** | 文档 | [claude-code#470](https://github.com/anthropics/claude-code/issues/470)、[#52137](https://github.com/anthropics/claude-code/issues/52137)、[#58687](https://github.com/anthropics/claude-code/issues/58687) |
| E7 | `callExtension` 默认 30000ms，错误文案即 `Timeout calling ${tool}` | 代码 | `mcp-server/index.js:268-279` |
| E8 | 扩展侧全局 FIFO 串行 + 60s 挂死兜底（`TOOL_HANG_MS`）。**60s > 30s ⇒ 任何超过 30s 的工具必然先报传输超时**，且排在它后面的调用（含 `navigate`）一起超时 | 代码 | `background.js:118-145`、`:155-170` |
| E9 | `wait_for` 的 schema 上限 30000 **等于**传输超时 → `wait_for(timeout=30000)` 必定先超时 | 代码 | `index.js:286` vs `:268` |
| E10 | **成功的**异步片段执行 **1** 次，正常返回 | **实测** | 抖音标签页 `runs=1 total=1` |
| E11 | **以 rejection 结尾**的片段执行 **2** 次，调用方只看到字符串 `undefined`（错误被吞） | **实测** | 同上，计数器 `asyncRejectRuns=2` |
| E12 | **同步 throw** 的片段也执行 **2** 次，但错误**能**上报（`Error: Error: syncboom`） | **实测** | 同上，`syncThrowRuns=2` |
| E13 | `chrome.scripting.executeScript` 快路径**一次都没执行**用户的代码（全部落到 CDP 路径）。推测是 MV3 默认 CSP 禁止隔离世界里 `eval`，异常被 `catch {}`（`background.js:1083`）吞掉 | **实测 + 推断** | 同上（失败=2 次，正好是 r1+r2，不含快路径）；CSP 那半是推断，未验证 |
| E14 | 页面内 `Promise.race([工作, 定时 reject])` **在预算内返回**（2.0s 返回，孤儿任务 6s 后才跑完）⇒ 今天就能实现「调用有上限」 | **实测** | 同上，`orphan.done - started = 6003ms`（被第二次执行的 `started` 覆盖，见 E11） |
| E15 | `stopRequested` 复位已在 `692d557` 修掉；线上扩展 SW 自 2026-09-19 20:50 未重启，**含不含该修复未定**（提交时间 20:52:18，只差 2 分钟） | 实测 + 代码 | `background.js:144`、`health_check` uptime |

**E11 + E13 合起来是第 4 篇事故的直接解释**：那次 JS 内含 16 次滚动循环且中途失败（元素没找到之类），于是**同样的循环跑了两遍 ≈ 32 次滚动**，跨过 30s → 调用方放弃 → 孤儿占着 FIFO → 重试的 JS 和随后的 `navigate` 一起超时。这比「16 次本来就太多」更贴合「为什么偏偏是第 4 篇」。

---

## 2. 要修的四条

按顺序，一条一变量：

1. **修双跑与吞错**（`handleJavaScript`）—— 一次调用只执行一次；成功返回数据，失败返回错误，超时返回超时标记。**这条单独就能把第 4 篇那类事故的概率砍掉一半。**
2. **修 seam 的 deadline**（D4 落地）—— 信封带绝对 `deadline`，扩展侧所有循环按剩余预算收敛，且**扩展的 deadline 永远早于 server 的预算**（不变式）。
3. **修常数错配** —— server 侧超时改成**按工具声明**；`wait_for` 的预算 = 参数 + 余量；扩展的 60s 兜底改成**由信封推导**，不再写死。
4. **（可选，第二步）给长任务一个诚实的接口** —— 不是 job 系统（Claude Code 不支持 SEP-1686），而是**文档化的分批配方**：长提取拆成 N 次短调用，状态放页面全局。

---

## 3. 具体细节

### 3.1 不变式与常量

**唯一必须成立的不变式**：

```
扩展侧 deadline  ≤  server 预算 − 3000ms  ≤  60_000ms
（留 3s 余量）        （按工具声明）          （留在 2 分钟自动转后台之前，且交互上还等得下去）
```

| 工具 | server 预算 | 扩展 deadline |
|---|---|---|
| `navigate` | 20000 | 17000 |
| `read_page` / `get_page_text` / `get_page_markdown` | 45000 | 42000 |
| `javascript_tool` | 45000 | 42000（其中**页面内硬顶** 25000） |
| `wait_for` | `args.timeout + 5000` | 预算 − 3000 |
| `computer` | 45000 | 42000 |
| `tabs_context` / `tabs_create` | 10000 | 7000 |
| `health_check` | 15000 | 12000 |
| 其它默认 | 30000 | 27000 |

> ⚠️ 本节是**动工前**的草案；最终的数字与边界处理以 `mcp-server/budget.js` 为准（health_check 后来从 10s 改成 15s，见 §9 第 1 条）。

- `JS_EXEC_CAP_MS = 25000`：单次 `javascript_tool` 在**页面内**的硬顶。理由：留出 CDP 往返与序列化余量，且远超正常抓取（第 1–3 篇都在 25s 内完成）。
- `TOOL_HANG_MS` 从常数改为 `deadline − now + 2000`，只作为「扩展自己没算准」的最后保险。

### 3.2 信封加 deadline（两处）

`mcp-server/index.js` —— 发出去时算绝对时间戳（同机，无时钟偏差问题）：

```js
const TOOL_BUDGET_MS = { navigate: 20e3, read_page: 45e3, /* … */ };
function budgetFor(tool, args) {
  if (tool === 'wait_for') return (args.timeout || 10000) + 5000;
  return TOOL_BUDGET_MS[tool] ?? 30e3;
}
// callExtension 内：
extWs.send(JSON.stringify({
  type: 'tool_call', id, tool, args,
  deadline: Date.now() + budgetFor(tool, args) - 3000   // 扩展要早 3s 放弃
}));
```

同时 `callExtension(tool, args, timeoutMs)` 的默认值改成 `budgetFor(tool, args)`（现在是写死 30000）。

`extension/background.js` —— 队列项带上 deadline，并把「排队久」和「执行久」分开：

```js
function enqueueToolCall(messageId, toolName, args, deadline) {
  state.commandQueue.push({ messageId, toolName, args, deadline });
}
const remaining = () => Math.max(0, item.deadline - Date.now());
// 超时答复（而不是让调用方空等）：
sendResponse(item.messageId, null, {
  code: 'DEADLINE_EXCEEDED',
  stage: elapsedBeforeStart > 200 ? 'queued' : 'executing',
  waited_ms: elapsedBeforeStart, ran_ms: ranFor, budget_ms: budget
});
```

`stage` 让「前面排队排太久」和「这一步本身慢」可区分——这是 D4 item 3，也是 `health_check` 里 `backlog` 警告从提示变成诊断的前提。

### 3.3 扩展侧要收敛的循环（4 处）

| 位置 | 现状 | 改法 |
|---|---|---|
| `background.js:396` `waitForLoad(tabId, ms)` | 固定 10s | `ms = Math.min(ms, remaining())` |
| `background.js:1189` `handleWaitFor` | 固定按 `args.timeout` 轮询 | 同上，并在每个轮询周期检查 |
| `background.js:601` `verifyAction` | 最多 8 轮 | 剩余 < 400ms 就停，返回「未验证完」而不是继续烧预算 |
| `background.js:785` `handleType` | 每字符 20ms | 剩余 < 500ms 停，返回已输入部分 |

### 3.4 `handleJavaScript` 重写（本文档最要紧的一段）

> ⚠️ 下面是**动工前的草案**，最终实现见 `extension/background.js` 的 `handleJavaScript` / `detectJsForm` 与 `extension/deadline.js`。三处已按实测改掉：形态判定改用 `Runtime.compileScript` 探测、payload 里用户代码后要补换行（行注释会吞掉收尾符号）、预算用 `budgetForJavaScript` 而不是内联的 `Math.min`。差异清单在 §8。

替换 `background.js:1070-1092` 整个函数。三个变化：**删掉死掉的快路径**、**删掉 r1/r2 回退链**、**加页面内 deadline**。

```js
const JS_EXEC_CAP_MS = 25000;

async function handleJavaScript(tabId, args, remaining) {
  await ensureAttached(tabId);
  const code = args.text || '';
  const budget = Math.max(500, Math.min(remaining - 1000, JS_EXEC_CAP_MS));
  const marker = `__cc_deadline_${Date.now()}`;

  // 1) 只用一条路径：CDP Runtime.evaluate。
  //    快路径（chrome.scripting.executeScript）实测一次都没执行成功过（E13），
  //    而它的 catch {} 正是「失败静默 + 双跑」的来源，删掉比修好划算。
  // 2) 用 Promise.race 做页面内 deadline，且 resolve 而不是 reject：
  //    reject 会被 CDP 的 awaitPromise 吞成 undefined（E11）。
  // 3) 用户代码包在 await 里，同步/异步错误都变成返回值，永远能上报（E12）。
  const expr = `Promise.race([
    (async () => {
      try { return { ok: true, val: await (async () => { ${code} })() }; }
      catch (e) { return { ok: false, err: String((e && e.stack) || e) }; }
    })(),
    new Promise(r => setTimeout(
      () => r({ ok: false, err: '${marker}', deadline_ms: ${budget} }), ${budget}))
  ])`;

  const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
    timeout: budget + 500            // CDP 侧兜底：见 §5 的 E1 验证；Experimental，失败也不影响 race
  });
  if (r.exceptionDetails) {
    return { error: { code: 'JS_ERROR', message: r.exceptionDetails.exception?.description || 'JS error' } };
  }
  const v = r.result?.value;
  if (v && v.ok === false && String(v.err).includes(marker)) {
    return { error: { code: 'JS_DEADLINE', message:
      `页面内已跑满 ${budget}ms 仍未结束。页面里那段活还在继续（无法取消），但队列已经放行。` +
      `把循环拆成多次调用；状态存在 window 上，下次接着做。` } };
  }
  if (v && v.ok === false) {
    return { error: { code: 'JS_ERROR', message: String(v.err).slice(0, 4000) } };
  }
  let out = formatValue(v && v.val);
  if (out.length > 50000) out = out.slice(0, 50000) + '\n... [OUTPUT TRUNCATED]';
  return { content: [{ type: 'text', text: out }] };
}
```

要点：
- **恰好执行一次**（不管是成功、失败还是超时）——这直接消掉 E11/E12/E13。
- 失败**一定**是一个可读的错误，不再出现「只有 `undefined`」。
- 超时的错误文案里明确写「页面里的活还在跑」，因为这是事实（E14 实测孤儿会跑完），不要假装取消了。
- 用户传进来的 `args.text` 直接内插进表达式：**这是既有行为**（现在也是字符串拼接），不做额外转义；风险等级不变，但要在 `CLAUDE.md` 的雷区里注明「`javascript_tool` 的 text 必须是表达式，不能是语句序列」——包装成 `async () => { … }` 后，语句序列也能用，反而比现在宽松。

### 3.5 长提取的配方（不改代码，随文档一起发）

超过 25s 的抓取（小红书评论这种）改成：

```js
// 第 1 次：装状态 + 前 4 次滚动
javascript_tool: `(async () => {
  window.__ccC = window.__ccC || { items: new Set(), rounds: 0 };
  for (let i = 0; i < 4; i++) { window.scrollBy(0, 2000); await new Promise(r => setTimeout(r, 700)); }
  window.__ccC.rounds += 4;
  document.querySelectorAll('.comment-item').forEach(n => window.__ccC.items.add(n.innerText.slice(0, 80)));
  return JSON.stringify({ rounds: window.__ccC.rounds, collected: window.__ccC.items.size });
})()`

// 第 2..N 次：同上，只改循环次数
// 最后一次：取回数据
javascript_tool: `JSON.stringify([...window.__ccC.items])`
```

每次都在 25s 内，失败也只丢一批。

---

## 4. 不做的事（及理由）

| 不做 | 理由 |
|---|---|
| 新起 job id + `job_status` 轮询工具 | Claude Code 不支持 SEP-1686 Tasks（E6）；而「多次短调用」用现有工具就能做到同样的事，不必新增接口面与 schema token |
| 靠 progress 通知延长超时 | 文档明确 progress 不延长硬墙钟（E5） |
| 单纯把 30000 调大 | 治不了「页面里的活停不下来」；而且会掩盖 E9 那类错配 |
| 在扩展侧 `Runtime.terminateExecution` 兜底 | 它的语义是「终止**当前**脚本执行」，而滚动循环每轮都在 `await` 定时器——**外层执行早已结束**，它大概率停不掉（E2 的措辞）。等到 §5 的 E1/E2 验证有结论再决定要不要加 |
| 动 `stopRequested` | 仓库已修（E15）。线上是否生效靠重载扩展，不属于本计划 |

---

## 5. 验证步骤（**先测，再改**）

**Step 0 · 两个还没定论的问题（10 分钟，不碰仓库）**

1. `Runtime.evaluate` 的 `timeout` 到底覆不覆盖 `awaitPromise` 的等待？
   办法：临时给扩展加一个 `_cdp_probe`（约 6 行，`{method, params}` 直通 `chrome.debugger.sendCommand`），重载扩展，发
   `{method:'Runtime.evaluate', params:{expression:'new Promise(r=>setTimeout(r,8000))', awaitPromise:true, timeout:2000}}`
   看它是 ~2s 返回错误，还是 8s 才返回。**决定 §3.4 里那行 `timeout:` 是兜底还是主力。**
2. 同步死循环（`while(true){}`）时 `timeout` 与 `terminateExecution` 各自能否救回页面主线程。**决定要不要给 `javascript_tool` 加一条「页面被自己写死」的救命路径。**
   → 测完立刻删掉 `_cdp_probe`，并确认 `git status` 干净。

**Step 1 · 纯函数单测**（不启动浏览器，扩 `test/action-resolver.test.cjs` 的手搓桩风格）
- `buildEvaluateExpression(code, budget)`：断言包含 `budget` 的 race、`ok:false` 分支、且 `code` 只出现一次（防双跑回归）。

**Step 2 · 端到端对照**（同一个第 4 篇页面，标签页 `515086344` 还开着）
- 改前：跑 16 次滚动的那段 JS → 预期 30s 超时。
- 改后：同段 JS → 预期在 25s 内返回 `JS_DEADLINE`（或提前跑完拿到数据）；**紧接着一次 `tabs_context` 必须在 1s 内返回**（证明队列没被占住）。

**Step 3 · 三个回归断言**（都用页面计数器验执行次数）
| 输入 | 期望 |
|---|---|
| 能 resolve 的异步片段 | 返回其值，执行 **1** 次 |
| 以 rejection 结尾的片段 | 返回 `JS_ERROR` + 原因，执行 **1** 次 |
| 同步 throw 的片段 | 返回 `JS_ERROR` + `syncboom`，执行 **1** 次 |

**Step 4 · 错配回归**：`wait_for(timeout=30000)` 必须返回它的真实结果，而不是 `Timeout calling wait_for`。

**Step 5**：`node test/action-resolver.test.cjs` 退出码 0；每个改动文件 `node --check` 通过。

---

## 6. 文档要同步改的

| 文件 | 改什么 |
|---|---|
| `README.md` | 新增「每次调用的预算表」（§3.1）；工具数 16 对但「项目结构」漏了 `content-scripts/action-resolver.js` 与 `test/` |
| `README_en.md` | 同上（英文） |
| `CLAUDE.md` | 雷区加一条 T：**「任何工具的 deadline 必须早于 server 预算；改预算必须同时改扩展侧」**；并把 §3.5 的分批配方写进「长任务怎么做」 |
| `ARCHITECTURE.md` | §5 的「15 个工具」→ 16（5 处）；`TOOLS :281-297` → `:281-298`；§D4 标记为已落地并链接本文；§7.1 的「CDP 调用无超时无取消」改成「已有 deadline + CDP timeout，取消仍不可用」 |
| Obsidian `claude-code-browser-浏览器MCP.md` | 「最该做的一件事」下方加一行指向本文 |

---

## 7. 风险

1. **CDP `timeout` 是 Experimental**（E1）。可能在某版本/某平台上静默失效 → 所以页面内的 `Promise.race` 必须是**主力**，CDP `timeout` 只是兜底。
2. **改 `handleJavaScript` 会改变 `text` 的语义**：包装成 `async () => { … }` 后，原来只能传表达式的调用现在也能传语句；但反过来，**依赖 `return` 在外层的写法**（少数）会失效。改动要一次性说清，不留两套语义。
3. **超时不再等于「活停了」**。页面里的滚动/点击会继续（E14 实测）。错误文案必须说清，否则调用方会以为页面干净了，接着发出互相打架的下一次调用。
4. **建议一次只改一处**：先 §3.4（双跑/吞错，独立可验），再 §3.2+§3.3（deadline）。两件事混在一个提交里，Step 2 的对照实验就分不清是哪条起的作用。

---

## 8. 实施记录（2026-09-20，未提交）

### 改了什么

| 文件 | 内容 |
|---|---|
| `extension/deadline.js`（新，72 行） | 纯函数：`buildEvaluateExpression` / `formFromProbeError` / `budgetForJavaScript` / `classifyJsResult` + `DEADLINE_MARGIN_MS` / `JS_EXEC_CAP_MS` |
| `extension/background.js` | 重写 `handleJavaScript`（`:1149`）+ 新增 `detectJsForm`（`:1133`）；队列接 `deadline`（`:117-205`）；`executeToolBounded` 兜底改为从剩余预算推导（`:196-205`）；`withTimeout`/`waitForLoad`/`waitFor`/`verifyAction`/`handleType` 五处按 `remainingMs()` 收敛 |
| `mcp-server/index.js` | `TOOL_BUDGET_MS` + `budgetFor` + 信封里的 `deadline`（`:273-307`） |
| `test/deadline.test.cjs`（新，105 行） | 29 条断言，零依赖 |

### 与计划的三处差异

1. **形态判定换成 `Runtime.compileScript` 纯解析探测**，而不是计划里写的「页面内 `SyntaxError` 回退」。原因：语句序列会让 `await (语句序列)` **整个 payload 解析失败**，而解析先于执行——页面内的 `try/catch` 根本来不及触发，语句形态会直接废掉。改成先探测再拼 payload 之后，「用户代码只出现一次」才成为真不变式（原方案做不到，只能保证「语法错误才重跑」）。
2. **整条 `chrome.scripting.executeScript` 快路径删掉**（含 `formatCDP`）。实测它一次都没执行成功过，且它的 `catch {}` 是「失败静默 + 失败跑两遍」的来源。不修，删。
3. **`health_check` 预算 15s**（计划写 10s）：它要逐跳探链路，其中注入探针本身就有 8s 上限。

### 已验证（实测，不是推断）

**纯函数层**：`node test/deadline.test.cjs` **32/32**；`node test/action-resolver.test.cjs` **14/14**；五个改动文件 `node --check` 通过。

**重载扩展之前**（借旧扩展的 CDP 路径跑**新 payload**，抖音标签页 `515085894`）：
- 以 rejection 结尾的异步片段 → 返回 `{ok:false, err:"Error: boom…"}`，页面计数器 **= 1**（旧实现：执行 2 次且只返回字符串 `undefined`）。
- 语句形态 `const a = 1; return a + 41` → `{ok:true, val:42}`。
- 预算 1500ms 对 4s 的慢分支 → race 报 `{deadline:true, ran_ms:1500}` 并返回；慢分支 4.9s 后才写完成标记 ⇒ 「超时后页面里那段活仍在继续」成立。

**重载扩展之后**（2026-09-20 ~15:35，uptime 28s 起）：

| 检查 | 结果 |
|---|---|
| ESM `import` 新模块后 SW 能否起来 | ✅ `health_check` 全通，uptime 28s（万一 fail 会整条链路断，所以这是第一项） |
| 能 resolve 的片段 | ✅ `value=1`，计数器 **= 1** |
| 以 rejection 结尾的片段 | ✅ `Error: Error: boom-verify` + 栈（旧版：字符串 `undefined`），计数器 **= 1** |
| `wait_for(timeout=3000)` 不存在文本 | ✅ 干净返回 `Timeout after 3000ms` |
| 预算：40 轮 × 1s 的循环 | ✅ **精确在 25000ms** 返回 `JS_DEADLINE` |
| 超时后队列是否被占住 | ✅ 紧接着的 `tabs_context` **立刻返回全表**；同页读取显示孤儿还在跑（19/40 轮）——事故里缺的就是这一环 |
| 语句序列形态 | ✅ **复测通过**（修完第二次重载后）：`const a = 1; return a + 41` → `42`；`const t = await Promise.resolve(5); return t * 2` → `10`（顶层 await 也能用） |
| 语句形态失败时的执行次数 | ✅ 计数器 **= 1**（证明「表达式形态解析失败 → 换语句形态重跑」不会双重执行） |
| 复测 deadline | ✅ 重写后仍是 **精确 25000ms** 返回 `JS_DEADLINE`；孤儿继续跑（删变量前读到 20/40 轮、未完成） |

### 真机上抓到的两个新问题（都已修，待再次重载）

1. **`Runtime.compileScript` 把编译失败报在结果里**（`exceptionDetails`），不是靠 reject。只判 reject 的写法把语句序列误判成表达式 → 语句形态直接报解析错。改成判 `result.exceptionDetails`，并把决策抽成纯函数 `formFromProbe({result, error})` 加测试。
2. **短预算工具会被队列饿死**（设计缺口，不是实现 bug）：`tabs_context` 10s 预算，排在 25s 的工具后面时，server 计时器会先于扩展的 `queued` 答复到期 → 又变回传输层超时。修法：**server 计时器 = 预算 + `QUEUE_ALLOWANCE_MS`(20000)**——它是「扩展还活着吗」的存活界，不是调度策略，必须给排队留位。残留风险写进 `CLAUDE.md` T4。

另外加了一层兜底：`handleJavaScript` 在表达式形态拿到 `exceptionDetails` 时换语句形态重跑一次。**这不是双重执行**——能冒到 CDP 层的 `exceptionDetails` 只可能是 payload 自己没解析过（用户代码的错误，含运行时 `SyntaxError`，都在 payload 的 `try/catch` 里变成了返回值），而解析失败意味着上一次什么都没执行。

### 仍需验证（只剩 server 侧的两条边角）

MCP server 本会话已重连（新 pid 54905），**信封 `deadline` 与按工具预算已生效**——判定方法是 `wait_for(timeout=30000)` 报的是 `Timeout after 30000ms` 而不是 26500ms（后者是 `FALLBACK_BUDGET_MS` 把页面内轮询压到 26500ms 的特征）。这一条同时证明 **T5 的错配端到端修好了**。

已补验：**`stage:'queued'` 分支**。用仓库 T8 里记的直连法（裸 WS client 连 19222）占住队列 25s，再从 MCP 发一个短预算工具：

- `tabs_create`（预算 10s）→ 返回「排在这个调用前面的工具吃掉了全部 10000ms 预算，它还没开始跑就被放弃了」= `DEADLINE_EXCEEDED stage:'queued'` ✅ 在 server 的 30s 计时器之前到达；也证明了 `QUEUE_ALLOWANCE_MS` 那段余量确实是必需的。
- 同一次实验还暴露一处旧逻辑：`tabs_context` 的 catch 把**一切**错误都渲染成「Extension disconnected」，把这条合法的 `queued` 答复伪装成了断链。已收窄为只有真的是「没连上」才给那句友好文案（需再重连一次 server 生效）。

仍未验：

- `Runtime.evaluate` 的 `timeout` 参数到底覆不覆盖 `awaitPromise`（Experimental，只当兜底，不影响结论）。
- 四个循环收敛后的真实表现（`read_page` / `computer` / `computer.type`）——它们的代码路径已按同一规则改，但没有单独构造慢页面来测。

### 下一步（已全部完成）

```bash
# 1) 重载扩展：edge://extensions → 刷新          ✅ 已做，6 项复测通过
# 2) 重连 MCP server：/mcp → reconnect           ✅ 已做，wait_for(30000) 报 30000ms 证明 deadline 已生效
# 3) 语句形态 → 42；长 JS + tabs_context → queued ✅ 两条都验过（见上表）
```

---

## 9. ocr 复核后的修补（2026-09-20 晚）

`ocr review --commit 0ae1de5`（阿里 open-code-review，4 文件 / +382 行，**16 分 39 秒**，走 cc-switch 花费 0）报 15 条：**0 critical / 0 high**，9 medium + 6 low。逐条回原码核实后 **11 条真** —— 全部是这次改动**自己引入的不一致**，已修完：

| # | 它报的 | 修法 |
|---|---|---|
| 1 | `health_check` 调用点写死 8000，绕过预算表 → 信封 deadline 只剩 5s（比扩展自己的 8s 探针上限还短），表里的 15000 成死配置 | 去掉第三参，走表（15s） |
| 2 | 我收窄 `tabs_context` 的 catch 用的 `/not connected/i` **匹配不到真实的断开文案** | 改判 `!extConnected`（真实文案是 `Extension disconnected` / `Upstream disconnected`） |
| 3 | fallback deadline 用**出队时刻**算，与它上方的注释矛盾 → 老 server 下排队时间不进预算，孤儿照旧 | 改用 `item.enqueuedAt + FALLBACK_BUDGET_MS` |
| 4 | reject 分支正则含 `invalid`/`parse`，会误命中 `Invalid parameters` → 合法表达式静默变 `undefined` | 收窄到 `/syntax ?error\|unexpected/i` |
| 5 | `injectTimeoutMs()` 漏落 `ensureActionResolver` 两处 | 一并替换 |
| 6 | `queuedMs` 写完没人读（死字段） | 用进 queued 文案（排队耗时对定位有价值） |
| 7 | 预算不足时 `!after` 返回路径丢了 `budgetNote` → 误报「标签页可能已关闭」 | 两种文案分开 |
| 8 | 用户代码以行注释结尾时，收尾符号被注释吞掉 | 用户代码后补换行（两个模板 + 探测表达式三处），并加「真能解析」断言 |
| 9 | `deadlineError('executing')` 不可达（死分支） | 接到 `executeToolBounded` 的兜底上，让 `stage` 名副其实 |
| 10 | `waitForLoad` 返回值被三处调用点丢弃 → 「没等完」被说成「导航成功」 | 返回文案带上 `LOAD_NOTE` |
| 11 | 边界硬化：`args.timeout` 非数值 → NaN、`TOOL_BUDGET_MS['constructor']` 命中原型链 | 抽出 **`mcp-server/budget.js`**（区间归一化 + 自身属性判定），`test/budget.test.cjs` 19 条断言 |

**它报错的 2 条（没照改）**：

- `typed += r.length` 被指「换行导致虚高」→ **实测 `text.length == sum(run.length)`**，与旧行为完全一致，不存在虚高
- 尾随行注释被指「静默返回 undefined」→ **真机实测报的是 `SyntaxError: Unexpected token 'catch'`**：是真 bug，但后果说反了

**它重复上报**：同一处 `health_check` 预算问题报了两条（`:303` 与 `:356`）。

**另一条属实但没动**：`handleType` 被 STOP 打断仍算成功返回 —— 那属于 STOP 契约（`CLAUDE.md` T3 的范围），本次只在文案上标明「被停止按钮中断」，不改状态语义。

**测试**：`deadline.test.cjs` 36 条 + `budget.test.cjs` 19 条 + `action-resolver.test.cjs` 14 条，全过（`node test/*.test.cjs`）。

**这一轮的教训**：11 条里有 8 条是「我改了 A 却忘了同步 B」——同一个改动面里的**不一致**，而不是新的复杂度。`ocr` 的价值恰恰在这个方向：它没有我「我为什么这么写」的记忆负担。
