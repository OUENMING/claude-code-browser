# Claude Code Browser Automation

<p align="center">
  <strong>AI-driven browser automation — navigate, click, type, screenshot, extract content via natural language</strong>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-简体中文-lightgrey?style=flat-square" alt="简体中文"></a>
</p>

A Chrome/Edge Extension + MCP Server that lets Claude Code control your real browser — navigate, click, input text, take screenshots, extract content — all through natural language.

**Core capability**: real browser fingerprint + CDP synthetic input = bypass anti-bot detection on platforms like Xiaohongshu, Bilibili, Zhihu.

---

## Architecture

```
Claude Code → MCP Server (stdio) → WebSocket (19222) → Chrome Extension → Real Browser
```

Startup flow:
1. Load the Extension in Edge/Chrome (developer mode)
2. Claude Code automatically launches the MCP Server
3. Extension connects to MCP Server via WebSocket
4. 12 browser tools are registered and ready

---

## All 12 Tools

### Navigation
| Tool | Parameters | Description |
|------|-----------|-------------|
| `navigate` | `url` | Navigate to a URL. Supports `"back"` / `"forward"` |

### Page Reading
| Tool | Parameters | Description |
|------|-----------|-------------|
| `read_page` | `filter`, `max_chars`, `ref_id` | Get accessibility element tree. `filter="interactive"` for interactive elements only (token-efficient), `"all"` for everything. Each element has a `[ref_N]` identifier |
| `find` | `query`, `max_results` | Search elements by keyword, returns ref list |

### Interaction
| Tool | Parameters | Description |
|------|-----------|-------------|
| `computer` | `action` | Mouse/keyboard/screenshot actions. Supported: `left_click`, `right_click`, `double_click`, `triple_click`, `type`, `screenshot`, `wait`, `scroll`, `scroll_to`, `key`, `left_click_drag`, `hover`, `zoom` |

### Forms
| Tool | Parameters | Description |
|------|-----------|-------------|
| `form_input` | `ref`, `value` | Fill form fields by ref. React/Vue controlled-component compatible (prototype setter). Checkbox uses boolean, select uses option text |

### Content Extraction
| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_page_text` | `max_chars` | Plain text (textContent). Most complete, no content loss. Best for social media, complex SPAs |
| `get_page_markdown` | `max_chars` | Structured Markdown. Preserves headings, links, code blocks, tables, images. Best for blogs, docs, product pages |

### JS & Debugging
| Tool | Parameters | Description |
|------|-----------|-------------|
| `javascript_tool` | `text` | Execute JavaScript in the page |
| `read_console_messages` | `tabId` | Read browser console messages |
| `read_network_requests` | `tabId` | Read HTTP network requests |

### Tab Management
| Tool | Parameters | Description |
|------|-----------|-------------|
| `tabs_context` | — | List all open tabs |
| `tabs_create` | — | Create a new tab |

---

## Typical Workflows

### Xiaohongshu search + post reading
```
1. navigate({ url: "xiaohongshu.com" })
2. read_page({ filter: "interactive" })          → find search box [ref_N]
3. computer({ action: "left_click", ref: "ref_N" })
4. computer({ action: "type", text: "Dublin travel\n" })
5. read_page({ filter: "interactive" })          → results, find post ref
6. computer({ action: "left_click", ref: "ref_M" })    → click post
7. get_page_text({ max_chars: 5000 })            → full post text
8. get_page_markdown()                            → structured Markdown
```

### Zhihu browsing
```
1. navigate({ url: "zhihu.com" })
2. get_page_text({ max_chars: 5000 })            → extract feed
3. read_page({ filter: "interactive" })          → find like/comment buttons
```

### Form filling (React/Vue compatible)
```
1. navigate({ url: "example.com/form" })
2. read_page({ filter: "interactive" })
3. form_input({ ref: "ref_N", value: "John" })
4. form_input({ ref: "ref_M", value: "test@test.com" })
5. form_input({ ref: "ref_K", value: true })     → checkbox
6. computer({ action: "left_click", ref: "ref_submit" })
```

### Technical documentation
```
1. navigate({ url: "docs.example.com" })
2. get_page_markdown()                            → preserves API tables, code blocks
3. get_page_text()                                → fallback if markdown misses content
```

### Bilibili video search
```
1. navigate({ url: "bilibili.com" })
2. read_page({ filter: "interactive" })
3. computer({ action: "left_click", ref: "search_ref" })
4. computer({ action: "type", text: "astrophotography\n" })
5. read_page()                                    → browse results
```

---

## Interaction Details

### Click targeting
- **ref preferred**: `read_page` → get `[ref_N]` → `left_click` with ref for precise targeting
- **Coordinate fallback**: `coordinate: [x, y]` pixel coordinates
- 50ms delay simulates human operation rhythm

### Text input
- ASCII: per-character keyDown→char→keyUp + 20ms delay
- Chinese: per-character `Input.insertText` + random delay 10-30ms
- Special keys: `\n`(Enter), `\t`(Tab)

### Screenshot
- Three quality levels: `low`(20%) / `medium`(40%) / `high`(60%)
- Auto-scales to 1280px width (HiDPI optimized)
- Returns JPEG base64

---

## Content Extraction Guide

| Scenario | Recommended Tool | Reason |
|----------|----------------|--------|
| Blog posts, technical docs | `get_page_markdown` first | Preserves headings/code blocks/tables/links |
| Social media (Xiaohongshu/Zhihu/Bilibili) | `get_page_text` first | textContent doesn't lose content |
| Product pages | `get_page_markdown` | Structured info matters |
| Unfamiliar pages | Try both | Markdown for structure → plain text for gaps |

---

## Security Design

| Mechanism | Description |
|-----------|-------------|
| Local WebSocket | `127.0.0.1:19222` only, not exposed to network |
| Per-tab disconnect | Popup provides "Disconnect tab" button |
| Real CDP events | `Input.dispatchMouseEvent` / `insertText` goes through real input pipeline |
| Permission isolation | Extension Manifest V3 minimal permissions |

---

## Configuration

### Install MCP in Claude Code
```bash
claude mcp add -s user browser -- node /path/to/claude-code-browser/mcp-server/index.js
```

### Load the Extension
1. Open `edge://extensions`
2. Enable "Developer mode"
3. "Load unpacked" → select `/path/to/claude-code-browser/extension/`
4. Confirm Service Worker has no errors

---

## Tech Stack

- **Extension**: Manifest V3, Service Worker, chrome.debugger (CDP), chrome.scripting
- **MCP Server**: Node.js, @modelcontextprotocol/sdk, ws (WebSocket Server)
- **Content Scripts**: WeakRef element mapping, prototype setter (React/Vue compatible), Shadow DOM overlay
- **CDP Domains**: Page, Runtime, Network, Input, DOM, Emulation
