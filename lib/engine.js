/**
 * SEO audit engine: fetch → parse → checks → score.
 *
 * Pure Node — no DSH services needed. index.js wires these into the Host
 * process via webServer routes; scripts/smoke.mjs exercises them standalone.
 */

import { fetchPage, fetchText, isHttpUrl } from './fetch.js';
import { parsePage, parseRobots } from './parse.js';
import { runChecks } from './checks.js';
import { scoreGroups } from './score.js';
import { runPageSpeed } from './psi.js';

export { runPageSpeed };

const DEFAULTS = { timeoutMs: 15000, maxRedirects: 5, userAgent: undefined };

const emptyReport = (url, error, durationMs) => ({
  status: 'error',
  error,
  url,
  finalUrl: null,
  fetchedAt: null,
  durationMs,
  page: null,
  robots: null,
  sitemap: null,
  groups: [],
  issues: [],
  notes: [],
  score: null,
  deep: null,
});

export async function runAudit(rawUrl, options = {}) {
  const url = String(rawUrl || '').trim();
  if (!isHttpUrl(url)) {
    return emptyReport(url, { code: 'unsupported-protocol', message: '只支持 http/https 地址' }, 0);
  }
  const opts = { ...DEFAULTS, ...options };
  const started = Date.now();

  let page;
  try {
    page = await fetchPage(url, opts);
  } catch (err) {
    return emptyReport(url, { code: err.code || 'fetch-failed', message: err.message || String(err) }, Date.now() - started);
  }

  const contentType = page.contentType || '';
  if (contentType && !contentType.includes('html') && !contentType.includes('xml') && !contentType.includes('text')) {
    return emptyReport(
      url,
      { code: 'unsupported-content', message: `页面内容类型不是 HTML（${contentType}）` },
      Date.now() - started,
    );
  }

  const notes = [];
  const parsed = parsePage(page.html, page.finalUrl);
  const robots = await fetchRobots(page.finalUrl, opts);
  const sitemap = await fetchSitemap(page.finalUrl, robots, opts);

  const { groups, issues } = runChecks({ url, finalUrl: page.finalUrl, page, parsed, robots, sitemap, notes });
  const score = scoreGroups(groups);

  return {
    status: 'ok',
    url,
    finalUrl: page.finalUrl,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    page: {
      httpStatus: page.status,
      redirectChain: page.redirectChain,
      contentType,
      bytes: page.bytes,
      title: parsed.title,
      description: parsed.description,
      lang: parsed.lang,
      viewport: parsed.viewport,
      canonical: parsed.canonical,
      robotsMeta: parsed.robotsMeta,
      hreflangs: parsed.hreflangs,
      internalLinks: parsed.internalLinks,
      externalLinks: parsed.externalLinks,
      nofollowLinks: parsed.nofollowLinks,
      imageCount: parsed.imageCount,
      imagesNoAlt: parsed.imagesNoAlt,
      lazyCount: parsed.lazyCount,
      h1s: parsed.h1s,
      h2s: parsed.h2Count,
      h3s: parsed.h3Count,
      jsonldTypes: parsed.jsonldTypes,
      words: parsed.words,
      mixedContent: parsed.mixedContent,
    },
    robots,
    sitemap,
    groups,
    issues,
    notes,
    score,
    deep: null,
  };
}

async function fetchRobots(finalUrl, opts) {
  try {
    const origin = new URL(finalUrl).origin;
    const res = await fetchText(`${origin}/robots.txt`, { timeoutMs: opts.timeoutMs, userAgent: opts.userAgent });
    const parsed = parseRobots(res.text);
    return {
      status: res.status,
      disallowAll: parsed.disallowAll,
      sitemaps: parsed.sitemaps,
    };
  } catch {
    return { status: 0, disallowAll: false, sitemaps: [] };
  }
}

async function fetchSitemap(finalUrl, robots, opts) {
  const origin = new URL(finalUrl).origin;
  const candidates = [...robots.sitemaps, `${origin}/sitemap.xml`];
  let last = null;
  for (const candidate of candidates) {
    try {
      const res = await fetchText(candidate, { timeoutMs: opts.timeoutMs, userAgent: opts.userAgent });
      last = { status: res.status, url: candidate, urls: 0 };
      if (res.status >= 200 && res.status < 300) {
        const urlCount = (res.text.match(/<url\b/gi) || []).length;
        const locCount = (res.text.match(/<loc\b/gi) || []).length;
        last.urls = urlCount || locCount;
        return last;
      }
    } catch {
      // try next candidate
    }
  }
  return last || { status: 0, url: null, urls: 0 };
}