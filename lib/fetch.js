/**
 * Network layer for the SEO engine.
 *
 * Uses global fetch (Node 18+/Electron). Redirects are followed manually so the
 * chain can be reported. A plain HTML fetch is used — deliberately NOT the DSH
 * web.fetch pipeline: that pipeline strips <script> tags, which would remove
 * JSON-LD structured data we need for the schema check.
 */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SeoWorkbench/1.0';

export class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
  }
}

export function isHttpUrl(input) {
  try {
    const u = new URL(String(input).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Fetch a page following redirects manually so the chain can be recorded.
 * Returns { status, finalUrl, redirectChain, contentType, html, bytes, durationMs }.
 * Throws FetchError with code 'timeout' | 'network' | 'too-large' | 'too-many-redirects'.
 */
export async function fetchPage(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const started = Date.now();

  let current = String(url).trim();
  const redirectChain = [];

  for (let hop = 0; ; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new FetchError('timeout', `请求超时（${timeoutMs}ms）：${current}`);
      }
      throw new FetchError('network', `网络错误：${(err && err.message) || String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    const status = res.status;
    const location = res.headers.get('location');
    if (status >= 300 && status < 400 && location) {
      if (redirectChain.length >= maxRedirects) {
        throw new FetchError('too-many-redirects', `重定向超过 ${maxRedirects} 次`);
      }
      const next = resolveUrl(current, location);
      if (!next) throw new FetchError('network', `无效的重定向目标：${location}`);
      redirectChain.push({ from: current, to: next, status });
      current = next;
      continue;
    }

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > maxBytes) {
      throw new FetchError('too-large', `页面体积 ${contentLength} 字节，超过 ${maxBytes} 上限`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      status,
      finalUrl: current,
      redirectChain,
      contentType: (res.headers.get('content-type') || '').toLowerCase(),
      html: buffer.toString('utf8'),
      bytes: buffer.length,
      durationMs: Date.now() - started,
    };
  }
}

/** Fetch a text resource (robots.txt / sitemap.xml) without HTML parsing. */
export async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': userAgent, accept: '*/*' },
    });
    const text = await res.text();
    return { status: res.status, text, url: res.url || url };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new FetchError('timeout', `请求超时（${timeoutMs}ms）：${url}`);
    }
    throw new FetchError('network', `无法访问 ${url}：${(err && err.message) || String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}