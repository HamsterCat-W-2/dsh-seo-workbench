/**
 * Dependency-free HTML extraction for SEO checks.
 *
 * Regex based on purpose: the goal is fast single-page analysis, not a robust
 * HTML5 parser. Every extractor is tolerant of malformed markup.
 */

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

export function getAttr(tag, name) {
  ATTR_RE.lastIndex = 0;
  let m;
  const target = name.toLowerCase();
  while ((m = ATTR_RE.exec(tag)) !== null) {
    if (m[1].toLowerCase() === target) return m[2] ?? m[3] ?? m[4] ?? '';
  }
  return null;
}

export function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return ' ';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return ' ';
      }
    });
}

export function stripTags(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

export function countWords(text) {
  const source = String(text);
  const cjk = (source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (source.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) || []).length;
  return { cjk, latin, total: cjk + latin };
}

export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : null;
}

export function extractMetas(html) {
  const out = [];
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    out.push({
      name: (getAttr(tag, 'name') || '').toLowerCase(),
      property: (getAttr(tag, 'property') || '').toLowerCase(),
      content: getAttr(tag, 'content') ?? '',
      httpEquiv: (getAttr(tag, 'http-equiv') || '').toLowerCase(),
      charset: getAttr(tag, 'charset'),
    });
  }
  return out;
}

export function extractLinks(html) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({
      rel: (getAttr(m[0], 'rel') || '').toLowerCase(),
      href: getAttr(m[0], 'href') || '',
      hreflang: getAttr(m[0], 'hreflang'),
    });
  }
  return out;
}

export function extractAnchors(html) {
  const out = [];
  const re = /<a\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = getAttr(m[0], 'href');
    if (!href) continue;
    out.push({ href, rel: (getAttr(m[0], 'rel') || '').toLowerCase() });
  }
  return out;
}

export function extractImages(html) {
  const out = [];
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const alt = getAttr(tag, 'alt');
    out.push({
      src: getAttr(tag, 'src') || getAttr(tag, 'data-src') || '',
      alt: alt === null ? null : alt, // null = attribute absent (empty string is valid decorative)
      loading: (getAttr(tag, 'loading') || '').toLowerCase(),
    });
  }
  return out;
}

export function extractHeadings(html) {
  const out = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({
      level: Number(m[1]),
      text: decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

export function extractJsonLd(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].replace(/^\s*<!--/, '').replace(/-->\s*$/, '').trim();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const types = [];
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }
        const type = node['@type'];
        if (Array.isArray(type)) {
          type.forEach((t) => typeof t === 'string' && types.push(t));
        } else if (typeof type === 'string') {
          types.push(type);
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') visit(value);
        }
      };
      visit(data);
      if (types.length) out.push({ raw, types });
    } catch {
      // Malformed JSON-LD blocks are common in the wild; skip them.
    }
  }
  return out;
}

export function extractHtmlLang(html) {
  const m = html.match(/<html\b[^>]*>/i);
  if (!m) return null;
  return getAttr(m[0], 'lang') || null;
}

export function hasMixedContent(html) {
  return /(?:src|href)\s*=\s*["']http:\/\//i.test(html);
}

/** Parse robots.txt: global disallow-all detection + Sitemap declarations. */
export function parseRobots(text) {
  let disallowAll = false;
  const sitemaps = [];
  let inGlobal = false;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (key === 'user-agent') {
      inGlobal = value === '*';
      continue;
    }
    if (key === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (inGlobal && key === 'disallow' && (value === '/' || value === '/*')) {
      disallowAll = true;
    }
  }
  return { disallowAll, sitemaps };
}

export function parsePage(html, baseUrl) {
  const base = new URL(baseUrl);
  const metas = extractMetas(html);
  const pick = (names) => metas.find((m) => names.includes(m.name) || names.includes(m.property));
  const links = extractLinks(html);
  const anchors = extractAnchors(html);
  const images = extractImages(html);
  const headings = extractHeadings(html);
  const visible = decodeEntities(stripTags(html));
  const words = countWords(visible);

  const canonical = (links.find((l) => l.rel.split(/\s+/).includes('canonical')) || {}).href || null;
  const hreflangs = links.filter((l) => l.hreflang);

  let internalLinks = 0;
  let externalLinks = 0;
  let nofollowLinks = 0;
  for (const anchor of anchors) {
    let u;
    try {
      u = new URL(anchor.href, baseUrl);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (u.host === base.host) internalLinks += 1;
    else externalLinks += 1;
    if (anchor.rel.split(/\s+/).includes('nofollow')) nofollowLinks += 1;
  }

  return {
    title: extractTitle(html),
    description: (pick(['description']) || {}).content?.trim() || null,
    viewport: (pick(['viewport']) || {}).content?.trim() || null,
    robotsMeta: (pick(['robots', 'googlebot']) || {}).content?.trim() || null,
    canonical,
    hreflangs,
    internalLinks,
    externalLinks,
    nofollowLinks,
    imageCount: images.length,
    imagesNoAlt: images.filter((i) => i.alt === null).length, // only missing attributes; empty alt="" is valid
    lazyCount: images.filter((i) => i.loading === 'lazy').length,
    h1s: headings.filter((h) => h.level === 1).map((h) => h.text),
    h2Count: headings.filter((h) => h.level === 2).length,
    h3Count: headings.filter((h) => h.level === 3).length,
    jsonldTypes: extractJsonLd(html).flatMap((j) => j.types),
    lang: extractHtmlLang(html),
    words,
    mixedContent: hasMixedContent(html),
  };
}