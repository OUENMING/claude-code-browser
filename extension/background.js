import { DEADLINE_MARGIN_MS, buildEvaluateExpression, budgetForJavaScript, classifyJsResult, formFromProbe } from './deadline.js';

// === STATE ===
const state = {
  ws: null, connected: false, wsPort: 19222,
  reconnectAttempt: 0, reconnectTimer: null,
  keepAliveTimer: null,
  attachedTabs: new Set(), enabledDomains: new Set(),
  commandQueue: [], queueRunning: false, stopRequested: false,
  currentCall: null,           // 正在跑的那个调用：{toolName, deadline, startedAt, budgetMs}
  screenshotContexts: new Map(),
  tabEventBuffers: new Map(),
  pendingDialogs: new Map(),   // tabId -> {type, message, defaultPrompt}
  snapshots: new Map(),        // tabId -> {tree, ts} — last read_page result, for diff
  startedAt: Date.now(),
};

function initTabBuffer(tabId) {
  if (!state.tabEventBuffers.has(tabId)) {
    state.tabEventBuffers.set(tabId, { console: [], network: [] });
  }
}

const BLOCKED_URLS = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://', 'view-source:'];
const TOOL_DEFINITIONS = [
  { name: 'navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'number' } }, required: ['url'] }, description: '导航到指定 URL，支持 "back"/"forward" 前进后退。' },
  { name: 'read_page', inputSchema: { type: 'object', properties: { filter: { type: 'string', enum: ['interactive', 'all'] }, depth: { type: 'integer', minimum: 1, maximum: 30 }, max_chars: { type: 'integer', minimum: 1000, maximum: 200000 }, ref_id: { type: 'string' }, keywords: { type: 'string' }, diff: { type: 'boolean' }, tabId: { type: 'number' } } }, description: '获取页面可访问性元素树，带 ref ID。filter="interactive" 仅交互元素（省 token），"all" 全部元素。keywords 空格分隔，只输出匹配元素（省 token 的定向读取）。diff=true 只返回相对上次快照的变化（省 token）。' },
  { name: 'find', inputSchema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 100 }, tabId: { type: 'number' } }, required: ['query'] }, description: '按关键词搜索元素，匹配 text/aria-label/title/role，返回 ref 列表供 computer/form_input 使用。' },
  { name: 'wait_for', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'integer', minimum: 500, maximum: 30000 }, tabId: { type: 'number' } } }, description: '等待元素或文本出现。selector 按 CSS 匹配可见元素，text 按页面文本匹配。默认超时 10s，300ms 轮询。navigate 后页面加载中自动等待 body 出现。' },
  { name: 'dismiss_dialog', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['accept', 'dismiss'] }, promptText: { type: 'string' }, tabId: { type: 'number' } }, required: ['action'] }, description: '关闭浏览器原生对话框（alert/confirm/prompt/beforeunload）。action="accept" 确认，"dismiss" 取消。prompt 类型用 promptText 填入文本。' },
  { name: 'computer', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['left_click','right_click','double_click','triple_click','type','screenshot','screenshot_element','wait','scroll','scroll_to','key','left_click_drag','hover','zoom'] }, coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, start_coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, ref: { type: 'string' }, text: { type: 'string' }, scroll_direction: { type: 'string', enum: ['up','down','left','right'] }, scroll_amount: { type: 'number', minimum: 1, maximum: 10 }, quality: { type: 'string', enum: ['low','medium','high'] }, duration: { type: 'number', minimum: 0, maximum: 10 }, region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, modifiers: { type: 'string' }, repeat: { type: 'number', minimum: 1, maximum: 100 }, verify: { type: 'boolean' }, tabId: { type: 'number' } }, required: ['action'] }, description: '鼠标/键盘/截图交互。ref 精确定位（来自 read_page），coordinate 像素坐标。type 逐字符输入带 20ms 延迟模拟人类。点击/按键默认自动校验页面是否发生变化（verify=false 关闭）。' },
  { name: 'form_input', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: ['string','boolean','number'] }, fields: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, value: { type: ['string','boolean','number'] } }, required: ['ref','value'] } }, tabId: { type: 'number' } } }, description: '设置表单字段值（单个或批量）。单字段用 ref+value，批量用 fields: [{ref, value}, ...]。React/Vue 受控组件兼容。' },
  { name: 'get_page_text', inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 1000, maximum: 200000 }, tabId: { type: 'number' } } }, description: '提取页面全部纯文本（textContent）。最完整，不会漏内容，但丢失结构。适合社交媒体、复杂 SPA。' },
  { name: 'get_page_markdown', inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 1000, maximum: 200000 }, tabId: { type: 'number' } } }, description: '提取页面为结构化 Markdown — 标题(#)、链接、代码块、表格、图片。过滤 <50px 装饰图标。适合博客、文档、产品页。漏内容时回退到 get_page_text。' },
  { name: 'javascript_tool', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, tabId: { type: 'number' } }, required: ['text'] }, description: '在当前页面执行 JavaScript。⚠️ 不要用它提取密码/token/敏感数据。' },
  { name: 'tabs_context', inputSchema: { type: 'object', properties: {} }, description: '列出所有打开的标签页。' },
  { name: 'tabs_create', inputSchema: { type: 'object', properties: {} }, description: '创建新的空白标签页。' },
  { name: 'read_console_messages', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, onlyErrors: { type: 'boolean' }, pattern: { type: 'string' }, clear: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['tabId'] }, description: '读取浏览器控制台消息。' },
  { name: 'read_network_requests', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, urlPattern: { type: 'string' }, clear: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['tabId'] }, description: '读取 HTTP 网络请求。' },
  { name: 'health_check', inputSchema: { type: 'object', properties: {} }, description: '端到端链路体检：MCP server → WebSocket → 扩展 → CDP，逐跳报告状态。工具调用异常时先用它定位是哪一跳断了。' },
];

// === HELPERS ===
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(...args) {
  console.log('[CCBrowser]', ...args);
}

// === WEBSOCKET ===
function connectToMcpServer(port) {
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onopen = () => {
      state.connected = true;
      state.reconnectAttempt = 0;
      state.wsPort = port;
      startKeepAlive();
      ws.send(JSON.stringify({
        type: 'extension_info',
        version: '1.0.0',
        capabilities: ['cdp', 'content-scripts', 'tab-management']
      }));
      log('Connected to MCP Server on port', port);
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
        if (msg.type === 'tool_call') { enqueueToolCall(msg.id, msg.tool, msg.args || {}, msg.deadline); return; }
        if (msg.type === 'list_tools') { ws.send(JSON.stringify({ id: msg.id, result: { tools: TOOL_DEFINITIONS } })); return; }
      } catch {}
    };
    ws.onclose = () => {
      state.connected = false;
      state.ws = null;
      stopKeepAlive();
      log('MCP Server disconnected, scheduling reconnect');
      scheduleReconnect();
    };
    ws.onerror = (e) => { log('WebSocket error:', e.message || e.type || 'unknown'); };
    state.ws = ws;
  } catch (e) { log('Failed to connect to MCP Server:', e.message || 'unknown'); }
}

function startKeepAlive() {
  stopKeepAlive();
  state.keepAliveTimer = setInterval(() => chrome.storage.local.set({ _keepalive: Date.now() }), 25000);
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }).catch(() => {});
}

function stopKeepAlive() {
  if (state.keepAliveTimer) { clearInterval(state.keepAliveTimer); state.keepAliveTimer = null; }
  chrome.alarms.clear('keepalive').catch(() => {});
}

// Alarm-based keepalive fallback — fires even when SW is woken from idle
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepalive') {
    chrome.storage.local.set({ _keepalive_alarm: Date.now() });
    // Reconnect if disconnected (alarm can wake SW in any state)
    if (!state.connected && !state.reconnectTimer) scheduleReconnect();
  }
});

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempt++), 10000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectToMcpServer(state.wsPort);
  }, delay);
}

// === FIFO COMMAND QUEUE ===
// 老版本 server 不发 deadline，就按它自己那个 30s 传输超时来假定，并先它一步放弃。
const FALLBACK_BUDGET_MS = 30000 - DEADLINE_MARGIN_MS;

// 当前调用还剩多少预算。排队等掉的与执行花掉的是**同一个**预算——这正是旧版缺的字段：
// 调用方那边只剩 3s 了，扩展还按「还有 60s」在跑。
function remainingMs() {
  if (!state.currentCall) return Infinity;
  return Math.max(0, state.currentCall.deadline - Date.now());
}

function enqueueToolCall(messageId, toolName, args, deadline) {
  state.commandQueue.push({ messageId, toolName, args, deadline, enqueuedAt: Date.now() });
  processQueue();
}

function deadlineError(stage) {
  const c = state.currentCall || {};
  const ranMs = c.startedAt ? Date.now() - c.startedAt : 0;
  return {
    code: 'DEADLINE_EXCEEDED',
    stage,
    ran_ms: ranMs,
    budget_ms: c.budgetMs ?? null,
    message: stage === 'queued'
      ? `排在这个调用前面的工具吃掉了全部 ${c.budgetMs}ms 预算，它还没开始跑就被放弃了。重试即可；如果反复出现，先用 health_check 看是哪一跳卡住。`
      : `跑到预算用完还没结束（已跑 ${ranMs}ms，预算 ${c.budgetMs}ms）。注意：页面里没干完的活**仍在继续**——CDP 取消不了一个正在 await 的循环。把长循环拆成多次调用，状态挂在 window 上。`
  };
}

async function processQueue() {
  if (state.queueRunning) return;
  state.queueRunning = true;
  while (state.commandQueue.length > 0 && !state.stopRequested) {
    const item = state.commandQueue.shift();
    const start = performance.now();
    state.currentCall = {
      toolName: item.toolName,
      deadline: item.deadline || Date.now() + FALLBACK_BUDGET_MS,
      startedAt: Date.now(),
      budgetMs: item.deadline ? item.deadline - item.enqueuedAt + DEADLINE_MARGIN_MS : FALLBACK_BUDGET_MS,
      queuedMs: Date.now() - item.enqueuedAt,
    };
    try {
      if (remainingMs() <= 0) {
        // 排队等到出局：这是「前面有慢工具」，不是「这一步本身慢」，所以分开报。
        sendResponse(item.messageId, null, deadlineError('queued'));
      } else {
        log('Executing tool:', item.toolName);
        const result = await executeToolBounded(item.toolName, item.args);
        if (result?.error) {
          sendResponse(item.messageId, null, result.error);
        } else {
          sendResponse(item.messageId, result, null);
        }
      }
    } catch (e) {
      log('Tool error:', item.toolName, e.message);
      sendResponse(item.messageId, null, { code: 'INTERNAL_ERROR', message: e.message });
    }
    const elapsed = performance.now() - start;
    if (elapsed > 5000) log(`Slow tool: ${item.toolName} took ${Math.round(elapsed)}ms`);
  }
  state.queueRunning = false;
  state.currentCall = null;
  // Cleared as soon as the queue is idle. By now the stop has been honoured —
  // queued work was dropped and the in-flight tool has returned (handleType
  // breaks out of its loop on the flag) — so holding it any longer would only
  // block the next call.
  state.stopRequested = false;
}

// An await inside executeTool that never settles (injection into a frozen tab, a
// debugger that cannot attach, a CDP command that never returns) used to wedge the
// global FIFO queue permanently: queueRunning stayed true, every later call from
// every client was queued but never run, and only an extension reload recovered it.
// Bounding the await turns that into one failed call.
//
// 这个上限不再是写死的常数，而是从信封里的 deadline 推出来的：正常路径上
// deadlineError 早就先触发了，这里只在「扩展自己没算准」时救队列。写死 60000 曾经
// 比 server 的 30000 还大，那就等于永远不会生效。
const HANG_GRACE_MS = 2000;

async function executeToolBounded(toolName, args) {
  let timer;
  const hangMs = Math.max(2500, remainingMs() + HANG_GRACE_MS);
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tool ${toolName} did not settle within ${Math.round(hangMs)}ms — abandoned so the queue keeps moving`)),
      hangMs
    );
  });
  try {
    return await Promise.race([executeTool(toolName, args), guard]);
  } finally {
    clearTimeout(timer);
  }
}

function sendResponse(messageId, result, error) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ id: messageId, result, error }));
  }
}

// === CDP MANAGEMENT ===
async function ensureAttached(tabId) {
  if (state.attachedTabs.has(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  if (BLOCKED_URLS.some(p => (tab.url || '').startsWith(p)))
    throw new Error(`Cannot attach to restricted URL: ${tab.url}`);

  try { await chrome.debugger.detach({ tabId }); } catch {}
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (/Another debugger/.test(e.message)) {
      throw new Error('Another debugger is already attached to this tab — close DevTools (F12) first');
    }
    throw e;
  }
  state.attachedTabs.add(tabId);
  initTabBuffer(tabId);

  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  state.enabledDomains.add(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  state.attachedTabs.delete(tabId);
  state.enabledDomains.delete(tabId);
  state.screenshotContexts.delete(tabId);
  state.tabEventBuffers.delete(tabId);
  state.pendingDialogs.delete(tabId);
  state.snapshots.delete(tabId);
});

chrome.debugger.onDetach.addListener((s) => {
  if (s.tabId) {
    state.attachedTabs.delete(s.tabId);
    state.enabledDomains.delete(s.tabId);
    state.screenshotContexts.delete(s.tabId);
    state.tabEventBuffers.delete(s.tabId);
    state.pendingDialogs.delete(s.tabId);
    state.snapshots.delete(s.tabId);
  }
});

// CDP event listeners (console + network)
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;
  initTabBuffer(tabId);
  const buf = state.tabEventBuffers.get(tabId);

  if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
    buf.console.push({
      type: method === 'Runtime.exceptionThrown' ? 'error' : (params.type || 'log'),
      text: method === 'Runtime.exceptionThrown'
        ? (params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || '')
        : params.args?.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ') || '',
      timestamp: Date.now()
    });
  }
  if (method === 'Network.requestWillBeSent') {
    buf.network.push({
      url: params.request?.url || '',
      method: params.request?.method || 'GET',
      type: params.type || '',
      timestamp: Date.now()
    });
  }
  if (method === 'Network.responseReceived') {
    buf.network.push({
      url: params.response?.url || '',
      status: params.response?.status || 0,
      type: params.type || '',
      timestamp: Date.now()
    });
  }
  // Track native browser dialogs (alert/confirm/prompt/beforeunload)
  if (method === 'Page.javascriptDialogOpening') {
    state.pendingDialogs.set(tabId, {
      type: params.type,
      message: params.message || '',
      defaultPrompt: params.defaultPrompt || ''
    });
  }
  if (method === 'Page.javascriptDialogClosed') {
    state.pendingDialogs.delete(tabId);
  }
});

// === CONTENT SCRIPT CALLS ===
async function callContentScript(tabId, func, args = []) {
  await ensureContentScripts(tabId);
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return r?.result;
  } catch {
    await ensureAttached(tabId);
    const expr = `(${func.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`;
    const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'CDP eval failed');
    return r.result?.value;
  }
}

// chrome.scripting.executeScript never settles on a tab Edge has put to sleep, so
// an awaiting tool call never returns — and since every tab-touching tool funnels
// through ensureContentScripts, one sleeping tab used to stall the whole serial
// queue. health_check picking a background tab to probe was enough to freeze every
// client. Bounding the injection turns a permanent stall into a fast local failure.
const INJECT_TIMEOUT_MS = 8000;

// 注入本身的上限也要受剩余预算约束：只剩 2s 的调用不该再花 8s 去注入。
function injectTimeoutMs() {
  return Math.max(1000, Math.min(INJECT_TIMEOUT_MS, remainingMs()));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms — the tab is probably asleep; click it once to wake it, or pass another tabId`)),
        ms
      );
    })
  ]);
}

async function ensureContentScripts(tabId) {
  try {
    const [r] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!(globalThis.__ccAccessibilityTree && globalThis.__ccBridge && globalThis.__ccAutoCapture)
      }),
      injectTimeoutMs(), 'content-script probe');
    if (r?.result === true) return;
  } catch (e) {
    // A probe that hangs means the tab is asleep — injecting would hang too, so
    // fail here instead of falling through to the injection below.
    if (/timed out/.test(e.message)) throw e;
  }
  await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'content-scripts/accessibility-tree.js',
        'content-scripts/page-bridge.js',
        'content-scripts/auto-capture.js',
        'content-scripts/visual-indicator.js'
      ]
    }),
    injectTimeoutMs(), 'content-script injection');
}

// The action resolver is only needed by resolve_actions, so it is injected here
// rather than added to the shared readiness probe: widening that probe would make
// every already-injected tab re-run a full injection on first touch, which is the
// expensive path. Tabs loaded after the manifest change already have it.
async function ensureActionResolver(tabId) {
  try {
    const [r] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!globalThis.__ccActionResolver
      }),
      INJECT_TIMEOUT_MS, 'action-resolver probe');
    if (r?.result === true) return;
  } catch (e) {
    if (/timed out/.test(e.message)) throw e;
  }
  await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/action-resolver.js']
    }),
    INJECT_TIMEOUT_MS, 'action-resolver injection');
}

// === TOOL ROUTING ===
async function executeTool(toolName, args) {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) return { error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}` } };
  let tabId = args?.tabId;
  if (!tabId && !['tabs_context', 'tabs_create', 'health_check'].includes(toolName)) {
    tabId = await getActiveTabId();
  }
  return handler(tabId, args || {});
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab.id;
}

// === NAVIGATION ===
async function handleNavigate(tabId, args) {
  let url = args.url || '';
  if (url === 'back') {
    await chrome.tabs.goBack(tabId);
    await waitForLoad(tabId, 5000);
    const tab = await chrome.tabs.get(tabId);
    return { content: [{ type: 'text', text: `Navigated back to: ${tab.url}` }] };
  }
  if (url === 'forward') {
    await chrome.tabs.goForward(tabId);
    await waitForLoad(tabId, 5000);
    const tab = await chrome.tabs.get(tabId);
    return { content: [{ type: 'text', text: `Navigated forward to: ${tab.url}` }] };
  }
  if (!url.match(/^https?:\/\//i)) url = `https://${url}`;
  try { url = new URL(url).href; } catch { return { error: { code: 'BAD_REQUEST', message: `Invalid URL: ${url}` } }; }
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId, 10000);
  const tab = await chrome.tabs.get(tabId);
  return { content: [{ type: 'text', text: `Navigated to: ${tab.url}\nTitle: ${tab.title}` }] };
}

async function waitForLoad(tabId, ms) {
  const budget = Math.min(ms, remainingMs());
  for (const start = Date.now(); Date.now() - start < budget;) {
    try { if ((await chrome.tabs.get(tabId)).status === 'complete') return true; } catch { return false; }
    await sleep(100);
  }
  return false;
}

// === READ PAGE ===
// Tree lines are keyed by ref (stable per element via WeakRef map), so a
// ref-level set difference approximates a semantic diff: same element + same
// line ⇒ unchanged, even when its position in the tree shifted.
function indexTree(tree) {
  const byRef = new Map();
  for (const line of String(tree || '').split('\n')) {
    const m = line.match(/\[(ref_\d+)\]/);
    if (m) byRef.set(m[1], line);
  }
  return byRef;
}

function computeDiff(prevTree, curTree, maxLines = 60) {
  const prev = indexTree(prevTree), cur = indexTree(curTree);
  const added = [], removed = [], changed = [];
  for (const [ref, line] of cur) {
    if (!prev.has(ref)) added.push(line);
    else if (prev.get(ref) !== line) changed.push(line);
  }
  for (const [ref, line] of prev) if (!cur.has(ref)) removed.push(line);

  const total = added.length + removed.length + changed.length;
  if (total === 0) {
    return { text: 'No changes since last snapshot — the page looks identical.', total: 0, added: 0, removed: 0, changed: 0 };
  }

  const out = [`## Changes since last snapshot (+${added.length} -${removed.length} ~${changed.length})`];
  let shown = 0;
  const push = (mark, lines) => {
    for (const l of lines) {
      if (shown >= maxLines) return;
      out.push(`${mark} ${l}`);
      shown++;
    }
  };
  push('+', added); push('-', removed); push('~', changed);
  if (total > shown) out.push(`… ${total - shown} more changed lines not shown`);
  return { text: out.join('\n'), total, added: added.length, removed: removed.length, changed: changed.length };
}

async function handleReadPage(tabId, args) {
  await ensureContentScripts(tabId);
  const prev = state.snapshots.get(tabId);
  const r = await callContentScript(tabId,
    (filter, maxDepth, maxChars, refId, keywords) => {
      const tree = globalThis.__ccAccessibilityTree;
      if (!tree) return { error: 'not available' };
      const result = tree.generate(filter || 'interactive', maxDepth, maxChars || 50000, refId || null, keywords || null);
      result.readyState = document.readyState;
      return result;
    },
    [args.filter || 'interactive', args.depth ?? 15, args.max_chars || 50000, args.ref_id || null, args.keywords || null]
  );
  if (r?.error) return { content: [{ type: 'text', text: String(r.error) }], isError: true };

  const ts = `[Snapshot at ${new Date().toISOString()}]\n`;
  const dialog = state.pendingDialogs.get(tabId);
  let dialogWarn = '';
  if (dialog) dialogWarn = `⚠️ Browser dialog active: ${dialog.type}("${dialog.message.slice(0, 100)}")\n\n`;

  // Page loading state — warn if page isn't ready yet
  let stateHeader = '';
  if (r.readyState && r.readyState !== 'complete') {
    stateHeader = `[Page state: ${r.readyState}]\n`;
  }

  // Live diagnostics: inject recent console errors and failed network requests
  let diagnostics = '';
  const buf = state.tabEventBuffers.get(tabId);
  if (buf) {
    const consoleErrors = buf.console.filter(e => e.type === 'error').slice(-5);
    const netFailures = buf.network.filter(e => e.status && e.status >= 400).slice(-5);
    if (consoleErrors.length || netFailures.length) {
      diagnostics = '## Live Diagnostics\n';
      for (const e of consoleErrors) diagnostics += `- [console] ${e.text.slice(0, 200)}\n`;
      for (const n of netFailures) diagnostics += `- [${n.status}] ${n.method} ${n.url.slice(0, 200)}\n`;
      diagnostics += '\n';
    }
  }

  let bodyText;
  const partialView = !!(args.keywords || args.ref_id);
  if (args.diff) {
    if (!prev) {
      bodyText = '[diff requested but no previous snapshot for this tab — returning full tree]\n\n' + r.tree;
    } else if (partialView) {
      bodyText = '[diff requested together with keywords/ref_id — a partial view can\'t be diffed against a full snapshot; returning full tree]\n\n' + r.tree;
    } else {
      const d = computeDiff(prev.tree, r.tree);
      bodyText = `(diff vs snapshot from ${new Date(prev.ts).toISOString()})\n\n${d.text}`;
    }
  } else {
    bodyText = r.tree;
  }

  // Only unfiltered reads become a diff baseline — a keyword/ref_id read is a
  // partial view, and diffing a full tree against it would report every other
  // element as newly added.
  if (!partialView) state.snapshots.set(tabId, { tree: r.tree, ts: Date.now() });
  return { content: [{ type: 'text', text: dialogWarn + stateHeader + ts + diagnostics + bodyText }] };
}

// === FIND ===
async function handleFind(tabId, args) {
  await ensureContentScripts(tabId);
  const r = await callContentScript(tabId,
    (query, maxResults) => {
      const bridge = globalThis.__ccBridge;
      return bridge ? bridge.searchElements(query, maxResults || 20) : [];
    },
    [args.query, args.max_results || 20]
  );
  const text = r.map(el => `[${el.ref}] ${el.text} (${el.role}, score=${el.score})`).join('\n') || '(no matches)';
  return { content: [{ type: 'text', text }] };
}

// === RESOLVE ACTIONS ===
// Declarative named actions → concrete refs, or an explicit miss. Read-only:
// the caller still acts through computer/form_input with the returned refs.
async function handleResolveActions(tabId, args) {
  await ensureContentScripts(tabId);
  await ensureActionResolver(tabId);
  const r = await callContentScript(tabId,
    (spec) => globalThis.__ccActionResolver?.resolve(spec) || { error: 'action resolver not available' },
    [{ actions: args.actions || [] }]
  );
  if (r?.error) return { content: [{ type: 'text', text: String(r.error) }], isError: true };

  const lines = [
    `页面: ${r.title || ''} ${r.url || ''}`.trim(),
    `扫描: ${r.scanned} 个可见可交互元素`,
    ''
  ];
  if (r.truncated) {
    lines.push(`⚠️ 已达扫描上限（${r.scanned}），页面上还有未扫到的元素 —— 下面的 missing 可能是预算被吃掉，不一定是"页面上没有"`, '');
  }
  for (const a of r.results || []) {
    if (a.status === 'missing') {
      lines.push(`✗ ${a.name} — 未找到（0 个候选）`);
      continue;
    }
    if (a.status === 'error') {
      lines.push(`‼ ${a.name} — 参数有问题: ${a.error || '未知错误'}`);
      continue;
    }
    const mark = a.status === 'resolved' ? '✓' : '⚠';
    // Ambiguous results carry no chosen element, so the target part is omitted
    // rather than printed as three undefineds.
    let line = a.ref
      ? `${mark} ${a.name} → [${a.ref}] ${a.role} "${a.label}"`
      : `${mark} ${a.name}`;
    if (a.value != null) line += ` = "${a.value}"`;
    line += ` (${a.candidates} 个候选)`;
    if (a.status === 'ambiguous') line += ` — 无法唯一确定，请加 pick 或改用 read_page`;
    if (a.note) line += ` · ${a.note}`;
    lines.push(line);
    for (const alt of a.alternatives || []) lines.push(`      · [${alt.ref}] "${alt.label}"`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// === COMPUTER (click, type, key, screenshot, scroll, etc.) ===

// --- Post-action verification -------------------------------------------------
// Long-horizon agents fail by compounding unverified steps: a click that silently
// misses still "succeeds" and the next three actions build on a false premise.
// Every mutating action therefore reports whether the page actually moved.
const VERIFY_SETTLE_MS = 1200;
const VERIFY_POLL_MS = 150;
const VERIFY_ACTIONS = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key']);

async function getSignature(tabId) {
  try {
    await ensureContentScripts(tabId);
    const r = await callContentScript(tabId, () => globalThis.__ccAccessibilityTree?.signature() || null, []);
    if (r?.sig) return r;
  } catch {}
  // Content script unreachable (e.g. mid-navigation) — url/title still tell us a lot.
  try {
    const tab = await chrome.tabs.get(tabId);
    return { sig: null, url: tab.url || '', title: tab.title || '', count: 0, interactive: 0, truncated: false };
  } catch { return null; }
}

// Pages with live counters, video timers or rotating ads change on their own, which
// would make every action look successful. Sample twice to detect that, so we can
// say "can't tell" instead of falsely confirming.
async function getBaselineSignature(tabId) {
  const a = await getSignature(tabId);
  await sleep(180);
  const b = await getSignature(tabId);
  if (!b) return a;
  if (a?.sig && b.sig && a.sig !== b.sig) return { ...b, noisy: true };
  return b;
}

async function verifyAction(tabId, before) {
  if (!before) return null;
  const start = Date.now();
  let after = null;
  // 验证是锦上添花：剩余预算不够就别再烧，直接说「没验完」。
  let outOfBudget = false;
  while (Date.now() - start < VERIFY_SETTLE_MS) {
    if (remainingMs() <= 400) { outOfBudget = true; break; }
    await sleep(VERIFY_POLL_MS);
    after = await getSignature(tabId);
    if (after && (after.sig !== before.sig || after.url !== before.url || after.title !== before.title)) break;
  }
  const budgetNote = outOfBudget
    ? ' [verify] 剩余预算不足，验证提前结束——结论可能不准，别把它当证据。'
    : '';
  if (!after) return '[verify] Could not read page state after the action — the tab may have closed.';

  const urlChanged = after.url !== before.url;
  const titleChanged = after.title !== before.title;
  const domChanged = after.sig !== before.sig;

  if (!urlChanged && !titleChanged && !domChanged) {
    // The fingerprint stops counting past its cap on very dense pages, so a change
    // below that point would not show up here. Say that instead of letting "no
    // detectable change" read as proof the action missed.
    const cap = after.truncated
      ? ' The page is large enough that the DOM fingerprint stopped counting past its cap, so a change below that point would not register — re-read the page rather than assuming the action missed.'
      : '';
    return `[verify] ⚠️ No detectable change after ${Date.now() - start}ms. The click may have missed, hit a disabled or covered element, or the effect is visual-only. Re-read the page before the next step.${cap}${budgetNote}`;
  }

  const noise = before.noisy
    ? ' [note: page changes on its own, so this signal is unreliable here]'
    : '';

  const parts = [];
  if (urlChanged) parts.push(`url → ${after.url}`);
  if (titleChanged) parts.push(`title → "${after.title}"`);
  if (domChanged) parts.push(`DOM changed (elements ${before.count} → ${after.count}, interactive ${before.interactive} → ${after.interactive})`);

  let detail = '';
  const prev = state.snapshots.get(tabId);
  if (prev && domChanged) {
    try {
      await ensureContentScripts(tabId);
      const cur = await callContentScript(tabId,
        (filter, maxDepth, maxChars) => {
          const t = globalThis.__ccAccessibilityTree;
          return t ? t.generate(filter, maxDepth, maxChars, null, null) : { error: 'not available' };
        },
        ['interactive', 15, 50000]
      );
      if (cur?.tree && !cur.error) {
        const d = computeDiff(prev.tree, cur.tree, 25);
        if (d.total > 0) detail = '\n' + d.text;
        state.snapshots.set(tabId, { tree: cur.tree, ts: Date.now() });
      }
    } catch {}
  }

  return `[verify] ✓ Page changed: ${parts.join('; ')}.${noise}${detail}${budgetNote}`;
}

async function handleComputer(tabId, args) {
  const shouldVerify = args.verify !== false && VERIFY_ACTIONS.has(args.action);
  const before = shouldVerify ? await getBaselineSignature(tabId) : null;

  const result = await dispatchComputer(tabId, args);

  if (shouldVerify && !result.error) {
    const note = await verifyAction(tabId, before);
    const first = result.content?.[0];
    if (note && first?.type === 'text') first.text += `\n\n${note}`;
    else if (note) result.content = [{ type: 'text', text: note }, ...(result.content || [])];
  }
  return result;
}

async function dispatchComputer(tabId, args) {
  const act = args.action;
  if (['left_click','right_click','double_click','triple_click'].includes(act)) {
    return handleClick(tabId, { ...args, action: act === 'hover' ? 'left_click' : act });
  }
  if (act === 'hover') return handleHover(tabId, args);
  if (act === 'type') return handleType(tabId, args);
  if (act === 'key') return handleKey(tabId, args);
  if (act === 'screenshot') return takeScreenshot(tabId, args.quality || 'low');
  if (act === 'wait') {
    await sleep((args.duration || 1) * 1000);
    return { content: [{ type: 'text', text: `Waited ${args.duration || 1}s` }] };
  }
  if (act === 'scroll') { await handleScroll(tabId, args); return { content: [{ type: 'text', text: `Scrolled ${args.scroll_direction || 'down'}` }] }; }
  if (act === 'scroll_to') {
    await ensureContentScripts(tabId);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (ref) => {
        const el = globalThis.__ccAccessibilityTree?.getElementByRef(ref);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); return true; }
        return false;
      },
      args: [args.ref]
    });
    return { content: [{ type: 'text', text: r?.result ? 'Element scrolled into view' : 'Element not found' }] };
  }
  if (act === 'zoom') {
    const [x0, y0, x1, y1] = args.region || [0, 0, 500, 500];
    await ensureAttached(tabId);
    const data = (await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 60, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 1 },
      captureBeyondViewport: false, fromSurface: true
    })).data;
    return { content: [{ type: 'text', text: `Zoomed region (${x0},${y0})-(${x1},${y1})` }, { type: 'image', data, mimeType: 'image/jpeg' }] };
  }
  if (act === 'left_click_drag') {
    await ensureAttached(tabId);
    const [sx, sy] = args.start_coordinate || [0, 0];
    const [ex, ey] = args.coordinate || [0, 0];
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 });
    await sleep(50);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: ex, y: ey });
    await sleep(50);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1 });
    return { content: [{ type: 'text', text: `Dragged from (${sx},${sy}) to (${ex},${ey})` }] };
  }
  if (act === 'screenshot_element') return handleScreenshotElement(tabId, args);
  return { error: { code: 'BAD_REQUEST', message: `Unknown action: ${act}` } };
}

// Click
async function handleClick(tabId, args) {
  await ensureAttached(tabId);
  let x, y;
  if (args.ref) {
    await ensureContentScripts(tabId);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (ref) => globalThis.__ccAccessibilityTree?.getElementCoordinates(ref, { scrollIntoView: true }) || null,
      args: [args.ref]
    });
    if (!r?.result) return { error: { code: 'NOT_FOUND', message: `Element not found: ${args.ref}` } };
    x = r.result.x; y = r.result.y;
  } else if (args.coordinate) {
    [x, y] = args.coordinate;
    const ctx = state.screenshotContexts.get(tabId);
    if (ctx) {
      x = Math.round(x * ctx.viewportWidth / ctx.screenshotWidth);
      y = Math.round(y * ctx.viewportHeight / ctx.screenshotHeight);
    }
  } else {
    return { error: { code: 'BAD_REQUEST', message: 'Missing coordinate or ref' } };
  }

  const modifiers = parseModifiers(args.modifiers || '');
  const btn = args.action === 'right_click' ? 'right' : 'left';
  const clicks = { double_click: 2, triple_click: 3 }[args.action] || 1;

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers }); await sleep(50);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: btn, clickCount: clicks, modifiers }); await sleep(50);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: btn, clickCount: clicks, modifiers });
  if (args.action === 'right_click') await sleep(300);
  return { content: [{ type: 'text', text: `${args.action} at (${Math.round(x)},${Math.round(y)})` }] };
}

// Hover — mouseMoved only, no press/release
async function handleHover(tabId, args) {
  await ensureAttached(tabId);
  let x, y;
  if (args.ref) {
    await ensureContentScripts(tabId);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (ref) => globalThis.__ccAccessibilityTree?.getElementCoordinates(ref, { scrollIntoView: true }) || null,
      args: [args.ref]
    });
    if (!r?.result) return { error: { code: 'NOT_FOUND', message: `Element not found: ${args.ref}` } };
    x = r.result.x; y = r.result.y;
  } else if (args.coordinate) {
    [x, y] = args.coordinate;
  } else {
    return { error: { code: 'BAD_REQUEST', message: 'Missing coordinate or ref for hover' } };
  }
  const modifiers = parseModifiers(args.modifiers || '');
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  return { content: [{ type: 'text', text: `Hovered at (${Math.round(x)},${Math.round(y)})` }] };
}

// Type — batches contiguous text runs into a single Input.insertText call.
// Per-character dispatchKeyEvent was ~3 CDP calls + 20ms per char; insertText
// does the whole run in one call (~10× faster) and handles CJK/IME reliably.
async function handleType(tabId, args) {
  await ensureAttached(tabId);
  const text = args.text || '';
  if (!text) return { content: [{ type: 'text', text: 'Typed 0 characters' }] };

  // Split into runs: newline/tab stay real key events, everything else batches.
  // Regular runs never contain '\n' or '\t', so those chars act as safe sentinels.
  const runs = [];
  let run = '';
  for (const ch of text) {
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      if (run) { runs.push(run); run = ''; }
      runs.push(ch === '\t' ? '\t' : '\n');
    } else {
      run += ch;
    }
  }
  if (run) runs.push(run);

  let typed = 0;
  for (const r of runs) {
    if (state.stopRequested) break;
    if (remainingMs() <= 500) {
      return { error: { code: 'DEADLINE_EXCEEDED', stage: 'executing', message: `打到 ${typed}/${text.length} 个字符时预算用完。已输入的部分留在页面上，不要盲目重打整个字符串。` } };
    }
    if (r === '\n') { await keyEventSimple(tabId, 'Enter', 13); }
    else if (r === '\t') { await keyEventSimple(tabId, 'Tab', 9); }
    else { await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: r }); }
    typed += r.length;
    await sleep(5);
  }
  return { content: [{ type: 'text', text: `Typed ${typed} characters` }] };
}

async function keyEventSimple(tabId, key, vk) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

// Key combos
async function handleKey(tabId, args) {
  await ensureAttached(tabId);
  const raw = (args.text || '').toLowerCase();
  if (raw === 'cmd+r' || raw === 'ctrl+r' || raw === 'f5') {
    await chrome.tabs.reload(tabId);
    return { content: [{ type: 'text', text: 'Page reloaded' }] };
  }
  const parts = raw.split('+').map(p => p.trim());
  const modifiers = parseModifiers(parts.slice(0, -1).join('+'));
  const key = KEY_ALIASES[parts.at(-1)] || parts.at(-1);
  const vk = VK_MAP[key] || null;
  for (let i = 0; i < Math.min(args.repeat || 1, 100); i++) {
    const base = { key, modifiers, ...(vk && { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }) };
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }
  return { content: [{ type: 'text', text: `Pressed key: ${args.text}` }] };
}

const KEY_ALIASES = { return:'Enter', enter:'Enter', ctrl:'Control', control:'Control', alt:'Alt', shift:'Shift', cmd:'Meta', command:'Meta', meta:'Meta', esc:'Escape', escape:'Escape', tab:'Tab', backspace:'Backspace', del:'Delete', delete:'Delete', space:' ', up:'ArrowUp', down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight' };
const VK_MAP = { Enter:13, Escape:27, Tab:9, Backspace:8, Delete:46, Insert:45, ' ':32, Control:17, Alt:18, Shift:16, Meta:91, ArrowUp:38, ArrowDown:40, ArrowLeft:37, ArrowRight:39, Home:36, End:35, PageUp:33, PageDown:34 };

function parseModifiers(s) {
  return (s || '').toLowerCase().split('+').reduce((m, p) => m | ({ alt:1, ctrl:2, control:2, meta:4, cmd:4, command:4, shift:8 }[p.trim()] || 0), 0);
}

// Screenshot element by ref — crops to element bounding box with padding
async function handleScreenshotElement(tabId, args) {
  await ensureAttached(tabId);
  // Clear any stale Emulation override so coordinates match the real viewport
  try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch {}

  await ensureContentScripts(tabId);
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref) => {
      const coords = globalThis.__ccAccessibilityTree?.getElementCoordinates(ref, { scrollIntoView: true });
      return coords || null;
    },
    args: [args.ref]
  });

  if (!r?.result) return { error: { code: 'NOT_FOUND', message: `Element not found: ${args.ref}` } };

  const cx = r.result.x, cy = r.result.y, w = r.result.width, h = r.result.height;
  const pad = Math.max(10, Math.min(w, h) * 0.1);
  const clip = {
    x: Math.max(0, cx - w / 2 - pad),
    y: Math.max(0, cy - h / 2 - pad),
    width: w + pad * 2,
    height: h + pad * 2,
    scale: 1
  };

  const data = (await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
    format: 'jpeg', quality: 60, clip, captureBeyondViewport: false, fromSurface: true
  })).data;

  return { content: [
    { type: 'text', text: `Element screenshot: ${args.ref} (${Math.round(w)}×${Math.round(h)}px)` },
    { type: 'image', data, mimeType: 'image/jpeg' }
  ]};
}

// Screenshot
async function takeScreenshot(tabId, quality = 'low') {
  await ensureAttached(tabId);
  let vp = { w: 1280, h: 720, dpr: 1 };
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 })
    });
    if (r?.result) vp = r.result;
  } catch {}
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');

  // Scale down viewport for performance on high-DPI displays
  const MAX_WIDTH = 1280;
  if (vp.w > MAX_WIDTH) {
    const scale = MAX_WIDTH / vp.w;
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width: MAX_WIDTH, height: Math.round(vp.h * scale), deviceScaleFactor: 1,
      mobile: false, screenWidth: MAX_WIDTH, screenHeight: Math.round(vp.h * scale),
      positionX: 0, positionY: 0
    });
  }

  const tiers = {
    low: { maxLen: 27000, q: 20, minQ: 5 },
    medium: { maxLen: 270000, q: 40, minQ: 10 },
    high: { maxLen: 670000, q: 60, minQ: 20 }
  };
  const tier = tiers[quality] || tiers.low;
  let q = tier.q, data;
  do {
    data = (await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'jpeg', quality: q, captureBeyondViewport: false, fromSurface: true
    })).data;
    q -= 5;
  } while (data.length > tier.maxLen && q > tier.minQ);

  // Restore viewport after scaled-down screenshot
  if (vp.w > MAX_WIDTH) {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
  }

  state.screenshotContexts.set(tabId, {
    viewportWidth: vp.w, viewportHeight: vp.h,
    screenshotWidth: Math.min(vp.w, MAX_WIDTH), screenshotHeight: Math.round(vp.h * (vp.w > MAX_WIDTH ? MAX_WIDTH / vp.w : 1)),
    devicePixelRatio: vp.dpr
  });
  return { content: [{ type: 'text', text: `Screenshot (${vp.w}x${vp.h}, ${quality} quality)` }, { type: 'image', data, mimeType: 'image/jpeg' }] };
}

// Scroll
async function handleScroll(tabId, args) {
  await ensureAttached(tabId);
  const dir = args.scroll_direction || 'down';
  const amt = args.scroll_amount || 1;
  const vp = state.screenshotContexts.get(tabId) || { viewportWidth: 1280, viewportHeight: 720 };
  const x = vp.viewportWidth / 2, y = vp.viewportHeight / 2;
  const deltas = { up: [0, -100 * amt], down: [0, 100 * amt], left: [-100 * amt, 0], right: [100 * amt, 0] }[dir];
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: deltas[0], deltaY: deltas[1]
  });
}

// === FORM INPUT ===
async function handleFormInput(tabId, args) {
  await ensureContentScripts(tabId);

  async function fillOne(ref, value) {
    if (!ref) return { ok: false, msg: '(skipped: missing ref)' };
    const r = await callContentScript(tabId,
      (ref, value) => {
        const bridge = globalThis.__ccBridge;
        return bridge ? bridge.fillForm(ref, value) : { success: false, error: 'not available' };
      },
      [ref, value]
    );
    // file input → CDP upload path (JS can't set value on file inputs)
    if (r?.fileInput) {
      const u = await handleFileUpload(tabId, ref, value);
      return u.success
        ? { ok: true, msg: `${ref} (file): ${value}` }
        : { ok: false, msg: `${ref} (file): ${u.error || 'upload failed'}` };
    }
    if (r?.success) return { ok: true, msg: `${r.fieldName}: OK` };
    return { ok: false, msg: `${ref}: ${r?.error || 'failed'}` };
  }

  // Batch mode: fill multiple fields in one call
  if (args.fields && Array.isArray(args.fields)) {
    const results = [];
    for (const f of args.fields) {
      try { results.push((await fillOne(f.ref, f.value)).msg); }
      catch (e) { results.push(`${f.ref}: ${e.message}`); }
    }
    return { content: [{ type: 'text', text: results.join('\n') }] };
  }

  // Single mode (backward compatible)
  if (!args.ref) return { error: { code: 'BAD_REQUEST', message: 'Missing ref for single mode (use fields array for batch)' } };
  let out;
  try { out = await fillOne(args.ref, args.value); }
  catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }
  return out.ok
    ? { content: [{ type: 'text', text: out.msg }] }
    : { content: [{ type: 'text', text: out.msg }], isError: true };
}

// File upload — CDP DOM.setFileInputFiles feeds a local path to a file input.
// JS cannot set <input type=file> value directly (browser security); this
// bypasses that and fires the native input/change events the page expects.
async function handleFileUpload(tabId, ref, value) {
  await ensureAttached(tabId);
  const path = String(value);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
    const { root } = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 1, pierce: true });
    let target = null; // { nodeId } or { backendNodeId }

    // Prefer the exact element via its ref coordinates when it's visible.
    const [vis] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (r) => {
        const el = globalThis.__ccAccessibilityTree?.getElementByRef(r);
        if (!el) return null;
        return { visible: el.offsetWidth > 0 && el.offsetHeight > 0 };
      },
      args: [ref]
    });
    if (vis?.result?.visible) {
      const [coord] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (r) => globalThis.__ccAccessibilityTree?.getElementCoordinates(r, { scrollIntoView: true }) || null,
        args: [ref]
      });
      if (coord?.result) {
        const byLoc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getNodeForLocation', {
          x: Math.round(coord.result.x), y: Math.round(coord.result.y)
        });
        if (byLoc.nodeId) target = { nodeId: byLoc.nodeId };
        else if (byLoc.backendNodeId) target = { backendNodeId: byLoc.backendNodeId };
      }
    }

    // Hidden inputs (styled upload buttons) have no rect — fall back to first file input.
    if (!target) {
      const qr = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
        nodeId: root.nodeId, selector: 'input[type="file"]'
      });
      if (qr.nodeId) target = { nodeId: qr.nodeId };
    }

    if (!target) return { success: false, error: 'File input not found' };
    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { ...target, files: [path] });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

// === GET PAGE TEXT ===
async function handleGetPageText(tabId, args) {
  await ensureContentScripts(tabId);
  const r = await callContentScript(tabId,
    (max) => globalThis.__ccBridge?.getPageText(max) || { error: 'not available' },
    [args.max_chars || 50000]
  );
  if (r?.error) return { content: [{ type: 'text', text: r.error }], isError: true };
  return { content: [{ type: 'text', text: `Title: ${r.title || 'N/A'}\nURL: ${r.url || 'N/A'}\nSource: ${r.sourceElement || 'body'}\n\n${r.content || '(empty)'}` }] };
}

// === GET PAGE MARKDOWN ===
async function handleGetPageMarkdown(tabId, args) {
  await ensureContentScripts(tabId);
  const r = await callContentScript(tabId,
    (max) => {
      const c = globalThis.__ccAutoCapture;
      return c ? { md: c.generateMarkdown(max), title: document.title, url: location.href } : { error: 'not available' };
    },
    [args.max_chars || 50000]
  );
  if (r?.error) return { content: [{ type: 'text', text: r.error }], isError: true };
  return { content: [{ type: 'text', text: `Title: ${r.title || 'N/A'}\nURL: ${r.url || 'N/A'}\n\n${r.md || '(no structured content — try get_page_text)'}` }] };
}

// === JAVASCRIPT TOOL ===
// 先只解析、不执行，决定用户给的是表达式还是语句序列。
// 为什么非要有这一步：语句序列直接塞进 `await (...)` 会让**整个** payload 解析失败，
// 页面内的 try/catch 救不了它（解析先于执行），语句形态就废了。compileScript 只编译
// 不执行，毫秒级，而且语法错误意味着什么都没跑，不会重复劳动。
// 注意它把编译失败报在**结果里**（`exceptionDetails`），不是靠 reject —— 这一点是在真机上
// 才发现的：早先只判 reject 的版本把语句序列误判成表达式，直接报 "Unexpected token 'const'"。
async function detectJsForm(tabId, code) {
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.compileScript', {
      expression: `(${code})`, sourceURL: '', persistScript: false
    });
    return formFromProbe({ result });
  } catch (e) {
    return formFromProbe({ error: e.message });
  }
}

// 只有一条路径：CDP Runtime.evaluate。旧实现在它前面还有一条 chrome.scripting
// 快路径，但那条要在隔离世界里 eval，而 MV3 的 CSP 拦得住——实测它一次都没执行
// 成功过，异常被 `catch {}` 吞掉，反而成了「失败静默」加「失败时跑两遍」的来源。
// 删掉比修好划算。现在：成功返回数据，失败返回错误，超预算返回 JS_DEADLINE，
// 而且**恰好执行一次**。
async function handleJavaScript(tabId, args) {
  await ensureAttached(tabId);
  const code = args.text || '';
  if (code.length > 100000) return { error: { code: 'CODE_TOO_LONG', message: `Code exceeds 100K limit (${code.length} chars)` } };

  const budget = budgetForJavaScript(remainingMs());

  const evaluate = async (form) => {
    try {
      return await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: buildEvaluateExpression(code, budget, form),
        returnByValue: true,
        awaitPromise: true,
        // CDP 自带的超时（Experimental）：页面里那层 race 是主力，这个只是兜底，
        // 所以多给 1s 让 race 先说话。
        timeout: budget + 1000
      });
    } catch (e) {
      if (/terminat|timeout/i.test(e.message || '')) return { cdpDeadline: true };
      throw e;
    }
  };

  let form = await detectJsForm(tabId, code);
  let r = await evaluate(form);

  // 这里的 exceptionDetails 只可能是「payload 自己没解析过」：用户代码的错误（包括运行时
  // 的 SyntaxError）都在 payload 的 try/catch 里变成了返回值，不会冒到这里来。也就是说
  // 这不是表达式 → 换语句形态重跑一次。**解析失败意味着刚才什么都没执行**，所以这样仍然
  // 恰好执行一次。这层兜的是探测失效（方法不存在、老版本浏览器），不是主路径。
  if (r?.exceptionDetails && form === 'expression') {
    log('javascript_tool: 表达式形态没解析过，按语句序列重试');
    form = 'statements';
    r = await evaluate(form);
  }

  if (r?.cdpDeadline) {
    return { error: { code: 'JS_DEADLINE', message: `CDP 在 ${budget + 1000}ms 处终止了这次执行。页面里没干完的活仍在继续，长循环请拆成多次调用。` } };
  }
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS error';
    return { error: { code: 'JS_ERROR', message: String(d).slice(0, 4000) } };
  }

  const c = classifyJsResult(r?.result?.value);
  if (c.kind === 'deadline') {
    return { error: { code: 'JS_DEADLINE', message: `页面内已跑满 ${c.ranMs}ms 仍未结束，按预算返回。那段活**仍在页面里继续**（CDP 取消不了一个正在 await 的循环），所以不要紧接着发一个会跟它打架的调用；长循环拆成多次调用，状态挂在 window 上，下次接着做。` } };
  }
  if (c.kind === 'error') {
    return { error: { code: 'JS_ERROR', message: String(c.message).slice(0, 4000) } };
  }

  let out = formatValue(c.value);
  if (out.length > 50000) out = out.slice(0, 50000) + '\n... [OUTPUT TRUNCATED]';
  return { content: [{ type: 'text', text: out }] };
}

function formatValue(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// === TABS ===
async function handleTabsContext(_tabId, _args) {
  const tabs = await chrome.tabs.query({});
  const lines = tabs.map(t => `[${t.id}] ${t.active ? '★ ' : ''}${t.title || t.url || 'N/A'} — ${t.url || ''}`);
  return { content: [{ type: 'text', text: `Open tabs:\n${lines.join('\n')}` }] };
}

async function handleTabsCreate(_tabId, _args) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  // Mark as automation tab so Agent can distinguish from user tabs in tabs_context
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { document.title = '[AI] ' + (document.title || 'New Tab'); }
    });
  } catch {}
  return { content: [{ type: 'text', text: `Created tab #${tab.id}` }] };
}

// === CONSOLE & NETWORK ===
async function handleReadConsole(tabId, args) {
  await ensureAttached(tabId);
  initTabBuffer(tabId);
  let entries = state.tabEventBuffers.get(tabId).console;

  if (args.onlyErrors) entries = entries.filter(e => e.type === 'error');
  if (args.pattern) {
    try {
      const re = new RegExp(args.pattern, 'i');
      entries = entries.filter(e => re.test(e.text));
    } catch {
      return { error: { code: 'BAD_REQUEST', message: 'Invalid regex pattern' } };
    }
  }
  if (args.limit) entries = entries.slice(-args.limit);
  if (args.clear) state.tabEventBuffers.get(tabId).console = [];

  const text = entries.map(e => `[${e.type}] ${e.text}`).join('\n') || '(no console messages)';
  return { content: [{ type: 'text', text }] };
}

async function handleReadNetwork(tabId, args) {
  await ensureAttached(tabId);
  initTabBuffer(tabId);
  let entries = state.tabEventBuffers.get(tabId).network;

  if (args.urlPattern) {
    try {
      const re = new RegExp(args.urlPattern, 'i');
      entries = entries.filter(e => re.test(e.url));
    } catch {
      return { error: { code: 'BAD_REQUEST', message: 'Invalid regex pattern' } };
    }
  }
  if (args.limit) entries = entries.slice(-args.limit);
  if (args.clear) state.tabEventBuffers.get(tabId).network = [];

  const text = entries.map(e => {
    if (e.status) return `[${e.status}] ${e.url}`;
    return `[→ ${e.method}] ${e.url}`;
  }).join('\n') || '(no network requests)';
  return { content: [{ type: 'text', text }] };
}

// === DISMISS DIALOG ===
async function handleDismissDialog(tabId, args) {
  await ensureAttached(tabId);
  const accept = args.action !== 'dismiss';
  const promptText = args.promptText || '';
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
      accept,
      promptText
    });
    state.pendingDialogs.delete(tabId);
    return { content: [{ type: 'text', text: `Dialog ${accept ? 'accepted' : 'dismissed'}` }] };
  } catch (e) {
    return { error: { code: 'NO_DIALOG', message: e.message } };
  }
}

// === WAIT FOR ELEMENT / TEXT ===
async function handleWaitFor(tabId, args) {
  await ensureContentScripts(tabId);
  // server 给 wait_for 的预算 = args.timeout + 5s，所以正常情况下这里等于 args.timeout；
  // 真正在削它的是「前面排队排掉的时间」。
  const timeout = Math.max(300, Math.min(args.timeout || 10000, remainingMs() - 500));
  const selector = args.selector || null;
  const text = args.text || null;

  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, txt, ms) => {
      return new Promise((resolve) => {
        const started = Date.now();
        function poll() {
          if (!document.body) { setTimeout(poll, 100); return; }
          let found = false;
          if (sel) {
            const el = document.querySelector(sel);
            if (el && (el.checkVisibility?.({checkOpacity: true}) ?? (el.offsetParent !== null || el.tagName === 'BODY'))) {
              found = true;
            }
          } else if (txt) {
            if (document.body.innerText.includes(txt)) found = true;
          }
          if (found) {
            resolve({ found: true, elapsed: Date.now() - started });
          } else if (Date.now() - started > ms) {
            resolve({ found: false, elapsed: ms });
          } else {
            setTimeout(poll, 300);
          }
        }
        poll();
      });
    },
    args: [selector, text, timeout]
  });

  if (r?.result?.found) {
    return { content: [{ type: 'text', text: `Found after ${r.result.elapsed}ms` }] };
  }
  const target = selector || `"${text}"`;
  return { content: [{ type: 'text', text: `Timeout after ${timeout}ms waiting for ${target}` }], isError: true };
}

// === HEALTH CHECK ===
// Walks the chain hop by hop. `claude mcp list` probes a fresh process and can
// report "Connected" while this session's extension link is dead — this does not.
// Not every page accepts injection (Edge's new-tab page, the extensions gallery).
// Probing one of those says nothing about whether the chain works, so we look for
// a scriptable tab instead of reporting a false failure.
function isScriptable(url) {
  if (!url) return false;
  if (BLOCKED_URLS.some(p => url.startsWith(p))) return false;
  if (/^https?:\/\/ntp\.msn\.com\/edge\/ntp/.test(url)) return false;
  if (/^https?:\/\/[^/]*newtab/.test(url)) return false;
  return /^https?:/.test(url);
}

async function handleHealth(_tabId, _args) {
  const lines = [];
  lines.push(`Extension uptime: ${Math.round((Date.now() - state.startedAt) / 1000)}s`);
  lines.push(`Hop 1 · extension → MCP server WebSocket: ${state.connected ? `OK (port ${state.wsPort})` : 'DISCONNECTED'}`);
  lines.push(`CDP sessions held: ${state.attachedTabs.size ? [...state.attachedTabs].join(', ') : 'none'}`);
  if (state.commandQueue.length) {
    lines.push(`⚠️ Command queue backlog: ${state.commandQueue.length} waiting — a prior tool call may be stuck`);
  }

  let tab = null;
  try {
    const active = await chrome.tabs.get(await getActiveTabId());
    tab = active;
    if (!isScriptable(active.url)) {
      const all = await chrome.tabs.query({});
      const alt = all.find(t => t.id !== active.id && isScriptable(t.url));
      if (alt) {
        tab = alt;
        lines.push(`Hop 2 · active tab [#${active.id}] is not scriptable — probed [#${alt.id}] instead`);
      } else {
        tab = null;
        lines.push(`Hop 2 · active tab [#${active.id}] is not scriptable and no other http(s) tab is open — cannot probe further`);
      }
    }
  } catch (e) {
    lines.push(`Hop 2 · active tab: FAILED (${e.message})`);
  }
  if (tab) lines.push(`Hop 2 · probed tab: OK — [#${tab.id}] ${tab.title || '(no title)'} — ${tab.url || ''}`);

  if (tab) {
    try {
      await ensureContentScripts(tab.id);
      const r = await callContentScript(tab.id, () => ({
        title: document.title,
        ready: document.readyState,
        treeReady: !!globalThis.__ccAccessibilityTree
      }), []);
      lines.push(r?.treeReady
        ? `Hop 3 · content script: OK (readyState=${r.ready}, title="${String(r.title).slice(0, 60)}")`
        : 'Hop 3 · content script: FAILED (injected but __ccAccessibilityTree missing)');
    } catch (e) {
      lines.push(`Hop 3 · content script: FAILED (${e.message})`);
    }

    if (state.attachedTabs.has(tab.id)) {
      try {
        const r = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', { expression: '1+1', returnByValue: true });
        lines.push(r?.result?.value === 2 ? 'Hop 4 · CDP: OK' : 'Hop 4 · CDP: unexpected result');
      } catch (e) {
        lines.push(`Hop 4 · CDP: FAILED (${e.message})`);
      }
    } else {
      lines.push('Hop 4 · CDP: not attached to this tab yet (attaches on first use — not probed to avoid the debugger banner)');
    }
  }

  if (state.pendingDialogs.size) {
    lines.push(`⚠️ Native dialog open on tab(s): ${[...state.pendingDialogs.keys()].join(', ')}`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// === TOOL HANDLERS ===
const TOOL_HANDLERS = {
  navigate: handleNavigate,
  read_page: handleReadPage,
  find: handleFind,
  resolve_actions: handleResolveActions,
  computer: handleComputer,
  form_input: handleFormInput,
  wait_for: handleWaitFor,
  dismiss_dialog: handleDismissDialog,
  get_page_text: handleGetPageText,
  get_page_markdown: handleGetPageMarkdown,
  javascript_tool: handleJavaScript,
  tabs_context: handleTabsContext,
  tabs_create: handleTabsCreate,
  read_console_messages: handleReadConsole,
  read_network_requests: handleReadNetwork,
  health_check: handleHealth,
};

// === POPUP MESSAGES ===
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'POPUP_GET_STATUS') {
    sendResponse({ relayConnected: state.connected, port: state.wsPort });
    return true;
  }
  if (msg.type === 'RECONNECT') {
    state.wsPort = msg.port;
    if (state.ws) try { state.ws.close(); } catch {}
    connectToMcpServer(msg.port);
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === 'DISCONNECT_TAB') {
    // Detach all CDP sessions
    for (const tabId of state.attachedTabs) {
      try { chrome.debugger.detach({ tabId }); } catch {}
    }
    state.attachedTabs.clear();
    state.enabledDomains.clear();
    state.screenshotContexts.clear();
    state.tabEventBuffers.clear();
    state.pendingDialogs.clear();
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === 'STOP_TOOL_EXECUTION') {
    // Answer the callers whose work is being dropped, instead of leaving them to
    // time out at the transport layer 30s later.
    for (const item of state.commandQueue) {
      sendResponse(item.messageId, null, { code: 'STOPPED', message: 'Stopped by user before this call ran' });
    }
    state.commandQueue = [];
    // The flag only means "abort what is running right now". With nothing in
    // flight there is no one to clear it later, and leaving it set made every
    // subsequent call queue up and never run until the extension was reloaded.
    if (state.queueRunning) state.stopRequested = true;
    sendResponse({ success: true });
    return true;
  }
  return false;
});

// === INIT ===
async function init() {
  // Restore port from storage
  const stored = await chrome.storage.local.get(['wsPort']);
  if (stored.wsPort) state.wsPort = stored.wsPort;

  connectToMcpServer(state.wsPort);

  // Restore tab state from session storage (MV3 SW recovery)
  try {
    const session = await chrome.storage.session.get(['persistedTabs']);
    if (session.persistedTabs && Array.isArray(session.persistedTabs)) {
      for (const t of session.persistedTabs) {
        try {
          await chrome.tabs.get(t.tabId);
          try { await ensureAttached(t.tabId); }
          catch { /* tab may no longer be available for debugger */ }
          // Restore event buffers from persisted state
          if (t.consoleEvents?.length || t.networkEvents?.length) {
            const buf = state.tabEventBuffers.get(t.tabId);
            if (buf) {
              if (t.consoleEvents) buf.console.push(...t.consoleEvents);
              if (t.networkEvents) buf.network.push(...t.networkEvents);
            }
          }
        } catch { /* tab closed */ }
      }
    }
  } catch {}
}

// Persist tab state periodically
setInterval(async () => {
  if (state.attachedTabs.size > 0) {
    const persisted = Array.from(state.attachedTabs).map(tabId => {
      const buf = state.tabEventBuffers.get(tabId);
      return {
        tabId,
        consoleCount: buf?.console.length || 0,
        // Keep last 50 events for SW recovery (strip timestamps to save space)
        consoleEvents: buf?.console.slice(-50) || [],
        networkEvents: buf?.network.slice(-50) || [],
      };
    });
    await chrome.storage.session.set({ persistedTabs: persisted });
  }
}, 15000);

init();
log('Claude Code Browser Extension started');
