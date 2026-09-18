# Claude Code Browser Automation

<p align="center">
  <strong>AI-driven browser automation — Chrome Extension + MCP Server</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-简体中文-lightgrey?style=flat-square" alt="简体中文"></a>
</p>

Claude Code Browser Automation lets Claude Code control your real browser through natural language — navigate, click, type, fill forms, screenshot, extract content. A real browser fingerprint plus CDP synthetic input gets past anti-bot detection.

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
3. Extension connects to MCP Server over WebSocket
4. All 15 browser tools are registered

---

## 15 Tools

### Navigation
| Tool | Parameters | Description |
|------|-----------|-------------|
| `navigate` | `url`, `tabId?` | Navigate to URL. Supports `"back"` / `"forward"` |

### Page Reading
| Tool | Parameters | Description |
|------|-----------|-------------|
| `read_page` | `filter?`, `depth?`, `max_chars?`, `ref_id?`, `keywords?`, `diff?`, `tabId?` | Accessibility element tree with ref IDs. `filter="interactive"` for interactive elements only (token-efficient), `"all"` for everything. `keywords` emits only matching elements. `diff=true` returns only what changed since the last full read — compared per-ref, so an element that merely moved is not a change. Filtered reads are not stored as a baseline. Includes live diagnostics (console errors, failed network requests) and pending dialog warnings |
| `find` | `query`, `max_results?`, `tabId?` | Search elements by keyword across text/aria-label/title/role. Multi-term scoring, returns ref list |
| `wait_for` | `selector?`, `text?`, `timeout?`, `tabId?` | Wait for element or text to appear. Selector uses CSS visibility check, text matches page content. Default 10s timeout, 300ms poll interval |

### Interaction
| Tool | Parameters | Description |
|------|-----------|-------------|
| `computer` | `action` (+ 13 optional params) | Mouse/keyboard/screenshot/scroll. Actions: `left_click`, `right_click`, `double_click`, `triple_click`, `type`, `screenshot`, `screenshot_element`, `wait`, `scroll`, `scroll_to`, `key`, `left_click_drag`, `hover`, `zoom`. Click via `ref` (precise) or `coordinate` (pixel). Type batches contiguous runs into a single `Input.insertText` call (newlines/tabs stay real key events). **Click/key press verify the page actually changed** and warn when nothing did (`verify: false` to disable); a two-sample baseline detects self-updating pages and reports the signal as unreliable rather than falsely confirming |
| `form_input` | `ref`+`value` or `fields[]`, `tabId?` | Fill form fields single or batch (`fields: [{ref, value}]`). React/Vue controlled-component compatible via prototype setter. Checkbox accepts boolean. File inputs are handled through CDP `DOM.setFileInputFiles`, so `value` must be an absolute path on the machine running the MCP server |

### Content Extraction
| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_page_text` | `max_chars?`, `tabId?` | Plain text extraction via textContent. Auto-detects article/content containers (10+ heuristic selectors). Most complete, best for social media/SPAs. Returns title, URL, source element |
| `get_page_markdown` | `max_chars?`, `tabId?` | Structured Markdown — headings, links, code blocks, tables, images, lists, blockquotes, details. Filters decorative icons (<50px). Max 10 table rows / 8 columns. Falls back to "try get_page_text" if empty |

### JS & Debugging
| Tool | Parameters | Description |
|------|-----------|-------------|
| `health_check` | — | Walk the chain hop by hop (MCP server → WebSocket → extension → content script → CDP) and report each one. Falls back to another tab when the active one can't be scripted. Use it first when a tool call misbehaves |
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

Startup decides the mode:

**Server mode** (port 19222 free):
- Listens on `ws://127.0.0.1:19222`
- Accepts Extension and client MCP connections
- Role comes from the first message — `extension_info` vs a tool call (`type: "tool_call"`)
- Multi-client: `routeTable` maps request IDs to client WebSockets, so extension replies go back to the right client
- PID file at `/tmp/claude-browser-mcp.pid`, stale-process cleanup

**Client mode** (port taken):
- Connects as a client to the existing server
- Reconnect every 500ms, up to 10 attempts
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
- **State persistence**: every 15s writes `{tabId, consoleEvents, networkEvents}` to `chrome.storage.session` for SW crash recovery
- **On init**: restores persisted tab state, re-attaches CDP, restores event buffers

### WebSocket management

- `reconnectAttempt` exponential backoff: 1s → 2s → 4s → 8s → 10s max
- On connect: sends `{type:'extension_info', version, capabilities}`
- On disconnect: auto-reconnect with backoff
- Ping/pong keepalive from server

### FIFO command queue

Strict FIFO order per extension instance. Each tool gets a 5-second slow-tool warning. `stopRequested` allows mid-execution abort from the popup.

### CDP management

- CDP v1.3 via `chrome.debugger.attach()`
- Domain enable: Page + Runtime + Network on attach
- Restricted URL rejection: `chrome://`, `edge://`, `about:`, `devtools://`
- Auto-detach on tab close; another-debugger guard (F12 conflict)
- Event listeners for console API calls, exceptions, network requests, dialog events
- Viewport emulation for HiDPI screenshots (scales to 1280px width, restores after)

### Popup (`popup.html` / `popup.js`)

- Connection status (Connected/Disconnected)
- Current tab info
- Configurable WebSocket port (persisted to chrome.storage.local)
- "Disconnect tab" button (detaches all CDP sessions)

### Content Scripts

**`accessibility-tree.js`** — element mapping:
- WeakRef mapping (elementMap + reverseMap) — no memory leaks
- `getElementByRef(ref)` / `getRefForElement(el)` — bidirectional lookup
- `getElementCoordinates(ref)` — `{x, y, width, height}` for click targeting, auto-scrolls into view
- `generate(mode, maxDepth, maxChars, focusRef)`:
  - `"interactive"`: omits non-interactive elements (token-efficient), unlimited depth
  - `"all"`: depth-limited (max 30), all visible elements
  - Hard cap at `maxChars`, tree truncation with resume guidance
  - Element states: disabled, checked/unchecked, readonly, required, select options count
  - Input values (excluding password), link destinations, accessible names
- Role detection: 30+ HTML tag→ARIA role mappings
- Visibility check: display/visibility/opacity + offset dimensions
- `ref_id` starts the tree from a specific element (for paginated navigation)

**`page-bridge.js`** — page interaction:
- `getPageText(maxChars)`: auto-detects content via 10 heuristic selectors (article, main, post-content, entry-content, etc.), picks the largest container
- `fillForm(ref, value)`:
  - `<select>`: matches by value or option text, fires `change`
  - checkbox/radio: sets `.checked`, fires `change`
  - file input: routes to CDP `DOM.setFileInputFiles`; `value` is an absolute path on the MCP-server machine
  - text/textarea: prototype setter (`HTMLInputElement.prototype` / `HTMLTextAreaElement.prototype`) for React/Vue controlled components
  - contentEditable: `execCommand('insertText')` fallback
  - After fill: cursor to end via `setSelectionRange`
  - Events: `InputEvent('input', {inputType:'insertText'})` + `Event('change')`
- `searchElements(query, maxResults)`: multi-term scoring across text/aria-label/role, sorted results

**`auto-capture.js`** — HTML→Markdown:
- Scans `h1-h6, p, a, li, pre, code, blockquote, table, img, figure, figcaption, dl, dt, dd, details, summary, strong, em`
- Renders headings (`#`), paragraphs, links `[text](url)`, code blocks (`` ``` ``), blockquotes (`>`), images `![alt](src)`
- Lists: ordered (1. 2.) and unordered (-), nested indentation via recursion
- Tables: header separator, max 10 rows / 8 cols, pipe escaping
- Details/summary: `> **summary** > content`
- DL: DT bold, DD indented
- Figure: image + caption
- Filters icons <50px

**`visual-indicator.js`** — DOM overlay:
- Shadow DOM container (z-index 2147483647, pointer-events: none by default)
- Element highlight: green pulsing border, scrolls into view
- Status badges: loading (⏳), completed (✅), error (❌) — top-right, click to dismiss
- Agent UI: pulsing green border around viewport + centered "Stop" button at bottom
- Stop button sends `STOP_TOOL_EXECUTION`, disables on click
- All UI via chrome.runtime.onMessage: `SHOW_HIGHLIGHT`, `HIDE_HIGHLIGHT`, `SHOW_STATUS`, `HIDE_STATUS`, `SHOW_AGENT_UI`, `HIDE_AGENT_UI`, `HIDE_ALL`

### Keyboard handling

- Key aliases: `return`→Enter, `cmd`→Meta, `esc`→Escape, `up`→ArrowUp, etc. (15+ aliases)
- VK code mapping: 19 codes (Enter, Tab, Escape, Backspace, Delete, Insert, Space, Control, Alt, Shift, Meta, arrows, Home, End, PageUp/Down)
- Modifier parsing: `alt+ctrl+shift+t` → bitmask; supports `cmd`, `meta`, `control`, `shift`, `alt`
- Special combos: `Cmd+R` / `Ctrl+R` / `F5` → tab reload
- Repeat support (up to 100×)

### Screenshot system

- `takeScreenshot(quality)`:
  - Quality tiers: `low` (target 27KB, q=20→5), `medium` (270KB, q=40→10), `high` (670KB, q=60→20)
  - Iterative quality reduction: start at tier quality, decrement by 5 until under threshold or min quality
  - HiDPI scaling: viewport emulated to 1280px width, restored after
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
| **FIFO queue single-threaded** — all tools share one global queue, so tools in *different* tabs run one at a time too; one stuck tool blocks everything | Open | Moderate: slow workflows |
| **MV3 SW idle kill** — Chrome may kill Service Worker after ~30s idle | Mitigated: dual keepalive (interval + alarms) | Rare: reconnect adds 1-2s delay |
| **Screenshot quality loop** — iterative linear degradation (not binary search) | Open | Low: 1-2 extra CDP calls |
| **waitForLoad polling** — 100ms interval until `status=complete` | Open | Low: may miss SPA navigations |
| **No end-to-end health check** — MCP shows "Connected" even if extension dropped | Fixed: `health_check` tool walks every hop and reports which one broke | — |
| **Content scripts injected serially** — 4 separate executeScript calls | Fixed: all four files go in one `executeScript` call via a `files` array (a separate cheap probe call checks whether they are already present) | — |
| **Chrome 136+ blocks `--remote-debugging-port`** on the default profile, so the "just launch Chrome with a debug port" approach no longer works | Known limitation — an extension driving `chrome.debugger` is the remaining path, which is what this project does | You cannot attach an external CDP client to a normal Chrome profile |
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

| Layer | Stack |
|-------|-------|
| Extension | Manifest V3, Service Worker, `chrome.debugger` (CDP v1.3), `chrome.scripting` |
| MCP Server | Node.js, `@modelcontextprotocol/sdk`, `ws` (WebSocket Server) |
| Content Scripts | WeakRef element mapping, prototype setter (form fill), Shadow DOM UI |
| CDP Domains | Page, Runtime, Network, Input, DOM, Emulation |
