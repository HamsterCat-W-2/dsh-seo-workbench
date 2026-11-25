/**
 * Host half of @local/seo-workbench.
 *
 * Exposes the audit engine as same-origin HTTP routes under /seo-workbench/api/,
 * which the Client half calls with plain fetch (same-origin, credentialed).
 *
 * Routes:
 *   POST /seo-workbench/api/audit    { url, fetchTimeoutMs?, maxRedirects? } → AuditReport
 *   POST /seo-workbench/api/deep     { url, psiKey? } → PageSpeed Insights result (CWV + Lighthouse + schema)
 *   GET  /seo-workbench/api/models   → { status, providers: [{ id, name, models: [{ id, name }] }] }
 *   POST /seo-workbench/api/advice   { url, report, model: { provider, model } } → { status, text }
 *   POST /seo-workbench/api/testkey  { psiKey } → { status, verdict } | { status, error: { code, message, hint } }
 *
 * Model catalog and AI advice come from the Host `llm` service (injected below).
 * Messages are built as plain objects and text chunks are accumulated defensively
 * because linked bundles cannot import @deepseek-ai/dsh-llm (see NOTE).
 */

import { runAudit, runPageSpeed } from './lib/engine.js';
import { runLocalDeep } from './lib/localdeep.js';
import { analyzeKeywords, joinSearchData } from './lib/keywords.js';
import { crawlSite } from './lib/crawl.js';
import { buildSiteReport } from './lib/site.js';
import { runCrux } from './lib/crux.js';
import { runBingSearch } from './lib/bing.js';
import { buildAuthUrl, exchangeCode, listSites, searchAnalytics, listSitemaps, inspectUrls } from './lib/gsc.js';

export const inject = ['webServer', 'llm', 'tools'];

/*
 * NOTE: no `Config` schema export on purpose — linked bundles must not import
 * external @deepseek-ai/* packages (default node resolution walks the real
 * path, so e.g. @deepseek-ai/schemastery cannot be resolved from the linked
 * package dir, and the row fails activation). Tunables are read from the row
 * `config` object below (a patch row may still carry `config: { … }` — it is
 * passed to apply even without a Config schema) and from environment vars.
 */

const API = '/seo-workbench/api/';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding && req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 128 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function createUrlHandler(run) {
  return (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    readBody(req)
      .then(async (raw) => {
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { error: 'bad-json' });
          return;
        }
        const url = body && typeof body.url === 'string' ? body.url.trim() : '';
        if (!url) {
          sendJson(res, 400, { error: 'missing-url' });
          return;
        }
        try {
          sendJson(res, 200, await run(url, body));
        } catch (err) {
          sendJson(res, 500, { error: 'internal', message: String((err && err.message) || err) });
        }
      })
      .catch(() => sendJson(res, 400, { error: 'bad-body' }));
  };
}

/** Best-effort text of one stream chunk across `llm.stream` delta shapes. */
function chunkText(chunk) {
  if (!chunk) return '';
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk.text === 'string' && (chunk.type === 'text' || chunk.type === 'text-delta' || chunk.type === undefined)) {
    return chunk.text;
  }
  if (chunk.delta && typeof chunk.delta.text === 'string') return chunk.delta.text;
  return '';
}

/** Full text of a terminal message chunk, if the chunk carries one. */
function messageText(chunk) {
  if (!chunk) return '';
  const parts = chunk.message && Array.isArray(chunk.message.content) ? chunk.message.content : Array.isArray(chunk.content) ? chunk.content : null;
  if (!parts) return '';
  return parts
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/** Map a Google PageSpeed error message to an actionable Chinese hint. */
function explainPsiError(message) {
  const m = String(message || '');
  if (/quota\s+exceeded/i.test(m)) {
    return 'PageSpeed 免费匿名配额已用尽（报错来自匿名身份或该 key 所属的项目）。请填写你自己的 API Key（设置 → PageSpeed API Key），或在 Google Cloud 新建一个项目的 key。';
  }
  if (/permission denied on the service/i.test(m)) {
    return '这个 key 被「应用限制」挡住了：HTTP referrer / IP 限制对本地宿主发出的请求无效（请求没有浏览器 referrer）。请到 Google Cloud → API 和服务 → 凭据 → 编辑该 key：应用限制选「无」，API 限制只保留 PageSpeed Insights API。保存后一般 1–5 分钟生效。';
  }
  if (/api key not valid|invalid api key/i.test(m)) {
    return '这个 key 无效或复制不完整：请重新复制以 AIza 开头的一整串 key（不要带空格或换行）。';
  }
  if (/has not been used in project|not been enabled|not enabled/i.test(m)) {
    return '该 key 所属的 Google Cloud 项目没有启用 PageSpeed Insights API：请到 Google Cloud → API 和服务 → 库 → 搜索并启用「PageSpeed Insights API」（注意是 key 所在的那个项目）。';
  }
  if (/requests from referer/i.test(m)) {
    return '这个 key 限制了 HTTP referrer：到 Google Cloud 编辑 key，把应用限制改为「无」。';
  }
  if (/billing/i.test(m)) {
    return '该 key 的项目需要启用结算（Billing）：到 Google Cloud 绑定结算账号后再试（PSI 免费额度一般不需要，但被组织策略限制时会出现这条）。';
  }
  return '';
}

function buildAdvicePrompt(url, report, extras = {}) {
  const score = report && report.score ? report.score : {};
  const groups = Array.isArray(report && report.groups) ? report.groups : [];
  const issues = Array.isArray(report && report.issues) ? report.issues : [];
  const groupLines = groups.map((g) => `- ${g.id}（${g.label || ''}）：${g.score ?? '?'}/100`).join('\n');
  const issueLines = issues
    .slice(0, 12)
    .map((i, n) => `${n + 1}. [${i.severity || 'medium'}] ${i.title || i.id} — ${i.detail || i.evidence || ''}`)
    .join('\n');

  const blocks = [];
  // 深度检测（本机 Chrome Lab CWV）
  if (extras.deep && extras.deep.status === 'ok') {
    const d = extras.deep;
    const cwv = d.cwv || {};
    const parts = [];
    if (cwv.lcpMs != null) parts.push(`LCP ${cwv.lcpMs}ms`);
    if (cwv.fcpMs != null) parts.push(`FCP ${cwv.fcpMs}ms`);
    if (cwv.ttfbMs != null) parts.push(`TTFB ${cwv.ttfbMs}ms`);
    if (cwv.cls != null) parts.push(`CLS ${cwv.cls}`);
    if (cwv.inpMs != null) parts.push(`INP ${cwv.inpMs}ms`);
    if (cwv.tbtMs != null) parts.push(`TBT ${cwv.tbtMs}ms`);
    blocks.push(`实验室性能（本机 Chrome 实测）：${parts.length ? parts.join('，') : '（无有效指标）'}`);
  }
  // CrUX 字段数据（真实用户 p75）
  if (extras.crux && extras.crux.status === 'ok' && extras.crux.data && extras.crux.data.hasData) {
    const c = extras.crux.data;
    const cwv = c.cwv || {};
    const parts = [];
    if (cwv.lcpMs != null) parts.push(`LCP ${cwv.lcpMs}ms`);
    if (cwv.cls != null) parts.push(`CLS ${cwv.cls}`);
    if (cwv.inpMs != null) parts.push(`INP ${cwv.inpMs}ms`);
    if (cwv.fcpMs != null) parts.push(`FCP ${cwv.fcpMs}ms`);
    if (cwv.ttfbMs != null) parts.push(`TTFB ${cwv.ttfbMs}ms`);
    blocks.push(`真实用户性能（CrUX p75，${(c.collectionPeriod && c.collectionPeriod.last) || '近 28 天'}）：${parts.length ? parts.join('，') : '（无有效指标）'}`);
  }
  // 搜索数据（GSC / 必应）
  const searchResult = extras.search && extras.search.result;
  if (searchResult && searchResult.status === 'ok') {
    const src = searchResult.source === 'bing' ? '必应 Webmaster' : 'Google Search Console';
    const t = searchResult.totals || {};
    blocks.push(
      `搜索数据（${src}）：点击 ${t.clicks ?? '?'} · 展示 ${t.impressions ?? '?'} · 平均排名 ${t.avgPosition ?? '?'}`,
    );
    const qs = (searchResult.queries || []).slice(0, 10);
    if (qs.length) blocks.push(`Top 查询词：${qs.map((q) => `「${q.query}」点击 ${q.clicks} 展示 ${q.impressions} 排名 ${q.position}`).join('；')}`);
  }
  // 关键词分析（站内词频 + 缺口）
  if (extras.keywords && extras.keywords.status === 'ok') {
    const kd = extras.keywords;
    const top = (kd.keywords || []).slice(0, 10);
    if (top.length) blocks.push(`站内 Top 关键词：${top.map((k) => `「${k.keyword}」频次 ${k.count} · 覆盖 ${k.pages} 页${k.search ? ` · 点击 ${k.search.clicks} 展示 ${k.search.impressions} 排名 ${k.search.position}` : ''}`).join('；')}`);
    if ((kd.clusters || []).length) blocks.push(`自相残杀（${kd.clusters.length} 组）：${kd.clusters.slice(0, 5).map((c) => `「${c.keyword}」在 ${c.pages.map((p) => p.url).join('、')} 重复`).join('；')}`);
    if ((kd.unmatchedQueries || []).length) blocks.push(`内容缺口：${kd.unmatchedQueries.slice(0, 5).map((q) => `「${q.query}」展示 ${q.impressions} 点击 ${q.clicks}`).join('；')}`);
  }
  // 站点体检页面级标志（抽样）
  if ((report.pages || []).length) {
    const flagged = (report.pages || []).filter((p) => p.thin || p.dupTitle || p.orphan || p.noindex || p.missingH1 || p.failed).slice(0, 10);
    if (flagged.length) blocks.push(`问题页面：${flagged.map((p) => `${p.url}（${[p.failed && '抓取失败', p.noindex && 'noindex', p.thin && '薄内容', p.dupTitle && '重复标题', p.orphan && '孤儿页', p.missingH1 && '缺 H1'].filter(Boolean).join(',') || '…'}）`).join('；')}`);
  }

  return [
    '你是一位资深技术 SEO 顾问。下面是一个网站的自动体检结果，请用中文给出修复建议。',
    '',
    `网站：${url}`,
    `总分：${score.total ?? '?'}/100`,
    `分组得分：\n${groupLines || '（无）'}`,
    `问题清单（已按严重度排序）：\n${issueLines || '（未发现问题）'}`,
    blocks.length ? `补充数据：\n${blocks.join('\n')}` : '',
    '',
    '要求：',
    '1. 输出一份可执行的修复清单，按影响从大到小排序，最多 8 条；',
    '2. 每条一句话说明问题，一句话给出具体做法（标签、属性、跳转、压缩等具体值）；',
    '3. 结合补充数据（真实用户性能、搜索流量、站内关键词）判断优先级——流量高但排名靠后的词优先处理；',
    '4. 最后用 2–3 句话总结最值得优先处理的事项；',
    '5. 只输出正文，不要客套话，不要重复我给的列表。',
  ].join('\n');
}

/* ------------------------------------------------------------------------ *
 * Agent tools — registered into the Host `tools` service so any DSH chat
 * agent can call the workbench directly ("帮我分析 https://x.com 的 SEO").
 * Results are bounded Chinese markdown summaries: the deep link (full report,
 * history, exports) stays in the sidebar workbench.
 * ------------------------------------------------------------------------ */

const TOOL_OUTPUT = { schema: { type: 'string' }, render: (_args, value) => String(value ?? '') };

function failText(result) {
  const e = (result && result.error) || {};
  return `❌ 分析失败：${e.message || e.code || '未知错误'}`;
}

function groupLine(report) {
  return (report && Array.isArray(report.groups) ? report.groups : [])
    .map((g) => `${g.label || g.id} ${g.score ?? '?'}/100`)
    .join(' · ');
}

function issuesLine(report, limit = 5) {
  const issues = (report && Array.isArray(report.issues) ? report.issues : []).slice(0, limit);
  if (!issues.length) return '（未发现问题）';
  return issues
    .map((i, n) => `${n + 1}. [${i.severity || 'medium'}] ${i.title || i.id}${i.pages && i.pages.length ? `（涉及 ${i.pages.length} 页）` : ''}`)
    .join('\n');
}

function summarizePage(report) {
  if (!report || report.status === 'error') return failText(report);
  const page = report.page || {};
  return [
    `## 单页 SEO 体检：${report.url}`,
    `- 总分 **${report.score ? report.score.total : '?'}/100** · ${groupLine(report)}`,
    `- HTTP ${page.httpStatus ?? '?'} · 重定向 ${(page.redirectChain || []).length} 跳 · 体积 ${page.bytes ? `${Math.round(page.bytes / 1024)} KB` : '?'}`,
    `- 问题 ${(report.issues || []).length} 条：`,
    issuesLine(report),
    '',
    '（完整报告、评分明细与导出在侧边栏「SEO 分析」工作台里）',
  ].join('\n');
}

function summarizeSite(report) {
  if (!report || report.status === 'error') return failText(report);
  const stats = report.stats || {};
  return [
    `## 站点 SEO 体检：${report.url}`,
    `- 抓取 ${stats.pages ?? 0} 页（成功 ${stats.ok ?? 0} / 失败 ${stats.failed ?? 0} / robots 跳过 ${stats.skippedDisallowed ?? 0} / 死链 ${stats.deadLinksFound ?? 0}）`,
    `- 总分 **${report.score ? report.score.total : '?'}/100** · ${groupLine(report)}`,
    `- 问题 ${(report.issues || []).length} 条：`,
    issuesLine(report),
    '',
    '（完整页面表、问题详情与导出在侧边栏「SEO 分析」工作台里）',
  ].join('\n');
}

function summarizeKeywords(report) {
  if (!report || report.status === 'error') return failText(report);
  const kw = (report.keywords || []).slice(0, 10);
  const lines = [
    `## 站点关键词分析：${report.url}`,
    `- 抓取 ${(report.stats && report.stats.pages) ?? 0} 页，提取 ${(report.keywords || []).length} 个关键词（源：站内词频；可选合并 GSC/Bing 真实数据）`,
    kw.length
      ? kw.map((k) => `- 「${k.keyword}」频次 ${k.count} · 密度 ${k.density}% · 覆盖 ${k.pages} 页${k.search ? ` · 点击 ${k.search.clicks} 展示 ${k.search.impressions} 排名 ${k.search.position}` : ''}`).join('\n')
      : '（未提取到足够的关键词）',
  ];
  if ((report.clusters || []).length) lines.push(`- 自相残杀 ${report.clusters.length} 组：${report.clusters.slice(0, 5).map((c) => `「${c.keyword}」`).join('、')}`);
  if ((report.unmatchedQueries || []).length) lines.push(`- 内容缺口 ${report.unmatchedQueries.length} 条：${report.unmatchedQueries.slice(0, 5).map((q) => `「${q.query}」`).join('、')}`);
  return lines.join('\n');
}

function summarizeDeep(deep) {
  if (!deep || deep.status === 'error') return failText(deep);
  const cwv = deep.cwv || {};
  const parts = [];
  if (cwv.lcpMs != null) parts.push(`LCP ${cwv.lcpMs}ms`);
  if (cwv.fcpMs != null) parts.push(`FCP ${cwv.fcpMs}ms`);
  if (cwv.ttfbMs != null) parts.push(`TTFB ${cwv.ttfbMs}ms`);
  if (cwv.cls != null) parts.push(`CLS ${cwv.cls}`);
  if (cwv.tbtMs != null) parts.push(`TBT ${cwv.tbtMs}ms`);
  return [
    `## 深度性能检测：${deep.url}`,
    `- 来源：${deep.source === 'local-chrome' ? '本机 Chrome 实测（Lab）' : 'PageSpeed Insights'} · 策略 ${deep.strategy || 'mobile'}`,
    `- ${parts.length ? parts.join(' · ') : '（无有效指标）'}`,
    '- 说明：Lab 数据单次采样，不代表真实用户；交互延迟 INP 无法在 Lab 测量。',
  ].join('\n');
}

function summarizeCrux(result) {
  if (!result || result.status === 'error') return failText(result);
  if (!result.data || !result.data.hasData) return `## 字段数据（CrUX）：${result.origin}\n- 样本不足（站点流量太低，Google 没有足够的真实用户数据）。`;
  const cwv = result.data.cwv || {};
  const parts = [];
  if (cwv.lcpMs != null) parts.push(`LCP ${cwv.lcpMs}ms`);
  if (cwv.cls != null) parts.push(`CLS ${cwv.cls}`);
  if (cwv.inpMs != null) parts.push(`INP ${cwv.inpMs}ms`);
  if (cwv.fcpMs != null) parts.push(`FCP ${cwv.fcpMs}ms`);
  if (cwv.ttfbMs != null) parts.push(`TTFB ${cwv.ttfbMs}ms`);
  const period = result.data.collectionPeriod || {};
  return [
    `## 字段数据（CrUX 真实用户 p75）：${result.origin}`,
    `- ${parts.join(' · ')}`,
    `- 统计区间：${period.first || '?'} ~ ${period.last || '?'}`,
  ].join('\n');
}

function summarizeSearch(result) {
  if (!result || result.status === 'error') return failText(result);
  const src = result.source === 'bing' ? '必应 Webmaster' : 'Google Search Console';
  const t = result.totals || {};
  const lines = [
    `## 搜索数据（${src}）：${result.siteUrl || ''}`,
    `- 点击 ${t.clicks ?? '?'} · 展示 ${t.impressions ?? '?'} · 平均 CTR ${t.avgCtr ?? '?'}% · 平均排名 ${t.avgPosition ?? '?'}（近 28 天）`,
  ];
  (result.queries || []).slice(0, 5).forEach((q) => lines.push(`- 「${q.query}」点击 ${q.clicks} · 展示 ${q.impressions} · 排名 ${q.position}`));
  return lines.join('\n');
}

function seoToolDefinitions(config, baseAuditOptions, basePsiKey) {
  const cfg = config || {};
  const gscCfg = () => ({
    clientId: cfg.gscClientId || process.env.GSC_CLIENT_ID || '',
    clientSecret: cfg.gscClientSecret || process.env.GSC_CLIENT_SECRET || '',
  });
  const str = (desc) => ({ type: 'string', description: desc });
  const num = (desc) => ({ type: 'number', description: desc });

  return [
    {
      name: 'seo_audit_page',
      description: '对单个网页做技术 SEO 体检：可抓取性（robots/sitemap/canonical）、技术基础（HTTPS/混合内容/性能）、On-Page（标题/描述/H1/图片）、内容质量，返回 0–100 总分、分组得分和问题清单。',
      parameters: {
        type: 'object',
        properties: {
          url: str('要分析的网页地址（https:// 开头）'),
          fetchTimeoutMs: num('抓取超时毫秒（1000–60000，默认 15000）'),
        },
        required: ['url'],
      },
      output: TOOL_OUTPUT,
      execute: async (args) => {
        const url = String((args && args.url) || '').trim();
        const report = await runAudit(url, {
          ...baseAuditOptions,
          timeoutMs: clampInt(args && args.fetchTimeoutMs, 1000, 60000, baseAuditOptions.timeoutMs),
        });
        return summarizePage(report);
      },
    },
    {
      name: 'seo_audit_site',
      description: '对一个站点做整站 SEO 体检：从首页+sitemap 出发抓取站内页面（遵守 robots.txt、限深限量），跨页聚合重复标题/描述、薄内容、孤儿页、死链、孤儿、canonical、noindex、hreflang 校验，返回总分、分组得分与按严重度排序的问题清单。耗时较长。',
      parameters: {
        type: 'object',
        properties: {
          url: str('站点地址（最好从首页开始）'),
          maxPages: num('最多抓取页数（2–200，默认 30）'),
          maxDepth: num('最大抓取深度（1–10，默认 3）'),
        },
        required: ['url'],
      },
      output: TOOL_OUTPUT,
      execute: async (args) => {
        const crawl = await crawlSite(String((args && args.url) || '').trim(), {
          maxPages: clampInt(args && args.maxPages, 2, 200, 30),
          maxDepth: clampInt(args && args.maxDepth, 1, 10, 3),
          fetchTimeoutMs: baseAuditOptions.timeoutMs,
          maxRedirects: baseAuditOptions.maxRedirects,
          userAgent: baseAuditOptions.userAgent,
          includePattern: cfg.includePattern || '',
          excludePattern: cfg.excludePattern || '',
          pathQuotas: cfg.pathQuotas || '',
        });
        if (crawl.status === 'error') return summarizeSite(crawl);
        return summarizeSite(buildSiteReport(crawl));
      },
    },
    {
      name: 'seo_keywords',
      description: '分析站点自身内容的关键词：站内词频/密度/页面覆盖、标题/H1/描述命中、自相残杀（多个页面抢同一关键词）与内容缺口。搜索量/热度是外部付费数据（Google Ads / Ahrefs 等），这里不提供。',
      parameters: {
        type: 'object',
        properties: {
          url: str('站点地址'),
          maxPages: num('最多抓取页数（2–200，默认 50）'),
        },
        required: ['url'],
      },
      output: TOOL_OUTPUT,
      execute: async (args) => {
        const report = await analyzeKeywords(String((args && args.url) || '').trim(), {
          maxPages: clampInt(args && args.maxPages, 2, 200, 50),
          fetchTimeoutMs: baseAuditOptions.timeoutMs,
          maxRedirects: baseAuditOptions.maxRedirects,
          userAgent: baseAuditOptions.userAgent,
          includePattern: cfg.includePattern || '',
          excludePattern: cfg.excludePattern || '',
          pathQuotas: cfg.pathQuotas || '',
        });
        return summarizeKeywords(report);
      },
    },
    {
      name: 'seo_deep',
      description: '实测网页的 Core Web Vitals：用本机安装的 Google Chrome 无头渲染页面（LCP/FCP/TTFB/CLS/TBT），不需要任何 API Key；本机没有 Chrome 时回退 PageSpeed Insights（需要配置 key）。',
      parameters: {
        type: 'object',
        properties: { url: str('网页地址') },
        required: ['url'],
      },
      output: TOOL_OUTPUT,
      execute: async (args) => {
        const url = String((args && args.url) || '').trim();
        const local = await runLocalDeep(url, { chromePath: cfg.chromePath || process.env.SEO_WB_CHROME_PATH });
        if (local.status === 'ok') return summarizeDeep(local);
        if (!basePsiKey) return summarizeDeep(local);
        const psi = await runPageSpeed(url, { key: basePsiKey });
        if (psi && psi.status === 'ok') {
          return summarizeDeep({
            ...psi,
            url,
            strategy: 'mobile',
            source: 'psi',
            cwv: psi.cwv || {},
          });
        }
        return `${summarizeDeep(local)}\n\nPSI 回退也失败：${(psi && psi.error && psi.error.message) || '未知'}`;
      },
    },
    {
      name: 'seo_crux',
      description: '读取 Google Chrome UX Report（CrUX）的字段 Core Web Vitals（真实用户 28 天 p75），与本地 Chrome 实测互补。需要 CrUX API Key（设置或环境变量 CRUX_API_KEY）；低流量站点会返回样本不足。',
      parameters: {
        type: 'object',
        properties: { url: str('网页地址') },
        required: ['url'],
      },
      output: TOOL_OUTPUT,
      execute: async (args) => summarizeCrux(await runCrux(String((args && args.url) || '').trim(), { key: cfg.cruxKey || process.env.CRUX_API_KEY || '' })),
    },
    {
      name: 'seo_bing',
      description: '读取必应 Webmaster 的搜索数据：点击、展示、平均排名、Top 查询词与页面。需要必应 Webmaster API Key（设置或环境变量 BING_API_KEY）。',
      parameters: {
        type: 'object',
        properties: { url: str('站点地址') },
        required: ['url'],
      },
      output: TOOL_OUTPUT,
      execute: async (args) => summarizeSearch(await runBingSearch(String((args && args.url) || '').trim(), { apiKey: cfg.bingApiKey || process.env.BING_API_KEY || '' })),
    },
    {
      name: 'seo_gsc_search',
      description: '读取 Google Search Console 的搜索数据（点击/展示/CTR/平均排名与 Top 查询词），复用工作台的 GSC OAuth 授权；需要 OAuth Client ID/Secret 与已授权令牌。',
      parameters: {
        type: 'object',
        properties: {
          url: str('站点地址（GSC 已验证的站点）'),
          days: num('统计天数（7–90，默认 28）'),
          clientId: str('OAuth Client ID（可选，默认读设置/环境变量）'),
          clientSecret: str('OAuth Client Secret（可选）'),
          accessToken: str('访问令牌（可选，默认读设置）'),
          refreshToken: str('刷新令牌（可选）'),
          expiresAt: num('访问令牌过期时间 ms（可选）'),
        },
        required: ['url'],
      },
      output: TOOL_OUTPUT,
      execute: async (args) => {
        const a = args || {};
        const c = gscCfg();
        const result = await searchAnalytics({
          clientId: a.clientId || c.clientId,
          clientSecret: a.clientSecret || c.clientSecret,
          accessToken: a.accessToken,
          refreshToken: a.refreshToken,
          expiresAt: Number(a.expiresAt) || 0,
          rawUrl: String(a.url || '').trim(),
          days: clampInt(a.days, 7, 90, 28),
        });
        return summarizeSearch(result);
      },
    },
  ];
}

export function apply(ctx, config = {}) {
  const baseAuditOptions = {
    timeoutMs: config.fetchTimeoutMs ?? 15000,
    userAgent: config.userAgent || undefined,
    maxRedirects: config.maxRedirects ?? 5,
  };
  const basePsiKey = config.psiKey || process.env.PSI_API_KEY || undefined;
  // Gate for the agent tools: they are `when`-gated so they exist (are
  // described to / callable by agents) only while the workbench panel is
  // open. The client toggles this via POST /api/tools/scope on panel
  // mount/unmount, so other chats are never polluted.
  let toolsEnabled = false;
  const llm = ctx.llm;

  // POST /api/audit — body may override fetch tunables per request.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}audit`,
        handler: createUrlHandler((url, body) => {
          const options = {
            ...baseAuditOptions,
            timeoutMs: clampInt(body && body.fetchTimeoutMs, 1000, 60000, baseAuditOptions.timeoutMs),
            maxRedirects: clampInt(body && body.maxRedirects, 0, 10, baseAuditOptions.maxRedirects),
          };
          return runAudit(url, options);
        }),
      }),
    'seo-workbench: audit route',
  );

  // POST /api/site-audit — crawl the site (robots-respecting, same-host, BFS
  // from the start URL + sitemap, bounded by maxPages/maxDepth) and aggregate
  // cross-page checks into a report shaped like the single-page audit.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}site-audit`,
        handler: createUrlHandler(async (url, body) => {
          const crawl = await crawlSite(url, {
            maxPages: clampInt(body && body.maxPages, 2, 200, 30),
            maxDepth: clampInt(body && body.maxDepth, 1, 10, 3),
            concurrency: clampInt(body && body.concurrency, 1, 8, 4),
            fetchTimeoutMs: clampInt(body && body.fetchTimeoutMs, 1000, 60000, baseAuditOptions.timeoutMs),
            maxRedirects: clampInt(body && body.maxRedirects, 0, 10, baseAuditOptions.maxRedirects),
            userAgent: baseAuditOptions.userAgent,
            deadLinkSample: clampInt(body && body.deadLinkSample, 0, 100, 40),
            includePattern: body && typeof body.includePattern === 'string' ? body.includePattern : (config && config.includePattern) || '',
            excludePattern: body && typeof body.excludePattern === 'string' ? body.excludePattern : (config && config.excludePattern) || '',
            pathQuotas: body && typeof body.pathQuotas === 'string' ? body.pathQuotas : (config && config.pathQuotas) || '',
          });
          if (crawl.status === 'error') return crawl;
          return buildSiteReport(crawl);
        }),
      }),
    'seo-workbench: site-audit route',
  );

  // POST /api/keywords — crawl the site (same machinery as site-audit) and
  // extract real keyword data from the pages' own content: CJK/latin term
  // frequency, density, page coverage, title/H1/description hits, best
  // targeting page, cannibalization clusters (≥2 pages on one keyword) and
  // content gaps. When the client has GSC/Bing query data it is joined here so
  // each keyword carries real clicks/impressions/CTR/position (body.searchQueries).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}keywords`,
        handler: createUrlHandler(async (url, body) => {
          const report = await analyzeKeywords(url, {
            maxPages: clampInt(body && body.maxPages, 2, 200, 50),
            maxDepth: clampInt(body && body.maxDepth, 1, 10, 3),
            concurrency: clampInt(body && body.concurrency, 1, 8, 4),
            fetchTimeoutMs: clampInt(body && body.fetchTimeoutMs, 1000, 60000, baseAuditOptions.timeoutMs),
            maxRedirects: clampInt(body && body.maxRedirects, 0, 10, baseAuditOptions.maxRedirects),
            userAgent: baseAuditOptions.userAgent,
            includePattern: body && typeof body.includePattern === 'string' ? body.includePattern : (config && config.includePattern) || '',
            excludePattern: body && typeof body.excludePattern === 'string' ? body.excludePattern : (config && config.excludePattern) || '',
            pathQuotas: body && typeof body.pathQuotas === 'string' ? body.pathQuotas : (config && config.pathQuotas) || '',
          });
          if (report.status === 'error') return report;
          const queries = Array.isArray(body && body.searchQueries) ? body.searchQueries : [];
          if (queries.length) return joinSearchData(report, { status: 'ok', queries });
          return report;
        }),
      }),
    'seo-workbench: keywords route',
  );

  // POST /api/deep — measure real Core Web Vitals:
  //   1. local headless Chrome (default; no Google dependency, no API key);
  //   2. Google PageSpeed Insights as a fallback when Chrome is unavailable
  //      (body may carry a user-provided PSI API key; errors keep Google's
  //      message verbatim and attach an actionable hint).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}deep`,
        handler: createUrlHandler(async (url, body) => {
          const local = await runLocalDeep(url, {
            timeoutMs: clampInt(body && body.deepTimeoutMs, 15000, 90000, 45000),
            chromePath: config.chromePath || process.env.SEO_WB_CHROME_PATH,
          });
          if (local.status === 'ok') return local;
          // Chrome unavailable → PSI fallback (needs a key; anonymous quota is
          // often exhausted, so without a key we report the local error).
          const key = (body && typeof body.psiKey === 'string' && body.psiKey.trim()) || basePsiKey;
          if (!key) {
            return {
              status: 'error',
              error: {
                code: 'chrome-unavailable',
                message: `${local.error.message} 且未配置 PageSpeed API Key（设置 → PageSpeed API Key），无法做深度检测。`,
              },
            };
          }
          const result = await runPageSpeed(url, { key });
          if (result && result.status === 'error' && result.error) {
            return {
              ...result,
              error: { ...result.error, hint: explainPsiError(result.error.message) },
            };
          }
          return result;
        }),
      }),
    'seo-workbench: deep route',
  );

  // POST /api/testkey — validate a PageSpeed API key with a minimal request,
  // so the user never has to debug Google Cloud blindly.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}testkey`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then(async (raw) => {
              let body;
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const key = body && typeof body.psiKey === 'string' ? body.psiKey.trim() : '';
              if (!key) {
                sendJson(res, 400, { status: 'error', error: { code: 'missing-key', message: '请输入要测试的 PageSpeed API Key' } });
                return;
              }
              const result = await runPageSpeed('https://example.com/', { key, timeoutMs: 30000 });
              if (result.status === 'ok') {
                sendJson(res, 200, { status: 'ok', verdict: '这个 Key 可用：PageSpeed 正常返回了结果。' });
              } else {
                sendJson(res, 200, {
                  status: 'error',
                  error: { ...result.error, hint: explainPsiError(result.error.message) },
                });
              }
            })
            .catch(() => sendJson(res, 400, { status: 'error', error: { code: 'bad-body', message: 'invalid body' } }));
        },
      }),
    'seo-workbench: testkey route',
  );

  // GET /api/models — live provider/model catalog from the Host llm service.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}models`,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          (async () => {
            const providers = [];
            try {
              let list = [];
              if (llm && typeof llm.listProviders === 'function') list = llm.listProviders() || [];
              if (!list.length && llm && typeof llm.listConfigurableProviders === 'function') {
                list = (llm.listConfigurableProviders() || []).map((p) => ({ id: p.provider, name: p.displayName || p.provider }));
              }
              for (const p of list) {
                if (!p || !p.id) continue;
                let models = [];
                try {
                  models = (await llm.listModels(p.id)) || [];
                } catch {
                  models = [];
                }
                providers.push({
                  id: p.id,
                  name: p.name || p.id,
                  models: models.filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.name || m.id })),
                });
              }
            } catch {
              // fall through with whatever was collected
            }
            sendJson(res, 200, { status: 'ok', providers });
          })().catch((err) => sendJson(res, 500, { status: 'error', error: { code: 'models-failed', message: String((err && err.message) || err) } }));
        },
      }),
    'seo-workbench: models route',
  );

  // POST /api/crux — field Core Web Vitals from the Chrome UX Report (real users, p75).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}crux`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then(async (raw) => {
              let body = {};
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const url = body && typeof body.url === 'string' ? body.url.trim() : '';
              const key = (body && typeof body.key === 'string' && body.key.trim()) || (config && config.cruxKey) || process.env.CRUX_API_KEY || '';
              const result = await runCrux(url, { key });
              sendJson(res, 200, result);
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: crux route',
  );

  // POST /api/bing — Bing Webmaster search data (key-based).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}bing`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then(async (raw) => {
              let body = {};
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const url = body && typeof body.url === 'string' ? body.url.trim() : '';
              const apiKey = (body && typeof body.apiKey === 'string' && body.apiKey.trim()) || (config && config.bingApiKey) || process.env.BING_API_KEY || '';
              const result = await runBingSearch(url, { apiKey });
              sendJson(res, 200, result);
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: bing route',
  );

  // GSC (Google Search Console) — OAuth2 + search analytics.
  const gscConfig = () => ({
    clientId: (config && config.gscClientId) || process.env.GSC_CLIENT_ID || '',
    clientSecret: (config && config.gscClientSecret) || process.env.GSC_CLIENT_SECRET || '',
  });
  // Loopback OAuth: the client asks for the consent URL (POST, carrying the
  // user's client id/secret from settings); Google redirects back to the
  // gsc-callback route below, which exchanges the code and parks the token
  // here for the client to pull.
  let gscClientCreds = null;
  let gscPendingToken = null;
  const sendHtml = (res, status, title, body) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>SEO 分析 · Google 授权</title></head><body style="font-family:system-ui;padding:40px;max-width:560px;margin:0 auto;line-height:1.7;color:#333"><h2 style="font-size:18px;margin:0 0 12px">${title}</h2><p style="margin:0">${body}</p></body></html>`,
    );
  };

  // POST /api/gsc/auth-url {clientId, clientSecret} — build the consent URL with
  // a loopback redirect back to this Host (no manual code paste needed).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}gsc/auth-url`,
        handler: (req, res) => {
          readBody(req)
            .then((raw) => {
              let body = {};
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              try {
                const cfg = gscConfig();
                const clientId = (body && body.clientId) || cfg.clientId;
                if (!clientId) {
                  sendJson(res, 200, { status: 'error', error: { code: 'no-client-id', message: '未配置 Google OAuth Client ID（⚙ 设置 → 搜索数据）' } });
                  return;
                }
                const clientSecret = (body && body.clientSecret) || cfg.clientSecret;
                const origin = ctx.webServer.getOrigin ? ctx.webServer.getOrigin() : '';
                const redirectUri = origin ? `${origin}${API}gsc-callback` : 'urn:ietf:wg:oauth:2.0:oob';
                gscClientCreds = { clientId, clientSecret, redirectUri };
                const result = buildAuthUrl({ clientId, redirectUri });
                sendJson(res, 200, result);
              } catch (err) {
                sendJson(res, 500, { status: 'error', error: { code: 'internal', message: String((err && err.message) || err) } });
              }
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: gsc auth-url route',
  );

  // GET /api/gsc-callback?code=... — Google redirects here after consent. The
  // code is exchanged immediately; the token is parked for the client to pull.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}gsc-callback`,
        handler: async (req, res) => {
          try {
            const u = new URL(req.url, 'http://local');
            const code = u.searchParams.get('code');
            const errQ = u.searchParams.get('error');
            if (!code) {
              sendHtml(res, 200, '授权没有完成', errQ ? `Google 返回：${errQ}` : '没有收到授权码（可能取消或拒绝授权）。');
              return;
            }
            const cfg = gscConfig();
            const creds = gscClientCreds || { clientId: cfg.clientId, clientSecret: cfg.clientSecret };
            if (!creds.clientId || !creds.clientSecret) {
              sendHtml(res, 200, '缺少 Client ID / Secret', '请先在 DSH 的 ⚙ 设置 → 搜索数据 里填好 OAuth Client ID 和 Secret，再重新点「获取授权链接」。');
              return;
            }
            // The token exchange MUST repeat the exact redirect_uri that was used
            // for the consent request, otherwise Google answers redirect_uri_mismatch.
            const origin = ctx.webServer.getOrigin ? ctx.webServer.getOrigin() : '';
            const redirectUri = creds.redirectUri || (origin ? `${origin}${API}gsc-callback` : 'urn:ietf:wg:oauth:2.0:oob');
            const result = await exchangeCode({ clientId: creds.clientId, clientSecret: creds.clientSecret, code, redirectUri });
            if (!result || result.status !== 'ok') {
              sendHtml(res, 200, '授权码兑换失败', (result && result.error && result.error.message) || '未知错误');
              return;
            }
            gscPendingToken = {
              accessToken: result.accessToken || '',
              refreshToken: result.refreshToken || '',
              expiresAt: Date.now() + (Number(result.expiresIn) || 3600) * 1000,
            };
            sendHtml(res, 200, '✓ 授权成功', '这个页面可以关掉了，回到 DSH 的「搜索数据」面板即可（令牌会自动收取并保存到本地）。');
          } catch (err) {
            sendHtml(res, 500, '回调处理失败', String((err && err.message) || err));
          }
        },
      }),
    'seo-workbench: gsc callback route',
  );

  // GET /api/gsc/pull-token — one-shot hand-off of the parked OAuth token.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}gsc/pull-token`,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          const token = gscPendingToken;
          gscPendingToken = null;
          sendJson(res, 200, { status: 'ok', token });
        },
      }),
    'seo-workbench: gsc pull-token route',
  );

  // POST /api/gsc/token {clientId, clientSecret, code} — exchange authorization code.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}gsc/token`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then(async (raw) => {
              let body = {};
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const cfg = gscConfig();
              const result = await exchangeCode({
                clientId: (body && body.clientId) || cfg.clientId,
                clientSecret: (body && body.clientSecret) || cfg.clientSecret,
                code: body && body.code,
              });
              sendJson(res, 200, result);
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: gsc token route',
  );

  // POST /api/gsc/sites — list verified properties (token may refresh).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}gsc/sites`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then(async (raw) => {
              let body = {};
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const cfg = gscConfig();
              const result = await listSites({
                clientId: (body && body.clientId) || cfg.clientId,
                clientSecret: (body && body.clientSecret) || cfg.clientSecret,
                accessToken: body && body.accessToken,
                refreshToken: body && body.refreshToken,
                expiresAt: body && Number(body.expiresAt) || 0,
              });
              sendJson(res, 200, result);
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: gsc sites route',
  );

  // POST /api/gsc/search {url, days, tokens} — clicks/impressions/position + top queries/pages.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}gsc/search`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then(async (raw) => {
              let body = {};
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const cfg = gscConfig();
              const result = await searchAnalytics({
                clientId: (body && body.clientId) || cfg.clientId,
                clientSecret: (body && body.clientSecret) || cfg.clientSecret,
                accessToken: body && body.accessToken,
                refreshToken: body && body.refreshToken,
                expiresAt: body && Number(body.expiresAt) || 0,
                rawUrl: body && typeof body.url === 'string' ? body.url : '',
                days: body && Number(body.days) || 28,
              });
              sendJson(res, 200, result);
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: gsc search route',
  );

  // POST /api/gsc/sitemaps — submitted vs indexed counts per sitemap.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}gsc/sitemaps`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then(async (raw) => {
              let body = {};
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const cfg = gscConfig();
              const result = await listSitemaps({
                clientId: (body && body.clientId) || cfg.clientId,
                clientSecret: (body && body.clientSecret) || cfg.clientSecret,
                accessToken: body && body.accessToken,
                refreshToken: body && body.refreshToken,
                expiresAt: body && Number(body.expiresAt) || 0,
                rawUrl: body && typeof body.url === 'string' ? body.url : '',
              });
              sendJson(res, 200, result);
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: gsc sitemaps route',
  );

  // POST /api/gsc/inspect {url, urls} — URL Inspection API sampling (index status).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}gsc/inspect`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then(async (raw) => {
              let body = {};
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const cfg = gscConfig();
              const result = await inspectUrls({
                clientId: (body && body.clientId) || cfg.clientId,
                clientSecret: (body && body.clientSecret) || cfg.clientSecret,
                accessToken: body && body.accessToken,
                refreshToken: body && body.refreshToken,
                expiresAt: body && Number(body.expiresAt) || 0,
                rawUrl: body && typeof body.url === 'string' ? body.url : '',
                urls: Array.isArray(body && body.urls) ? body.urls : [],
                limit: Number(body && body.limit) || 25,
              });
              sendJson(res, 200, result);
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: gsc inspect route',
  );

  // POST /api/advice — AI fix plan generated by the model chosen in the client.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}advice`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then(async (raw) => {
              let body;
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const url = body && typeof body.url === 'string' ? body.url.trim() : '';
              const report = body && body.report && typeof body.report === 'object' ? body.report : null;
              const provider = body && body.model && typeof body.model.provider === 'string' ? body.model.provider : '';
              const model = body && body.model && typeof body.model.model === 'string' ? body.model.model : '';
              if (!url || !report) {
                sendJson(res, 400, { status: 'error', error: { code: 'missing-input', message: 'url and report are required' } });
                return;
              }
              if (!llm || !provider || !model) {
                sendJson(res, 400, { status: 'error', error: { code: 'no-model', message: 'DHS 模型服务不可用，或未选择模型' } });
                return;
              }
              const prompt = buildAdvicePrompt(url, report, {
                deep: body && body.deep,
                crux: body && body.crux,
                search: body && body.search,
                keywords: body && body.keywords,
              });
              const signal = AbortSignal.timeout(90000);
              let text = '';
              let fallback = '';
              try {
                for await (const chunk of llm.stream({
                  provider,
                  model,
                  sessionId: 'seo-workbench-advice',
                  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
                  system: '你是资深技术 SEO 顾问，回答简洁、具体、可执行。',
                  temperature: 0.7,
                  signal,
                })) {
                  text += chunkText(chunk);
                  const full = messageText(chunk);
                  if (full) fallback = full;
                }
              } catch (err) {
                sendJson(res, 502, {
                  status: 'error',
                  error: { code: 'llm-failed', message: String((err && err.message) || err || 'llm call failed') },
                });
                return;
              }
              const output = (text || fallback || '').trim();
              if (!output) {
                sendJson(res, 502, { status: 'error', error: { code: 'empty-output', message: '模型没有返回内容，请换个模型再试' } });
                return;
              }
              sendJson(res, 200, { status: 'ok', text: output, model: { provider, model } });
            })
            .catch(() => sendJson(res, 400, { status: 'error', error: { code: 'bad-body', message: 'invalid body' } }));
        },
      }),
    'seo-workbench: advice route',
  );

  // POST /api/tools/scope {enabled} — the client toggles this when the
  // workbench panel mounts/unmounts, so the seo_* agent tools exist only
  // while the panel is open.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}tools/scope`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then((raw) => {
              let body = {};
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              toolsEnabled = body && body.enabled === true;
              sendJson(res, 200, { status: 'ok', enabled: toolsEnabled });
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: tools scope route',
  );

  // Agent tools — `when`-gated so they are described to / callable by agents
  // only while the workbench panel is open (toolsEnabled above). Other chats
  // never see them.
  ctx.effect(
    () => {
      const definitions = seoToolDefinitions(config, baseAuditOptions, basePsiKey);
      const disposers = definitions.map((definition) =>
        ctx.tools.register(definition, { when: () => toolsEnabled }),
      );
      return () => disposers.forEach((disposer) => disposer && disposer());
    },
    'seo-workbench: seo agent tools',
  );
}