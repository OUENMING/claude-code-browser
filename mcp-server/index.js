import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';

const WS_PORT = 19222;
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;
const PID_PATH = '/tmp/claude-browser-mcp.pid';

// Atomically claim PID file. Falls through if another process holds it —
// port binding in start() is the authoritative conflict resolver.
function claimPidFile() {
  function register() {
    process.on('exit', () => { try { if (readFileSync(PID_PATH, 'utf-8').trim() === String(process.pid)) unlinkSync(PID_PATH); } catch {} });
    process.on('SIGINT', () => { process.exit(0); });
    process.on('SIGTERM', () => { process.exit(0); });
  }

  // Fast path: atomic exclusive creation.
  try { writeFileSync(PID_PATH, String(process.pid), { flag: 'wx' }); register(); return; }
  catch (e) { if (e.code !== 'EEXIST') { console.error(`[MCP] PID file error: ${e.message}`); } }

  // File exists — try to clean up if stale, then retry.
  try {
    const oldPid = parseInt(readFileSync(PID_PATH, 'utf-8').trim(), 10);
    if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
      // Best-effort: if old process is dead (ESRCH), remove the stale file.
      try { process.kill(oldPid, 0); } catch (e) { if (e.code === 'ESRCH') { try { unlinkSync(PID_PATH); } catch {} } }
    }
  } catch { /* corrupt file */ try { unlinkSync(PID_PATH); } catch {} }

  // Retry atomic creation after cleanup.
  try { writeFileSync(PID_PATH, String(process.pid), { flag: 'wx' }); register(); }
  catch { /* another process beat us — start() will route to client mode via EADDRINUSE */ }
}

claimPidFile();

let extWs = null;        // the upstream socket (extension via server, or the server itself in client mode)
let extConnected = false;
let isClientMode = false;
const pending = new Map();   // id -> {resolve, reject, timer} — for THIS process's own tool calls
const routeTable = new Map(); // server_id -> {clientWs, clientId} — server-only routing table
let msgId = 1;
let routeMsgId = 1;
let keepAliveTimer = null;
const clients = new Set();   // client MCP processes connected to this server (server mode only)

// ---------------------------------------------------------------------------
// Keep-alive
// ---------------------------------------------------------------------------
function sendPing() {
  if (extWs?.readyState === WebSocket.OPEN) extWs.send(JSON.stringify({ type: 'ping' }));
}
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(sendPing, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

function rejectAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

// ---------------------------------------------------------------------------
// Upstream handling — for BOTH modes, this process's own tool calls ride extWs.
// In server mode, extWs is the extension; in client mode, it's the shared server.
// ---------------------------------------------------------------------------
// Attach a socket as our upstream extWs.
// In client mode this socket is the shared server, and we register a message
// listener to receive replies for THIS process's own tool calls.
// In server mode the upstream IS the extension, but its messages are already
// handled by the per-connection `dispatch` in start() — so we do NOT register a
// duplicate message listener here (would otherwise double-process replies).
function attachUpstream(ws, registerMessageListener = true) {
  if (extWs && extWs !== ws) {
    try { extWs.close(); } catch (e) { console.error('[MCP] Error closing old upstream:', e.message); }
    rejectAllPending('Replaced by new upstream');
  }
  extWs = ws;
  extConnected = true;
  startKeepAlive();
  if (registerMessageListener) ws.on('message', handleUpstreamMessage);
  ws.on('close', handleClose);
  ws.on('error', (e) => { console.error('[MCP] Upstream WebSocket error:', e.message || e.code || 'unknown'); });
}

// Messages from the upstream (extension in server mode, server in client mode)
function handleUpstreamMessage(data) {
  try {
    const msg = JSON.parse(data);
    if (msg.type === 'pong') return;
    // Server mode: if this id is in the route table, the reply belongs to a client.
    if (msg.id && routeTable.has(msg.id)) {
      const { clientWs, clientId } = routeTable.get(msg.id);
      routeTable.delete(msg.id);
      const relay = { ...msg, id: clientId };
      if (clientWs?.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(relay));
      return;
    }
    // Otherwise it's a reply to THIS process's own tool call.
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  } catch (e) { console.error('[MCP] Failed to parse upstream message:', e.message); }
}

function handleClose() {
  extConnected = false;
  stopKeepAlive();
  rejectAllPending('Upstream disconnected');
  extWs = null;
  console.error('[MCP] Upstream disconnected');
  // In client mode, the shared server may still be alive — try reconnecting so
  // tool calls resume once a fresh server takes the port. (Server mode never hits this
  // because the extension reconnects on its own and triggers a new attachUpstream.)
  if (isClientMode) {
    console.error('[MCP] Client mode: reconnecting to shared server...');
    becomeClient();
  }
}

// ---------------------------------------------------------------------------
// Mode selection: try to be the server; if port taken, become a client of it.
// EADDRINUSE is asynchronous in ws — must use events, not try/catch.
// ---------------------------------------------------------------------------
function start() {
  const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

  wss.on('listening', () => {
    console.error(`[MCP] Server mode: listening on ${WS_PORT}`);
  });

  wss.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[MCP] Port ${WS_PORT} in use, switching to client mode`);
      becomeClient();
    } else {
      console.error(`[MCP] Server error: ${e.code || e.message}`);
    }
  });

  // Server-mode connection handler.
  // Role decided by FIRST message (no race, no ordering guess):
  //   - extension sends {type:'extension_info'} immediately on connect
  //   - client MCP sends {type:'tool_call'} (or something else)
  // Until the first frame arrives the role is unknown; messages that arrive
  // before we know the role are buffered (extremely rare in practice — the
  // first frame is the very first thing a client sends).
  wss.on('connection', (ws) => {
    ws.role = 'pending';
    const pendingFrames = [];

    const dispatch = (msg) => {
      if (msg.type === 'pong') return;

      if (ws.role === 'extension') {
        // Extension reply — route to owning client if in route table, else local
        if (msg.id && routeTable.has(msg.id)) {
          const { clientWs, clientId } = routeTable.get(msg.id);
          routeTable.delete(msg.id);
          if (clientWs?.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ ...msg, id: clientId }));
          }
        } else if (msg.id && pending.has(msg.id)) {
          const { resolve, reject, timer } = pending.get(msg.id);
          clearTimeout(timer);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } else if (ws.role === 'client') {
        // Client MCP forwarding a tool_call — rewrite id, route, forward to extension
        if (msg.type === 'tool_call' && msg.id != null) {
          const clientId = msg.id;
          const serverId = 'r' + (routeMsgId++);
          routeTable.set(serverId, { clientWs: ws, clientId });
          if (extWs?.readyState === WebSocket.OPEN) {
            extWs.send(JSON.stringify({ ...msg, id: serverId }));
          } else {
            routeTable.delete(serverId);
            ws.send(JSON.stringify({ id: clientId, error: { message: 'Browser extension not connected' } }));
          }
        }
      }
    };

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      // Resolve role on first frame.
      if (ws.role === 'pending') {
        if (msg.type === 'extension_info') {
          ws.role = 'extension';
          console.error('[MCP] Extension connected (server mode)');
          attachUpstream(ws, /*registerMessageListener=*/false);
        } else {
          ws.role = 'client';
          clients.add(ws);
          console.error('[MCP] Client MCP connected (server mode)');
        }
      }

      dispatch(msg);
      // After role resolved, drain any buffered frames (none expected).
      if (pendingFrames.length && ws.role !== 'pending') {
        const frames = pendingFrames.splice(0);
        for (const m of frames) dispatch(m);
      }
    });

    ws.on('close', () => {
      if (ws.role === 'extension') {
        if (extWs === ws) { extConnected = false; stopKeepAlive(); extWs = null; rejectAllPending('Extension disconnected'); }
        console.error('[MCP] Extension disconnected');
      } else if (ws.role === 'client') {
        clients.delete(ws);
        for (const [serverId, entry] of routeTable) {
          if (entry.clientWs === ws) routeTable.delete(serverId);
        }
        console.error('[MCP] Client MCP disconnected');
      }
    });

    ws.on('error', (e) => { console.error('[MCP] Connection error:', e.message || e.code || 'unknown'); });
  });
}

function becomeClient() {
  isClientMode = true;
  const connect = (retries = 10) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => {
      console.error(`[MCP] Client mode: connected to shared server ${WS_PORT}`);
      attachUpstream(ws);
    });
    ws.on('error', () => {
      if (retries > 0) {
        setTimeout(() => connect(retries - 1), 500);
      } else {
        console.error('[MCP] Could not connect to shared server after retries; exiting');
        process.exit(1);
      }
    });
  };
  connect();
}

// ---------------------------------------------------------------------------
// MCP tool wiring (identical in both modes — all calls go through extWs)
// ---------------------------------------------------------------------------
function callExtension(tool, args) {
  if (!extConnected || !extWs) throw new Error('Browser extension not connected');
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout calling ${tool}`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    extWs.send(JSON.stringify({ type: 'tool_call', id, tool, args }));
  });
}

const TOOLS = [
  { name: 'navigate', description: '导航到指定 URL，支持 "back"/"forward" 前进后退。', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'number' } }, required: ['url'] } },
  { name: 'read_page', description: '获取页面可访问性元素树，带 ref ID。filter="interactive" 仅交互元素（省 token），"all" 全部元素。', inputSchema: { type: 'object', properties: { filter: { type: 'string', enum: ['interactive', 'all'] }, depth: { type: 'integer', minimum: 1, maximum: 30 }, max_chars: { type: 'integer', minimum: 1000, maximum: 200000 }, ref_id: { type: 'string' }, tabId: { type: 'number' } } } },
  { name: 'find', description: '按关键词搜索元素，匹配 text/aria-label/title/role，返回 ref 列表。', inputSchema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 100 }, tabId: { type: 'number' } }, required: ['query'] } },
  { name: 'wait_for', description: '等待元素或文本出现。selector 按 CSS 匹配可见元素，text 按页面文本匹配。默认超时 10s，300ms 轮询。', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'integer', minimum: 500, maximum: 30000 }, tabId: { type: 'number' } } } },
  { name: 'dismiss_dialog', description: '关闭浏览器原生对话框（alert/confirm/prompt/beforeunload）。action="accept" 确认，"dismiss" 取消。', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['accept', 'dismiss'] }, promptText: { type: 'string' }, tabId: { type: 'number' } }, required: ['action'] } },
  { name: 'computer', description: '鼠标/键盘/截图交互。ref 精确定位，coordinate 像素坐标。type 逐字符输入带 20ms 延迟。', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['left_click','right_click','double_click','triple_click','type','screenshot','screenshot_element','wait','scroll','scroll_to','key','left_click_drag','hover','zoom'] }, coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, start_coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, ref: { type: 'string' }, text: { type: 'string' }, scroll_direction: { type: 'string', enum: ['up','down','left','right'] }, scroll_amount: { type: 'number', minimum: 1, maximum: 10 }, quality: { type: 'string', enum: ['low','medium','high'] }, duration: { type: 'number', minimum: 0, maximum: 10 }, region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, modifiers: { type: 'string' }, repeat: { type: 'number', minimum: 1, maximum: 100 }, tabId: { type: 'number' } }, required: ['action'] } },
  { name: 'form_input', description: '设置表单字段值（单个或批量）。单字段用 ref+value，批量用 fields: [{ref, value}, ...]。React/Vue 受控组件兼容。', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, value: { type: ['string','boolean','number'] }, fields: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, value: { type: ['string','boolean','number'] } }, required: ['ref','value'] } }, tabId: { type: 'number' } } } },
  { name: 'get_page_text', description: '提取页面全部纯文本（textContent）。最完整不丢内容，但失去结构。适合社交媒体、复杂 SPA。', inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 1000, maximum: 200000 }, tabId: { type: 'number' } } } },
  { name: 'get_page_markdown', description: '提取页面为结构化 Markdown — 标题(#)、链接、代码块、表格、图片。过滤 <50px 装饰图标。漏内容时回退到 get_page_text。', inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 1000, maximum: 200000 }, tabId: { type: 'number' } } } },
  { name: 'javascript_tool', description: '在当前页面执行 JavaScript。⚠️ 不要用它提取密码/token/敏感数据。', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, tabId: { type: 'number' } }, required: ['text'] } },
  { name: 'tabs_context', description: '列出所有打开的标签页。', inputSchema: { type: 'object', properties: {} } },
  { name: 'tabs_create', description: '创建新的空白标签页。', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_console_messages', description: '读取浏览器控制台消息。', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, onlyErrors: { type: 'boolean' }, pattern: { type: 'string' }, clear: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['tabId'] } },
  { name: 'read_network_requests', description: '读取 HTTP 网络请求。', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, urlPattern: { type: 'string' }, clear: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['tabId'] } }
];

const server = new Server(
  { name: 'claude-browser', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const result = await callExtension(req.params.name, req.params.arguments || {});
    // Inject connection health into tabs_context response
    if (req.params.name === 'tabs_context' && result?.content) {
      result.content.unshift({ type: 'text', text: `[Browser MCP: Extension connected]\n` });
    }
    return result;
  } catch (e) {
    // tabs_context with disconnected extension → return health status instead of error
    if (req.params.name === 'tabs_context') {
      return { content: [{ type: 'text', text: '[Browser MCP: Extension disconnected]\n(No active browser tabs)' }] };
    }
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

start();
console.error(`[MCP] Claude Code Browser MCP Server starting (port ${WS_PORT})`);
await server.connect(new StdioServerTransport());