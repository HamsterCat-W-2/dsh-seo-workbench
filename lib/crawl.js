/**
 * Site crawler: same-origin BFS over sitemap seeds + discovered internal links.
 * Respects robots.txt Disallow rules (basic pattern matching), stays on one host,
 * bounded by maxPages / maxDepth / concurrency.
 */

import { fetchPage, fetchText, FetchError, isHttpUrl, DEFAULT_USER_AGENT } from './fetch.js';
import { parsePage, extractAnchors, parseRobots } from './parse.js';

const HTMLISH = /(^text\/html|^application\/xhtml\+xml|^application\/xml|^text\/xml|\+html)/i;

export function normalizeCrawlOpts(rawUrl, options = {}) {
  const url = String(rawUrl || '').trim();
  if (!isHttpUrl(url)) {
    return { error: { code: 'unsupported-protocol', message: '仅支持 http/https 网址' } };
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    return { error: { code: 'bad-url', message: '网址格式不正确' } };
  }
  return {
    url,
    origin: u.origin,
    host: u.host,
    opts: {
      maxPages: clampInt(options.maxPages, 2, 200, 100),
      maxDepth: clampInt(options.maxDepth, 1, 10, 3),
      concurrency: clampInt(options.concurrency, 1, 8, 4),
      fetchTimeoutMs: clampInt(options.fetchTimeoutMs, 1000, 60000, 15000),
      maxRedirects: clampInt(options.maxRedirects, 0, 10, 5),
      userAgent: options.userAgent || DEFAULT_USER_AGENT,
      deadLinkSample: clampInt(options.deadLinkSample, 0, 100, 40),
      includeUrl: compileUrlFilter(options.includePattern, 'include'),
      excludeUrl: compileUrlFilter(options.excludePattern, 'exclude'),
      includePattern: String(options.includePattern || '').trim(),
      excludePattern: String(options.excludePattern || '').trim(),
      quotas: compilePathQuotas(options.pathQuotas),
      quotasRaw: String(options.pathQuotas || '').trim(),
    },
  };
}

/**
 * Path quotas: newline-separated `regex=maxPages` lines. Each matching internal
 * link consumes one slot; when a pattern's budget is spent the remaining links
 * are skipped (so high-volume paths like /detail/ are sampled, not ignored).
 */
function compilePathQuotas(text) {
  const src = String(text || '');
  const quotas = [];
  const lines = src.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.*?)\s*=\s*(\d+)\s*$/);
    if (!m) {
      throw { code: 'bad-pattern', message: `路径配额格式应为「正则=页数」：${line}` };
    }
    try {
      quotas.push({ pattern: m[1], re: new RegExp(m[1], 'i'), max: clampInt(m[2], 0, 9999, 0), used: 0 });
    } catch {
      throw { code: 'bad-pattern', message: `路径配额里的正则表达式无效：${m[1]}` };
    }
  }
  return quotas;
}

function compileUrlFilter(pattern, label) {
  const src = String(pattern || '').trim();
  if (!src) return null;
  try {
    return new RegExp(src, 'i');
  } catch {
    throw { code: 'bad-pattern', message: `${label === 'include' ? '只抓路径' : '排除路径'}的正则表达式无效：${src}` };
  }
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function patternToRegExp(pattern) {
  // Basic robots.txt pattern: '/' prefix match, '*' wildcard, '$' end anchor.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  let src = '^' + escaped;
  if (pattern.endsWith('$')) src += '$';
  else src += '(?:\\?.*)?$';
  return new RegExp(src);
}

function robotsAllowsPath(path, robotsText) {
  if (!robotsText) return true;
  // Group rules by user-agent, take groups that apply to us.
  let group = null;
  const rules = []; // {ua, disallow:[], allow:[]}
  for (const line of robotsText.split(/\r?\n/)) {
    const m = line.match(/^\s*(User-agent|Disallow|Allow)\s*:\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      group = { ua: val.toLowerCase(), disallow: [], allow: [] };
      rules.push(group);
    } else if (group && key === 'disallow') {
      group.disallow.push(val);
    } else if (group && key === 'allow') {
      group.allow.push(val);
    }
  }
  const mine = rules.filter((g) => g.ua === '*' || g.ua.includes('seo') || g.ua.includes('bot') || g.ua.includes('google'));
  for (const g of mine) {
    for (const d of g.disallow) {
      if (!d) continue;
      const disallowed = patternToRegExp(d).test(path);
      if (!disallowed) continue;
      const allowed = g.allow.some((a) => a && patternToRegExp(a).test(path));
      if (!allowed) return false;
    }
  }
  return true;
}

async function fetchRobots(origin, userAgent, timeoutMs) {
  try {
    const res = await fetchText(`${origin}/robots.txt`, { timeoutMs, userAgent });
    return { status: res.status, text: res.text };
  } catch (err) {
    return { status: 0, text: '', error: (err && err.message) || String(err) };
  }
}

function extractSitemapUrls(text) {
  const urls = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(text)) !== null) urls.push(m[1].trim());
  return urls;
}

async function collectSitemapUrls(origin, robots, opts) {
  const candidates = [];
  if (robots.sitemaps && robots.sitemaps.length) candidates.push(...robots.sitemaps);
  else candidates.push(`${origin}/sitemap.xml`);
  const out = [];
  for (const s of candidates) {
    if (out.length >= opts.maxPages * 2) break;
    try {
      const res = await fetchText(s, { timeoutMs: opts.fetchTimeoutMs, userAgent: opts.userAgent });
      if (res.status !== 200) continue;
      const isIndex = /<sitemapindex|<\s*sitemap\b/i.test(res.text);
      if (isIndex) {
        const nested = extractSitemapUrls(res.text);
        for (const n of nested) {
          if (out.length >= opts.maxPages * 2) break;
          try {
            const r2 = await fetchText(n, { timeoutMs: opts.fetchTimeoutMs, userAgent: opts.userAgent });
            if (r2.status === 200) out.push(...extractSitemapUrls(r2.text).slice(0, opts.maxPages * 2 - out.length));
          } catch {
            /* skip broken nested sitemap */
          }
        }
      } else {
        out.push(...extractSitemapUrls(res.text));
      }
    } catch {
      /* skip */
    }
  }
  return { urls: out, fetchedFrom: candidates };
}

/**
 * Crawl a site. Returns {status:'ok'|'error', ...} — never throws.
 */
export async function crawlSite(rawUrl, options = {}) {
  const started = Date.now();
  let norm;
  try {
    norm = normalizeCrawlOpts(rawUrl, options);
  } catch (err) {
    return { status: 'error', error: { code: err.code || 'bad-options', message: err.message || String(err) } };
  }
  if (norm.error) return { status: 'error', error: norm.error };
  const { url, origin, host, opts } = norm;
  const matchesFilter = (pathAndQuery) => {
    if (opts.excludeUrl && opts.excludeUrl.test(pathAndQuery)) return false;
    if (opts.includeUrl && !opts.includeUrl.test(pathAndQuery)) return false;
    return true;
  };
  const matchesQuota = (pathAndQuery) => {
    for (const q of opts.quotas) {
      if (!q.re.test(pathAndQuery)) continue;
      if (q.used >= q.max) return false;
      q.used += 1;
      return true;
    }
    return true;
  };

  const robotsRes = await fetchRobots(origin, opts.userAgent, opts.fetchTimeoutMs);
  const robots = {
    status: robotsRes.status,
    disallowAll: /^\s*Disallow\s*:\s*\/?\s*$/im.test(robotsRes.text || ''),
    sitemaps: (parseRobots(robotsRes.text || '').sitemaps || []).filter((u) => u.startsWith(origin)),
    error: robotsRes.error || null,
  };
  const sitemap = await collectSitemapUrls(origin, robots, opts);

  // Seed queue: start URL first, then sitemap URLs.
  const queue = [{ url, depth: 0, referrer: null }];
  const seeds = new Set([url]);
  for (const su of sitemap.urls) {
    if (!su.startsWith(origin)) continue;
    try {
      const u = new URL(su);
      if (u.host !== host) continue;
      if (!matchesFilter(u.pathname + u.search)) {
        filtered += 1;
        continue;
      }
      if (!matchesQuota(u.pathname + u.search)) {
        quotaLimited += 1;
        continue;
      }
      if (!seeds.has(u.href)) {
        seeds.add(u.href);
        queue.push({ url: u.href, depth: 0, referrer: 'sitemap' });
      }
    } catch {
      /* skip malformed sitemap URL */
    }
  }

  const visited = new Set(); // normalized URLs (final or input)
  const pages = [];
  const byUrl = new Map(); // normalized -> page record
  const seenInput = new Set([url]);
  const notes = [];

  let attempted = 0;
  let ok = 0;
  let failed = 0;
  let skippedDisallowed = 0;
  let filtered = 0;
  let quotaLimited = 0;
  let head = 0;
  let active = 0; // items currently being fetched (may push to queue)

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Adaptive concurrency: start gentle (2), ramp up on fast successful
  // responses, back off on timeouts/5xx/429, and serialize with a robots
  // Crawl-delay when the site asks for one.
  const crawlDelayMs = Math.min(Math.max(0, Math.round((parseRobots(robotsRes.text || '').crawlDelay || 0) * 1000)), 10000);
  let window = crawlDelayMs > 0 ? 1 : Math.min(2, opts.concurrency);
  let windowFailStreak = 0;
  let windowCompletions = 0;
  let lastDuration = 0;
  let lastFetchAt = 0;

  async function pump() {
    for (;;) {
      if (attempted >= opts.maxPages) return;
      if (head >= queue.length) {
        // Queue empty. If every slot is idle, no fetch can push new links —
        // we are done. Otherwise wait briefly for in-flight items to enqueue.
        if (active === 0) return;
        await sleep(2);
        continue;
      }
      // Keep at most `window` requests in flight.
      while (active >= window) await sleep(2);
      const item = queue[head++];
      if (!item) continue;
      active += 1;
      (async () => {
        try {
          if (crawlDelayMs > 0) {
            const wait = crawlDelayMs - (Date.now() - lastFetchAt);
            if (wait > 0) await sleep(wait);
            lastFetchAt = Date.now();
          }
          const path = new URL(item.url).pathname;
          if (!robotsAllowsPath(path, robotsRes.text || '')) {
            skippedDisallowed += 1;
            return;
          }
          if (visited.has(item.url)) return;
          visited.add(item.url);
          attempted += 1;

          let record;
          let isFailure = false;
          try {
            const res = await fetchPage(item.url, {
              timeoutMs: opts.fetchTimeoutMs,
              maxRedirects: opts.maxRedirects,
              userAgent: opts.userAgent,
            });
            ok += 1;
            if (res.status >= 500 || res.status === 429) isFailure = true;
            record = {
              url: item.url,
              finalUrl: res.finalUrl,
              status: res.status,
              contentType: res.contentType,
              bytes: res.bytes,
              depth: item.depth,
              referrer: item.referrer,
              redirectCount: res.redirectChain.length,
              durationMs: res.durationMs,
              error: null,
              title: null,
              description: null,
              canonical: null,
              h1Count: 0,
              words: 0,
              cjk: 0,
              latin: 0,
              imagesNoAlt: 0,
              imageCount: 0,
              noindex: false,
              internalLinks: 0,
              jsonldTypes: [],
              links: [],
            };
            const isHtml = HTMLISH.test(res.contentType) || /<html[\s>]/i.test(res.html.slice(0, 512));
            if (isHtml && res.status >= 200 && res.status < 300) {
              const page = parsePage(res.html, res.finalUrl);
              const anchors = extractAnchors(res.html);
              record.title = page.title;
              record.description = page.description;
              record.canonical = page.canonical;
              record.h1Count = page.h1s.length;
              record.words = page.words ? page.words.total : 0;
              record.cjk = page.words ? page.words.cjk : 0;
              record.latin = page.words ? page.words.latin : 0;
              record.imagesNoAlt = page.imagesNoAlt;
              record.imageCount = page.imageCount;
              record.noindex = /noindex/i.test(page.robotsMeta || '');
              record.internalLinks = page.internalLinks;
              record.jsonldTypes = page.jsonldTypes || [];
              record.links = [];
              for (const anchor of anchors) {
                if (anchor.rel.split(/\s+/).includes('nofollow')) continue;
                let u;
                try {
                  u = new URL(anchor.href, res.finalUrl);
                } catch {
                  continue;
                }
                if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
                if (u.host !== host) continue;
                const target = u.href.split('#')[0];
                if (target === res.finalUrl.split('#')[0]) continue;
                record.links.push(target);
              }
              // Dedupe links, enqueue undiscovered ones (BFS).
              for (const target of new Set(record.links)) {
                if (attempted >= opts.maxPages) break;
                if (visited.has(target) || seenInput.has(target)) continue;
                seenInput.add(target);
                let tu;
                try {
                  tu = new URL(target);
                } catch {
                  continue;
                }
                if (!matchesFilter(tu.pathname + tu.search)) {
                  filtered += 1;
                  continue;
                }
                if (!matchesQuota(tu.pathname + tu.search)) {
                  quotaLimited += 1;
                  continue;
                }
                if (item.depth < opts.maxDepth) queue.push({ url: target, depth: item.depth + 1, referrer: record.finalUrl || item.url });
              }
            } else {
              // Non-HTML or non-2xx: record status only.
              if (res.status >= 400) failed += 1;
            }
          } catch (err) {
            failed += 1;
            isFailure = true;
            record = {
              url: item.url,
              finalUrl: item.url,
              status: 0,
              contentType: null,
              bytes: 0,
              depth: item.depth,
              referrer: item.referrer,
              redirectCount: 0,
              durationMs: 0,
              error: (err && err.code) || 'network',
              errorMessage: (err && err.message) || String(err),
              title: null,
              description: null,
              canonical: null,
              h1Count: 0,
              words: 0,
              cjk: 0,
              latin: 0,
              imagesNoAlt: 0,
              imageCount: 0,
              noindex: false,
              internalLinks: 0,
              jsonldTypes: [],
              links: [],
            };
          }
          byUrl.set(record.finalUrl, record);
          byUrl.set(record.url, record);
          pages.push(record);

          // Adaptive window: shrink on failures, grow on fast success.
          windowCompletions += 1;
          lastDuration = record.durationMs || 0;
          windowFailStreak = isFailure ? windowFailStreak + 1 : 0;
          if (crawlDelayMs > 0) {
            window = 1;
          } else if (windowCompletions % 4 === 0) {
            if (windowFailStreak > 0) window = Math.max(1, window - 1);
            else if (window < opts.concurrency && lastDuration < 1500) window = Math.min(opts.concurrency, window + 1);
          }
        } finally {
          active -= 1;
        }
      })();
    }
  }
  await pump();

  // ---- inlinks: count how many crawled pages point at each crawled page ----
  const inlinks = new Map();
  for (const p of pages) {
    for (const target of p.links || []) {
      const rec = byUrl.get(target);
      if (rec) inlinks.set(target, (inlinks.get(target) || 0) + 1);
    }
  }
  for (const p of pages) p.inlinks = inlinks.get(p.finalUrl) || inlinks.get(p.url) || 0;

  // ---- dead-link sampling: same-host link targets never crawled ----
  const deadLinks = [];
  let deadLinkSamples = 0;
  if (opts.deadLinkSample > 0) {
    const candidates = [];
    const seenTarget = new Set();
    for (const p of pages) {
      for (const target of p.links || []) {
        if (candidates.length >= opts.deadLinkSample) break;
        if (visited.has(target) || seenTarget.has(target)) continue;
        try {
          if (new URL(target).host !== host) continue;
        } catch {
          continue;
        }
        seenTarget.add(target);
        candidates.push({ target, foundOn: p.finalUrl || p.url });
      }
      if (candidates.length >= opts.deadLinkSample) break;
    }
    const workers2 = Array.from({ length: crawlDelayMs > 0 ? 1 : Math.min(4, candidates.length) }, () => (async () => {
      while (true) {
        const c = candidates.shift();
        if (!c) return;
        if (crawlDelayMs > 0) {
          const wait = crawlDelayMs - (Date.now() - lastFetchAt);
          if (wait > 0) await sleep(wait);
          lastFetchAt = Date.now();
        }
        try {
          const res = await fetchPage(c.target, {
            timeoutMs: 8000,
            maxRedirects: opts.maxRedirects,
            userAgent: opts.userAgent,
            maxBytes: 512 * 1024,
          });
          if (res.status >= 400) deadLinks.push({ url: c.target, status: res.status, foundOn: c.foundOn });
        } catch (err) {
          if (err && err.code === 'too-many-redirects') deadLinks.push({ url: c.target, status: 'redirect-loop', foundOn: c.foundOn });
        }
      }
    })());
    deadLinkSamples = candidates.length;
    await Promise.all(workers2);
    deadLinks.sort((a, b) => String(a.status).localeCompare(String(b.status)));
  }

  const durationMs = Date.now() - started;
  if (robots.status === 0) notes.push('robots.txt 无法访问，按"允许全部抓取"处理');
  if (sitemap.urls.length === 0) notes.push('未发现 sitemap，仅从首页内链扩展抓取');
  if (crawlDelayMs > 0) notes.push(`robots.txt 要求 Crawl-delay ${Math.round(crawlDelayMs / 100) / 10}s，已自动放慢抓取速度`);
  if (attempted >= opts.maxPages) notes.push(`达到抓取上限 ${opts.maxPages} 页，剩余链接未遍历（上限在「⚙ 设置 → 站点体检最大页数」里调整，最多 200）`);
  if (filtered > 0) notes.push(`已按路径过滤规则跳过 ${filtered} 个链接（⚙ 设置 → 只抓路径 / 排除路径）`);
  if (quotaLimited > 0) notes.push(`已按路径配额限制跳过 ${quotaLimited} 个链接（⚙ 设置 → 路径配额，如 ^/detail/=10）`);
  if (pages.length > 0 && pages.every((p) => p.depth === 0)) notes.push('没有从首页发现新的站内链接');

  return {
    status: 'ok',
    url,
    origin,
    host,
    fetchedAt: new Date().toISOString(),
    durationMs,
    robots,
    sitemap: { status: sitemap.urls.length ? 200 : 404, urls: sitemap.urls.slice(0, opts.maxPages * 2), fetchedFrom: sitemap.fetchedFrom },
    stats: { sitemapUrls: sitemap.urls.length, seeds: queue.length, attempted, ok, failed, skippedDisallowed, filtered, quotaLimited, pages: pages.length, deadLinksChecked: deadLinkSamples, deadLinksFound: deadLinks.length, maxDepth: opts.maxDepth, maxPages: opts.maxPages, concurrency: window, crawlDelayMs },
    filters: { includePattern: opts.includePattern, excludePattern: opts.excludePattern, pathQuotas: opts.quotasRaw },
    pages,
    deadLinks,
    notes,
  };
}
