/**
 * Structured-data (JSON-LD) extraction and validation.
 *
 * Pure Node — no DSH services needed. Walks every
 * <script type="application/ld+json"> block, checks syntax, and validates the
 * detected schema.org types against a built-in requirement table (required vs
 * recommended properties) plus Google rich-result eligibility hints.
 */

/** schema.org requirement table: required + recommended properties. */
const REQUIREMENTS = {
  Article: { required: ['headline'], recommended: ['datePublished', 'author', 'image', 'publisher'] },
  Product: { required: ['name', 'offers'], recommended: ['image', 'brand', 'aggregateRating', 'sku'] },
  BreadcrumbList: { required: ['itemListElement'], recommended: ['itemListElement.item', 'itemListElement.name'] },
  FAQPage: { required: ['mainEntity'], recommended: ['mainEntity.acceptedAnswer', 'mainEntity.acceptedAnswer.text'] },
  Organization: { required: ['name'], recommended: ['url', 'logo', 'contactPoint'] },
  WebSite: { required: ['name', 'url'], recommended: ['potentialAction'] },
  WebPage: { required: ['name'], recommended: ['url', 'datePublished', 'author', 'description'] },
  LocalBusiness: { required: ['name', 'address'], recommended: ['telephone', 'openingHours', 'url', 'geo'] },
  Event: { required: ['name', 'startDate', 'location'], recommended: ['endDate', 'image', 'description', 'offers'] },
  Recipe: { required: ['name', 'recipeIngredient', 'recipeInstructions'], recommended: ['image', 'author', 'recipeYield', 'aggregateRating'] },
  VideoObject: { required: ['name', 'thumbnailUrl', 'uploadDate'], recommended: ['duration', 'description', 'contentUrl'] },
  JobPosting: { required: ['title', 'hiringOrganization', 'datePosted'], recommended: ['description', 'employmentType', 'validThrough'] },
  Course: { required: ['name', 'description', 'provider'], recommended: ['offers', 'hasCourseInstance'] },
  SoftwareApplication: { required: ['name'], recommended: ['offers', 'aggregateRating', 'applicationCategory'] },
  Dataset: { required: ['name', 'description'], recommended: ['url', 'distribution', 'creator'] },
  Person: { required: ['name'], recommended: ['url', 'jobTitle', 'image'] },
  Review: { required: ['itemReviewed', 'reviewRating'], recommended: ['author', 'reviewBody', 'datePublished'] },
  AggregateRating: { required: ['ratingValue'], recommended: ['ratingCount', 'bestRating', 'worstRating'] },
  CreativeWork: { required: ['name'], recommended: ['author', 'datePublished', 'publisher'] },
  HowTo: { required: ['name', 'step'], recommended: ['totalTime', 'image', 'tool'] },
  MedicalClinic: { required: ['name', 'address'], recommended: ['telephone', 'openingHours'] },
  Physician: { required: ['name', 'address'], recommended: ['telephone', 'openingHours'] },
};

/** Rich-result eligibility hints per type (Google guidance, non-exhaustive). */
const RICH_HINTS = {
  Product: '商品富结果：需 offers.price + offers.priceCurrency；提供 aggregateRating 可增强星级展示。',
  FAQPage: 'FAQ 富结果：每个 mainEntity Question 需带 acceptedAnswer.text（纯文本，内容不可用 HTML）。',
  BreadcrumbList: '面包屑富结果：itemListElement 至少 2 项，每项含 name，URL 用 item（末项可省略）。',
  Article: '文章富结果：需 headline + datePublished + author.image（作者头像）。',
  Event: '活动富结果：需 name + startDate + location。',
  Recipe: '食谱富结果：需 name + image + recipeIngredient + recipeInstructions。',
  VideoObject: '视频富结果：需 name + thumbnailUrl + uploadDate，且视频文件需可公开访问。',
  JobPosting: '职位招聘富结果：需 title + hiringOrganization + datePosted。',
  Review: '评论富结果：需 itemReviewed + reviewRating.ratingValue。',
  SoftwareApplication: '软件应用富结果：name + offers 或 aggregateRating 齐全时可申请。',
  Course: '课程富结果：需 name + description + provider。',
  Organization: '知识面板/机构信息：需 name；补 logo + url 更完整。',
  WebSite: '网站信息；加 potentialAction 可申请站点搜索框富结果。',
  LocalBusiness: '本地商家富结果/地图面板：需 name + address。',
  Person: '人物信息：需 name；补 url + image 更完整。',
  HowTo: '教程富结果：需 name + step。',
  MedicalClinic: '本地商家富结果：需 name + address。',
};

const LD_RE = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Extract every JSON-LD block: { raw, ok, error, data, types }. */
export function extractJsonLdBlocks(html) {
  const blocks = [];
  let m;
  const re = new RegExp(LD_RE.source, 'gi');
  while ((m = re.exec(html || '')) !== null) {
    let raw = m[1].replace(/^\s*<!--/, '').replace(/-->\s*$/, '').trim();
    if (!raw) continue;
    const block = { raw, ok: false, error: null, data: null, types: [] };
    try {
      const data = JSON.parse(raw);
      block.data = data;
      block.ok = true;
      const types = [];
      for (const node of iterNodes(data)) {
        const t = node['@type'];
        if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.push(x));
        else if (typeof t === 'string') types.push(t);
      }
      block.types = [...new Set(types)];
    } catch (err) {
      block.error = err && err.message ? String(err.message) : 'JSON 解析失败';
    }
    blocks.push(block);
  }
  return blocks;
}

/** Depth-first walk over JSON-LD data (arrays, @graph, nested nodes). */
function* iterNodes(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) yield* iterNodes(item, seen);
    return;
  }
  if (seen.has(node)) return;
  seen.add(node);
  yield node;
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') yield* iterNodes(value, seen);
  }
}

/** Resolve a dotted path ('offers.price') against a node; arrays are searched. */
function getPath(node, path) {
  const parts = path.split('.');
  let cur = node;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      // find the first array element that satisfies the remaining path
      for (const item of cur) {
        const value = getPath(item, parts.slice(i).join('.'));
        if (value !== undefined) return value;
      }
      return undefined;
    }
    cur = cur[parts[i]];
  }
  return cur;
}

/** True when the dotted path is present (value exists and is non-empty). */
function hasPath(node, path) {
  const value = getPath(node, path);
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Validate all JSON-LD blocks in the page.
 * Returns { status:'ok', url, finalUrl, fetchedAt, hasJsonLd, blocks, types, notes }.
 */
export function validateSchema(html, extra = {}) {
  const blocks = extractJsonLdBlocks(html).map((block) => {
    const out = {
      raw: block.raw,
      ok: block.ok,
      error: block.error,
      types: block.types,
      nodes: [],
      warnings: [],
      rich: { eligible: false, hints: [] },
    };
    if (!block.ok) {
      out.warnings.push('JSON-LD 语法错误：浏览器和搜索引擎都会忽略整个 block。');
      return out;
    }
    if (block.data && !block.data['@context']) {
      out.warnings.push('缺少 @context（应为 "https://schema.org"）。');
    } else if (block.data && block.data['@context'] && String(block.data['@context']).indexOf('schema.org') === -1) {
      out.warnings.push(`@context 不是 schema.org（"${String(block.data['@context']).slice(0, 40)}"），可能无法被识别。`);
    }
    // Validate each typed node whose type is in the requirement table.
    const seen = new Set();
    for (const node of iterNodes(block.data)) {
      const types = Array.isArray(node['@type']) ? node['@type'] : node['@type'] ? [node['@type']] : [];
      for (const type of types) {
        if (typeof type !== 'string') continue;
        const req = REQUIREMENTS[type];
        if (!req) continue;
        const key = `${type}:${node['@id'] || ''}:${Object.keys(node).sort().join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const missing = req.required.filter((p) => !hasPath(node, p));
        const warnings = req.recommended.filter((p) => !hasPath(node, p)).map((p) => `推荐属性缺失：${p}`);
        out.nodes.push({ type, present: Object.keys(node).filter((k) => k !== '@context' && k !== '@id' && k !== '@type'), missing, warnings });
        const hints = RICH_HINTS[type] ? [RICH_HINTS[type]] : [];
        if (hints.length) {
          out.rich.eligible = true;
          out.rich.hints = [...out.rich.hints, ...hints];
        }
      }
    }
    if (!out.types.length) out.warnings.push('未检测到 @type（无法判定类型）。');
    out.rich.hints = [...new Set(out.rich.hints)];
    return out;
  });

  const types = [...new Set(blocks.flatMap((b) => b.types))];
  const notes = [];
  if (blocks.length) {
    const okCount = blocks.filter((b) => b.ok).length;
    const badCount = blocks.length - okCount;
    if (badCount) notes.push(`${badCount} 个 block 存在语法错误，已被搜索引擎忽略。`);
    const missingTypes = types.filter((t) => !REQUIREMENTS[t]);
    if (missingTypes.length) notes.push(`未在规则表中的类型（不校验必填项）：${missingTypes.slice(0, 5).join('、')}${missingTypes.length > 5 ? ' 等' : ''}。`);
  }
  return {
    status: 'ok',
    url: extra.url || '',
    finalUrl: extra.finalUrl || extra.url || '',
    fetchedAt: extra.fetchedAt || new Date().toISOString(),
    hasJsonLd: blocks.length > 0,
    blocks,
    types,
    notes,
  };
}
