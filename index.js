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
 *
 * Model catalog and AI advice come from the Host `llm` service (injected below).
 * Messages are built as plain objects and text chunks are accumulated defensively
 * because linked bundles cannot import @deepseek-ai/dsh-llm (see NOTE).
 */

import { runAudit, runPageSpeed } from './lib/engine.js';

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

  // POST /api/deep — body may carry a user-provided PageSpeed API key.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}deep`,
        handler: createUrlHandler((url, body) => {
          const key = (body && typeof body.psiKey === 'string' && body.psiKey.trim()) || basePsiKey;
          return runPageSpeed(url, { key });
        }),
      }),
    'seo-workbench: deep route',
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