# Claude Code 浏览器自动化 — 使用指南

## 概述

一个 Chrome/Edge Extension + MCP Server 的 AI 驱动浏览器自动化系统。让 Claude Code 能像人一样操控你的真实浏览器——导航、点击、输入、截图、提取内容——全部通过自然语言驱动。

**核心能力**：真实浏览器指纹 + CDP 合成输入 = 绕过小红书/B站/知乎的反爬检测。

---

## 架构

```
Claude Code → MCP Server (stdio) → WebSocket (19222) → Chrome Extension → 真实浏览器
```

启动流程：
1. Edge/Chrome 加载 Extension（开发者模式）
2. Claude Code 自动拉起 MCP Server
3. Extension 通过 WebSocket 连接到 MCP Server
4. 12 个浏览器工具自动注册，可用

---

## 全部 12 个工具

### 导航
| 工具 | 参数 | 说明 |
|------|------|------|
| `navigate` | `url` | 导航到 URL，支持 `"back"` / `"forward"` |

### 页面读取
| 工具 | 参数 | 说明 |
|------|------|------|
| `read_page` | `filter`, `max_chars`, `ref_id` | 获取可访问性元素树。`filter="interactive"` 仅交互元素（省 token），`"all"` 全部元素。每个元素带 `[ref_N]` 标识符 |
| `find` | `query`, `max_results` | 按关键词搜索元素，返回 ref 列表 |

### 交互
| 工具 | 参数 | 说明 |
|------|------|------|
| `computer` | `action` | 鼠标/键盘/截图交互。`action` 支持：`left_click`, `right_click`, `double_click`, `triple_click`, `type`, `screenshot`, `wait`, `scroll`, `scroll_to`, `key`, `left_click_drag`, `hover`, `zoom` |

### 表单
| 工具 | 参数 | 说明 |
|------|------|------|
| `form_input` | `ref`, `value` | 用 ref 填写表单。React/Vue 受控组件兼容（prototype setter）。checkbox 用 boolean，select 用 option text |

### 内容提取
| 工具 | 参数 | 说明 |
|------|------|------|
| `get_page_text` | `max_chars` | 纯文本提取（textContent）。最完整，不丢内容。适合社交媒体、复杂 SPA |
| `get_page_markdown` | `max_chars` | 结构化 Markdown 提取。保留标题(#)、链接、代码块、表格、图片。适合博客、文档、产品页 |

### JS & 调试
| 工具 | 参数 | 说明 |
|------|------|------|
| `javascript_tool` | `text` | 在页面执行 JavaScript |
| `read_console_messages` | `tabId` | 读取浏览器控制台消息 |
| `read_network_requests` | `tabId` | 读取 HTTP 网络请求 |

### 标签页管理
| 工具 | 参数 | 说明 |
|------|------|------|
| `tabs_context` | — | 列出所有打开的标签页 |
| `tabs_create` | — | 创建新标签页 |

---

## 典型工作流

### 小红书搜索 + 帖子阅读
```
1. navigate({ url: "xiaohongshu.com" })
2. read_page({ filter: "interactive" })          → 找到搜索框 [ref_N] textbox "搜索小红书"
3. computer({ action: "left_click", ref: "ref_N" })
4. computer({ action: "type", text: "都柏林旅行\n" })  → 输中文 + 回车
5. read_page({ filter: "interactive" })          → 看搜索结果，找到帖子 ref
6. computer({ action: "left_click", ref: "ref_M" })    → 点击帖子
7. get_page_text({ max_chars: 5000 })            → 提取帖子全文
8. get_page_markdown()                            → 结构化 Markdown
```

### 知乎浏览
```
1. navigate({ url: "zhihu.com" })
2. get_page_text({ max_chars: 5000 })            → 提取首页 Feed
3. read_page({ filter: "interactive" })          → 找点赞/评论按钮
```

### 表单填写（含 React/Vue）
```
1. navigate({ url: "example.com/form" })
2. read_page({ filter: "interactive" })
3. form_input({ ref: "ref_N", value: "张三" })
4. form_input({ ref: "ref_M", value: "test@test.com" })
5. form_input({ ref: "ref_K", value: true })     → checkbox
6. computer({ action: "left_click", ref: "ref_submit" })
```

### 技术文档阅读
```
1. navigate({ url: "docs.example.com" })
2. get_page_markdown()                            → 保留 API 表格、代码块
3. get_page_text()                                → Markdown 漏内容时补漏
```

### B站视频搜索
```
1. navigate({ url: "bilibili.com" })
2. read_page({ filter: "interactive" })
3. computer({ action: "left_click", ref: "search_ref" })
4. computer({ action: "type", text: "星空摄影\n" })
5. read_page()                                    → 看搜索结果
```

---

## 交互细节

### 点击定位
- **ref 优先**：`read_page` → 获取 `[ref_N]` → `left_click` 用 ref 精确定位
- **坐标后备**：`coordinate: [x, y]` 像素坐标
- 50ms 延迟模拟人类操作节奏

### 文本输入
- ASCII：逐字符 keyDown→char→keyUp + 20ms 延迟
- 中文：逐字符 `Input.insertText` + 随机延迟 10-30ms
- 支持特殊键：`\n`(回车)、`\t`(Tab)

### 截图
- 三级质量：`low`(20%) / `medium`(40%) / `high`(60%)
- 自动缩放到 1280px 宽度（高 DPI 优化）
- 返回 JPEG base64

---

## 内容提取选择指南

| 场景 | 推荐工具 | 原因 |
|------|---------|------|
| 博客文章、技术文档 | `get_page_markdown` 优先 | 保留标题/代码块/表格/链接 |
| 社交媒体（小红书/知乎/B站） | `get_page_text` 优先 | textContent 不丢内容 |
| 产品页面 | `get_page_markdown` | 结构化信息重要 |
| 不熟悉的页面 | 两个都调 | Markdown 看结构 → 纯文本补漏 |

---

## 安全设计

| 机制 | 说明 |
|------|------|
| 本地 WebSocket | 仅 `127.0.0.1:19222`，不暴露到网络 |
| 每 Tab 可断开 | popup 提供 "断开当前标签页" 按钮 |
| CDP 事件真实 | `Input.dispatchMouseEvent` / `insertText` 走真实输入管线 |
| 权限隔离 | Extension Manifest V3 权限最小化 |

---

## 配置

### 安装 MCP 到 Claude Code
```bash
claude mcp add -s user browser -- node /Users/owen/WorkBuddy/claude-code-browser/mcp-server/index.js
```

### 加载 Extension
1. 打开 `edge://extensions`
2. 开启 "开发者模式"
3. "加载解压缩的扩展" → 选 `/Users/owen/WorkBuddy/claude-code-browser/extension/`
4. 确认 Service Worker 无报错

---

## 技术栈

- **Extension**: Manifest V3, Service Worker, chrome.debugger (CDP), chrome.scripting
- **MCP Server**: Node.js, @modelcontextprotocol/sdk, ws (WebSocket Server)
- **Content Scripts**: WeakRef 元素映射, prototype setter (React/Vue 兼容), Shadow DOM overlay
- **CDP 域**: Page, Runtime, Network, Input, DOM, Emulation
