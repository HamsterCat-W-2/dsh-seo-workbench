/**
 * Host half of @local/seo-workbench.
 *
 * Exposes the audit engine as two same-origin HTTP routes under /seo-workbench/api/,
 * which the Client half calls with plain fetch (same-origin, credentialed).
 *
 * Routes:
 *   POST /seo-workbench/api/audit  { url } → AuditReport (fetch → parse → checks → score)
 *   POST /seo-workbench/api/deep   { url } → PageSpeed Insights result (CWV + Lighthouse + schema)
 */

import { runAudit, runPageSpeed } from './lib/engine.js';

export const inject = ['webServer'];

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
      if (data.length > 64 * 1024) {
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

function createUrlHandler(run, options) {
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
          sendJson(res, 200, await run(url, options));
        } catch (err) {
          sendJson(res, 500, { error: 'internal', message: String((err && err.message) || err) });
        }
      })
      .catch(() => sendJson(res, 400, { error: 'bad-body' }));
  };
}

export function apply(ctx, config = {}) {
  const auditOptions = {
    timeoutMs: config.fetchTimeoutMs ?? 15000,
    userAgent: config.userAgent || undefined,
    maxRedirects: config.maxRedirects ?? 5,
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}audit`,
        handler: createUrlHandler(runAudit, auditOptions),
      }),
    'seo-workbench: audit route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}deep`,
        handler: createUrlHandler((url) => runPageSpeed(url, { key: config.psiKey || process.env.PSI_API_KEY || undefined }), {}),
      }),
    'seo-workbench: deep route',
  );
}