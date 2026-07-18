# Claude Code 浏览器自动化 — 使用指南

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README_en.md"><img src="https://img.shields.io/badge/English-blue?style=flat-square" alt="English"></a>
</p>

Claude Code 浏览器自动化系统 = Chrome/Edge Extension + MCP Server。让 Claude Code 操控你的真实浏览器——导航、点击、输入、填表、截图、提取内容——全部通过自然语言驱动。

**核心优势**：真实浏览器指纹 + CDP 合成输入 = 绕过小红书/B站/知乎的反爬检测。

---

## 架构

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

---

## 14 个工具

### 导航
| 工具 | 参数 | 说明 |
|------|------|------|
| `navigate` | `url`, `tabId?` | 导航到 URL，支持 `"back"` / `"forward"` 前进后退 |

### 页面读取
| 工具 | 参数 | 说明 |
|------|------|------|
| `read_page` | `filter?`, `depth?`, `max_chars?`, `ref_id?`, `tabId?` | 可访问性元素树，带 `[ref_N]` 标识符。`filter="interactive"` 仅交互元素（省 token），`"all"` 全部。内置活动诊断（控制台错误 + 失败网络请求）和弹窗警告 |
| `find` | `query`, `max_results?`, `tabId?` | 按关键词搜索元素，匹配 text/aria-label/title/role，多词打分排序，返回 ref 列表 |
| `wait_for` | `selector?`, `text?`, `timeout?`, `tabId?` | 等待元素或文本出现。selector 用 CSS 匹配可见元素，text 匹配页面文本。默认 10s 超时，300ms 轮询 |

### 交互
| 工具 | 参数 | 说明 |
|------|------|------|
| `computer` | `action` (+ 12 个可选参数) | 鼠标/键盘/截图/滚动。动作：`left_click`, `right_click`, `double_click`, `triple_click`, `type`, `screenshot`, `screenshot_element`, `wait`, `scroll`, `scroll_to`, `key`, `left_click_drag`, `hover`, `zoom`。点击支持 ref 精确定位或 coordinate 像素坐标。输入：ASCII 逐字符 key 事件+20ms 延迟，中文用 `Input.insertText` + 随机 10-30ms |
| `form_input` | `ref`+`value` 或 `fields[]`, `tabId?` | 设置表单字段值（单个或批量）。批量用 `fields: [{ref, value}]`。React/Vue 受控组件兼容（prototype setter）。checkbox 接受 boolean |

### 内容提取
| 工具 | 参数 | 说明 |
|------|------|------|
| `get_page_text` | `max_chars?`, `tabId?` | 纯文本提取（textContent），自动检测正文容器（10+ 启发式选择器）。最完整不丢内容，适合社交/复杂 SPA。返回标题、URL、来源元素 |
| `get_page_markdown` | `max_chars?`, `tabId?` | 结构化 Markdown — 标题、链接、代码块、表格、图片、列表、引用、折叠块。过滤 <50px 装饰图标。限制表格 10 行/8 列。无内容时提示回退到 get_page_text |

### JS & 调试
| 工具 | 参数 | 说明 |
|------|------|------|
| `javascript_tool` | `text`, `tabId?` | 在页面执行 JS。10 万字符限制，双 eval 包裹兼容表达式和语句。scripting.executeScript 失败时 CDP 兜底 |
| `read_console_messages` | `tabId`, `onlyErrors?`, `pattern?`, `clear?`, `limit?` | 读取控制台消息。支持正则匹配 |
| `read_network_requests` | `tabId`, `urlPattern?`, `clear?`, `limit?` | 读取 HTTP 网络请求及状态码 |

### 标签页管理
| 工具 | 参数 | 说明 |
|------|------|------|
| `tabs_context` | — | 列出所有标签页（ID/标题/URL/活跃状态）。含连接健康前缀 |
| `tabs_create` | — | 创建新空白标签页，标题自动加 `[AI]` 前缀 |

### 弹窗处理
| 工具 | 参数 | 说明 |
|------|------|------|
| `dismiss_dialog` | `action`, `promptText?`, `tabId?` | 关闭浏览器原生对话框（alert/confirm/prompt/beforeunload）。prompt 类型可填入文本 |

---

## 内容提取选择指南

| 场景 | 推荐工具 | 原因 |
|------|---------|------|
| 博客文章、技术文档 | `get_page_markdown` 优先 | 保留结构（标题/代码/表格） |
| 社交媒体（小红书/知乎/B站） | `get_page_text` 优先 | textContent 不漏内容 |
| 产品页面 | `get_page_markdown` 最佳 | 结构信息重要 |
| 复杂 SPA | `get_page_text` 优先 | JS 重应用可能破坏树结构 |
| 不熟悉页面 | 两个都调 | Markdown 看结构 → 纯文本补漏 |

---

## MCP Server (`mcp-server/index.js`)

### 双模式架构

启动时自动判定模式：

**服务端模式**（端口 19222 空闲）：
- 监听 `ws://127.0.0.1:19222`
- 同时接收 Extension 和 Client MCP 连接
- 角色由第一条消息判定：`extension_info`（type: "extension_info"）→ Extension，工具调用（type: "tool_call"）→ Client
- 多客户端支持：`routeTable` 映射请求 ID 到客户端 WebSocket，Extension 回复自动路由回正确客户端
- PID 文件保护 `/tmp/claude-browser-mcp.pid`，自动清理过期进程

**客户端模式**（端口已被占用）：
- 作为客户端连接到已有服务端
- 指数退避重连（500ms × 重试次数，最多 10 次）
- 所有工具调用通过共享服务端路由

### Extension 通信

```
callExtension(tool, args):
  1. 生成唯一消息 ID
  2. 在 pending Map 注册 Promise（30s 超时）
  3. 通过 WebSocket 发送 {type:'tool_call', id, tool, args}
  4. 收到回复 → resolve Promise / reject error
```

### 保活
- 服务端每 20s 发 `{type:'ping'}`
- Extension 回复 `{type:'pong'}`
- 连接断开 → 拒绝所有 pending 请求 → 自动重连

### 特殊处理
- Extension 断开时，`tabs_context` 返回 `[Browser MCP: Extension disconnected]` 而非报错

---

## Extension (`extension/background.js`)

### Service Worker 生命周期

- **双轨保活**：`setInterval` 25s（chrome.storage.local 写入）+ `chrome.alarms` 0.5min（SW 空闲时唤醒）
- **状态持久化**：每 15s 保存 `{tabId, consoleEvents, networkEvents}` 到 `chrome.storage.session`，SW 崩溃恢复
- **初始化**：恢复持久化的标签页状态，重新附加 CDP，恢复事件缓冲区

### WebSocket 管理

- 断线重连：指数退避 1s→2s→4s→8s→10s（最大）
- 连接后发送 `{type:'extension_info', version, capabilities}`
- 服务端 ping/pong 保活

### FIFO 命令队列

工具严格串行执行。单工具超过 5 秒记慢工具警告。`stopRequested` 标志支持通过 popup 按钮中断执行。

### CDP 管理

- CDP v1.3，通过 `chrome.debugger.attach()`
- 附加时启用 Page + Runtime + Network 域
- 受限 URL 拦截：`chrome://`, `edge://`, `about:`, `devtools://`
- 标签关闭自动分离；F12 冲突检测
- 事件监听：console API、异常、网络请求、对话框事件
- HiDPI 截图视口模拟（缩放到 1280px 宽度，截完后恢复）

### Popup (`popup.html` / `popup.js`)

- 连接状态指示器
- 当前标签页信息
- WebSocket 端口配置（永久保存到 chrome.storage.local）
- 断开标签页按钮（分离所有 CDP 会话）

### Content Script 四件套

**`accessibility-tree.js`** — 元素映射系统：
- WeakRef 双向映射（elementMap + reverseMap），无内存泄漏
- `getElementByRef(ref)` / `getRefForElement(el)` — ref 双向查找
- `getElementCoordinates(ref)` — 返回 `{x, y, width, height}`，自动滚动到视口
- `generate(mode, maxDepth, maxChars, focusRef)` — 树生成
  - `interactive` 模式：跳过非交互元素（省 token），不限制深度
  - `all` 模式：深度限制 30，包含所有可见元素
  - hard cap 按字符上限截断，标注最后一个 ref 供续接
  - 显示元素状态：禁用/选中/只读/必填/选择框选项数
  - 显示输入值（不含密码）、链接目标、可访问标签
- 角色检测：30+ HTML 标签→ARIA 角色映射
- 透明度/可见性检测

**`page-bridge.js`** — 页面交互层：
- `getPageText(maxChars)`：10 个启发式选择器自动检测正文（article/main/post-content/entry-content 等），选取内容最大的容器
- `fillForm(ref, value)`：表单字段填充
  - `<select>`：按值或选项文本匹配，触发 change 事件
  - checkbox/radio：设置 `.checked`，触发 change
  - file input：拒绝（需 CDP）
  - text/textarea：prototype setter（`HTMLInputElement.prototype` / `HTMLTextAreaElement.prototype`），兼容 React/Vue 受控组件
  - contentEditable：`execCommand('insertText')` 兜底
  - 填充后将光标设到末尾
  - 事件序列：`InputEvent('input', {inputType:'insertText'})` + `Event('change')`
- `searchElements(query, maxResults)`：多词打分搜索（text/aria-label/role）

**`auto-capture.js`** — HTML→Markdown 转换器：
- 扫描 `h1-h6, p, a, li, pre, code, blockquote, table, img, figure, figcaption, dl, details, strong, em` 等
- 渲染：标题（`#`）、段落、链接 `[text](url)`、代码块（`` ``` ``）、引用（`>`）、图片 `![alt](src)`
- 列表：有序/无序，嵌套递归缩进
- 表格：表头分隔线，限制 10 行/8 列，管道符转义
- Details/summary：`> **标题** > 内容`
- 过滤 <50px 装饰图标

**`visual-indicator.js`** — DOM 叠加层 UI：
- Shadow DOM 容器（z-index 2147483647，默认 pointer-events: none）
- 元素高亮：绿色脉冲边框动画，自动滚入视口
- 状态徽章：⏳ loading / ✅ completed / ❌ error，右上角固定，点击可关闭
- Agent UI：视口绿色脉冲边框 + 底部居中"停止"按钮
- 停止按钮发送 `STOP_TOOL_EXECUTION` 消息
- 7 个消息类型：`SHOW_HIGHLIGHT`, `HIDE_HIGHLIGHT`, `SHOW_STATUS`, `HIDE_STATUS`, `SHOW_AGENT_UI`, `HIDE_AGENT_UI`, `HIDE_ALL`

### 键盘处理

- 键名别名：15+ 映射（return→Enter, cmd→Meta, esc→Escape, up→ArrowUp 等）
- 虚拟键码映射：18 个键码（Enter, Tab, Escape, Backspace, Delete, 方向键, Home, End, PageUp/Down）
- 修饰符解析：`alt+ctrl+shift+t` → 位掩码
- 特殊组合：`Cmd+R` / `Ctrl+R` / `F5` → 刷新页面
- 重复支持（最多 100 次）

### 截图系统

- `takeScreenshot(quality)`：
  - 质量档位：`low`（目标 27KB，q=20→5），`medium`（270KB，q=40→10），`high`（670KB，q=60→20）
  - 迭代降质：从档位质量开始，每次减 5，直到低于阈值或最低质量
  - HiDPI：视口模拟 1280px 宽度，截完后恢复
  - 截图上下文存储用于坐标重映射
- `screenshot_element` 动作：按元素边界裁剪，10% 间距，60% 质量
- `zoom` 动作：区域截图（x0/y0/x1/y1），固定 60% 质量
- 全部 JPEG base64，`captureBeyondViewport: false`, `fromSurface: true`

### 权限清单

- `debugger`, `tabs`, `tabGroups`, `activeTab`, `scripting`, `storage`, `alarms`
- 主机权限：`http://127.0.0.1/*`, `http://localhost/*`, `<all_urls>`
- Content scripts 全部 HTTP/HTTPS 页面 `document_idle` 注入
- MV3 Service Worker（module 类型）

---

## 典型工作流

### 小红书搜索 + 帖子阅读
```
1. navigate({ url: "xiaohongshu.com" })
2. read_page({ filter: "interactive" })          → 找到搜索框 [ref_N]
3. computer({ action: "left_click", ref: "ref_N" })
4. computer({ action: "type", text: "关键词\n" })
5. read_page({ filter: "interactive" })          → 看搜索结果
6. computer({ action: "left_click", ref: "ref_M" })    → 点帖子
7. get_page_text({ max_chars: 5000 })            → 读全文
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

### 弹窗处理
```
1. read_page 时看到:
   ⚠️ Browser dialog active: confirm("确认删除？")
2. dismiss_dialog({ action: "accept" })        → 确认
3. dismiss_dialog({ action: "dismiss" })        → 取消
4. dismiss_dialog({ action: "accept", promptText: "我的输入" })  → prompt 填入文本
```

---

## 安全设计

| 机制 | 说明 |
|------|------|
| 本地 WebSocket | 仅 `127.0.0.1:19222`，不暴露到网络 |
| 受限 URL 拦截 | 阻止 `chrome://`, `edge://`, `about:`, `devtools://` |
| CDP 独占 | 只有 Extension 操作 CDP，无直接 DevTools 暴露 |
| PID 文件保护 | `/tmp/claude-browser-mcp.pid`，自动清理过期进程 |
| JS 工具限制 | 10 万字符上限，双包裹 eval，输出截断 5 万字符 |
| 标签页隔离 | 每标签独立 CDP session；popup 提供"断开"按钮 |
| Content scripts | `document_idle` 注入，Shadow DOM 隔离 UI 样式 |

---

## 已知问题与限制

| 问题 | 状态 | 影响 |
|------|------|------|
| **端口 19222 冲突** — 多 session 抢同一端口 | 已修复：PID 文件 + EADDRINUSE→客户端模式降级 + 3 次重试 | 低：重试加延迟 |
| **FIFO 队列单线程** — 同标签工具串行，卡住阻塞后续 | 未修复 | 中：慢工作流受影响 |
| **MV3 SW 空闲回收** — Chrome 可能约 30s 空闲后销毁 SW | 缓解：双轨保活（interval + alarms） | 罕见：重连 1-2s |
| **截图降级线性** — 逐 5 递减，非二分法 | 未修复 | 低：多 1-2 次 CDP 调用 |
| **waitForLoad 轮询** — 100ms 轮询 status=complete | 未修复 | 低：可能错过 SPA 导航 |
| **无端到端健康检查** — MCP 显示已连但 Extension 可能已掉 | 未修复 | 中：工具调用超时 |
| **Content script 串行注入** — 4 次独立 executeScript | 未修复 | 低：~200ms 感知延迟 |
| **合盖+电池** — Chrome 在电池睡眠时暂停 CDP | 已知限制 | 不可用 |
| **Hover→click bug** — 历史问题，已修（hover 只发 mouseMoved） | 已修复 | — |

---

## 配置

### 安装 MCP 到 Claude Code
```bash
claude mcp add -s user browser -- node /路径/claude-code-browser/mcp-server/index.js
```

### 加载 Extension
1. 打开 `edge://extensions` 或 `chrome://extensions`
2. 开启"开发者模式"
3. "加载解压缩的扩展" → 选 `/路径/claude-code-browser/extension/`
4. 确认 Service Worker 无报错

---

## 技术栈

| 层 | 技术 |
|----|------|
| Extension | Manifest V3, Service Worker, `chrome.debugger` (CDP v1.3), `chrome.scripting` |
| MCP Server | Node.js, `@modelcontextprotocol/sdk`, `ws` (WebSocket Server) |
| Content Scripts | WeakRef 元素映射, prototype setter (表单), Shadow DOM 叠加层 |
| CDP 域 | Page, Runtime, Network, Input, DOM, Emulation |
