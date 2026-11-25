/**
 * Keyword analysis for a site.
 *
 * Extracts real, deterministic keyword data from the site's own content:
 * CJK n-grams (2–4 chars) and latin words, aggregated across crawled pages.
 * For each keyword we report frequency, density, page coverage, title/H1/
 * description hit counts, best-targeting page, and (when search-query data is
 * joined) real clicks / impressions / CTR / position from GSC or Bing.
 * Also detects cannibalization clusters (multiple pages competing for the
 * same keyword) and content gaps (high-impression queries with no keyword
 * match). No external volume API — "搜索量/热度" is deliberately NOT faked.
 */

import { normalizeCrawlOpts, robotsAllowsPath, fetchRobots, collectSitemapUrls, clampInt } from './crawl.js';
import { fetchPage } from './fetch.js';
import { parsePage, extractHeadings, extractAnchors, stripTags, parseRobots } from './parse.js';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_RE = /[a-zA-Z][a-zA-Z0-9-]{1,}/g;
const HTMLISH = /(^text\/html|^application\/xhtml\+xml|\+html)/i;

// Minimal English + Chinese function-word lists. These are the only place a
// "real" dictionary is needed; everything else is frequency-based.
const EN_STOP = new Set(('the a an and or of to in for on with without is are was were be been am it its this that these those as at by from not no nor your our we us you they their them he she his her who whom which what when where why how do does did done have has had having but so if then than too very just about also into out up down off over under again further once such only own same few both each other some any all can could will would shall should may might must need ought').split(' '));
const ZH_STOP = new Set(('的 了 在 是 我 你 他 她 它 们 有 和 与 及 或 而 但 就 都 也 很 更 最 这 那 个 种 些 里 中 上 下 前 后 时 年 月 日 人 大 小 多 少 不 没 无 为 对 于 从 到 向 被 把 让 给 会 能 要 想 去 来 出 过 还 再 又 以 之 其 此 等 与 比 可 应 该 已 经 现 因 为 所 以 但 是 什 么 怎 么 如 何 为 什 么 已 经 现 在 时 候 地 方 东 西 没 有 不 是 就 是 还 是 一 个 我 们 你 们 他 们 可 以 自 己 这 个 那 个 这 些 那 些 之 后 之 前 上 面 下 面 里 面 外 面 开 始 结 束 一 种 一 些 两 三 四 五 六 七 八 九 十 第 一 二 三 四 五 六 七 八 九 零 百 千 万 亿').split(' '));

function cjkGrams(run) {
  const grams = [];
  if (run.length <= 4 && !ZH_STOP.has(run)) grams.push(run);
  for (let size = 2; size <= 4; size += 1) {
    for (let i = 0; i + size <= run.length; i += 1) {
      grams.push(run.slice(i, i + size));
    }
  }
  return grams;
}

function tokenize(text) {
  // Returns { cjk: [], latin: [] } with stopwords removed; CJK grams deduped
  // within a run to avoid n-gram inflation on one repeated phrase.
  const cjk = [];
  const latin = [];
  let m;
  const reCjk = new RegExp(CJK_RE.source, 'g');
  while ((m = reCjk.exec(text)) !== null) {
    const run = m[0];
    if (run.length < 2) continue;
    const seen = new Set();
    for (const g of cjkGrams(run)) {
      if (ZH_STOP.has(g)) continue;
      if (seen.has(g)) continue;
      seen.add(g);
      cjk.push(g);
    }
  }
  const reLatin = new RegExp(LATIN_RE.source, 'g');
  while ((m = reLatin.exec(text)) !== null) {
    const w = m[0].toLowerCase();
    if (w.length < 2 || EN_STOP.has(w)) continue;
    latin.push(w);
  }
  return { cjk, latin };
}

function pageText(html) {
  // Strip script/style/noscript first, then tags; collapse whitespace.
  return stripTags(html).replace(/\s+/g, ' ').trim().slice(0, 8000);
}

// Same path include/exclude + quota semantics as crawlSite (see lib/crawl.js).
function passesFilters(path, opts) {
  if (opts.excludeUrl && opts.excludeUrl.test(path)) return false;
  if (opts.includeUrl && !opts.includeUrl.test(path)) return false;
  return true;
}
function tryQuota(path, opts) {
  for (const q of opts.quotas) {
    if (q.re.test(path)) {
      if (q.used >= q.max) return false;
      q.used += 1;
      return true;
    }
  }
  return true;
}

/**
 * Crawl a site collecting per-page keyword material, then aggregate.
 * Returns {status:'ok'|'error', ...} — never throws.
 */
export async function analyzeKeywords(rawUrl, options = {}) {
  const norm = normalizeCrawlOpts(rawUrl, options);
  if (norm.error) {
    return { status: 'error', error: norm.error };
  }
  const { url, origin, host, opts } = norm;

  const started = Date.now();

  // Robots + sitemap seeds (same machinery as crawlSite).
  const robots = await fetchRobots(origin, opts.userAgent, opts.fetchTimeoutMs);
  const robotsParsed = robots.status === 200 ? parseRobots(robots.text || '') : { disallowAll: false, sitemaps: [], crawlDelay: 0 };
  const sm = await collectSitemapUrls(origin, robots, opts);
  const sitemap = { status: robots.status === 200 ? sm.urls.length ? 200 : 404 : robots.status, urls: sm.urls, fetchedFrom: sm.fetchedFrom };

  const queue = [{ url, depth: 0, referrer: null }];
  let filteredSeeds = 0;
  for (const u of sm.urls) {
    let parsed;
    try { parsed = new URL(u); } catch { continue; }
    if (parsed.host !== host) continue;
    const sp = parsed.pathname + parsed.search;
    if (!robotsAllowsPath(sp, robots.text || '') || !passesFilters(sp, opts) || !tryQuota(sp, opts)) {
      filteredSeeds += 1;
      continue;
    }
    if (queue.length < opts.maxPages) queue.push({ url: u, depth: 1, referrer: 'sitemap' });
  }

  const visited = new Set();
  const failed = new Set();
  const stats = { sitemapUrls: sm.urls.length, seeds: queue.length, attempted: 0, ok: 0, failed: 0, skippedDisallowed: 0, filtered: filteredSeeds, pages: 0, maxDepth: 0 };
  const notes = [];

  // Aggregation.
  const agg = new Map(); // kw -> {text, lang, textCount, pages:Set, titlePages:Set, h1Pages:Set, descPages:Set, best:{url,score}}
  let tokensTotal = 0;
  let pagesSkippedDisallowed = 0;

  const head = { value: 0 };
  let active = 0;
  const queueArr = queue;

  async function worker() {
    for (;;) {
      if (stats.attempted >= opts.maxPages) return;
      if (head.value >= queueArr.length) {
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 2));
        continue;
      }
      const item = queueArr[head.value];
      head.value += 1;
      active += 1;
      try {
        if (visited.has(item.url)) continue;
        visited.add(item.url);
        if (!robotsAllowsPath(new URL(item.url).pathname + new URL(item.url).search, robots.text || '')) {
          pagesSkippedDisallowed += 1;
          continue;
        }
        stats.attempted += 1;
        const depth = item.depth;
        if (depth > stats.maxDepth) stats.maxDepth = depth;

        let res;
        try {
          res = await fetchPage(item.url, { timeoutMs: opts.fetchTimeoutMs, userAgent: opts.userAgent, maxRedirects: opts.maxRedirects });
        } catch (err) {
          stats.failed += 1;
          continue;
        }
        const ct = res.contentType || '';
        if (!HTMLISH.test(ct) && !/<!doctype html|<html/i.test((res.html || '').slice(0, 512))) {
          stats.failed += 1;
          continue;
        }
        stats.ok += 1;

        const parsed = parsePage(res.html, res.finalUrl || item.url);
        const headings = extractHeadings(res.html).filter((h) => h.level <= 2);
        const text = pageText(res.html);
        const t = tokenize(text);
        const tTitle = tokenize(parsed.title || '');
        const tHead = tokenize(headings.map((h) => h.text).join(' '));
        const tDesc = tokenize(parsed.description || '');

        tokensTotal += t.cjk.length + t.latin.length;

        // Merge this page's tokens into the aggregate.
        const bump = (kws, field) => {
          for (const kw of kws) {
            const e = agg.get(kw);
            const isTitle = field === 'title';
            const isH1 = field === 'h1';
            const isDesc = field === 'desc';
            if (e) {
              if (isTitle) e.titlePages.add(item.url);
              if (isH1) e.h1Pages.add(item.url);
              if (isDesc) e.descPages.add(item.url);
              e.pages.add(item.url);
              e.textCount += field === 'text' ? 1 : 0;
              const score = e.textCount + e.titlePages.size * 3 + e.h1Pages.size * 2 + e.descPages.size;
              if (score > e.best.score) e.best = { url: item.url, score };
            } else {
              agg.set(kw, {
                lang: CJK_CHAR.test(kw) ? 'zh' : 'en',
                textCount: field === 'text' ? 1 : 0,
                pages: new Set([item.url]),
                titlePages: isTitle ? new Set([item.url]) : new Set(),
                h1Pages: isH1 ? new Set([item.url]) : new Set(),
                descPages: isDesc ? new Set([item.url]) : new Set(),
                best: { url: item.url, score: 1 + (isTitle ? 3 : 0) + (isH1 ? 2 : 0) + (isDesc ? 1 : 0) },
              });
            }
          }
        };
        bump(t.cjk, 'text');
        bump(t.latin, 'text');
        bump(tTitle.cjk, 'title');
        bump(tTitle.latin, 'title');
        bump(tHead.cjk, 'h1');
        bump(tHead.latin, 'h1');
        bump(tDesc.cjk, 'desc');
        bump(tDesc.latin, 'desc');

        // Enqueue same-host links.
        if (depth < opts.maxDepth && queueArr.length < opts.maxPages + 64) {
          for (const a of extractAnchors(res.html)) {
            if ((a.rel || '').toLowerCase().includes('nofollow')) continue;
            let u;
            try { u = new URL(a.href, res.finalUrl || item.url); } catch { continue; }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
            if (u.host !== host) continue;
            if (visited.has(u.href)) continue;
            const path = u.pathname + u.search;
            if (!robotsAllowsPath(path, robots.text || '')) {
              pagesSkippedDisallowed += 1;
              continue;
            }
            if (!passesFilters(path, opts) || !tryQuota(path, opts)) {
              stats.filtered += 1;
              continue;
            }
            queueArr.push({ url: u.href, depth: depth + 1, referrer: item.url });
          }
        }
      } finally {
        active -= 1;
      }
    }
  }

  const concurrency = clampInt(opts.concurrency, 1, 8, 4);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  stats.pages = visited.size;
  stats.skippedDisallowed = pagesSkippedDisallowed;

  if (stats.filtered > 0) notes.push(`已按路径过滤/配额规则跳过 ${stats.filtered} 个链接（⚙ 设置 → 只抓路径 / 排除路径 / 路径配额）`);
  if (stats.attempted >= opts.maxPages) notes.push(`已达到抓取上限 ${opts.maxPages} 页，关键词分析基于已抓页面`);
  if (robots.status !== 200) notes.push('robots.txt 不可用');
  if (!sm.urls.length) notes.push('未发现 sitemap，仅从首页链接展开');
  if (tokensTotal < 100) notes.push('可分析文本量偏少（不足 100 词），结果仅供参考');

  // Build keyword rows.
  const keywords = [];
  for (const [kw, e] of agg) {
    const score = e.textCount + e.titlePages.size * 3 + e.h1Pages.size * 2 + e.descPages.size;
    if (score < 2) continue;
    keywords.push({
      keyword: kw,
      lang: e.lang,
      score,
      count: e.textCount,
      density: tokensTotal ? Number(((e.textCount / tokensTotal) * 100).toFixed(2)) : 0,
      pages: e.pages.size,
      titleHits: e.titlePages.size,
      h1Hits: e.h1Pages.size,
      descHits: e.descPages.size,
      bestUrl: e.best.url,
      search: null,
    });
  }
  keywords.sort((a, b) => b.score - a.score || b.pages - a.pages || b.count - a.count);
  const top = keywords.slice(0, 40);

  // Cannibalization clusters: ≥2 pages targeting the same keyword via title or H1.
  const clusters = [];
  for (const [kw, e] of agg) {
    const targeted = new Set([...e.titlePages, ...e.h1Pages]).size;
    if (targeted >= 2) {
      const pages = [];
      for (const u of e.pages) {
        if (e.titlePages.has(u)) pages.push({ url: u, source: 'title' });
        else if (e.h1Pages.has(u)) pages.push({ url: u, source: 'H1' });
      }
      clusters.push({ keyword: kw, pages: pages.slice(0, 10) });
    }
  }
  clusters.sort((a, b) => b.pages.length - a.pages.length);

  return {
    status: 'ok',
    mode: 'keywords',
    url,
    finalUrl: url,
    origin,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    stats,
    sitemap,
    keywords: top,
    clusters: clusters.slice(0, 15),
    unmatchedQueries: [],
    notes,
  };
}

/**
 * Join real search-query data (GSC or Bing result) onto the keyword rows.
 * Mutates and returns the report. Queries that match no keyword are kept as
 * content-gap candidates (高展示但内容没覆盖的词).
 */
export function joinSearchData(report, searchResult) {
  if (!searchResult || searchResult.status !== 'ok') return report;
  const queries = (searchResult.queries || []).filter((q) => q && q.query);
  if (!queries.length) return report;

  const norm = (s) => String(s || '').toLowerCase();
  const unmatched = [];
  for (const q of queries) {
    const qn = norm(q.query);
    // Longest-match: attach the query to the MOST SPECIFIC keyword it covers
    // (e.g. "电商网站搭建" lands on "电商网站" rather than "电商"/"网站").
    let hit = null;
    let bestLen = 0;
    for (const k of report.keywords) {
      const kn = norm(k.keyword);
      if ((kn.length >= 2 && qn.includes(kn)) || (qn.length >= 2 && kn.includes(qn))) {
        if (kn.length > bestLen) {
          bestLen = kn.length;
          hit = k;
        }
      }
    }
    if (hit) {
      const s = hit.search || (hit.search = { clicks: 0, impressions: 0, ctr: 0, position: 0, n: 0 });
      s.clicks += Number(q.clicks) || 0;
      s.impressions += Number(q.impressions) || 0;
      s.position += Number(q.position != null ? q.position : q.rank) || 0;
      s.n += 1;
      s.ctr = s.impressions ? Number((((s.clicks || 0) / s.impressions) * 100).toFixed(1)) : 0;
      s.position = s.n ? Number((s.position / s.n).toFixed(1)) : 0;
    } else {
      unmatched.push({ query: q.query, clicks: Number(q.clicks) || 0, impressions: Number(q.impressions) || 0, position: Number(q.position != null ? q.position : q.rank) || 0 });
    }
  }
  for (const k of report.keywords) {
    if (k.search && k.search.n > 0) {
      k.search = { clicks: k.search.clicks, impressions: k.search.impressions, ctr: k.search.ctr, position: k.search.position };
    } else {
      k.search = null;
    }
  }
  unmatched.sort((a, b) => b.impressions - a.impressions);
  report.unmatchedQueries = unmatched.slice(0, 10);
  report.notes.push(`已合并 ${queries.length} 条搜索查询数据，${unmatched.length} 条查询未命中现有关键词（潜在内容缺口）`);
  return report;
}

