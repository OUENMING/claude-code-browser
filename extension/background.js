// === STATE ===
const state = {
  ws: null, connected: false, wsPort: 19222,
  reconnectAttempt: 0, reconnectTimer: null,
  keepAliveTimer: null,
  attachedTabs: new Set(), enabledDomains: new Set(),
  commandQueue: [], queueRunning: false, stopRequested: false,
  screenshotContexts: new Map(),
  tabEventBuffers: new Map(),
  pendingDialogs: new Map(),   // tabId -> {type, message, defaultPrompt}
};

function initTabBuffer(tabId) {
  if (!state.tabEventBuffers.has(tabId)) {
    state.tabEventBuffers.set(tabId, { console: [], network: [] });
  }
}

const BLOCKED_URLS = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://', 'view-source:'];
const TOOL_DEFINITIONS = [
  { name: 'navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'number' } }, required: ['url'] }, description: '导航到指定 URL，支持 "back"/"forward" 前进后退。' },
  { name: 'read_page', inputSchema: { type: 'object', properties: { filter: { type: 'string', enum: ['interactive', 'all'] }, depth: { type: 'integer', minimum: 1, maximum: 30 }, max_chars: { type: 'integer', minimum: 1000, maximum: 200000 }, ref_id: { type: 'string' }, tabId: { type: 'number' } } }, description: '获取页面可访问性元素树，带 ref ID。filter="interactive" 仅交互元素（省 token），"all" 全部元素。' },
  { name: 'find', inputSchema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 100 }, tabId: { type: 'number' } }, required: ['query'] }, description: '按关键词搜索元素，匹配 text/aria-label/title/role，返回 ref 列表供 computer/form_input 使用。' },
  { name: 'wait_for', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'integer', minimum: 500, maximum: 30000 }, tabId: { type: 'number' } } }, description: '等待元素或文本出现。selector 按 CSS 匹配可见元素，text 按页面文本匹配。默认超时 10s，300ms 轮询。navigate 后页面加载中自动等待 body 出现。' },
  { name: 'dismiss_dialog', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['accept', 'dismiss'] }, promptText: { type: 'string' }, tabId: { type: 'number' } }, required: ['action'] }, description: '关闭浏览器原生对话框（alert/confirm/prompt/beforeunload）。action="accept" 确认，"dismiss" 取消。prompt 类型用 promptText 填入文本。' },
  { name: 'computer', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['left_click','right_click','double_click','triple_click','type','screenshot','screenshot_element','wait','scroll','scroll_to','key','left_click_drag','hover','zoom'] }, coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, start_coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, ref: { type: 'string' }, text: { type: 'string' }, scroll_direction: { type: 'string', enum: ['up','down','left','right'] }, scroll_amount: { type: 'number', minimum: 1, maximum: 10 }, quality: { type: 'string', enum: ['low','medium','high'] }, duration: { type: 'number', minimum: 0, maximum: 10 }, region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, modifiers: { type: 'string' }, repeat: { type: 'number', minimum: 1, maximum: 100 }, tabId: { type: 'number' } }, required: ['action'] }, description: '鼠标/键盘/截图交互。ref 精确定位（来自 read_page），coordinate 像素坐标。type 逐字符输入带 20ms 延迟模拟人类。' },
  { name: 'form_input', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: ['string','boolean','number'] }, fields: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, value: { type: ['string','boolean','number'] } }, required: ['ref','value'] } }, tabId: { type: 'number' } } }, description: '设置表单字段值（单个或批量）。单字段用 ref+value，批量用 fields: [{ref, value}, ...]。React/Vue 受控组件兼容。' },
  { name: 'get_page_text', inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 1000, maximum: 200000 }, tabId: { type: 'number' } } }, description: '提取页面全部纯文本（textContent）。最完整，不会漏内容，但丢失结构。适合社交媒体、复杂 SPA。' },
  { name: 'get_page_markdown', inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 1000, maximum: 200000 }, tabId: { type: 'number' } } }, description: '提取页面为结构化 Markdown — 标题(#)、链接、代码块、表格、图片。过滤 <50px 装饰图标。适合博客、文档、产品页。漏内容时回退到 get_page_text。' },
  { name: 'javascript_tool', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, tabId: { type: 'number' } }, required: ['text'] }, description: '在当前页面执行 JavaScript。⚠️ 不要用它提取密码/token/敏感数据。' },
  { name: 'tabs_context', inputSchema: { type: 'object', properties: {} }, description: '列出所有打开的标签页。' },
  { name: 'tabs_create', inputSchema: { type: 'object', properties: {} }, description: '创建新的空白标签页。' },
  { name: 'read_console_messages', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, onlyErrors: { type: 'boolean' }, pattern: { type: 'string' }, clear: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['tabId'] }, description: '读取浏览器控制台消息。' },
  { name: 'read_network_requests', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, urlPattern: { type: 'string' }, clear: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['tabId'] }, description: '读取 HTTP 网络请求。' },
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
        if (msg.type === 'tool_call') { enqueueToolCall(msg.id, msg.tool, msg.args || {}); return; }
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
function enqueueToolCall(messageId, toolName, args) {
  state.commandQueue.push({ messageId, toolName, args });
  processQueue();
}

async function processQueue() {
  if (state.queueRunning) return;
  state.queueRunning = true;
  while (state.commandQueue.length > 0 && !state.stopRequested) {
    const item = state.commandQueue.shift();
    const start = performance.now();
    try {
      log('Executing tool:', item.toolName);
      const result = await executeTool(item.toolName, item.args);
      if (result?.error) {
        sendResponse(item.messageId, null, result.error);
      } else {
        sendResponse(item.messageId, result, null);
      }
    } catch (e) {
      log('Tool error:', item.toolName, e.message);
      sendResponse(item.messageId, null, { code: 'INTERNAL_ERROR', message: e.message });
    }
    const elapsed = performance.now() - start;
    if (elapsed > 5000) log(`Slow tool: ${item.toolName} took ${Math.round(elapsed)}ms`);
  }
  state.queueRunning = false;
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
});

chrome.debugger.onDetach.addListener((s) => {
  if (s.tabId) {
    state.attachedTabs.delete(s.tabId);
    state.enabledDomains.delete(s.tabId);
    state.screenshotContexts.delete(s.tabId);
    state.tabEventBuffers.delete(s.tabId);
    state.pendingDialogs.delete(s.tabId);
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

async function ensureContentScripts(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!(globalThis.__ccAccessibilityTree && globalThis.__ccBridge && globalThis.__ccAutoCapture)
    });
    if (r?.result === true) return;
  } catch {}
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      'content-scripts/accessibility-tree.js',
      'content-scripts/page-bridge.js',
      'content-scripts/auto-capture.js',
      'content-scripts/visual-indicator.js'
    ]
  });
}

// === TOOL ROUTING ===
async function executeTool(toolName, args) {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) return { error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}` } };
  let tabId = args?.tabId;
  if (!tabId && !['tabs_context', 'tabs_create'].includes(toolName)) {
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
  for (const start = Date.now(); Date.now() - start < ms;) {
    try { if ((await chrome.tabs.get(tabId)).status === 'complete') return true; } catch { return false; }
    await sleep(100);
  }
  return false;
}

// === READ PAGE ===
async function handleReadPage(tabId, args) {
  await ensureContentScripts(tabId);
  const r = await callContentScript(tabId,
    (filter, maxDepth, maxChars, refId) => {
      const tree = globalThis.__ccAccessibilityTree;
      if (!tree) return { error: 'not available' };
      const result = tree.generate(filter || 'interactive', maxDepth, maxChars || 50000, refId || null);
      result.readyState = document.readyState;
      return result;
    },
    [args.filter || 'interactive', args.depth ?? 15, args.max_chars || 50000, args.ref_id || null]
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

  return { content: [{ type: 'text', text: dialogWarn + stateHeader + ts + diagnostics + r.tree }] };
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

// === COMPUTER (click, type, key, screenshot, scroll, etc.) ===
async function handleComputer(tabId, args) {
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

// Type
async function handleType(tabId, args) {
  await ensureAttached(tabId);
  const text = args.text || '';
  if (/[^\x00-\x7F]/.test(text)) {
    for (const ch of text) {
      if (state.stopRequested) break;
      if (ch === '\n' || ch === '\r') { await keyEventSimple(tabId, 'Enter', 13); }
      else if (ch === '\t') { await keyEventSimple(tabId, 'Tab', 9); }
      else { await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: ch }); }
      await sleep(10 + Math.random() * 20);
    }
    return { content: [{ type: 'text', text: `Typed ${text.length} characters (mixed charset)` }] };
  }
  for (const ch of text) {
    if (state.stopRequested) break;
    if (ch === '\t') { await keyEventSimple(tabId, 'Tab', 9); }
    else if (ch === '\n' || ch === '\r') { await keyEventSimple(tabId, 'Enter', 13); }
    else {
      const code = ch.charCodeAt(0);
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    }
    await sleep(20);
  }
  return { content: [{ type: 'text', text: `Typed ${text.length} characters` }] };
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

  // Batch mode: fill multiple fields in one call
  if (args.fields && Array.isArray(args.fields)) {
    const results = [];
    for (const f of args.fields) {
      if (!f.ref) { results.push('(skipped: missing ref)'); continue; }
      try {
        const r = await callContentScript(tabId,
          (ref, value) => {
            const bridge = globalThis.__ccBridge;
            return bridge ? bridge.fillForm(ref, value) : { success: false, error: 'not available' };
          },
          [f.ref, f.value]
        );
        results.push(r?.success ? `${r.fieldName}: OK` : `${f.ref}: ${r?.error || 'failed'}`);
      } catch (e) {
        results.push(`${f.ref}: ${e.message}`);
      }
    }
    return { content: [{ type: 'text', text: results.join('\n') }] };
  }

  // Single mode (backward compatible)
  if (!args.ref) return { error: { code: 'BAD_REQUEST', message: 'Missing ref for single mode (use fields array for batch)' } };
  const r = await callContentScript(tabId,
    (ref, value) => {
      const bridge = globalThis.__ccBridge;
      return bridge ? bridge.fillForm(ref, value) : { success: false, error: 'not available' };
    },
    [args.ref, args.value]
  );
  if (!r?.success) return { content: [{ type: 'text', text: `Error: ${r?.error || 'failed'}` }], isError: true };
  return { content: [{ type: 'text', text: `Form field "${r.fieldName}" set` }] };
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
async function handleJavaScript(tabId, args) {
  await ensureAttached(tabId);
  const code = args.text || '';
  if (code.length > 100000) return { error: { code: 'CODE_TOO_LONG', message: `Code exceeds 100K limit (${code.length} chars)` } };

  let result;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (c) => { try { return { ok: true, val: (0, eval)(c) } } catch (e) { return { ok: false, err: e.message }; } },
      args: [`(function(){ try { return (${code}) } catch(e) { ${code} } })()`]
    });
    if (r?.result?.ok) result = formatValue(r.result.val);
  } catch {}
  if (result === undefined) {
    const cdpSend = (expr) => chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const r1 = await cdpSend(`(${code})`);
    if (!r1.exceptionDetails) { result = formatCDP(r1); }
    else { const r2 = await cdpSend(`(async function(){ ${code} })()`); result = formatCDP(r2); }
  }
  if (result.length > 50000) result = result.slice(0, 50000) + '\n... [OUTPUT TRUNCATED]';
  return { content: [{ type: 'text', text: result }] };
}

function formatCDP(r) {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS error');
  return formatValue(r.result?.value);
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
  const timeout = args.timeout || 10000;
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

// === TOOL HANDLERS ===
const TOOL_HANDLERS = {
  navigate: handleNavigate,
  read_page: handleReadPage,
  find: handleFind,
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
    state.stopRequested = true;
    state.commandQueue = [];
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
