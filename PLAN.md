# SEO 分析工作台 · DSH 插件方案

## 1. 目标与形态

在 DeepSeek Harness **右侧边栏**新增一个「SEO 分析」页签（dsh 插件形式安装）：

- 输入网址 → 一键跑 SEO 体检
- 面板内查看：综合得分、分项得分、问题清单（Issue / Impact / Evidence / Fix / Priority）
- 结果可导出为 Markdown 报告

## 2. 总体架构

DSH 插件 = **Host 插件（Node 端逻辑）+ Client 插件（浏览器端 UI）**，同一个包里：

```
┌─────────────────────────────────────────────┐
│ Client 插件 (client.js)                      │
│  · sidebarRightTabs.register → 右侧边栏页签   │
│  · React 面板：输入框 / 得分环 / 问题列表 / 导出 │
└──────────────┬──────────────────────────────┘
               │ ctx.remote.<seoService>.runAudit(url)
               ▼
┌─────────────────────────────────────────────┐
│ Host 插件 (index.js + src/engine.js)         │
│  · @Remote 服务方法（数据通道）                 │
│  · SEO 检测引擎：抓取→解析→规则检查→评分         │
│  · ctx.web.fetch 抓页面 / robots.txt / sitemap │
│  · 深度检测可选调 PSI API（真 CWV + schema）     │
└─────────────────────────────────────────────┘
```

- **数据通道**：面板 → `ctx.remote.<seoService>.runAudit(url)` → Host 引擎 → 返回结构化报告 JSON。这是 DSH 文档里「实现一次、双入口」的标准模式（Host 服务方法 + Client 可调用入口）。
- 长任务（如 Phase 2 整站爬取）用 `@Remote mode:'stream'` 推进度帧，面板显示实时进度。

## 3. 功能范围

### MVP（一期）
| 分组 | 检查项 |
|---|---|
| 可抓取与索引 | HTTP 状态码 / 重定向链、robots.txt、XML sitemap 发现与校验、canonical、meta robots / noindex |
| On-Page | title 长度（建议 50–60）、meta description（150–160）、H1 数量与层级结构、img alt、懒加载、结构化数据 schema（SSR 部分直抓原始 HTML 检测） |
| 技术基础 | HTTPS / 混合内容、移动 viewport、hreflang、页面体积、外链/内链数量 |
| 内容质量 | 正文占比（thin content）、重复 title/description、标题层级跳跃 |
| 深度检测（按钮） | 调 Google PageSpeed Insights API：真实 Core Web Vitals（LCP/INP/CLS）+ Lighthouse 审计 + schema 检测兜底（覆盖 JS 注入的 JSON-LD） |

- **评分**：按 SEO 优先级加权（可抓性 > 技术基础 > On-Page > 内容），输出总分 + 分项分。
- **报告格式**：每项问题含 Issue / Impact / Evidence / Fix / Priority（高/中/低），可导出 Markdown。
- **深度检测**：点按钮调 PSI 取真实 CWV + schema，结果并入报告可导出。

### Phase 2（二期）
- **整站爬取**：内链 BFS（页数 / 深度上限由 Config 控制），跨页聚合问题。
- **历史记录**：用 `storageDomain` 保存分析历史，面板内可回看。
- **Agent 工具入口**：把同一引擎再暴露为 agent 工具（user-actions.md 的"一个操作、两个入口"），聊天里也能 `/seo-audit <url>`。

### 以后（可选）
- **外链 / 权威度**：需要第三方 API（如 Ahrefs/Moz），MVP 不做。
- ~~捆绑 Playwright + Chromium（150–300MB）~~ **已砍掉**：体积/进程管理成本不值，真 CWV 和 schema 兜底由 PSI API 覆盖。

## 4. 项目结构

```
seo-workbench-plugin/
├── package.json        # name: @local/seo-workbench, dsh.bundle.patch + dsh.client
├── cordis.patch.yml    # insert 一行: id: seo-workbench, name: @local/seo-workbench
├── index.js            # Host apply(ctx, config)：注册 SEO 服务（@Remote 方法）
├── src/engine.js       # 抓取 + 解析 + 检查规则 + 评分（可无依赖或仅 node-html-parser）
├── client.js           # Client：sidebarRightTabs.register + slots.register（面板组件）
├── locale/
│   ├── en.json         # meta.title / meta.description / 面板文案
│   └── zh.json
├── icon.svg            # ≤256KiB
└── docs/
    ├── DETAIL.md       # 插件详情页（<1MiB）
    └── preview.svg
```

## 5. 关键技术点

### 5.1 右侧边栏页签注册（Client 侧）

```js
// client.js（要点，非完整代码）
ctx.sidebarRightTabs.register({
  id: 'seo-workbench',          // 全局唯一（用包名）
  kind: 'seo-workbench',        // 页签类型标识（openTab 用它打开）
  title: () => 'SEO 分析',       // 打开时捕获
  keepMounted: true,            // 保留已访问的面板
  guide: [{ id, order, title: () => 'SEO 分析', description: () => '网站 SEO 体检工作台', icon }],
});
// 面板主体
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'seo-workbench' }, Body);
// 标题芯片（可显示当前网址/得分）
ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'seo-workbench' }, Title);
```

- Body 组件内用 `useTabInfo()` 拿 `{ sidebar, panel, tab }`，React 从浏览器模块表取（不重复引入 React）。
- guide 只配一项 → 点「SEO 分析」直接打开页签。

### 5.2 Host 检测引擎

- 用 `ctx.web.fetch` 抓取页面 / robots.txt / sitemap（走 DSH 已配置的抓取提供方）。
- 解析：MVP 用轻量 HTML 解析（`node-html-parser` 或自写最小解析器）。
- **schema 检测策略**：`ctx.web.fetch` 会剥掉 `<script>`，所以先**直连抓一份原始 HTML**（保留 `<script>` 标签，捕获 SSR 输出的 JSON-LD——Yoast/AIOSEO 等多数是 SSR 注入）；纯 JS 注入的靠「深度检测」按钮调 PSI 兜底。（直连抓取是否可用在实现时验证，不行则 schema 全靠 PSI。）
- **CWV 策略**：MVP 直接调 Google PageSpeed Insights API 拿真值（LCP/INP/CLS + Lighthouse 审计 + schema）；代理指标（页面重量、img 尺寸等）只作快速参考。
- 规则按优先级分组实现，各组独立打分，按权重合成总分。

### 5.3 Host ↔ Client 数据通道

- Host 在 `apply(ctx, config)` 里注册服务，把方法标 `@Remote`（如 `runAudit(url, opts): Promise<AuditReport>`）。
- Client 面板经 `ctx.remote.<服务名>.runAudit(...)` 调用（这是 DSH 文档 user-actions.md 推荐的模式；确切的 remote 命名空间在实现时用 `cordis_inspect_query` 核对一遍）。
- 大报告直接作为返回值；Phase 2 爬取用 `@Remote mode:'stream'` 推送进度。

### 5.4 配置（Config）

可调项放 Config（升级时用户 patch 层可覆盖）：`fetchTimeoutMs`、`userAgent`、`maxRedirects`、`enabledChecks`、`scoreWeights`、`crawlLimit`（Phase 2）。

### 5.5 安装与激活

- 开发期：`plugin_manager` action `install_bundle`，target 传包目录绝对路径（**每次操作需用户批准**）。
- 激活：新 bundle 可 HMR 激活；**替换已安装的同名包需重启应用**。
- 正式装：Plugins 页「添加插件」选包目录，或由我直接调 install_bundle。
- 改动影响 profile 下所有会话、重启后保留。

## 6. 验证清单

1. `cordis_inspect_query` 确认：服务已注册（@Remote 方法可见）、`sidebar.right.pane.tab` 槽位被占用。
2. 打开右侧边栏「SEO 分析」页签 → 输入测试网址 → 报告渲染、评分正确、问题清单完整。
3. 导出 Markdown 报告可用。
4. zh/en 文案、图标、DETAIL.md 详情页正常。
5. 重启应用后插件仍生效。

## 7. 分阶段开发步骤

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1. 骨架 | package.json + cordis.patch.yml + 空 index/client | install_bundle 可安装、激活无报错 |
| 2. Host 引擎 | 抓取 + 解析 + 核心检查规则 + 评分 + PSI 深度检测调用 | 用 Node 直接跑 engine.js 冒烟（命令行传 URL 出报告） |
| 3. Remote 通道 | 注册服务 + @Remote 方法 | cordis_inspect 可见方法；client 能调到 |
| 4. Client UI | 页签 + 面板（输入框 / 得分环 / 问题列表 / 导出） | 面板完整可用 |
| 5. 打磨 | locale、icon、DETAIL.md、错误态、加载态 | 检查清单 4 通过 |
| 6. 正式安装 | install_bundle / Plugins 添加 | 重启后生效 |

## 8. 风险与注意

- **schema 检测分两段**：SSR 部分靠直抓原始 HTML；JS 注入部分靠 PSI 兜底——纯客户端渲染且 PSI 不可用的站点会漏，报告注明。
- **PSI 依赖网络与配额**：深度检测按钮需要能访问 Google API（国内环境可能不通，做失败降级提示）；免费配额有限，按钮式按需调用。
- **替换安装需重启** → 迭代时改包名或接受重启。
- **plugin_manager 操作需批准** → 每次安装/替换都会弹审批。
