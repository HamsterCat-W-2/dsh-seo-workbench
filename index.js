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
import { buildAuthUrl, exchangeCode, listSites, searchAnalytics } from './lib/gsc.js';

export const inject = ['webServer', 'llm'];

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

function buildAdvicePrompt(url, report) {
  const score = report && report.score ? report.score : {};
  const groups = Array.isArray(report && report.groups) ? report.groups : [];
  const issues = Array.isArray(report && report.issues) ? report.issues : [];
  const groupLines = groups.map((g) => `- ${g.id}（${g.label || ''}）：${g.score ?? '?'}/100`).join('\n');
  const issueLines = issues
    .slice(0, 12)
    .map((i, n) => `${n + 1}. [${i.severity || 'medium'}] ${i.title || i.id} — ${i.detail || i.evidence || ''}`)
    .join('\n');
  return [
    '你是一位资深技术 SEO 顾问。下面是一个网站的自动体检结果，请用中文给出修复建议。',
    '',
    `网站：${url}`,
    `总分：${score.total ?? '?'}/100`,
    `分组得分：\n${groupLines || '（无）'}`,
    `问题清单（已按严重度排序）：\n${issueLines || '（未发现问题）'}`,
    '',
    '要求：',
    '1. 输出一份可执行的修复清单，按影响从大到小排序，最多 8 条；',
    '2. 每条一句话说明问题，一句话给出具体做法（标签、属性、跳转、压缩等具体值）；',
    '3. 最后用 2–3 句话总结最值得优先处理的事项；',
    '4. 只输出正文，不要客套话，不要重复我给的列表。',
  ].join('\n');
}

export function apply(ctx, config = {}) {
  const baseAuditOptions = {
    timeoutMs: config.fetchTimeoutMs ?? 15000,
    userAgent: config.userAgent || undefined,
    maxRedirects: config.maxRedirects ?? 5,
  };
  const basePsiKey = config.psiKey || process.env.PSI_API_KEY || undefined;
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
              const prompt = buildAdvicePrompt(url, report);
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
}