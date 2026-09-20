# Claude Code 浏览器自动化

> 让 Claude Code 用自然语言操控你的真实浏览器：导航、点击、输入、填表、截图、提取内容。

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/OUENMING/claude-code-browser)
[![English](https://img.shields.io/badge/English-blue?style=flat-square)](README_en.md)

## 项目介绍

Claude Code 浏览器自动化 = Chrome/Edge Extension + MCP Server。**真实浏览器指纹 + CDP 合成输入**，绕开无头浏览器在小红书、B 站、知乎等强反爬站点的失败。

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
| 内容提取 | Markdown 结构化 / 纯文本，两种模式 | content script | 2026-07-19 | v1.0.0 |
| 截图 | 元素截图、区域截图、自动降质 | CDP Screenshot | 2026-07-19 | v1.0.0 |
| JS 执行 | 页面内执行 JavaScript | CDP Runtime | 2026-07-19 | v1.0.0 |
| 调试 | 控制台日志和网络请求读取 | CDP Console/Network | 2026-07-19 | v1.0.0 |
| 标签页管理 | 标签页列表、新建标签页 | chrome.tabs | 2026-07-19 | v1.0.0 |
| 弹窗处理 | alert/confirm/prompt/beforeunload 处理 | CDP Page | 2026-07-19 | v1.0.0 |
| iframe/Shadow DOM 穿透 | 同源 iframe 与 Shadow DOM 内的元素照样编号 | accessibility-tree 递归 | 2026-09-14 | v1.0.0 |
| 文件上传 | 给 file input 喂本地路径 | CDP DOM.setFileInputFiles | 2026-09-14 | v1.0.0 |
| 页面 diff | `read_page` 只返回自上次完整读取以来的变化 | 按 ref 比对 | 2026-09-14 | v1.0.0 |
| 动作后校验 | 点击/按键后确认页面真的变了，没变就警告 | 双采样基线 | 2026-09-14 | v1.0.0 |
| 健康检查 | 逐跳报告链路断在哪（server→WS→扩展→content script→CDP） | — | 2026-09-14 | v1.0.0 |

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
Claude Code
     ⇅  stdio
MCP Server  (mcp-server/index.js)
     ⇅  WebSocket   ws://127.0.0.1:19222
Extension   (background.js + content-scripts)   独占 CDP · FIFO 队列
     ⇅  CDP (DevTools Protocol)
真实浏览器标签页
```

启动流程：
1. Edge/Chrome 加载 Extension（开发者模式）
2. Claude Code 自动拉起 MCP Server
3. Extension 经 WebSocket 连接 MCP Server
4. 自动注册 16 个浏览器工具

## 项目结构

```
claude-code-browser/
├── extension/                      # Chrome/Edge Extension
│   ├── manifest.json               # MV3 清单
│   ├── background.js               # Service Worker
│   ├── deadline.js                 # 预算/超时的纯函数（可在 node 里单测）
│   ├── popup.html / popup.js       # 连接状态管理 UI
│   ├── content-scripts/
│   │   ├── accessibility-tree.js   # 元素映射系统（WeakRef 双向映射）
│   │   ├── action-resolver.js      # 具名动作 → ref 的确定性解析（resolve_actions）
│   │   ├── page-bridge.js          # 表单填充、文本提取、元素搜索
│   │   ├── auto-capture.js         # HTML → Markdown 转换
│   │   └── visual-indicator.js     # Shadow DOM 叠加层 UI
│   └── icons/                      # 扩展图标
├── mcp-server/
│   ├── index.js                    # MCP Server（双模 WebSocket）
│   └── budget.js                   # 每次调用的预算表与边界归一化（可在 node 里单测）
├── test/                           # 零依赖回归测试（node 直接跑，无框架）
│   ├── action-resolver.test.cjs    # resolve_actions 的三态与 pick 模式
│   ├── budget.test.cjs             # 预算表的边界（脏 timeout / 原型链）
│   └── deadline.test.cjs           # 预算/超时/执行次数的不变式
├── docs/                           # 文档站点
│   ├── index.html
│   ├── technical-whitepaper.html
│   ├── project-story.html
│   ├── promo-browser.html
│   ├── promo-wechat.html
├── ARCHITECTURE.md                 # 架构与已知约束（动手前先读）
├── CLAUDE.md                       # AI agent 入场说明
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
# 注册 MCP Server
claude mcp add -s user browser -- node /path/to/claude-code-browser/mcp-server/index.js
```

### 加载 Extension

1. 打开 `edge://extensions` 或 `chrome://extensions`
2. 开启"开发者模式"
3. "加载解压缩的扩展" → 选择 `extension/` 目录
4. 确认 Service Worker 无报错

## 使用说明

### 16 个工具一览

#### 导航
| 工具 | 参数 | 说明 |
|------|------|------|
| `navigate` | `url`, `tabId?` | 导航到 URL，支持 `"back"` / `"forward"` 前进后退 |

#### 页面读取
| 工具 | 参数 | 说明 |
|------|------|------|
| `read_page` | `filter?`, `depth?`, `max_chars?`, `ref_id?`, `keywords?`, `diff?`, `tabId?` | 可访问性元素树，带 `[ref_N]` 标识符。`filter="interactive"` 仅交互元素（省 token），`"all"` 全部。`keywords` 空格分隔只输出匹配元素。`diff=true` 只返回相对上次快照的变化——按 ref 逐个比对，元素只是移动了不算变化；带过滤的读取不存为基线。结果附带实时诊断（控制台报错、失败的网络请求）和待处理弹窗警告 |
| `find` | `query`, `max_results?`, `tabId?` | 按关键词搜索元素，多词打分排序，返回 ref 列表 |
| `resolve_actions` | `actions[]`, `tabId?` | 把「具名动作」确定性地解析成元素 ref。每个动作声明 `name` + 匹配条件（`role` / `name_contains` / `name_matches` / `text_contains` / `text_matches`），可选 `pick` 选择模式（`first` / `last` / `top` 按页面位置 / `min` / `max` 按数值，配 `pick_from` 正则，默认抓数字）。返回四种状态：✓ 唯一命中、⚠ 多候选无法唯一确定（附候选样本）、✗ 未找到、‼ 参数错误（正则非法等，附原因）。扫描触到上限时另带 `truncated`——此时 `missing` 可能是预算被吃掉，不一定是页面上真的没有。**只读**——拿到 ref 后仍需用 `computer` / `form_input` 执行。与 `find` 的差别：只扫可见可交互元素（不碰折叠菜单和页脚）、能按数值挑「最便宜的票档」、命不中时明说未找到而不是返回空表。⚠️ 只认有 a11y role 的元素，React 无 role 的 div（如小红书的 `...展开`）看不见，那种用 `find` |
| `wait_for` | `selector?`, `text?`, `timeout?`, `tabId?` | 等待元素或文本出现。默认 10s 超时，300ms 轮询 |

#### 交互
| 工具 | 参数 | 说明 |
|------|------|------|
| `computer` | `action` + 13 个可选参数 | 鼠标/键盘/截图/滚动。动作：`left_click`, `right_click`, `double_click`, `triple_click`, `type`, `screenshot`, `screenshot_element`, `wait`, `scroll`, `scroll_to`, `key`, `left_click_drag`, `hover`, `zoom`。文本用 `Input.insertText` 按段批量输入。**点击/按键默认校验页面是否变化**，无变化即警告（`verify: false` 关闭） |
| `form_input` | `ref`+`value` 或 `fields[]`, `tabId?` | 设置表单字段值（单个或批量）。React/Vue 受控组件兼容。checkbox 接受 boolean。file input 走 CDP `DOM.setFileInputFiles`，`value` 须是运行 MCP server 那台机器上的绝对路径；它返回 `status: "need_file_upload"`，与普通失败区分开。没有可写原生 value 的元素（如普通 div）会明确返回失败，不会假装填写成功 |

#### 内容提取
| 工具 | 参数 | 说明 |
|------|------|------|
| `get_page_text` | `max_chars?`, `tabId?` | 纯文本提取（textContent），自动检测正文容器（10+ 启发式选择器）。适合社交/SPA |
| `get_page_markdown` | `max_chars?`, `tabId?` | 结构化 Markdown — 标题、链接、代码块、表格、图片、列表、引用、折叠块 |

#### JS & 调试
| 工具 | 参数 | 说明 |
|------|------|------|
| `health_check` | — | 端到端链路体检：MCP server → WebSocket → 扩展 → 内容脚本 → CDP，逐跳报告状态。工具报错时先用它定位断在哪一跳 |
| `javascript_tool` | `text`, `tabId?` | 在页面执行 JS。10 万字符限制。表达式与语句序列都支持（先只解析一次再决定形态）。**恰好执行一次**；失败返回 `JS_ERROR` 带原因，超出预算返回 `JS_DEADLINE` —— 见「单次调用的预算」 |
| `read_console_messages` | `tabId`, `onlyErrors?`, `pattern?`, `clear?`, `limit?` | 读取控制台消息。支持正则匹配 |
| `read_network_requests` | `tabId`, `urlPattern?`, `clear?`, `limit?` | 读取 HTTP 网络请求及状态码 |

#### 标签页管理
| 工具 | 参数 | 说明 |
|------|------|------|
| `tabs_context` | — | 列出所有标签页（ID/标题/URL/活跃状态）。含连接健康前缀 |
| `tabs_create` | — | 创建新空白标签页，标题自动加 `[AI]` 前缀 |

#### 弹窗处理
| 工具 | 参数 | 说明 |
|------|------|------|
| `dismiss_dialog` | `action`, `promptText?`, `tabId?` | 关闭浏览器原生对话框（alert/confirm/prompt/beforeunload） |

### 单次调用的预算与长任务

每个工具在 server 侧有一个预算，而扩展拿到的截止时间比它早 3 秒——所以**超时总是先在扩展侧变成一条可读的错误**，而不是把调用方挂在传输层，也不是让扩展继续跑一个已经没人要的结果。

| 工具 | 预算 |
|------|------|
| `javascript_tool` / `read_page` / `get_page_text` / `get_page_markdown` / `computer` | 45s |
| `wait_for` | 你传的 `timeout` + 5s |
| `navigate` | 20s |
| `health_check` | 15s |
| `tabs_context` / `tabs_create` | 10s |
| 其它 | 30s |

队列是**全局串行**的（同一时刻只跑一个工具），所以排队时间也算在你自己的预算里。超时会告诉你卡在哪一段：

- `stage: 'queued'` —— 前面的工具吃掉了预算，这次还没开始跑。重试即可。
- `stage: 'executing'` —— 是这次本身跑了太久。

#### 长提取怎么拆

超过约 25 秒的抓取（例如滚动加载一篇文章的全部评论）不要写成一次调用，拆成多次，状态挂在 `window` 上：

```js
// 第 1..N 次：每次只滚几轮，做完就返回进度
(async () => {
  window.__ccC = window.__ccC || { items: new Set(), rounds: 0 };
  for (let i = 0; i < 4; i++) { window.scrollBy(0, 2000); await new Promise(r => setTimeout(r, 700)); }
  window.__ccC.rounds += 4;
  document.querySelectorAll('.comment-item').forEach(n => window.__ccC.items.add(n.innerText.slice(0, 80)));
  return JSON.stringify({ rounds: window.__ccC.rounds, collected: window.__ccC.items.size });
})()

// 最后一次：取回数据
JSON.stringify([...window.__ccC.items])
```

**为什么不能只把预算调大**：CDP 没有可靠的取消手段——能终止的只是「当前」那次脚本执行，而滚动循环每一轮都在 `await` 定时器，外层执行早就结束了。所以超时返回之后，**页面里那段活仍在继续**。把长活拆开会比给它更长的预算更好，也避免紧接着发出一个会跟它打架的调用。

设计取舍与真机实测证据（含两处只有跑起来才发现的问题）见 [`PLAN-DEADLINE-20260920.md`](PLAN-DEADLINE-20260920.md)。

### 内容提取选择指南

| 场景 | 推荐工具 | 原因 |
|------|---------|------|
| 博客文章、技术文档 | `get_page_markdown` 优先 | 保留结构（标题/代码/表格） |
| 社交媒体（小红书/知乎/B站） | `get_page_text` 优先 | textContent 不漏内容 |
| 产品页面 | `get_page_markdown` 最佳 | 结构信息重要 |
| 复杂 SPA | `get_page_text` 优先 | JS 重应用可能破坏树结构 |
| 不熟悉页面 | 两个都调 | Markdown 看结构，纯文本补漏 |

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
逐篇抓「正文 + 全部评论」时，评论要滚动加载——**别把滚动循环写进一次 `javascript_tool`**，按「长提取怎么拆」分成多次调用。一次滚动十几轮很容易跨过 25s 的页面内硬顶。

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

没有额外的构建步骤，直接改 `extension/` 或 `mcp-server/` 下的文件即可。改完**重载扩展**（`edge://extensions` → 刷新）才生效；只改内容脚本的话刷新页面即可。

```bash
# MCP Server 开发
cd mcp-server
node index.js

# 回归测试（零依赖，直接跑，退出码 0 = 全过）
node test/action-resolver.test.cjs    # resolve_actions 的解析三态
node test/budget.test.cjs             # 调用预算表的边界（脏 timeout、原型链）
node test/deadline.test.cjs           # 调用预算 / 超时 / 执行次数的不变式
```

### Extension 组件说明

| 组件 | 路径 | 说明 |
|------|------|------|
| Service Worker | `extension/background.js` | 双轨保活、WebSocket 管理、FIFO 命令队列、CDP 管理 |
| 预算与超时 | `extension/deadline.js` | 纯函数：拼执行表达式、判形态、算页面内预算、分拣结果（可在 node 里单测） |
| 内容脚本 | `extension/content-scripts/` | 5 个独立脚本：元素映射 / 具名动作解析 / 表单填充 / Markdown 转换 / 叠加层 UI |
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
| Markdown 协议白名单 | `get_page_markdown` 只写 http/https/mailto/tel/ftp 与相对路径，`javascript:`、`data:` 等一律丢弃 |

## 路线图

### 计划功能

- [ ] 多标签页并发操作
- [ ] 录制回放功能
- [ ] Chrome Web Store 上架
- [ ] 更多 CDP 域支持

### 优化计划

- [ ] FIFO 队列改为并发队列
- [ ] 截图降质算法优化（二分法替代线性递减）
- [x] 端到端健康检查机制（`health_check` 工具，逐跳报告）

## License

[MIT](LICENSE)

Copyright (c) 2026 Owen

## Star History

<a href="https://www.star-history.com/?repos=OUENMING%2Fclaude-code-browser&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=OUENMING/claude-code-browser&type=date&theme=dark&legend=top-left&sealed_token=1XVxC84Hpu0RJwfCDSX51MDZeW15ak8AkCigZFs43zLKRoT88M-4C3r8f79S3d5qfL3dTQIk6KQ2rwtfMy0QyC1dqnjvqkK6ujtmhY6uSk_Lo1WviIA6Gg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=OUENMING/claude-code-browser&type=date&legend=top-left&sealed_token=1XVxC84Hpu0RJwfCDSX51MDZeW15ak8AkCigZFs43zLKRoT88M-4C3r8f79S3d5qfL3dTQIk6KQ2rwtfMy0QyC1dqnjvqkK6ujtmhY6uSk_Lo1WviIA6Gg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=OUENMING/claude-code-browser&type=date&legend=top-left&sealed_token=1XVxC84Hpu0RJwfCDSX51MDZeW15ak8AkCigZFs43zLKRoT88M-4C3r8f79S3d5qfL3dTQIk6KQ2rwtfMy0QyC1dqnjvqkK6ujtmhY6uSk_Lo1WviIA6Gg" />
 </picture>
</a>
