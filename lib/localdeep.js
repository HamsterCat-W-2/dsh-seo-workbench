// Local deep check: measure real Core Web Vitals with the user's own
// installed Chrome via the DevTools protocol (no Google PSI / no API key).
//
// Why: PSI needs a Google Cloud key whose application restriction rejects
// host-side calls ("Permission denied on the service."), and its anonymous
// quota is shared. A local headless Chrome measures LCP / FCP / CLS / TTFB
// on this machine, which is exactly what a technical SEO lab check needs.
//
// Chrome is spawned with --no-sandbox (headless one-shot profiling run; the
// sandbox cannot initialize under an Electron host). Each run gets its own
// throwaway user-data dir, which is removed afterwards.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.SEO_WB_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
  'chrome',
].filter(Boolean);

const OBSERVER_SRC = `
window.__seoWb = { lcp: null, fcp: null, ttfb: null, cls: 0, longTasksMs: 0, navType: '' };
try {
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) { __seoWb.ttfb = nav.responseStart; __seoWb.navType = nav.type; }
  new PerformanceObserver((l) => { const e = l.getEntries().pop(); if (e) __seoWb.fcp = e.startTime; })
    .observe({ type: 'paint', buffered: true });
  new PerformanceObserver((l) => { const e = l.getEntries().pop(); if (e) __seoWb.lcp = e.startTime; })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  let cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) cls += e.value; } })
    .observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { __seoWb.longTasksMs += Math.max(0, e.duration - 50); } })
    .observe({ type: 'longtask', buffered: true });
  setInterval(() => { __seoWb.cls = cls; }, 300);
} catch (e) { __seoWb.err = String(e); }
`;

const READ_SRC = `(() => {
  try {
    const out = { ...(window.__seoWb || {}), title: document.title, href: location.href };
    const meta = document.querySelector('meta[name="description"]');
    out.description = meta ? (meta.getAttribute('content') || '') : '';
    out.h1Count = document.querySelectorAll('h1').length;
    out.jsonld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((s) => { try { const d = JSON.parse(s.textContent); return (d && (d['@type'] || (Array.isArray(d) && d[0] && d[0]['@type']))) || '?'; } catch { return 'unparsed'; } })
      .filter(Boolean);
    return JSON.stringify(out);
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome(explicit) {
  const list = explicit ? [explicit, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  for (const candidate of list) {
    if (!candidate) continue;
    // Absolute paths are probed on disk; bare commands (google-chrome) are
    // accepted as-is and resolved by spawn through PATH.
    const isPath = candidate.includes('/');
    if (!isPath || existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Connect to Chrome's DevTools WebSocket.
 * Returns a small CDP client: send(method, params, sessionId) / onEvent / close.
 */
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const sessionEvents = new Map();
    let idc = 0;
    ws.onopen = () => {
      resolve({
        send(method, params = {}, sessionId) {
          const id = ++idc;
          const msg = { id, method, params };
          if (sessionId) msg.sessionId = sessionId;
          ws.send(JSON.stringify(msg));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        onEvent(sessionId, handler) {
          const key = sessionId || '*';
          const list = sessionEvents.get(key) || [];
          list.push(handler);
          sessionEvents.set(key, list);
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
    };
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || `CDP ${msg.method} failed`));
        else res(msg.result);
      } else if (msg.method) {
        const list = sessionEvents.get(msg.sessionId) || sessionEvents.get('*') || [];
        for (const h of list) h(msg);
      }
    };
  });
}

/**
 * Measure Core Web Vitals of `url` in a throwaway headless Chrome.
 *
 * @returns {Promise<object>} {status:'ok', source:'local-chrome', ...metrics}
 *   or {status:'error', error:{code,message}} — never throws.
 */
export async function runLocalDeep(url, options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, 15000, 90000, 45000);
  const strategy = options.strategy === 'desktop' ? 'desktop' : 'mobile';
  const started = Date.now();
  const chromePath = findChrome(options.chromePath);
  if (!chromePath) {
    return {
      status: 'error',
      error: { code: 'chrome-unavailable', message: `没有找到可用的 Google Chrome（${CHROME_CANDIDATES.join(' / ')}），无法做本地性能实测。` },
    };
  }

  const userData = mkdtempSync(join(tmpdir(), 'seo-wb-cdp-'));
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${userData}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let wsUrl = '';
  const stderr = chrome.stderr;
  if (stderr) {
    stderr.setEncoding('utf8');
    stderr.on('data', (d) => {
      const m = d.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m && !wsUrl) wsUrl = m[1];
    });
  }

  let cdp = null;
  let targetId = null;
  const cleanup = () => {
    try {
      if (targetId && cdp) cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    } catch {
      /* ignore */
    }
    try {
      if (cdp) cdp.close();
    } catch {
      /* ignore */
    }
    try {
      chrome.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    // Wait for the DevTools endpoint (Chrome re-execs; the ws url arrives on stderr).
    const deadline = Date.now() + 15000;
    while (!wsUrl && Date.now() < deadline) await wait(150);

    if (!wsUrl) {
      cleanup();
      return {
        status: 'error',
        error: { code: 'chrome-start-failed', message: 'Chrome 启动超时或崩溃，无法连接 DevTools（可能被安全策略拦截）。' },
      };
    }

    cdp = await connectCdp(wsUrl);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId;
    const s = (method, params) => cdp.send(method, params, sessionId);

    await s('Page.enable');
    await s('Runtime.enable');
    if (strategy === 'mobile') {
      await s('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
    } else {
      await s('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 2, mobile: false });
    }
    await s('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SRC });

    const loaded = new Promise((resolve) => {
      cdp.onEvent(sessionId, (msg) => {
        if (msg.method === 'Page.loadEventFired') resolve(true);
      });
    });

    await s('Page.navigate', { url });
    await Promise.race([loaded, wait(timeoutMs - 5000)]);
    await wait(2000); // let LCP / CLS settle after load

    const evaluated = await s('Runtime.evaluate', { expression: READ_SRC, returnByValue: true, awaitPromise: true });
    const raw = evaluated && evaluated.result && evaluated.result.value;
    if (!raw) {
      cleanup();
      return { status: 'error', error: { code: 'measure-failed', message: '页面已加载但取不到性能数据。' } };
    }
    const data = JSON.parse(raw);
    if (data.error) {
      cleanup();
      return { status: 'error', error: { code: 'measure-failed', message: String(data.error) } };
    }

    cleanup();

    const lcp = numOrNull(data.lcp);
    const fcp = numOrNull(data.fcp);
    const ttfb = numOrNull(data.ttfb);
    const cls = typeof data.cls === 'number' ? Math.round(data.cls * 1000) / 1000 : null;
    const longTasksMs = numOrNull(data.longTasksMs);
    const jsonld = Array.isArray(data.jsonld) ? data.jsonld : [];

    return {
      status: 'ok',
      source: 'local-chrome',
      strategy,
      url,
      finalUrl: data.href || url,
      title: data.title || '',
      description: data.description || '',
      h1Count: typeof data.h1Count === 'number' ? data.h1Count : 0,
      cwv: { lcpMs: lcp, fcpMs: fcp, ttfbMs: ttfb, cls, inpMs: null, tbtMs: longTasksMs },
      schemaFound: jsonld.length > 0,
      jsonldTypes: jsonld,
      performance: null,
      seo: null,
      accessibility: null,
      bestPractices: null,
      lighthouseIssues: [],
      durationMs: Date.now() - started,
    };
  } catch (err) {
    cleanup();
    return {
      status: 'error',
      error: { code: 'measure-failed', message: err && err.message ? String(err.message) : '本地 Chrome 检测失败。' },
    };
  }
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}