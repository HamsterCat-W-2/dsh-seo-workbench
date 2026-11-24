/**
 * Deep check via the Google PageSpeed Insights API (v5).
 *
 * Covers what a static fetch cannot: real Core Web Vitals from CrUX,
 * Lighthouse category scores, and a fallback schema audit for JS-injected
 * JSON-LD. Free quota is limited and the API may be unreachable in some
 * networks — errors are returned as a report, not thrown.
 */

const CATEGORIES = ['performance', 'seo', 'accessibility', 'best-practices'];

export async function runPageSpeed(url, options = {}) {
  const strategy = options.strategy || 'mobile';
  const key = options.key || '';
  const timeoutMs = options.timeoutMs ?? 60000;

  const params = new URLSearchParams();
  params.set('url', url);
  params.set('strategy', strategy);
  for (const category of CATEGORIES) params.append('category', category);
  if (key) params.set('key', key);
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (data && data.error && data.error.message) || `PageSpeed 接口返回 ${res.status}`;
      return { status: 'error', error: { code: 'psi-failed', message } };
    }
    if (!data || !data.categories) {
      return { status: 'error', error: { code: 'psi-empty', message: 'PageSpeed 返回了空结果' } };
    }

    const categories = data.categories;
    const metrics = (data.loadingExperience && data.loadingExperience.metrics) || {};
    const num = (value) => (typeof value === 'number' ? value : null);
    const cwv = {
      lcpMs: num(metrics.LARGEST_CONTENTFUL_PAINT_MS && metrics.LARGEST_CONTENTFUL_PAINT_MS.percentile),
      cls: num(metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE && metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile),
      inpMs: num(metrics.INTERACTION_TO_NEXT_PAINT && metrics.INTERACTION_TO_NEXT_PAINT.percentile),
      ttfbMs: num(metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE && metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE.percentile),
      fcpMs: num(metrics.FIRST_CONTENTFUL_PAINT_MS && metrics.FIRST_CONTENTFUL_PAINT_MS.percentile),
    };
    const hasCwv = Object.values(cwv).some((value) => value != null);

    const structuredData = data.audits && data.audits['structured-data'];
    const schemaFound = structuredData && structuredData.details && Array.isArray(structuredData.details.items)
      ? structuredData.details.items.length > 0
      : null;

    return {
      status: 'ok',
      strategy,
      performance: categories.performance && categories.performance.score,
      seo: categories.seo && categories.seo.score,
      accessibility: categories.accessibility && categories.accessibility.score,
      bestPractices: categories['best-practices'] && categories['best-practices'].score,
      cwv: hasCwv ? cwv : null,
      schemaFound,
      lighthouseIssues: collectLighthouseIssues(data.audits),
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { status: 'error', error: { code: 'timeout', message: `PageSpeed 请求超时（${timeoutMs / 1000}s）` } };
    }
    return { status: 'error', error: { code: 'network', message: `无法访问 PageSpeed 接口：${(err && err.message) || String(err)}` } };
  } finally {
    clearTimeout(timer);
  }
}

/** Top failing Lighthouse audits, best-effort evidence. */
function collectLighthouseIssues(audits) {
  if (!audits || typeof audits !== 'object') return [];
  const failing = Object.values(audits).filter(
    (audit) => audit && typeof audit.score === 'number' && audit.score < 0.9 && audit.title,
  );
  failing.sort((a, b) => a.score - b.score);
  return failing.slice(0, 6).map((audit) => ({
    id: audit.id,
    title: audit.title,
    score: audit.score,
    displayValue: audit.displayValue || '',
  }));
}