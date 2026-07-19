# Claude Code 浏览器自动化

> 让 Claude Code 操控你的真实浏览器——导航、点击、输入、填表、截图、提取内容——全部通过自然语言驱动。

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/OUENMING/claude-code-browser)
[![English](https://img.shields.io/badge/English-blue?style=flat-square)](README_en.md)

## 项目介绍

Claude Code 浏览器自动化系统 = Chrome/Edge Extension + MCP Server。**真实浏览器指纹 + CDP 合成输入**，市面上绝大多数无头浏览器方案在遇到小红书、B 站、知乎等强反爬站点时会失败，这个方案不会。

### 核心优势

- **真实浏览器指纹**：不暴露无头浏览器特征，CDP v1.3 原生调试协议操控页面
- **反反爬**：小红书、知乎、B 站等强反爬站点正常访问，无需额外配置
- **受控组件兼容**：React/Vue 表单通过 prototype setter 注入，不是简单 dispatchEvent
- **内容提取双引擎**：Markdown 结构化 + textContent 全量，按场景选择或组合使用

### 适用场景

- 社交媒体内容采集（小红书/知乎/B 站帖子、评论区）
- 表单自动填写（含 React/Vue 受控组件）
- 页面截图和质量检测
- 网页端到端测试辅助
- 动态 SPA 内容抓取

## 功能清单

| 功能名称 | 功能说明 | 技术栈 | 更新时间 | 版本 |
|---------|---------|--------|----------|------|
| 导航 | 页面跳转、前进后退 | CDP Page | 2026-07-19 | v1.0.0 |
| 页面读取 | 可访问性元素树、关键词搜索、元素等待 | Accessibility Tree | 2026-07-19 | v1.0.0 |
| 鼠标键盘交互 | 点击、输入、滚动、拖拽、悬停 | CDP Input | 2026-07-19 | v1.0.0 |
| 表单填充 | 受控组件兼容的批量表单填写 | prototype setter | 2026-07-19 | v1.0.0 |
| 内容提取 | Markdown 结构化和纯文本两种模式 | content script | 2026-07-19 | v1.0.0 |
| 截图 | 元素截图、区域截图、自动降质 | CDP Screenshot | 2026-07-19 | v1.0.0 |
| JS 执行 | 页面内执行 JavaScript | CDP Runtime | 2026-07-19 | v1.0.0 |
| 调试 | 控制台日志和网络请求读取 | CDP Console/Network | 2026-07-19 | v1.0.0 |
| 标签页管理 | 标签页列表、新建标签页 | chrome.tabs | 2026-07-19 | v1.0.0 |
| 弹窗处理 | alert/confirm/prompt/beforeunload 处理 | CDP Page | 2026-07-19 | v1.0.0 |

## 技术栈

| 技术 | 版本 | 用途 | 官网 |
|------|------|------|------|
| Manifest V3 | — | Extension 声明 | https://developer.chrome.com/docs/extensions/ |
| CDP v1.3 | — | Chrome DevTools Protocol 调试 | https://chromedevtools.github.io/devtools-protocol/ |
| Node.js | >=18 | MCP Server 运行环境 | https://nodejs.org |
| WebSocket | — | Extension ↔ MCP 通信 | — |
| WeakRef | — | 元素 ref 映射（无内存泄漏） | — |

### 技术架构

```
Claude Code ←──stdio──→ MCP Server (index.js) ←──ws:127.0.0.1:19222──→ Edge/Chrome Extension
                                                                                │
                                                                          CDP (DevTools Protocol)
                                                                                │
                                                                         真实浏览器标签页
```

启动流程：
1. Edge/Chrome 加载 Extension（开发者模式）
2. Claude Code 自动拉起 MCP Server
3. Extension 通过 WebSocket 连接 MCP Server
4. 14 个浏览器工具自动注册

## 项目结构

```
claude-code-browser/
├── extension/                      # Chrome/Edge Extension
│   ├── manifest.json               # MV3 清单
│   ├── background.js               # Service Worker
│   ├── popup.html / popup.js       # 连接状态管理 UI
│   ├── content-scripts/
│   │   ├── accessibility-tree.js   # 元素映射系统（WeakRef 双向映射）
│   │   ├── page-bridge.js          # 表单填充、文本提取、元素搜索
│   │   ├── auto-capture.js         # HTML → Markdown 转换
│   │   └── visual-indicator.js     # Shadow DOM 叠加层 UI
│   └── icons/                      # 扩展图标
├── mcp-server/
│   └── index.js                    # MCP Server（双模 WebSocket）
├── docs/                           # 文档站点
│   ├── index.html
│   ├── technical-whitepaper.html
│   ├── project-story.html
│   ├── promo-browser.html
│   ├── promo-wechat.html
├── README_en.md                    # 英文 README
└── LICENSE                         # MIT
```

## 安装说明

### 环境要求

- Node.js >= 18
- Edge 或 Chrome 浏览器
- macOS / Linux / Windows 均可
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 并完成认证

### 安装步骤

```bash
# 方式一：注册 MCP Server
claude mcp add -s user browser -- node /path/to/claude-code-browser/mcp-server/index.js
```

### 加载 Extension

1. 打开 `edge://extensions` 或 `chrome://extensions`
2. 开启"开发者模式"
3. "加载解压缩的扩展" → 选择 `extension/` 目录
4. 确认 Service Worker 无报错

## 使用说明

### 14 个工具一览

#### 导航
| 工具 | 参数 | 说明 |
|------|------|------|
| `navigate` | `url`, `tabId?` | 导航到 URL，支持 `"back"` / `"forward"` 前进后退 |

#### 页面读取
| 工具 | 参数 | 说明 |
|------|------|------|
| `read_page` | `filter?`, `depth?`, `max_chars?`, `tabId?` | 可访问性元素树，带 `[ref_N]` 标识符。`filter="interactive"` 仅交互元素（省 token），`"all"` 全部 |
| `find` | `query`, `max_results?`, `tabId?` | 按关键词搜索元素，多词打分排序，返回 ref 列表 |
| `wait_for` | `selector?`, `text?`, `timeout?`, `tabId?` | 等待元素或文本出现。默认 10s 超时，300ms 轮询 |

#### 交互
| 工具 | 参数 | 说明 |
|------|------|------|
| `computer` | `action` + 12 个可选参数 | 鼠标/键盘/截图/滚动。动作：`left_click`, `right_click`, `double_click`, `type`, `screenshot`, `scroll`, `key`, `hover` 等。中文用 `Input.insertText` + 随机 10-30ms |
| `form_input` | `ref`+`value` 或 `fields[]`, `tabId?` | 设置表单字段值（单个或批量）。React/Vue 受控组件兼容。checkbox 接受 boolean |

#### 内容提取
| 工具 | 参数 | 说明 |
|------|------|------|
| `get_page_text` | `max_chars?`, `tabId?` | 纯文本提取（textContent），自动检测正文容器（10+ 启发式选择器）。适合社交/SPA |
| `get_page_markdown` | `max_chars?`, `tabId?` | 结构化 Markdown — 标题、链接、代码块、表格、图片、列表、引用、折叠块 |

#### JS & 调试
| 工具 | 参数 | 说明 |
|------|------|------|
| `javascript_tool` | `text`, `tabId?` | 在页面执行 JS。10 万字符限制，scripting.executeScript 失败时 CDP 兜底 |
| `read_console_messages` | `tabId`, `onlyErrors?`, `pattern?`, `limit?` | 读取控制台消息。支持正则匹配 |
| `read_network_requests` | `tabId`, `urlPattern?`, `limit?` | 读取 HTTP 网络请求及状态码 |

#### 标签页管理
| 工具 | 参数 | 说明 |
|------|------|------|
| `tabs_context` | — | 列出所有标签页（ID/标题/URL/活跃状态）。含连接健康前缀 |
| `tabs_create` | — | 创建新空白标签页，标题自动加 `[AI]` 前缀 |

#### 弹窗处理
| 工具 | 参数 | 说明 |
|------|------|------|
| `dismiss_dialog` | `action`, `promptText?`, `tabId?` | 关闭浏览器原生对话框（alert/confirm/prompt/beforeunload） |

### 内容提取选择指南

| 场景 | 推荐工具 | 原因 |
|------|---------|------|
| 博客文章、技术文档 | `get_page_markdown` 优先 | 保留结构（标题/代码/表格） |
| 社交媒体（小红书/知乎/B站） | `get_page_text` 优先 | textContent 不漏内容 |
| 产品页面 | `get_page_markdown` 最佳 | 结构信息重要 |
| 复杂 SPA | `get_page_text` 优先 | JS 重应用可能破坏树结构 |
| 不熟悉页面 | 两个都调 | Markdown 看结构 → 纯文本补漏 |

### 典型工作流

#### 小红书搜索 + 帖子阅读
```
1. navigate({ url: "xiaohongshu.com" })
2. read_page({ filter: "interactive" })           → 找到搜索框 [ref_N]
3. computer({ action: "left_click", ref: "ref_N" })
4. computer({ action: "type", text: "关键词\n" })
5. read_page({ filter: "interactive" })           → 看搜索结果
6. computer({ action: "left_click", ref: "ref_M" })     → 点帖子
7. get_page_text({ max_chars: 5000 })             → 读全文
```

#### 表单填写（React/Vue 兼容）
```
1. navigate({ url: "example.com/form" })
2. read_page({ filter: "interactive" })
3. form_input({ fields: [{ref:"ref_N", value:"张三"}, {ref:"ref_M", value:"test@test.com"}] })
4. computer({ action: "left_click", ref: "ref_submit" })
```

#### 弹窗处理
```
1. read_page 时看到:
   ⚠️ Browser dialog active: confirm("确认删除？")
2. dismiss_dialog({ action: "accept" })     → 确认
3. dismiss_dialog({ action: "dismiss" })    → 取消
```

## 开发指南

### 本地开发

没有额外的构建步骤，直接改 `extension/` 或 `mcp-server/` 下的文件即可。

```bash
# MCP Server 开发
cd mcp-server
node index.js
```

### Extension 组件说明

| 组件 | 路径 | 说明 |
|------|------|------|
| Service Worker | `extension/background.js` | 双轨保活、WebSocket 管理、FIFO 命令队列、CDP 管理 |
| 内容脚本 | `extension/content-scripts/` | 4 个独立脚本：元素映射 / 表单填充 / Markdown 转换 / 叠加层 UI |
| Popup | `extension/popup.html/js` | 连接状态、端口配置、标签断开 |
| MCP Server | `mcp-server/index.js` | 双模 WebSocket（服务端/客户端），多客户端路由 |

### 贡献指南

欢迎提交 Issue 和 PR。改动覆盖 Extension 和 MCP Server 两端的请确保两端兼容。

## 常见问题

<details>
<summary>Extension 连接不上 MCP Server？</summary>

1. 确认 MCP Server 已注册：`claude mcp add` 命令是否正确
2. 检查 Extension 的 WebSocket 端口设置（popup 页面可配置，默认 19222）
3. 查看 Service Worker 是否有报错

</details>

<details>
<summary>有些网站操作没有反应？</summary>

检查页面是否是受限 URL（`chrome://`、`edge://`、`about:`、`devtools://`），这些页面被系统拦截。普通网站的交互问题通常可以通过刷新页面或重启 Extension 解决。

</details>

<details>
<summary>合盖后怎么不行了？</summary>

这是 Chrome 浏览器本身的限制——电池睡眠时 Chrome 暂停 CDP 连接。合盖前请确保不需要使用浏览器自动化，或重新加载 Extension。

</details>

## 安全设计

| 机制 | 说明 |
|------|------|
| 本地 WebSocket | 仅 `127.0.0.1:19222`，不暴露到网络 |
| 受限 URL 拦截 | 阻止 `chrome://`, `edge://`, `about:`, `devtools://` |
| CDP 独占 | 只有 Extension 操作 CDP，无直接 DevTools 暴露 |
| PID 文件保护 | `/tmp/claude-browser-mcp.pid`，自动清理过期进程 |
| 标签页隔离 | 每标签独立 CDP session；popup 提供"断开"按钮 |

## 路线图

### 计划功能

- [ ] 多标签页并发操作
- [ ] 录制回放功能
- [ ] Chrome Web Store 上架
- [ ] 更多 CDP 域支持

### 优化计划

- [ ] FIFO 队列改为并发队列
- [ ] 截图降质算法优化（二分法替代线性递减）
- [ ] 端到端健康检查机制

## License

[MIT](LICENSE)

Copyright (c) 2026 Owen

## Star History

如果觉得项目不错，欢迎点个 Star ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=OUENMING/claude-code-browser&type=Date)](https://star-history.com/#OUENMING/claude-code-browser&Date)
