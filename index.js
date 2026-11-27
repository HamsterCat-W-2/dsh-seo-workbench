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
import { fetchPage } from './lib/fetch.js';
import { validateSchema } from './lib/schema.js';
import { pullSemrush, pullUserChrome, activeTabUrl, buildSemrushParsePrompt, normalizeSemrushParse, mirrorUrl } from './lib/semrush.js';

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

/**
 * Build the prompt for the batch fix-plan route: generate concrete title /
 * meta description rewrites for pages with title/description problems.
 */
function buildFixPlanPrompt(url, report, extras = {}) {
  const isSite = report && report.mode === 'site';
  const flagNames = (p) =>
    [
      p.failed && '抓取失败',
      p.noindex && 'noindex',
      p.thin && '薄内容',
      p.dupTitle && '标题重复',
      p.dupDesc && '描述重复',
      p.orphan && '孤儿页',
      p.missingH1 && '缺H1',
      p.missingCanonical && '缺canonical',
      p.missingTitle && '缺标题',
      p.missingDesc && '缺描述',
    ]
      .filter(Boolean)
      .join('、');
  let pageLines = '';
  if (isSite) {
    const flagged = (report.pages || []).filter((p) => p.failed || p.noindex || p.thin || p.dupTitle || p.dupDesc || p.orphan || p.missingH1 || p.missingTitle || p.missingDesc || p.missingCanonical).slice(0, 10);
    pageLines = flagged.length
      ? flagged.map((p) => `- url: ${p.url}\n  title: ${p.title || '（无）'}\n  words: ${p.words ?? '?'}\n  flags: ${flagNames(p) || '无'}`).join('\n')
      : '（没有标题/描述相关问题页面）';
  } else {
    const p = report && report.page ? report.page : {};
    pageLines = `- url: ${url}\n  title: ${p.title || '（无）'}\n  description: ${p.description || '（无）'}\n  words: ${p.words ? p.words.total : '?'}\n  flags: ${(report.issues || []).map((i) => i.title).join('、') || '无'}`;
  }
  const maxCount = isSite ? 8 : 1;
  return [
    '你是一位资深技术 SEO 编辑。基于下面的页面数据，为存在标题/描述问题的页面批量生成修复方案。',
    '',
    `网站：${url}`,
    `页面数据：\n${pageLines || '（无）'}`,
    '',
    `要求：只输出一个 JSON 数组，包含最多 ${maxCount} 个元素，每个元素格式：`,
    '{"url":"页面完整地址","title":"建议的新标题","description":"建议的新 meta description","issues":["涉及的现有问题标签"],"note":"一句生成依据"}',
    '',
    '硬性规则：',
    '1. 只输出 JSON 数组本身，不要 Markdown 代码围栏、不要注释、不要前后缀文字；',
    '2. 中文标题不超过 60 字符，中文描述不超过 150 字符；',
    '3. 标题自然包含主关键词，避免关键词堆砌；描述一句话概括页面价值并引导点击；',
    '4. 保留品牌名（如果有）；不要凭空发明页面不存在的业务内容；',
    '5. 只处理列表里"缺标题/缺描述/标题重复/描述重复/薄内容"的页面；没有问题的页面不要包含；',
    '6. 如果某页确实无法安全改写，就把该页的 title/description 设为 "" 并在 note 里说明。',
  ].join('\n');
}

/** Pull the first balanced JSON array out of a model answer (best effort). */
function extractJsonArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  for (let end = text.lastIndexOf(']'); end > start; end = text.lastIndexOf(']', end - 1)) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(value)) return value;
    } catch {
      // keep scanning for an earlier "]" that balances
    }
  }
  return null;
}

/** Pull the first balanced JSON object out of a model answer (best effort). */
function extractJsonObject(text) {
  let idx = -1;
  while ((idx = text.indexOf('{', idx + 1)) !== -1) {
    let depth = 0;
    let inString = false;
    let esc = false;
    for (let i = idx; i < text.length; i += 1) {
      const c = text[i];
      if (inString) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(text.slice(idx, i + 1));
            if (value && typeof value === 'object' && !Array.isArray(value)) return value;
          } catch {
            // keep scanning for another balanced object
          }
          break;
        }
      }
    }
  }
  return null;
}

/** Strict prompt asking the model to complete/repair one JSON-LD block. */
function buildSchemaFixPrompt(url, raw, types, missing) {
  const missLines =
    Array.isArray(missing) && missing.length
      ? missing.map((m) => `- ${m}`).join('\n')
      : '（校验未发现缺失的必需属性，请保持原结构，只做合理补全）';
  return [
    '你是一个资深的技术 SEO / Schema.org 专家。下面是一个网页里提取的 JSON-LD 结构化数据块，以及校验发现的缺失属性。',
    `页面 URL：${url}`,
    `检测到的类型：${(Array.isArray(types) && types.length ? types : ['未知']).join(', ')}`,
    '缺失的必需属性（尽量合理推断补全；不确定的内容用合适占位符，不要编造业务数据）：',
    missLines,
    '',
    '原始 JSON-LD：',
    (raw || '').trim() || '（无）',
    '',
    '要求：只输出修正后的完整 JSON-LD 对象本身（一个 JSON 对象）。',
    '硬性规则：',
    '1. 只输出 JSON 对象，不要 Markdown 代码围栏、不要注释、不要前后缀文字；',
    '2. 必须是合法 JSON，能被 JSON.parse 直接解析；',
    '3. 保留原有类型与已有属性不变，只补齐缺失属性并做合理修正。',
  ].join('\n');
}

/** Strict prompt asking the model to expand keyword candidates for the site. */
function buildKeywordExpandPrompt(url, seeds, topKeywords, clusters, gaps) {
  const seedLines = (seeds || []).length ? seeds.join('、') : '（用户未给种子词，请从站点主题自行推导 3-5 个种子方向）';
  const topLines = (topKeywords || []).length
    ? topKeywords
        .slice(0, 12)
        .map((k) => `「${k.keyword}」频次 ${k.count} · 覆盖 ${k.pages} 页`)
        .join('；')
    : '（无）';
  const clusterLines = (clusters || []).length
    ? clusters
        .slice(0, 5)
        .map((c) => `「${c.keyword}」重复在 ${(c.pages || []).map((pg) => pg.url).join('、')}`)
        .join('；')
    : '（无）';
  const gapLines = (gaps || []).length
    ? gaps
        .slice(0, 8)
        .map((q) => `「${q.query}」展示 ${q.impressions} 点击 ${q.clicks} 排名 ${q.position}`)
        .join('；')
    : '（无）';
  return [
    '你是一个资深 SEO 关键词研究员。根据下面的站点资料，生成一份关键词候选清单（用于内容规划）。',
    '',
    `网站：${url}`,
    `种子词：${seedLines}`,
    `站内已有 Top 关键词：${topLines}`,
    `关键词自相残杀：${clusterLines}`,
    `内容缺口（有搜索展示但站内内容未覆盖的查询）：${gapLines}`,
    '',
    '要求：只输出一个 JSON 数组，最多 24 个元素，每个元素格式：',
    '{"keyword":"候选关键词","intent":"informational|commercial|transactional|navigational","target":"建议落点：已有页面路径（/xxx）或「新页面」","note":"一句话依据（搜索意图 / 竞争判断 / 建议写法）"}',
    '',
    '硬性规则：',
    '1. 只输出 JSON 数组本身，不要 Markdown 代码围栏、不要注释、不要前后缀文字；',
    '2. 关键词使用与站点一致的语言（中文站用中文）；长尾词为主，避免与已有页自相残杀；',
    '3. 不要编造搜索量、CPC、竞争度等外部数据；note 里也不许出现具体数字指标；',
    '4. 优先覆盖「内容缺口」里的查询，其次围绕种子词与 Top 关键词扩展；',
    '5. target 只能填站点已有路径（从站内链接推断）或「新页面」。',
  ].join('\n');
}

/** Sanitize one keyword candidate to plain strings. */
function normalizeKeywordItem(item) {
  const str = (v) => (v == null ? '' : String(v)).trim();
  const intent = str(item && item.intent).toLowerCase();
  const allowed = ['informational', 'commercial', 'transactional', 'navigational'];
  return {
    keyword: str(item && item.keyword),
    intent: allowed.includes(intent) ? intent : 'informational',
    target: str(item && item.target),
    note: str(item && item.note),
  };
}

/** Sanitize one fix-plan item to plain strings. */
function normalizeFixItem(item) {
  const str = (v) => (v == null ? '' : String(v)).trim();
  const issues = Array.isArray(item && item.issues) ? item.issues.map(str).filter(Boolean) : [];
  return {
    url: str(item && item.url),
    title: str(item && item.title),
    description: str(item && item.description),
    issues,
    note: str(item && item.note),
  };
}

/* ------------------------------------------------------------------------ *
 * Embedded chat — the in-workbench conversation. Reuses the same Host `llm`
 * stream as AI 建议, but keeps a message history and streams deltas over SSE
 * so the panel can render the answer live.
 * ------------------------------------------------------------------------ */

/** Compact Chinese context snapshot for the chat system prompt. */
function buildChatContext(url, context) {
  if (!context) return '';
  const lines = [];
  if (url) lines.push(`当前分析的网站：${url}`);
  const report = context.report || null;
  if (report) {
    lines.push(
      `分析总分：${report.score && report.score.total != null ? report.score.total : '?'}/100（${report.mode === 'site' ? '站点体检' : '单页分析'}）`,
    );
    const groups = Array.isArray(report.groups) ? report.groups : [];
    if (groups.length) lines.push(`分组得分：${groups.map((g) => `${g.label || g.id} ${g.score}`).join(' · ')}`);
    const issues = Array.isArray(report.issues) ? report.issues : [];
    if (issues.length) {
      lines.push(
        `问题（${issues.length} 条，按严重度排序）：${issues
          .slice(0, 12)
          .map((i) => `[${i.severity}] ${i.title}`)
          .join('；')}`,
      );
    }
    if (Array.isArray(report.pages) && report.pages.length) lines.push(`站点抓取页数：${report.pages.length} 页`);
  }
  const deep = context.deep || null;
  if (deep && deep.status === 'ok' && deep.cwv) {
    const c = deep.cwv;
    lines.push(
      `深度检测（${deep.source === 'local-chrome' ? '本地 Chrome Lab' : 'PageSpeed'}）：LCP ${c.lcpMs}ms · CLS ${c.cls} · TTFB ${c.ttfbMs}ms · FCP ${c.fcpMs}ms${c.tbtMs ? ` · TBT ${c.tbtMs}ms` : ''}`,
    );
  }
  const crux = context.crux || null;
  if (crux && crux.status === 'ok' && crux.data && crux.data.hasData) {
    const c = crux.data.cwv || {};
    lines.push(`真实用户 CWV（CrUX p75）：LCP ${c.lcpMs}ms · CLS ${c.cls} · INP ${c.inpMs}ms · FCP ${c.fcpMs}ms · TTFB ${c.ttfbMs}ms`);
  }
  const search = context.search || null;
  if (search && search.result && search.result.status === 'ok') {
    const t = search.result.totals || {};
    lines.push(
      `搜索数据（${search.result.source === 'bing' ? '必应 Webmaster' : 'Google Search Console'}）：点击 ${t.clicks ?? '?'} · 展示 ${t.impressions ?? '?'} · 平均排名 ${t.avgPosition ?? '?'}`,
    );
    const qs = (search.result.queries || []).slice(0, 8);
    if (qs.length) lines.push(`Top 查询词：${qs.map((q) => `「${q.query}」点击 ${q.clicks} 展示 ${q.impressions} 排名 ${q.position}`).join('；')}`);
  }
  const kw = context.keywords || null;
  if (kw && kw.status === 'ok' && Array.isArray(kw.keywords) && kw.keywords.length) {
    lines.push(`站内 Top 关键词：${kw.keywords.slice(0, 10).map((k) => `「${k.keyword}」×${k.count} 覆盖 ${k.pages} 页`).join('；')}`);
    if (Array.isArray(kw.clusters) && kw.clusters.length) lines.push(`自相残杀：${kw.clusters.slice(0, 5).map((c) => c.keyword).join('、')}`);
    if (Array.isArray(kw.unmatchedQueries) && kw.unmatchedQueries.length) lines.push(`内容缺口：${kw.unmatchedQueries.slice(0, 5).map((q) => q.query).join('、')}`);
  }
  return lines.join('\n');
}

function chatSystemPrompt(url, context) {
  const block = buildChatContext(url, context);
  return [
    '你是一名内嵌在 DSH「SEO 分析工作台」里的资深技术 SEO 顾问，正在和用户对话。',
    '回答简洁、具体、可执行，用中文；必要时用小标题和 markdown 列表。',
    '只依据下面给出的分析数据回答，不要编造数字；数据缺失时如实说明，再给通用建议。',
    block ? `\n当前分析数据：\n${block}` : '\n当前还没有分析数据。如果用户还没给网址，先邀请他输入网址开始分析；也可以直接回答通用 SEO 问题。',
    '\n如果用户的问题需要新的检测（抓取、关键词、搜索数据、性能等），提醒他可以回到工作台点对应的按钮（分析 / 站点体检 / 关键词 / 搜索数据 / 索引状态 / 性能检测）。',
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

  // POST /api/schema — validate the page's JSON-LD (server HTML; use 深度检测
  // when client-side JS injection is suspected).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}schema`,
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
              if (!url) {
                sendJson(res, 400, { status: 'error', error: { code: 'missing-input', message: 'url is required' } });
                return;
              }
              try {
                const page = await fetchPage(url, {
                  timeoutMs: Number(body.fetchTimeoutMs) || 15000,
                  maxRedirects: Number(body.maxRedirects) || 5,
                });
                sendJson(
                  res,
                  200,
                  validateSchema(page.html, { url, finalUrl: page.finalUrl, fetchedAt: new Date().toISOString() }),
                );
              } catch (err) {
                sendJson(res, 200, {
                  status: 'error',
                  error: { code: (err && err.code) || 'schema-failed', message: (err && err.message) || String(err) },
                });
              }
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: schema route',
  );

  // POST /api/fixplan — batch-generate concrete title / meta description fixes
  // for pages with title/description problems. Strict-JSON prompt; the answer
  // is parsed into a { pages: [...] } plan (raw text kept as fallback).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}fixplan`,
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
              const prompt = buildFixPlanPrompt(url, report);
              const signal = AbortSignal.timeout(90000);
              let text = '';
              let fallback = '';
              try {
                for await (const chunk of llm.stream({
                  provider,
                  model,
                  sessionId: 'seo-workbench-fixplan',
                  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
                  system: '你是资深技术 SEO 编辑，严格按指令输出 JSON。',
                  temperature: 0.5,
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
              const rawList = extractJsonArray(output);
              const pages = Array.isArray(rawList) ? rawList.map(normalizeFixItem).filter((p) => p.url) : [];
              if (!pages.length) {
                sendJson(res, 200, { status: 'ok', pages: [], text: output, model: { provider, model }, parseFailed: true });
                return;
              }
              sendJson(res, 200, { status: 'ok', pages, text: output, model: { provider, model }, parseFailed: false });
            })
            .catch(() => sendJson(res, 400, { status: 'error', error: { code: 'bad-body', message: 'invalid body' } }));
        },
      }),
    'seo-workbench: fixplan route',
  );

  // POST /api/schema-fix — ask the model to complete / repair one JSON-LD
  // block (missing required properties, syntax issues). Returns the corrected
  // JSON-LD object as a pretty-printed string.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}schema-fix`,
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
              const blockRaw = body && typeof body.raw === 'string' ? body.raw.trim() : '';
              const types = Array.isArray(body && body.types) ? body.types.filter((t) => typeof t === 'string').slice(0, 20) : [];
              const missing = Array.isArray(body && body.missing) ? body.missing.filter((m) => typeof m === 'string').slice(0, 40) : [];
              const provider = body && body.model && typeof body.model.provider === 'string' ? body.model.provider : '';
              const model = body && body.model && typeof body.model.model === 'string' ? body.model.model : '';
              if (!url || !blockRaw) {
                sendJson(res, 400, { status: 'error', error: { code: 'missing-input', message: 'url and raw are required' } });
                return;
              }
              if (!llm || !provider || !model) {
                sendJson(res, 400, { status: 'error', error: { code: 'no-model', message: 'DHS 模型服务不可用，或未选择模型' } });
                return;
              }
              const prompt = buildSchemaFixPrompt(url, blockRaw, types, missing);
              const signal = AbortSignal.timeout(90000);
              let text = '';
              let fallback = '';
              try {
                for await (const chunk of llm.stream({
                  provider,
                  model,
                  sessionId: 'seo-workbench-schema-fix',
                  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
                  system: '你是资深技术 SEO 与 Schema.org 专家，严格按指令输出 JSON。',
                  temperature: 0.3,
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
              const parsed = extractJsonObject(output);
              sendJson(res, 200, {
                status: 'ok',
                code: parsed ? JSON.stringify(parsed, null, 2) : output,
                model: { provider, model },
                parseFailed: !parsed,
              });
            })
            .catch(() => sendJson(res, 400, { status: 'error', error: { code: 'bad-body', message: 'invalid body' } }));
        },
      }),
    'seo-workbench: schema-fix route',
  );

  // POST /api/semrush-pull { url, kind?, waitMs? } — read a Semrush page from
  // the local debug Chrome (visible window, persistent profile). Never throws:
  // returns status ok | login-required | error so the client can guide the user.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}semrush-pull`,
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
              if (!url) {
                sendJson(res, 400, { status: 'error', error: { code: 'missing-input', message: 'url is required' } });
                return;
              }
              const kind = ['keywords', 'keyword', 'compare', 'gap'].includes(body.kind) ? body.kind : 'overview';
              const waitMs = Number.isFinite(body.waitMs) ? body.waitMs : undefined;
              const channel = body.channel === 'user-chrome' ? 'user-chrome' : 'debug-window';
              // keyword/compare/gap pages only exist on the mirror tool the user
              // is logged into, so their URLs are derived from the saved link.
              const mirrorKind = kind === 'keyword' || kind === 'compare' || kind === 'gap' ? kind : '';
              const pageUrl = channel === 'user-chrome' && mirrorKind
                ? mirrorUrl(mirrorKind, body.own || url, {
                    base: body.base || url,
                    keyword: body.keyword,
                    competitor: body.competitor,
                    db: body.db,
                  })
                : url;
              if (!pageUrl) {
                sendJson(res, 400, {
                  status: 'error',
                  error: {
                    code: 'missing-input',
                    message: kind === 'keyword' ? 'keyword is required' : 'competitor is required',
                  },
                });
                return;
              }
              const result = channel === 'user-chrome'
                ? await pullUserChrome(pageUrl, { waitMs })
                : await pullSemrush(pageUrl, { kind, waitMs });
              sendJson(res, 200, { ...result, kind, own: body.own || '', competitor: body.competitor || '', keyword: body.keyword || '' });
            })
            .catch(() => sendJson(res, 400, { status: 'error', error: { code: 'bad-body', message: 'invalid body' } }));
        },
      }),
    'seo-workbench: semrush-pull route',
  );

  // POST /api/semrush-parse { url, text, tables, model:{provider,model} } —
  // turn the pulled Semrush page into strict JSON (overview / keywords /
  // competitors / notes). No fabrication: the prompt forbids inventing numbers.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}semrush-parse`,
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
              const text = body && typeof body.text === 'string' ? body.text : '';
              const tables = Array.isArray(body && body.tables) ? body.tables.slice(0, 4) : [];
              const provider = body && body.model && typeof body.model.provider === 'string' ? body.model.provider : '';
              const model = body && body.model && typeof body.model.model === 'string' ? body.model.model : '';
              if (!url || !text) {
                sendJson(res, 400, { status: 'error', error: { code: 'missing-input', message: 'url and text are required' } });
                return;
              }
              if (!llm || !provider || !model) {
                sendJson(res, 400, { status: 'error', error: { code: 'no-model', message: 'DHS 模型服务不可用，或未选择模型' } });
                return;
              }
              const meta = {
                kind: typeof body.kind === 'string' ? body.kind : '',
                own: typeof body.own === 'string' ? body.own : '',
                competitor: typeof body.competitor === 'string' ? body.competitor : '',
                keyword: typeof body.keyword === 'string' ? body.keyword : '',
              };
              const prompt = buildSemrushParsePrompt(url, text, tables, meta);
              const signal = AbortSignal.timeout(90000);
              let out = '';
              let fallback = '';
              try {
                for await (const chunk of llm.stream({
                  provider,
                  model,
                  sessionId: 'seo-workbench-semrush-parse',
                  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
                  system: '你是资深 SEO 数据分析师，严格按指令输出 JSON。',
                  temperature: 0.3,
                  signal,
                })) {
                  out += chunkText(chunk);
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
              const output = (out || fallback || '').trim();
              if (!output) {
                sendJson(res, 502, { status: 'error', error: { code: 'empty-output', message: '模型没有返回内容，请换个模型再试' } });
                return;
              }
              const parsed = extractJsonObject(output);
              sendJson(res, 200, {
                status: 'ok',
                data: normalizeSemrushParse(parsed),
                text: output,
                model: { provider, model },
                parseFailed: !parsed,
              });
            })
            .catch(() => sendJson(res, 400, { status: 'error', error: { code: 'bad-body', message: 'invalid body' } }));
        },
      }),
    'seo-workbench: semrush-parse route',
  );

  // GET /api/semrush-active-tab — read the user's current Chrome tab (URL and
  // title) through the AppleScript helper, so the Semrush tab can be pointed at
  // whatever tool link is open right now (that link keeps changing).
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}semrush-active-tab`,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          activeTabUrl({})
            .then((data) => sendJson(res, 200, data))
            .catch(() =>
              sendJson(res, 200, { status: 'error', error: { code: 'tab-unavailable', message: '读取当前标签页失败' } }),
            );
        },
      }),
    'seo-workbench: semrush-active-tab route',
  );

  // POST /api/keywords-expand — ask the model to generate keyword candidates
  // from the site's own keyword analysis (frequency, cannibalization, gaps)
  // plus optional user seed words. No external volume data involved.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}keywords-expand`,
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
              const pick = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 40) : []);
              const seeds = pick(body && body.seeds).map((x) => x.trim()).filter(Boolean);
              const topKeywords = Array.isArray(body && body.topKeywords) ? body.topKeywords.slice(0, 30) : [];
              const clusters = Array.isArray(body && body.clusters) ? body.clusters.slice(0, 10) : [];
              const gaps = Array.isArray(body && body.gaps) ? body.gaps.slice(0, 20) : [];
              const provider = body && body.model && typeof body.model.provider === 'string' ? body.model.provider : '';
              const model = body && body.model && typeof body.model.model === 'string' ? body.model.model : '';
              if (!url) {
                sendJson(res, 400, { status: 'error', error: { code: 'missing-input', message: 'url is required' } });
                return;
              }
              if (!llm || !provider || !model) {
                sendJson(res, 400, { status: 'error', error: { code: 'no-model', message: 'DHS 模型服务不可用，或未选择模型' } });
                return;
              }
              const prompt = buildKeywordExpandPrompt(url, seeds, topKeywords, clusters, gaps);
              const signal = AbortSignal.timeout(90000);
              let text = '';
              let fallback = '';
              try {
                for await (const chunk of llm.stream({
                  provider,
                  model,
                  sessionId: 'seo-workbench-keywords-expand',
                  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
                  system: '你是资深 SEO 关键词研究员，严格按指令输出 JSON。',
                  temperature: 0.5,
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
              const parsed = extractJsonArray(output);
              const keywords = parsed ? parsed.map(normalizeKeywordItem).filter((k) => k.keyword) : [];
              sendJson(res, 200, {
                status: 'ok',
                keywords,
                text: output,
                model: { provider, model },
                parseFailed: !parsed || keywords.length === 0,
              });
            })
            .catch(() => sendJson(res, 400, { status: 'error', error: { code: 'bad-body', message: 'invalid body' } }));
        },
      }),
    'seo-workbench: keywords-expand route',
  );

  // POST /api/chat — embedded workbench conversation. Streams the model answer
  // as SSE (`data: {"type":"delta","text":…}` events, then "done" or "error").
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}chat`,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' });
            return;
          }
          readBody(req)
            .then((raw) => {
              let body;
              try {
                body = JSON.parse(raw || '{}');
              } catch {
                sendJson(res, 400, { status: 'error', error: { code: 'bad-json', message: 'invalid JSON' } });
                return;
              }
              const modelSel = body && body.model;
              const messages = Array.isArray(body && body.messages) ? body.messages : [];
              if (!messages.length) {
                sendJson(res, 400, { status: 'error', error: { code: 'missing-input', message: '消息不能为空' } });
                return;
              }
              if (!modelSel || !modelSel.provider || !modelSel.model) {
                sendJson(res, 400, { status: 'error', error: { code: 'no-model', message: '请先选择一个模型' } });
                return;
              }
              if (!llm) {
                sendJson(res, 503, { status: 'error', error: { code: 'llm-failed', message: '模型服务不可用' } });
                return;
              }
              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
              });
              let closed = false;
              req.on('close', () => {
                closed = true;
              });
              const send = (payload) => {
                if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
              };
              send({ type: 'start' });
              const chatMessages = messages.slice(-24).map((m) =>
                m.role === 'assistant'
                  ? {
                      role: 'assistant',
                      content: [{ type: 'text', text: String(m.content || '') }],
                      source: { kind: 'model', provider: modelSel.provider, model: modelSel.model },
                    }
                  : { role: 'user', content: [{ type: 'text', text: String(m.content || '') }], source: { kind: 'user' } },
              );
              (async () => {
                let text = '';
                let fallback = '';
                try {
                  for await (const chunk of llm.stream({
                    provider: modelSel.provider,
                    model: modelSel.model,
                    sessionId: 'seo-workbench-chat',
                    messages: chatMessages,
                    system: chatSystemPrompt(body.url, body.context),
                    temperature: 0.7,
                    signal: AbortSignal.timeout(120000),
                  })) {
                    const piece = chunkText(chunk);
                    if (piece) {
                      text += piece;
                      send({ type: 'delta', text: piece });
                    }
                    const full = messageText(chunk);
                    if (full) fallback = full;
                  }
                } catch (err) {
                  send({ type: 'error', code: 'llm-failed', message: String((err && err.message) || err || 'llm call failed') });
                  if (!closed) res.end();
                  return;
                }
                const output = (text || fallback || '').trim();
                if (!output) send({ type: 'error', code: 'empty-output', message: '模型没有返回内容，请换个模型再试' });
                else send({ type: 'done', text: output });
                if (!closed) res.end();
              })();
            })
            .catch(() => sendJson(res, 500, { status: 'error', error: { code: 'internal', message: 'internal' } }));
        },
      }),
    'seo-workbench: chat route',
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