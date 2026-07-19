# Claude Code 浏览器自动化

> 让 Claude Code 操控真实浏览器——导航、点击、输入、填表、截图、提取内容，全部通过自然语言驱动。

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/OUENMING/claude-code-browser)
[![English](https://img.shields.io/badge/English-blue?style=flat-square)](README_en.md)

Chrome/Edge Extension + MCP Server 构成的浏览器自动化系统。**真实浏览器指纹 + CDP 合成输入**，能绕过小红书、B 站、知乎等平台的反爬检测——市面上绝大多数无头浏览器方案在遇到这些站点时都会失败。

## 架构

```
Claude Code ←──stdio──→ MCP Server (index.js) ←──ws:127.0.0.1:19222──→ Edge/Chrome Extension
                                                                                │
                                                                          CDP (DevTools Protocol)
                                                                                │
                                                                         真实浏览器标签页
```

启动即用：Edge/Chrome 加载 Extension（开发者模式）→ Claude Code 自动拉起 MCP Server → Extension 通过 WebSocket 连接 → 14 个浏览器工具自动注册。

## 亮点

- **真实浏览器指纹**：不暴露无头浏览器特征，CDP v1.3 原生调试协议操控页面
- **反反爬**：小红书、知乎、B 站等强反爬站点正常访问，无需额外配置
- **14 个工具**：覆盖导航、页面读取、交互、内容提取、JS 执行、标签页管理、弹窗处理全流程
- **受控组件兼容**：React/Vue 表单通过 prototype setter 注入，不是简单 dispatchEvent
- **双模架构**：端口被占用时自动降级为客户端模式，多会话共存不冲突
- **内容提取双引擎**：Markdown 结构化 + textContent 全量提取，按场景选择或组合使用

## 14 个工具一览

### 导航
| 工具 | 参数 | 说明 |
|------|------|------|
| `navigate` | `url`, `tabId?` | 导航到 URL，支持 `"back"` / `"forward"` |

### 页面读取
| 工具 | 参数 | 说明 |
|------|------|------|
| `read_page` | `filter?`, `depth?`, `max_chars?` | 可访问性元素树，带 `[ref_N]` 标识符。`filter="interactive"` 只显示交互元素节省 token |
| `find` | `query`, `max_results?` | 关键词搜索元素，多词打分排序，返回 ref 列表 |
| `wait_for` | `selector?`, `text?`, `timeout?` | 等待元素或文本出现，默认 10s 超时 |

### 交互
| 工具 | 参数 | 说明 |
|------|------|------|
| `computer` | `action` + 12 个可选参数 | 鼠标/键盘/截图/滚动。支持 ref 定位或像素坐标。中文输入用 `Input.insertText` + 随机 10-30ms 延迟 |
| `form_input` | `ref`+`value` 或 `fields[]` | 设置表单字段值。批量、checkbox、React/Vue 受控组件均支持 |

### 内容提取
| 工具 | 参数 | 说明 |
|------|------|------|
| `get_page_text` | `max_chars?` | 纯文本提取，自动检测正文容器（10+ 启发式选择器），适合社交/SPA |
| `get_page_markdown` | `max_chars?` | 结构化 Markdown：标题、链接、代码块、表格、图片、列表 |

### JS & 调试
| 工具 | 参数 | 说明 |
|------|------|------|
| `javascript_tool` | `text` | 页面执行 JS，10 万字符限制，CDP 兜底 |
| `read_console_messages` | `tabId`, `onlyErrors?` | 读取控制台消息 |
| `read_network_requests` | `tabId`, `urlPattern?` | 读取 HTTP 网络请求及状态码 |

### 标签页管理
| 工具 | 说明 |
|------|------|
| `tabs_context` | 列出所有标签页（ID/标题/URL/活跃状态） |
| `tabs_create` | 创建新空白标签页 |

### 弹窗处理
| 工具 | 参数 | 说明 |
|------|------|------|
| `dismiss_dialog` | `action`, `promptText?` | 关闭浏览器原生对话框（alert/confirm/prompt/beforeunload） |

## 安装

### 前置条件
- Node.js >= 18
- Edge 或 Chrome 浏览器
- macOS / Linux / Windows 均可
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 并完成认证

### 1. 注册 MCP Server

```bash
claude mcp add -s user browser -- node /path/to/claude-code-browser/mcp-server/index.js
```

### 2. 加载 Extension

1. 打开 `edge://extensions` 或 `chrome://extensions`
2. 开启"开发者模式"
3. "加载解压缩的扩展" → 选择 `extension/` 目录
4. 确认 Service Worker 无报错

### 3. 开始使用

在 Claude Code 中直接描述操作目标，浏览器工具自动调用。

## 典型工作流

### 小红书搜索 + 帖子阅读

```
1. navigate({ url: "xiaohongshu.com" })
2. read_page({ filter: "interactive" })           → 找到搜索框 [ref_N]
3. computer({ action: "left_click", ref: "ref_N" })
4. computer({ action: "type", text: "关键词\n" })
5. read_page({ filter: "interactive" })           → 看搜索结果
6. computer({ action: "left_click", ref: "ref_M" })     → 点帖子
7. get_page_text({ max_chars: 5000 })             → 读全文
```

### 表单填写（React/Vue 兼容）

```
1. navigate({ url: "example.com/form" })
2. read_page({ filter: "interactive" })
3. form_input({ fields: [{ref:"ref_N", value:"张三"}, {ref:"ref_M", value:"test@test.com"}] })
4. computer({ action: "left_click", ref: "ref_submit" })
```

### 等待动态内容

```
1. navigate({ url: "example.com/dynamic" })
2. wait_for({ selector: ".loading-spinner", timeout: 3000 })
3. wait_for({ text: "加载完成" })
4. read_page({ filter: "interactive" })
```

## 内容提取选择

| 场景 | 推荐工具 |
|------|---------|
| 博客文章、技术文档 | `get_page_markdown`（保留结构） |
| 社交媒体（小红书/知乎/B站） | `get_page_text`（textContent 不漏内容） |
| 产品页面 | `get_page_markdown` |
| 复杂 SPA | `get_page_text` |
| 不熟悉页面 | 两个都调：Markdown 看结构 → 纯文本补漏 |

## 项目结构

```
claude-code-browser/
├── extension/                     # Chrome/Edge Extension
│   ├── manifest.json              # MV3 清单
│   ├── background.js              # Service Worker — CDP 管理、WebSocket、命令队列
│   ├── popup.html / popup.js      # 连接状态、端口配置、标签断开
│   └── content-scripts/
│       ├── accessibility-tree.js  # 元素映射系统（WeakRef 双向映射）
│       ├── page-bridge.js         # 表单填充、文本提取、元素搜索
│       ├── auto-capture.js        # HTML → Markdown 转换
│       └── visual-indicator.js    # Shadow DOM 叠加层 UI
├── mcp-server/
│   └── index.js                   # MCP Server（双模 WebSocket）
├── docs/                          # 文档站点
├── LICENSE                        # MIT
└── README.md
```

## 技术栈

| 层 | 技术 |
|----|------|
| Extension | Manifest V3, Service Worker, `chrome.debugger` (CDP v1.3), `chrome.scripting` |
| MCP Server | Node.js, `@modelcontextprotocol/sdk`, `ws` (WebSocket Server) |
| Content Scripts | WeakRef 元素映射, prototype setter (表单), Shadow DOM 叠加层 |
| CDP 域 | Page, Runtime, Network, Input, DOM, Emulation |

## 安全设计

- WebSocket 仅绑定 `127.0.0.1:19222`，不暴露到网络
- 阻止 `chrome://`、`edge://`、`about:`、`devtools://` 等内部页面
- PID 文件保护 `/tmp/claude-browser-mcp.pid`，自动清理过期进程
- JS 工具 10 万字符上限，输出截断
- 日志脱敏敏感信息

## 已知限制

- **FIFO 队列单线程**：同标签工具串行，慢工作流可能被阻塞
- **合盖+电池**：Chrome 在电池睡眠时暂停 CDP
- **MV3 SW 空闲回收**：Chrome 约 30s 空闲可能销毁 Service Worker（双轨保活缓解）
- **无端到端健康检查**：MCP 显示已连但 Extension 可能已掉（工具调用超时）

## 开发

```bash
# 没有额外的构建步骤，直接改 extension/ 或 mcp-server/ 下的文件即可
```

## License

[MIT](LICENSE)

Copyright (c) 2026 Owen
