// Google Search Console: OAuth2 (installed-app style) + searchAnalytics query.
// Tokens stay with the caller (plugin settings); this module only exchanges and calls. Never throws.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function buildAuthUrl({ clientId, redirectUri = 'urn:ietf:wg:oauth:2.0:oob' } = {}) {
  if (!clientId) {
    return { status: 'error', error: { code: 'no-client-id', message: '未配置 Google OAuth Client ID（⚙ 设置 → 搜索数据）' } };
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return { status: 'ok', url: `${AUTH_URL}?${params.toString()}` };
}

async function postForm(url, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = (body.error_description || body.error || `HTTP ${res.status}`).toString();
      const code = /invalid_grant/i.test(errMsg)
        ? 'invalid-grant'
        : /invalid_client/i.test(errMsg)
          ? 'invalid-client'
          : /redirect_uri_mismatch/i.test(errMsg)
            ? 'redirect-mismatch'
            : 'token-failed';
      return { ok: false, code, message: errMsg };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, code: err && err.name === 'AbortError' ? 'timeout' : 'network', message: err && err.message ? String(err.message) : '请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri = 'urn:ietf:wg:oauth:2.0:oob', timeoutMs = 30000 } = {}) {
  if (!clientId || !clientSecret) return { status: 'error', error: { code: 'no-client', message: '请先填写 Client ID 和 Client Secret' } };
  if (!code) return { status: 'error', error: { code: 'no-code', message: '请先粘贴授权码' } };
  const r = await postForm(TOKEN_URL, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }, clampInt(timeoutMs, 5000, 120000, 30000));
  if (!r.ok) return { status: 'error', error: { code: r.code, message: r.message } };
  const b = r.body || {};
  return {
    status: 'ok',
    accessToken: b.access_token || null,
    refreshToken: b.refresh_token || null,
    expiresIn: Number(b.expires_in) || 3600,
    tokenType: b.token_type || 'Bearer',
    scope: b.scope || SCOPE,
  };
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken, timeoutMs = 30000 } = {}) {
  if (!clientId || !clientSecret || !refreshToken) return { status: 'error', error: { code: 'no-token', message: '缺少刷新令牌或客户端配置' } };
  const r = await postForm(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }, clampInt(timeoutMs, 5000, 120000, 30000));
  if (!r.ok) return { status: 'error', error: { code: r.code, message: r.message } };
  const b = r.body || {};
  return { status: 'ok', accessToken: b.access_token || null, expiresIn: Number(b.expires_in) || 3600 };
}

function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function gscGet(path, accessToken, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: {}, error: err && err.name === 'AbortError' ? '请求超时' : (err && err.message) || '请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

async function gscPost(path, accessToken, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: {}, error: err && err.name === 'AbortError' ? '请求超时' : (err && err.message) || '请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

function normalizePropertyInput(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    const origin = `${u.protocol}//${u.host}/`;
    const domain = u.host;
    return { origin, domain, host: u.host, protocol: u.protocol };
  } catch {
    return null;
  }
}

export async function listSites({ clientId, clientSecret, accessToken, refreshToken, expiresAt, timeoutMs = 30000 } = {}) {
  let access = accessToken;
  let refreshed = null;
  if (!access || (expiresAt && expiresAt < Date.now() + 60_000)) {
    if (!refreshToken) return { status: 'error', error: { code: 'no-token', message: '需要先完成授权' } };
    const r = await refreshAccessToken({ clientId, clientSecret, refreshToken, timeoutMs });
    if (r.status !== 'ok') return { status: 'error', error: r.error };
    access = r.accessToken;
    refreshed = { accessToken: access, expiresAt: Date.now() + r.expiresIn * 1000 };
  }
  const res = await gscGet('/sites', access, clampInt(timeoutMs, 5000, 120000, 30000));
  if (!res.ok) {
    const message = res.error || (res.body && res.body.error && res.body.error.message) || `HTTP ${res.status}`;
    const code = res.status === 401 || res.status === 403 ? 'unauthorized' : !res.status ? 'network' : 'api-failed';
    return { status: 'error', error: { code, message }, refreshed };
  }
  const entries = (res.body && res.body.siteEntry) || [];
  return {
    status: 'ok',
    refreshed,
    sites: entries.map((e) => ({ siteUrl: e.siteUrl, permissionLevel: e.permissionLevel })),
  };
}

export async function searchAnalytics({
  clientId,
  clientSecret,
  accessToken,
  refreshToken,
  expiresAt,
  rawUrl,
  days = 28,
  timeoutMs = 30000,
} = {}) {
  const target = normalizePropertyInput(rawUrl);
  if (!target) return { status: 'error', error: { code: 'bad-url', message: '网址格式不正确（仅支持 http/https）' } };
  const t = clampInt(timeoutMs, 5000, 120000, 30000);
  let access = accessToken;
  let refreshed = null;
  if (!access || (expiresAt && expiresAt < Date.now() + 60_000)) {
    if (!refreshToken) return { status: 'error', error: { code: 'no-token', message: '需要先完成授权' } };
    const r = await refreshAccessToken({ clientId, clientSecret, refreshToken, timeoutMs: t });
    if (r.status !== 'ok') return { status: 'error', error: r.error };
    access = r.accessToken;
    refreshed = { accessToken: access, expiresAt: Date.now() + r.expiresIn * 1000 };
  }

  const sitesRes = await gscGet('/sites', access, t);
  if (!sitesRes.ok) {
    const message = sitesRes.error || (sitesRes.body && sitesRes.body.error && sitesRes.body.error.message) || `HTTP ${sitesRes.status}`;
    return { status: 'error', error: { code: sitesRes.status === 401 || sitesRes.status === 403 ? 'unauthorized' : 'api-failed', message }, refreshed };
  }
  const sites = ((sitesRes.body && sitesRes.body.siteEntry) || []).map((e) => e.siteUrl);
  const candidates = [target.origin, `sc-domain:${target.domain}`, `http://${target.host}/`];
  const siteUrl = candidates.find((c) => sites.includes(c)) || null;
  if (!siteUrl) {
    return {
      status: 'error',
      error: {
        code: 'no-property',
        message: `该网址不在你的 Search Console 已验证站点里（现有：${sites.slice(0, 5).join('、') || '无'}）`,
      },
      refreshed,
    };
  }
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // GSC data lags ~2 days
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - clampInt(days, 7, 180, 28));
  const payload = (dims, limit) => ({
    startDate: ymd(start),
    endDate: ymd(end),
    dimensions: dims,
    rowLimit: limit,
  });
  const enc = encodeURIComponent(siteUrl);
  const [agg, queries, pages] = await Promise.all([
    gscPost(`/sites/${enc}/searchAnalytics/query`, access, payload([], 1), t),
    gscPost(`/sites/${enc}/searchAnalytics/query`, access, payload(['query'], 25), t),
    gscPost(`/sites/${enc}/searchAnalytics/query`, access, payload(['page'], 25), t),
  ]);
  const rowsOf = (r) => ((r && r.ok && r.body && r.body.rows) || []);
  const aggRow = rowsOf(agg)[0] || null;
  return {
    status: 'ok',
    source: 'gsc',
    siteUrl,
    period: { start: ymd(start), end: ymd(end) },
    totals: aggRow
      ? {
          clicks: Math.round(aggRow.clicks),
          impressions: Math.round(aggRow.impressions),
          avgCtr: Number((aggRow.ctr * 100).toFixed(2)),
          avgPosition: Number(aggRow.position.toFixed(1)),
        }
      : null,
    queries: rowsOf(queries).map((r) => ({
      query: (r.keys && r.keys[0]) || '',
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: Number((r.ctr * 100).toFixed(2)),
      position: Number(r.position.toFixed(1)),
    })),
    pages: rowsOf(pages).map((r) => ({
      page: (r.keys && r.keys[0]) || '',
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: Number((r.ctr * 100).toFixed(2)),
      position: Number(r.position.toFixed(1)),
    })),
    notes: [agg.ok ? null : `汇总数据获取失败（${agg.error || agg.status}）`, queries.ok ? null : '查询词获取失败', pages.ok ? null : '页面获取失败'].filter(Boolean),
    refreshed,
  };
}
// ---- GSC coverage: sitemaps submission status + URL Inspection sampling ----

/**
 * Fetch the sitemaps listed in Search Console for the verified property
 * matching rawUrl. Returns per-sitemap submission + indexed counts.
 */
export async function listSitemaps({
  clientId, clientSecret, accessToken, refreshToken, expiresAt, rawUrl, timeoutMs = 30000,
} = {}) {
  const target = normalizePropertyInput(rawUrl);
  if (!target) return { status: 'error', error: { code: 'bad-url', message: '网址格式不正确（仅支持 http/https）' } };
  const t = clampInt(timeoutMs, 5000, 120000, 30000);
  const auth = await withAuth({ clientId, clientSecret, accessToken, refreshToken, expiresAt, timeoutMs: t });
  if (auth.status !== 'ok') return { status: 'error', error: auth.error, refreshed: auth.refreshed };
  const { access } = auth;

  const sitesRes = await gscGet('/sites', access, t);
  if (!sitesRes.ok) {
    return {
      status: 'error',
      error: { code: sitesRes.status === 401 || sitesRes.status === 403 ? 'unauthorized' : 'api-failed', message: sitesRes.error || (sitesRes.body && sitesRes.body.error && sitesRes.body.error.message) || `HTTP ${sitesRes.status}` },
      refreshed: auth.refreshed,
    };
  }
  const sites = ((sitesRes.body && sitesRes.body.siteEntry) || []).map((e) => e.siteUrl);
  const candidates = [target.origin, `sc-domain:${target.domain}`, `http://${target.host}/`];
  const siteUrl = candidates.find((c) => sites.includes(c)) || null;
  if (!siteUrl) {
    return { status: 'error', error: { code: 'no-property', message: `该网址不在你的 Search Console 已验证站点里（现有：${sites.slice(0, 5).join('、') || '无'}）` }, refreshed: auth.refreshed };
  }
  const enc = encodeURIComponent(siteUrl);
  const res = await gscGet(`/sites/${enc}/sitemaps`, access, t);
  if (!res.ok) {
    return {
      status: 'error',
      error: { code: res.status === 401 || res.status === 403 ? 'unauthorized' : 'api-failed', message: res.error || (res.body && res.body.error && res.body.error.message) || `HTTP ${res.status}` },
      refreshed: auth.refreshed,
    };
  }
  const entries = ((res.body && res.body.sitemap) || []).map((s) => ({
    path: s.path,
    lastSubmitted: s.lastSubmitted || null,
    lastDownloaded: s.lastDownloaded || null,
    isPending: !!s.isPending,
    isSitemapsIndex: !!s.isSitemapsIndex,
    errors: s.errors || null,
    warnings: s.warnings || null,
    submitted: s.contents ? Number(s.contents.submitted) || 0 : 0,
    indexed: s.contents ? Number(s.contents.indexed) || 0 : 0,
  }));
  return { status: 'ok', source: 'gsc', siteUrl, sitemaps: entries, refreshed: auth.refreshed };
}

/**
 * Sample up to `limit` URLs through the URL Inspection API.
 * urls: absolute URLs to inspect (same property). Returns per-URL index status.
 */
export async function inspectUrls({
  clientId, clientSecret, accessToken, refreshToken, expiresAt, rawUrl, urls = [], limit = 25, timeoutMs = 30000,
} = {}) {
  const target = normalizePropertyInput(rawUrl);
  if (!target) return { status: 'error', error: { code: 'bad-url', message: '网址格式不正确（仅支持 http/https）' } };
  const t = clampInt(timeoutMs, 5000, 120000, 30000);
  const auth = await withAuth({ clientId, clientSecret, accessToken, refreshToken, expiresAt, timeoutMs: t });
  if (auth.status !== 'ok') return { status: 'error', error: auth.error, refreshed: auth.refreshed };
  const { access } = auth;

  const sitesRes = await gscGet('/sites', access, t);
  if (!sitesRes.ok) {
    return {
      status: 'error',
      error: { code: sitesRes.status === 401 || sitesRes.status === 403 ? 'unauthorized' : 'api-failed', message: sitesRes.error || (sitesRes.body && sitesRes.body.error && sitesRes.body.error.message) || `HTTP ${sitesRes.status}` },
      refreshed: auth.refreshed,
    };
  }
  const sites = ((sitesRes.body && sitesRes.body.siteEntry) || []).map((e) => e.siteUrl);
  const candidates = [target.origin, `sc-domain:${target.domain}`, `http://${target.host}/`];
  const siteUrl = candidates.find((c) => sites.includes(c)) || null;
  if (!siteUrl) {
    return { status: 'error', error: { code: 'no-property', message: `该网址不在你的 Search Console 已验证站点里（现有：${sites.slice(0, 5).join('、') || '无'}）` }, refreshed: auth.refreshed };
  }

  const sample = [...new Set(urls.map((u) => String(u || '').trim()).filter(Boolean))].slice(0, clampInt(limit, 1, 100, 25));
  if (sample.length === 0) {
    return { status: 'error', error: { code: 'no-urls', message: '没有可抽查的 URL（先做一次站点体检，或提供 sitemap URL）' }, refreshed: auth.refreshed };
  }
  const API_V1 = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
  const results = [];
  for (const u of sample) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), t);
    try {
      const res = await fetch(`${API_V1}?siteUrl=${encodeURIComponent(siteUrl)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inspectionUrl: u, siteUrl, languageCode: 'zh-CN' }),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => ({}));
      const r = (body && body.inspectionResult) || {};
      const idx = r.indexStatusResult || {};
      results.push({
        url: u,
        ok: res.ok,
        verdict: r.verdict || null,
        coverageState: idx.coverageState || null,
        indexingState: idx.indexingState || null,
        robotsTxtState: idx.robotsTxtState || null,
        pageFetchState: idx.pageFetchState || null,
        lastCrawlTime: idx.lastCrawlTime || null,
        googleCanonical: idx.googleCanonical || null,
        userCanonical: idx.userCanonical || null,
        error: !res.ok ? ((body && body.error && body.error.message) || `HTTP ${res.status}`) : null,
      });
    } catch (err) {
      results.push({ url: u, ok: false, error: err && err.name === 'AbortError' ? '请求超时' : (err && err.message) || '请求失败' });
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 'ok', source: 'gsc', siteUrl, results, refreshed: auth.refreshed };
}

async function withAuth({ clientId, clientSecret, accessToken, refreshToken, expiresAt, timeoutMs }) {
  if (!accessToken || (expiresAt && expiresAt < Date.now() + 60_000)) {
    if (!refreshToken) return { status: 'error', error: { code: 'no-token', message: '需要先完成授权' } };
    const r = await refreshAccessToken({ clientId, clientSecret, refreshToken, timeoutMs });
    if (r.status !== 'ok') return { status: 'error', error: r.error };
    return { status: 'ok', access: r.accessToken, refreshed: { accessToken: r.accessToken, expiresAt: Date.now() + r.expiresIn * 1000 } };
  }
  return { status: 'ok', access: accessToken, refreshed: null };
}
