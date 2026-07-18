# Claude Code Browser Automation

<p align="center">
  <strong>AI-driven browser automation — Chrome Extension + MCP Server</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-简体中文-lightgrey?style=flat-square" alt="简体中文"></a>
</p>

Claude Code Browser Automation lets Claude Code control your real browser — navigate, click, type, fill forms, take screenshots, extract content — all through natural language. Bypasses anti-bot detection by using a real browser fingerprint and CDP synthetic input.

---

## Architecture

```
Claude Code ←──stdio──→ MCP Server (index.js) ←──ws:127.0.0.1:19222──→ Edge/Chrome Extension
                                                                              │
                                                                        CDP (DevTools Protocol)
                                                                              │
                                                                       Real Browser Tab
```

Startup:
1. Load the Extension in Edge/Chrome (developer mode)
2. Claude Code auto-launches MCP Server via MCP config
3. Extension connects to MCP Server via WebSocket
4. 14 browser tools are registered

---

## 14 Tools

### Navigation
| Tool | Parameters | Description |
|------|-----------|-------------|
| `navigate` | `url`, `tabId?` | Navigate to URL. Supports `"back"` / `"forward"` |

### Page Reading
| Tool | Parameters | Description |
|------|-----------|-------------|
| `read_page` | `filter?`, `depth?`, `max_chars?`, `ref_id?`, `tabId?` | Accessibility element tree with ref IDs. `filter="interactive"` for interactive elements only (token-efficient), `"all"` for everything. Includes live diagnostics (console errors, failed network requests) and pending dialog warnings |
| `find` | `query`, `max_results?`, `tabId?` | Search elements by keyword across text/aria-label/title/role. Multi-term scoring, returns ref list |
| `wait_for` | `selector?`, `text?`, `timeout?`, `tabId?` | Wait for element or text to appear. Selector uses CSS visibility check, text matches page content. Default 10s timeout, 300ms poll interval |

### Interaction
| Tool | Parameters | Description |
|------|-----------|-------------|
| `computer` | `action` (+ 12 optional params) | Mouse/keyboard/screenshot/scroll. Actions: `left_click`, `right_click`, `double_click`, `triple_click`, `type`, `screenshot`, `screenshot_element`, `wait`, `scroll`, `scroll_to`, `key`, `left_click_drag`, `hover`, `zoom`. Click via `ref` (precise) or `coordinate` (pixel). Type: ASCII per-character key events + 20ms delay, Chinese via `Input.insertText` + random 10-30ms delay |
| `form_input` | `ref`+`value` or `fields[]`, `tabId?` | Fill form fields single or batch (`fields: [{ref, value}]`). React/Vue controlled-component compatible via prototype setter. Checkbox accepts boolean |

### Content Extraction
| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_page_text` | `max_chars?`, `tabId?` | Plain text extraction via textContent. Auto-detects article/content containers (10+ heuristic selectors). Most complete, best for social media/SPAs. Returns title, URL, source element |
| `get_page_markdown` | `max_chars?`, `tabId?` | Structured Markdown — headings, links, code blocks, tables, images, lists, blockquotes, details. Filters decorative icons (<50px). Max 10 table rows / 8 columns. Falls back to "try get_page_text" if empty |

### JS & Debugging
| Tool | Parameters | Description |
|------|-----------|-------------|
| `javascript_tool` | `text`, `tabId?` | Execute JS in the page. 100K char limit. Double eval wrapping for expression/statement compatibility. CDP fallback if scripting.executeScript fails |
| `read_console_messages` | `tabId`, `onlyErrors?`, `pattern?`, `clear?`, `limit?` | Read console messages. Supports regex pattern filtering |
| `read_network_requests` | `tabId`, `urlPattern?`, `clear?`, `limit?` | Read HTTP network requests with status codes |

### Tab Management
| Tool | Parameters | Description |
|------|-----------|-------------|
| `tabs_context` | — | List all open tabs with ID, title, URL, active state. Includes connection health prefix (`[Browser MCP: Extension connected]`) |
| `tabs_create` | — | Create new blank tab, auto-prefixed with `[AI]` in title |

### Dialog Handling
| Tool | Parameters | Description |
|------|-----------|-------------|
| `dismiss_dialog` | `action`, `promptText?`, `tabId?` | Accept/dismiss native browser dialogs (alert/confirm/prompt/beforeunload). Supports prompt text input |

---

## Content Extraction Guide

| Scenario | Recommended Tool | Reason |
|----------|----------------|--------|
| Blog posts, technical docs | `get_page_markdown` first | Preserves structure (headings, code, tables) |
| Social media (Xiaohongshu/Zhihu/Bilibili) | `get_page_text` first | textContent never loses content |
| Product pages | `get_page_markdown` best | Structured info matters |
| Complex SPAs | `get_page_text` | Heavier JS apps may break tree-based extraction |
| Unfamiliar pages | Try both | Markdown for structure → text for gaps |

---

## MCP Server (`mcp-server/index.js`)

### Dual-mode architecture

The server has two modes, determined at startup:

**Server mode** (port 19222 free):
- Listens on `ws://127.0.0.1:19222`
- Accepts both Extension and client MCP connections
- Role determined by first message — `extension_info` (type: "extension_info") vs tool call (type: "tool_call")
- Multi-client support: `routeTable` maps request IDs to client WebSocket connections, replies from extension are forwarded to the correct client
- PID file at `/tmp/claude-browser-mcp.pid` with stale-process cleanup

**Client mode** (port already taken):
- Connects as a client to the existing server
- Reconnects with exponential backoff (500ms × retries, 10 max)
- All tool calls routed through the shared server

### Extension communication

```
callExtension(tool, args):
  1. Generate unique message ID
  2. Register promise in pending Map with 30s timeout
  3. Send {type:'tool_call', id, tool, args} via WebSocket
  4. On response: resolve promise / reject on error
```

### Keepalive
- Every 20s the server sends `{type:'ping'}` to the extension
- Extension responds with `{type:'pong'}`
- Connection loss triggers pending promise rejection and reconnection

### Special handling
- `tabs_context` returns graceful status (`[Browser MCP: Extension disconnected]`) instead of error when extension is disconnected

---

## Extension (`extension/background.js`)

### Service Worker lifecycle

- **Dual keepalive**: `setInterval` 25s (chrome.storage.local write) + `chrome.alarms` 0.5min (wakes SW from idle)
- **State persistence**: Every 15s, saves `{tabId, consoleEvents, networkEvents}` to `chrome.storage.session` for SW crash recovery
- **On init**: restores persisted tab state, re-attaches CDP, restores event buffers

### WebSocket management

- `reconnectAttempt` exponential backoff: 1s → 2s → 4s → 8s → 10s max
- On connect: sends `{type:'extension_info', version, capabilities}`
- On disconnect: auto-reconnect with backoff
- Ping/pong keepalive from server

### FIFO command queue

Tools are executed in strict FIFO order per extension instance. Each tool has a 5-second slow-tool warning. `stopRequested` flag allows mid-execution abort via popup button.

### CDP management

- CDP v1.3 via `chrome.debugger.attach()`
- Domain enable: Page + Runtime + Network on attach
- Restricted URL rejection: `chrome://`, `edge://`, `about:`, `devtools://`
- Auto-detach on tab close; another-debugger guard (F12 conflict)
- Event listeners for console API calls, exceptions, network requests, dialog events
- Viewport emulation for HiDPI screenshots (scales to 1280px width, restores after)

### Popup (`popup.html` / `popup.js`)

- Connection status indicator (Connected/Disconnected)
- Current tab info display
- Configurable WebSocket port (saved to chrome.storage.local)
- "Disconnect tab" button (detaches all CDP sessions)
- Port config persistence

### Content Scripts

**`accessibility-tree.js`** — Element mapping system:
- WeakRef-based mapping (elementMap + reverseMap) — avoids memory leaks
- `getElementByRef(ref)` / `getRefForElement(el)` — bidirectional ref lookup
- `getElementCoordinates(ref)` — returns `{x, y, width, height}` for click targeting, auto-scrolls into view
- `generate(mode, maxDepth, maxChars, focusRef)` — tree generation:
  - Mode `"interactive"`: omits non-interactive elements (token-efficient), unlimited depth
  - Mode `"all"`: depth-limited (max 30), includes all visible elements
  - Hard cap at `maxChars`, tree truncation with resume guidance
  - Element states: disabled, checked/unchecked, readonly, required, select options count
  - Input values shown (excluding password), link destinations, accessible names
- Role detection: 30+ HTML tag→ARIA role mappings
- Visibility check: display/visibility/opacity + offset dimensions
- `ref_id` argument to start tree from a specific element (for paginated navigation)

**`page-bridge.js`** — Page interaction layer:
- `getPageText(maxChars)`: Content auto-detection via 10 heuristic selectors (article, main, post-content, entry-content, etc.), picks largest content container
- `fillForm(ref, value)`: Form field filler:
  - `<select>`: matches by value or option text, fires `change` event
  - checkbox/radio: sets `.checked`, fires `change`
  - file input: rejected (requires CDP)
  - text/textarea: prototype setter (`HTMLInputElement.prototype` / `HTMLTextAreaElement.prototype`) for React/Vue controlled-component compatibility
  - contentEditable: `execCommand('insertText')` fallback
  - After fill: sets cursor to end of value via `setSelectionRange`
  - Events: `InputEvent('input', {inputType:'insertText'})` + `Event('change')`
- `searchElements(query, maxResults)`: Multi-term scoring across text/aria-label/role, returns sorted results

**`auto-capture.js`** — HTML→Markdown converter:
- Scans `h1-h6, p, a, li, pre, code, blockquote, table, img, figure, figcaption, dl, dt, dd, details, summary, strong, em`
- Renders: headings (`#`), paragraphs, links `[text](url)`, code blocks (`` ``` ``), blockquotes (`>`), images `![alt](src)`
- List rendering: ordered (1. 2.) and unordered (-), nested indentation via recursion
- Table rendering: header separator, max 10 rows / 8 cols, pipe escaping
- Details/summary: rendered as `> **summary** > content`
- DL: DT as bold, DD indented
- Figure: embedded image + caption
- Filters icons <50px

**`visual-indicator.js`** — DOM overlay UI:
- Shadow DOM container (z-index 2147483647, pointer-events: none default)
- Element highlighting: green pulsing border animation, scrolls into view
- Status badges: loading (⏳), completed (✅), error (❌) — positioned top-right, clickable to dismiss
- Agent UI: pulsing green border around viewport + centered "Stop" button at bottom
- Stop button sends `STOP_TOOL_EXECUTION` message, disables on click
- All UI via chrome.runtime.onMessage: `SHOW_HIGHLIGHT`, `HIDE_HIGHLIGHT`, `SHOW_STATUS`, `HIDE_STATUS`, `SHOW_AGENT_UI`, `HIDE_AGENT_UI`, `HIDE_ALL`

### Keyboard handling

- Key aliases: `return`→Enter, `cmd`→Meta, `esc`→Escape, `up`→ArrowUp, etc. (15+ aliases)
- VK code mapping: 18 codes (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp/Down)
- Modifier parsing: `alt+ctrl+shift+t` → bitmask, supports `cmd`, `meta`, `control`, `shift`, `alt`
- Special combos: `Cmd+R` / `Ctrl+R` / `F5` → tab reload
- Repeat support (up to 100×)

### Screenshot system

- `takeScreenshot(quality)`:
  - Quality tiers: `low` (target 27KB, q=20→5), `medium` (270KB, q=40→10), `high` (670KB, q=60→20)
  - Iterative quality reduction: starts at tier quality, decrements by 5 until under threshold or min quality
  - HiDPI scaling: viewport emulated to 1280px width, restored after screenshot
  - Screenshot context stored for coordinate remapping
  - Returns `screenshot(element)` — crops to element bounding box with 10% padding
- `zoom` action: region screenshot (x0/y0/x1/y1), fixed 60% quality
- All screenshots: JPEG base64, `captureBeyondViewport: false`, `fromSurface: true`

### Permission set (manifest.json)

- `debugger`, `tabs`, `tabGroups`, `activeTab`, `scripting`, `storage`, `alarms`
- Host permissions: `http://127.0.0.1/*`, `http://localhost/*`, `<all_urls>`
- Content scripts injected on all HTTP/HTTPS pages at `document_idle`
- MV3 Service Worker (module type)

---

## Typical Workflows

### Xiaohongshu search + post reading
```
1. navigate({ url: "xiaohongshu.com" })
2. read_page({ filter: "interactive" })          → find search box [ref_N]
3. computer({ action: "left_click", ref: "ref_N" })
4. computer({ action: "type", text: "keyword\n" })
5. read_page({ filter: "interactive" })          → browse results
6. computer({ action: "left_click", ref: "ref_M" })    → click post
7. get_page_text({ max_chars: 5000 })            → read full content
```

### Form filling (React/Vue compatible)
```
1. navigate({ url: "example.com/form" })
2. read_page({ filter: "interactive" })
3. form_input({ fields: [{ref:"ref_N", value:"Name"}, {ref:"ref_M", value:"email@test.com"}] })
4. computer({ action: "left_click", ref: "ref_submit" })
```

### Waiting for dynamic content
```
1. navigate({ url: "example.com/dynamic" })
2. wait_for({ selector: ".loading-spinner", timeout: 3000 })
3. wait_for({ text: "Loaded successfully" })
4. read_page({ filter: "interactive" })
```

### Dialog handling (alert/confirm/prompt)
```
1. Before the dialog: read_page shows:
   ⚠️ Browser dialog active: confirm("Are you sure?")
2. dismiss_dialog({ action: "accept" })
3. dismiss_dialog({ action: "dismiss" })
4. dismiss_dialog({ action: "accept", promptText: "my input" })
```

---

## Prerequisites

- Node.js >= 18
- Edge or Chrome browser
- macOS / Linux / Windows all supported
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated

---

## Security Design

| Mechanism | Detail |
|-----------|--------|
| Local-only WebSocket | `127.0.0.1:19222` — not exposed to network |
| Restricted URL guard | Blocks `chrome://`, `edge://`, `about:`, `devtools://` |
| CDP exclusive | Only the extension talks to CDP — no direct DevTools exposure |
| PID file protection | `/tmp/claude-browser-mcp.pid` with stale cleanup |
| JS tool limits | 100K char max, double-wrapped eval, output truncated at 50K |
| Tab isolation | Each tab gets own CDP session; popup provides "Disconnect tab" |
| Content scripts | `document_idle` injection, Shadow DOM for UI (no page style pollution) |

---

## Known Issues & Limitations

| Issue | Status | Impact |
|-------|--------|--------|
| **Port 19222 conflict** — multiple Claude Code sessions compete for the same WebSocket port | Fixed: PID file + EADDRINUSE → client mode fallback + 3 retries | Mild: retry adds latency |
| **FIFO queue single-threaded** — same-tab tools execute serially; one stuck tool blocks the queue | Open | Moderate: slow workflows |
| **MV3 SW idle kill** — Chrome may kill Service Worker after ~30s idle | Mitigated: dual keepalive (interval + alarms) | Rare: reconnect adds 1-2s delay |
| **Screenshot quality loop** — iterative linear degradation (not binary search) | Open | Low: 1-2 extra CDP calls |
| **waitForLoad polling** — 100ms interval until `status=complete` | Open | Low: may miss SPA navigations |
| **No end-to-end health check** — MCP shows "Connected" even if extension dropped | Open | Medium: tool call timeouts |
| **Content scripts injected serially** — 4 separate executeScript calls | Open | Low: ~200ms perceived delay |
| **Lid closed + battery** — Chrome suspends CDP on battery sleep | Known limitation | Unusable |
| **Hover → click bug** — historical; fixed (hover now sends mouseMoved only) | Fixed | — |

---

## Configuration

### Install MCP in Claude Code
```bash
claude mcp add -s user browser -- node /path/to/claude-code-browser/mcp-server/index.js
```

### Load the Extension
1. Open `edge://extensions` or `chrome://extensions`
2. Enable Developer mode
3. "Load unpacked" → select `/path/to/claude-code-browser/extension/`
4. Confirm Service Worker is active with no errors

---

## License

[MIT](LICENSE)

## Tech Stack
|-------|-----------|
| Extension | Manifest V3, Service Worker, `chrome.debugger` (CDP v1.3), `chrome.scripting` |
| MCP Server | Node.js, `@modelcontextprotocol/sdk`, `ws` (WebSocket Server) |
| Content Scripts | WeakRef element mapping, prototype setter (form fill), Shadow DOM UI |
| CDP Domains | Page, Runtime, Network, Input, DOM, Emulation |
