// hreflang deep validation: self-references, reciprocal pairs, x-default,
// valid language-region codes, duplicate codes, target reachability, and
// canonical-in-set agreement. Pure functions over crawl page records — never throws.

const LANG_CODES = new Set(
  (
    'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'
  ).split(/\s+/),
);

const REGION_CODES = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
  ).split(/\s+/),
);

const X_DEFAULT = 'x-default';

/**
 * Parse an hreflang code like "en", "en-GB", "zh-Hans", "x-default".
 * Returns { valid, lang, region, reason } — reason only when invalid.
 * Grammar: ISO 639-1 (2 letters) optionally followed by "-" + ISO 3166-1
 * alpha-2 (2 letters) or an ISO 15924 script like "zh-Hans" (accepted,
 * script codes are 4 letters starting uppercase; we accept 4-letter codes).
 */
export function parseHreflangCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return { valid: false, reason: 'empty' };
  if (c === X_DEFAULT) return { valid: true, lang: c, region: null };
  const parts = c.split('-');
  const lang = parts[0];
  if (lang.length !== 2 || !LANG_CODES.has(lang)) {
    return { valid: false, reason: `非法语言码 "${code}"（应为 ISO 639-1，如 en、zh）` };
  }
  let region = null;
  if (parts.length === 2) {
    const sub = parts[1];
    if (sub.length === 2) {
      if (!REGION_CODES.has(sub)) return { valid: false, reason: `非法地区码 "${code}"（如 en-UK 应为 en-GB）` };
      region = sub;
    } else if (sub.length === 4) {
      region = sub; // ISO 15924 script, e.g. zh-Hans — accepted
    } else {
      return { valid: false, reason: `地区/脚本码长度非法 "${code}"` };
    }
  } else if (parts.length > 2) {
    return { valid: false, reason: `hreflang 码只能含一个连字符 "${code}"` };
  }
  return { valid: true, lang, region };
}

function absUrl(href, base) {
  try {
    return new URL(String(href || '').trim(), base).toString();
  } catch {
    return null;
  }
}

function sameUrl(a, b) {
  try {
    return new URL(a).origin + new URL(a).pathname === new URL(b).origin + new URL(b).pathname;
  } catch {
    return false;
  }
}

const GROUP = 'indexability';

/**
 * Validate hreflang across crawled pages.
 * pages: array of crawl page records: { url, finalUrl, hreflangs?, canonical?, status?, error?, noindex? }
 *   (hreflangs = [{ hreflang, href }] as produced by parsePage)
 * Returns { status, annotated: n, issues: [...], notes: [...] } — never throws.
 */
export function validateHreflangs(pages) {
  const issues = [];
  const notes = [];
  const byUrl = new Map();
  for (const p of pages) {
    const key = p.finalUrl || p.url;
    if (key) byUrl.set(key, p);
  }

  const annotated = pages.filter((p) => Array.isArray(p.hreflangs) && p.hreflangs.length > 0);
  if (annotated.length === 0) {
    return { status: 'ok', annotated: 0, issues: [], notes: ['没有页面声明 hreflang（单语言站点可忽略）'] };
  }

  // 1) per-page: self-reference, x-default, valid codes, duplicate codes,
  //    canonical-in-set. 2) cross-page: reciprocal pairs + target reachability.
  const pageSets = [];
  for (const p of annotated) {
    const pageUrl = p.finalUrl || p.url;
    const entries = [];
    const seen = new Map(); // code -> url (dup detection)
    const selfKeys = new Set([p.url, p.finalUrl].filter(Boolean));
    const canonical = p.canonical || null;
    let hasXDefault = false;
    for (const e of p.hreflangs) {
      const code = String(e.hreflang || '').trim();
      const target = absUrl(e.href, pageUrl);
      if (!target) continue;
      const parsed = parseHreflangCode(code);
      entries.push({ code, rawCode: e.hreflang, target, valid: parsed.valid, reason: parsed.reason });
      if (code === X_DEFAULT) hasXDefault = true;
      if (!parsed.valid) {
        issues.push({
          id: 'hreflang-invalid-code',
          group: GROUP,
          severity: 'medium',
          title: 'hreflang 使用了非法语言/地区码',
          impact: '非法的语言码会被搜索引擎忽略，可能整套 hreflang 失效。',
          evidence: parsed.reason,
          fix: '改成合法的 ISO 639-1 + ISO 3166-1 码（如 en-GB，而不是 en-UK）。',
          pages: [{ url: pageUrl, detail: `hreflang="${e.hreflang}"` }],
        });
        continue;
      }
      const key = parsed.lang + (parsed.region ? `-${parsed.region}` : '');
      if (seen.has(key)) {
        const prev = seen.get(key);
        if (prev !== target) {
          issues.push({
            id: 'hreflang-duplicate-code',
            group: GROUP,
            severity: 'high',
            title: '同一语言-地区码指向了不同 URL',
            impact: '同一语言码指向多个地址会让搜索引擎不确定该用哪个版本，影响索引。',
            evidence: `${key} 同时指向 ${prev} 与 ${target}`,
            fix: '同一语言-地区码只能保留一个目标 URL（通常是该语言的自引用）。',
            pages: [{ url: pageUrl, detail: `${key} → ${target}（与 ${prev} 冲突）` }],
          });
        }
      } else {
        seen.set(key, target);
      }
    }
    if (!hasXDefault) {
      issues.push({
        id: 'hreflang-missing-x-default',
        group: GROUP,
        severity: 'medium',
        title: '缺少 x-default 回退条目',
        impact: '无 x-default 时，未匹配语言/地区的用户无法获得回退页。',
        evidence: `${pageUrl} 的 hreflang 集合中没有 x-default`,
        fix: '增加 <link rel="alternate" hreflang="x-default" href="回退页">（通常是首页或默认语言版）。',
        pages: [{ url: pageUrl, detail: '缺少 x-default' }],
      });
    }
    const inSet = (u) => entries.some((e) => sameUrl(e.target, u));
    if (!selfKeys.size || ![...selfKeys].some((k) => inSet(k))) {
      issues.push({
        id: 'hreflang-no-self-reference',
        group: GROUP,
        severity: 'high',
        title: '页面没有把自己的 URL 放进 hreflang 集合',
        impact: '缺自引用会让整套 hreflang 失效（Google 规范要求每页都自引用）。',
        evidence: `${pageUrl} 的 hreflang 未包含自身`,
        fix: '在该页的 hreflang 集合里加入指向自身 URL 的条目（对应语言码）。',
        pages: [{ url: pageUrl, detail: '缺自引用' }],
      });
    }
    if (canonical && !inSet(canonical)) {
      issues.push({
        id: 'hreflang-canonical-mismatch',
        group: GROUP,
        severity: 'high',
        title: 'canonical 不在 hreflang 集合里',
        impact: 'canonical 与 hreflang 冲突时以 canonical 为准，整套 hreflang 可能被忽略。',
        evidence: `canonical=${canonical} 不在 ${pageUrl} 的 hreflang 集合中`,
        fix: '让该页的 hreflang 集合包含它的 canonical URL（通常就是自引用条目）。',
        pages: [{ url: pageUrl, detail: `canonical=${canonical}` }],
      });
    }
    pageSets.push({ page: p, pageUrl, entries, targets: entries.map((e) => e.target) });
  }

  // Cross-page: reciprocal + target reachability (only against crawled pages).
  for (const { pageUrl, entries } of pageSets) {
    for (const e of entries) {
      if (!e.valid) continue;
      const targetPage = byUrl.get(e.target) || null;
      if (!targetPage) continue; // target not crawled — reachability unknown
      const targetSet = pageSets.find((s) => (s.page.finalUrl || s.page.url) === (targetPage.finalUrl || targetPage.url));
      const back = targetSet && targetSet.entries.some((t) => sameUrl(t.target, pageUrl));
      if (!back) {
        issues.push({
          id: 'hreflang-not-reciprocal',
          group: GROUP,
          severity: 'medium',
          title: 'hreflang 不是双向互链',
          impact: 'A→B 但 B 没指回 A 时，该语言对会被丢弃，回退可能失效。',
          evidence: `${pageUrl} → ${e.target}（${e.code}），但 ${e.target} 未回链`,
          fix: `在 ${e.target} 的 hreflang 集合中加入指向 ${pageUrl} 的条目。`,
          pages: [{ url: pageUrl, detail: `${e.code} → ${e.target}` }],
        });
      }
      if (targetPage.error || !(targetPage.status >= 200 && targetPage.status < 300) || targetPage.noindex) {
        issues.push({
          id: 'hreflang-target-broken',
          group: GROUP,
          severity: 'high',
          title: 'hreflang 目标页不可索引或请求失败',
          impact: '指向 404 / 错误页 / noindex 页的 hreflang 会让该语言版本无法索引。',
          evidence: `${e.target} → status=${targetPage.status || 'error'}` + (targetPage.noindex ? ', noindex' : ''),
          fix: '让所有 hreflang 目标返回 200、可索引，且与 canonical 一致。',
          pages: [{ url: pageUrl, detail: `${e.code} → ${e.target}` }],
        });
      }
    }
  }

  // De-dup identical issues (multiple pages may raise the same one).
  const seenIssues = new Set();
  const deduped = [];
  for (const issue of issues) {
    const key = `${issue.id}|${issue.evidence}`;
    if (seenIssues.has(key)) {
      const prev = deduped.find((d) => `${d.id}|${d.evidence}` === key);
      if (prev && issue.pages) prev.pages.push(...issue.pages);
      continue;
    }
    seenIssues.add(key);
    deduped.push({ ...issue, pages: [...(issue.pages || [])] });
  }

  return {
    status: deduped.length === 0 ? 'ok' : 'warn',
    annotated: annotated.length,
    issues: deduped,
    notes: notes.length ? notes : [`${annotated.length} 个页面声明了 hreflang，已校验自引用/互链/语言码/目标可索引性`],
  };
}
