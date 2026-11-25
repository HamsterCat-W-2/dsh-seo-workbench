// Chrome UX Report (field Core Web Vitals): real-user p75 metrics for an origin.
// Requires a Google API key (same project style as PSI). Never throws.

const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function p75ms(metric, unit) {
  const p = metric && metric.percentiles && metric.percentiles.p75;
  if (!p) return null;
  if (unit === 'ms') return p.milliseconds == null ? null : Math.round(p.milliseconds);
  return p.smallerIsBetter == null ? null : Number(p.smallerIsBetter.toFixed(3));
}

export async function runCrux(rawUrl, { key, timeoutMs = 30000 } = {}) {
  let origin;
  try {
    origin = new URL(String(rawUrl || '')).origin;
    if (!/^https?:$/.test(new URL(origin).protocol)) throw new Error('bad');
  } catch {
    return { status: 'error', error: { code: 'bad-url', message: '网址格式不正确（仅支持 http/https）' } };
  }
  if (!key) {
    return { status: 'error', error: { code: 'no-key', message: '未配置 CrUX API Key（⚙ 设置 → 深度检测 → CrUX API Key，或环境变量 CRUX_API_KEY）' } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clampInt(timeoutMs, 5000, 120000, 30000));
  try {
    const res = await fetch(`${CRUX_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        const err = body.error && (body.error.message || body.error.status);
        if (err) message = String(err);
      } catch { /* keep http status */ }
      const code =
        res.status === 400 && /not found|not available|no.*data|origin.*crx/i.test(message)
          ? 'no-data'
          : /quota/i.test(message)
            ? 'quota'
            : /key not valid|invalid key/i.test(message)
              ? 'bad-key'
              : res.status === 403
                ? 'forbidden'
                : 'http-error';
      return { status: 'error', error: { code, message } };
    }
    const body = await res.json();
    const metrics = body.record && body.record.metrics ? body.record.metrics : {};
    const period = body.record && body.record.collectionPeriod ? body.record.collectionPeriod : null;
    const cwv = {
      lcpMs: p75ms(metrics.largest_contentful_paint, 'ms'),
      cls: p75ms(metrics.cumulative_layout_shift),
      inpMs: p75ms(metrics.interaction_to_next_paint, 'ms'),
      fcpMs: p75ms(metrics.first_contentful_paint, 'ms'),
      fidMs: p75ms(metrics.first_input_delay, 'ms'),
      ttfbMs: p75ms(metrics.experimental_time_to_first_byte, 'ms'),
    };
    return {
      status: 'ok',
      source: 'crux',
      origin,
      url: body.urlNormalizationDetails && body.urlNormalizationDetails.normalizedUrl ? body.urlNormalizationDetails.normalizedUrl : origin,
      collectionPeriod: period
        ? {
            first: period.firstDate ? `${period.firstDate.year}-${String(period.firstDate.month).padStart(2, '0')}-${String(period.firstDate.day).padStart(2, '0')}` : null,
            last: period.lastDate ? `${period.lastDate.year}-${String(period.lastDate.month).padStart(2, '0')}-${String(period.lastDate.day).padStart(2, '0')}` : null,
          }
        : null,
      cwv,
      hasData: Object.values(cwv).some((v) => v != null),
    };
  } catch (err) {
    const code = err && err.name === 'AbortError' ? 'timeout' : 'network';
    return { status: 'error', error: { code, message: err && err.message ? String(err.message) : '请求失败' } };
  } finally {
    clearTimeout(timer);
  }
}
