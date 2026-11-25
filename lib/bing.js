// Bing Webmaster Tools API v1 (JSON endpoints). Key-based, no OAuth.
// Endpoints used: GetPageTraffic, GetQueryStats, GetSiteStats.
// Response shape is quirky (D: [...], __type fields) — parse defensively. Never throws.

const BING_API = 'https://ssl.bing.com/webmaster/api.svc/json/';

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeSiteUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!/^https?:$/.test(u.protocol)) return { error: { code: 'bad-url', message: '网址格式不正确（仅支持 http/https）' } };
    return { url: `${u.protocol}//${u.host}/`, origin: `${u.protocol}//${u.host}` };
  } catch {
    return { error: { code: 'bad-url', message: '网址格式不正确（仅支持 http/https）' } };
  }
}

async function bingGet(endpoint, siteUrl, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${BING_API}${endpoint}?siteUrl=${encodeURIComponent(siteUrl)}`;
    const res = await fetch(url, {
      headers: { api_key: apiKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.Message) message = String(body.Message);
      } catch { /* keep http status */ }
      return { ok: false, message };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, message: err && err.name === 'AbortError' ? '请求超时' : (err && err.message) || '请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

function asRows(data) {
  if (!data || !Array.isArray(data.D)) return [];
  return data.D.map((item) => {
    const o = item || {};
    return {
      clicks: Number(o.Clicks) || 0,
      impressions: Number(o.Impressions || o.Count) || 0,
      rank: Number(o.Rank) || null,
      query: typeof o.Query === 'string' ? o.Query : null,
      page: typeof o.Page === 'string' ? o.Page : null,
    };
  }).filter((r) => r.query || r.page);
}

export async function runBingSearch(rawUrl, { apiKey, timeoutMs = 30000 } = {}) {
  const { url, origin, error } = normalizeSiteUrl(rawUrl);
  if (error) return { status: 'error', error };
  if (!apiKey) {
    return { status: 'error', error: { code: 'no-key', message: '未配置 Bing API Key（⚙ 设置 → 搜索数据 → Bing API Key，或环境变量 BING_API_KEY）' } };
  }
  const t = clampInt(timeoutMs, 5000, 120000, 30000);
  const [stats, queries, pages] = await Promise.all([
    bingGet('GetSiteStats', url, apiKey, t),
    bingGet('GetQueryStats', url, apiKey, t),
    bingGet('GetPageTraffic', url, apiKey, t),
  ]);
  const failures = [stats, queries, pages].filter((r) => !r.ok);
  if (failures.length === 3) {
    return { status: 'error', error: { code: 'api-failed', message: `Bing API 调用失败：${failures[0].message}` } };
  }
  const stat = stats.ok && stats.data && Array.isArray(stats.data.D) ? stats.data.D[0] || {} : {};
  const totals = {
    clicks: Number(stat.TotalClicks) || null,
    impressions: Number(stat.TotalImpressions) || null,
    avgRank: Number(stat.TotalRank) || null,
    queries: Number(stat.TotalQueries) || null,
  };
  const notes = [];
  if (!stats.ok) notes.push(`站点统计获取失败（${stats.message}），仅显示查询/页面明细`);
  if (!queries.ok) notes.push(`查询词获取失败（${queries.message}）`);
  if (!pages.ok) notes.push(`页面获取失败（${pages.message}）`);
  return {
    status: 'ok',
    source: 'bing',
    siteUrl: url,
    totals,
    queries: asRows(queries.data).sort((a, b) => b.clicks - a.clicks).slice(0, 50),
    pages: asRows(pages.data).sort((a, b) => b.clicks - a.clicks).slice(0, 50),
    notes,
  };
}
