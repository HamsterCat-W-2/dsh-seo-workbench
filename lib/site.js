/**
 * Site-level aggregation: turns a crawl result into a site report with
 * cross-page checks (duplicates, dead links, thin pages, orphans, sitemap
 * coverage) and a weighted score, reusing the same report shape as the
 * single-page audit so the client can render it with the same components.
 */

import { scoreGroups } from './score.js';

const HTML_OK = (p) => !p.error && p.status >= 200 && p.status < 400;

function ratio(count, total) {
  return total > 0 ? count / total : 0;
}

function pct(r) {
  return `${Math.round(r * 100)}%`;
}

function mkCheck(id, label, weight, status, detail) {
  return { id, label, weight, status, detail };
}

function normTitle(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function groupByText(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function mkIssue(id, group, severity, title, impact, evidence, fix, extra = {}) {
  return { id, group, severity, title, impact, evidence, fix, priority: 0, ...extra };
}

export function buildSiteReport(crawl) {
  const pages = crawl.pages || [];
  const okPages = pages.filter((p) => HTML_OK(p) && !p.error);
  const failedPages = pages.filter((p) => p.error || p.status >= 400);
  // Links that point at pages we could not serve: sampled uncrawled targets
  // plus link-discovered pages that returned 4xx/5xx (the start URL and
  // sitemap seeds are site-level entries, not in-site links).
  const deadLinkMap = new Map();
  for (const d of crawl.deadLinks || []) deadLinkMap.set(d.url, d);
  for (const p of failedPages) {
    if (p.error || p.status < 400) continue;
    if (!p.referrer || p.referrer === 'sitemap') continue;
    const key = p.finalUrl || p.url;
    if (!deadLinkMap.has(key)) deadLinkMap.set(key, { url: key, status: p.status, foundOn: p.referrer });
  }
  const deadLinks = [...deadLinkMap.values()];
  const indexable = okPages.filter((p) => !p.noindex);
  const total = Math.max(1, okPages.length);

  const titleGroups = [...groupByText(indexable, (p) => normTitle(p.title))].filter(([, g]) => g.length >= 2);
  const descGroups = [...groupByText(indexable, (p) => normTitle(p.description))].filter(([, g]) => g.length >= 2);
  const dupTitlePages = new Set(titleGroups.flatMap(([, g]) => g.map((p) => p.finalUrl || p.url)));
  const dupDescPages = new Set(descGroups.flatMap(([, g]) => g.map((p) => p.finalUrl || p.url)));

  const startPage = pages[0];
  const startKeys = new Set(startPage ? [startPage.url, startPage.finalUrl] : [crawl.url]);
  const missingTitle = indexable.filter((p) => !String(p.title || '').trim());
  const missingDesc = indexable.filter((p) => !String(p.description || '').trim());
  const missingH1 = okPages.filter((p) => !(p.h1Count > 0));
  const missingCanonical = indexable.filter((p) => !p.canonical);
  const thin = okPages.filter((p) => (p.words || 0) < 300);
  const veryThin = okPages.filter((p) => (p.words || 0) < 100);
  const noindexPages = pages.filter((p) => p.noindex);
  const imgMissing = okPages.filter((p) => (p.imagesNoAlt || 0) > 0);
  const redirects = pages.filter((p) => (p.redirectCount || 0) > 0);
  const orphans = okPages.filter((p) => (p.inlinks || 0) === 0 && !startKeys.has(p.url) && !startKeys.has(p.finalUrl));
  const crawlFailed = failedPages;

  const groups = [];
  const issues = [];

  // ---- indexability ----
  const robotsCheck = crawl.robots
    ? crawl.robots.disallowAll
      ? mkCheck('robots', 'robots.txt', 0.2, 'fail', 'robots.txt 声明 Disallow: / — 整站被禁止抓取')
      : crawl.robots.status === 200
        ? mkCheck('robots', 'robots.txt', 0.2, 'pass', 'robots.txt 可访问，且未禁止整站')
        : mkCheck('robots', 'robots.txt', 0.2, 'warn', `robots.txt 返回 ${crawl.robots.status || '无法访问'}`)
    : mkCheck('robots', 'robots.txt', 0.2, 'warn', '未读取 robots.txt');
  const sitemapCheck = crawl.sitemap && crawl.sitemap.urls.length
    ? mkCheck('sitemap', 'sitemap', 0.15, 'pass', `发现 ${crawl.stats.sitemapUrls} 个 URL`)
    : mkCheck('sitemap', 'sitemap', 0.15, 'warn', '未发现可用的 sitemap');
  const crawlRatio = ratio(failedPages.length, attemptedOf(crawl));
  const crawlCheck = crawlRatio <= 0.05
    ? mkCheck('crawl-success', '抓取成功率', 0.35, 'pass', `${pages.length} 页中 ${failedPages.length} 页失败`)
    : crawlRatio <= 0.2
      ? mkCheck('crawl-success', '抓取成功率', 0.35, 'warn', `${pages.length} 页中 ${failedPages.length} 页失败（${pct(crawlRatio)}）`)
      : mkCheck('crawl-success', '抓取成功率', 0.35, 'fail', `${pages.length} 页中 ${failedPages.length} 页失败（${pct(crawlRatio)}）`);
  const indexRatio = ratio(noindexPages.length, pages.length);
  const indexCheck = indexRatio === 0
    ? mkCheck('indexable', '可索引页面', 0.15, 'pass', '所有抓取到的页面都允许索引')
    : indexRatio <= 0.1
      ? mkCheck('indexable', '可索引页面', 0.15, 'warn', `${noindexPages.length}/${pages.length} 页声明 noindex`)
      : mkCheck('indexable', '可索引页面', 0.15, 'fail', `${noindexPages.length}/${pages.length} 页声明 noindex`);
  const canonRatio = ratio(missingCanonical.length, indexable.length || 1);
  const canonCheck = canonRatio === 0
    ? mkCheck('canonical', 'canonical 覆盖', 0.15, 'pass', '可索引页面都有 canonical')
    : canonRatio <= 0.05
      ? mkCheck('canonical', 'canonical 覆盖', 0.15, 'warn', `${missingCanonical.length} 页缺 canonical（${pct(canonRatio)}）`)
      : mkCheck('canonical', 'canonical 覆盖', 0.15, 'fail', `${missingCanonical.length} 页缺 canonical（${pct(canonRatio)}）`);
  groups.push({ id: 'indexability', label: '可抓取与索引', weight: 0.35, checks: [robotsCheck, sitemapCheck, crawlCheck, indexCheck, canonCheck] });

  // ---- on-page ----
  const titleCheck = missingTitle.length === 0
    ? mkCheck('title', '标题覆盖', 0.3, 'pass', '可索引页面都有标题')
    : mkCheck('title', '标题覆盖', 0.3, ratio(missingTitle.length, indexable.length || 1) <= 0.05 ? 'warn' : 'fail', `${missingTitle.length} 页缺标题`);
  const descCheck = missingDesc.length === 0
    ? mkCheck('description', '描述覆盖', 0.25, 'pass', '可索引页面都有描述')
    : mkCheck('description', '描述覆盖', 0.25, ratio(missingDesc.length, indexable.length || 1) <= 0.3 ? 'warn' : 'fail', `${missingDesc.length} 页缺 meta description`);
  const h1Check = missingH1.length === 0
    ? mkCheck('h1', 'H1 覆盖', 0.2, 'pass', '所有页面都有 H1')
    : mkCheck('h1', 'H1 覆盖', 0.2, ratio(missingH1.length, total) <= 0.05 ? 'warn' : 'fail', `${missingH1.length} 页缺 H1`);
  const imgRatio = ratio(imgMissing.length, total);
  const imgCheck = imgRatio <= 0.1
    ? mkCheck('img-alt', '图片 alt 覆盖', 0.25, imgMissing.length === 0 ? 'pass' : 'warn', `${imgMissing.length} 页有缺 alt 的图片`)
    : mkCheck('img-alt', '图片 alt 覆盖', 0.25, 'fail', `${imgMissing.length} 页有缺 alt 的图片（${pct(imgRatio)}）`);
  groups.push({ id: 'onpage', label: 'On-Page', weight: 0.3, checks: [titleCheck, descCheck, h1Check, imgCheck] });

  // ---- content ----
  const thinRatio = ratio(thin.length, total);
  const thinCheck = thinRatio <= 0.1
    ? mkCheck('thin', '内容厚度', 0.45, thin.length === 0 ? 'pass' : 'warn', thin.length ? `${thin.length} 页少于 300 字` : '没有薄内容页')
    : mkCheck('thin', '内容厚度', 0.45, 'fail', `${thin.length} 页少于 300 字（${pct(thinRatio)}），其中 ${veryThin.length} 页少于 100 字`);
  const dupTitleCheck = titleGroups.length === 0
    ? mkCheck('dup-title', '重复标题', 0.3, 'pass', '没有重复标题')
    : titleGroups.length <= 2
      ? mkCheck('dup-title', '重复标题', 0.3, 'warn', `${titleGroups.length} 组页面共用标题`)
      : mkCheck('dup-title', '重复标题', 0.3, 'fail', `${titleGroups.length} 组页面共用标题`);
  const dupDescCheck = descGroups.length === 0
    ? mkCheck('dup-desc', '重复描述', 0.25, 'pass', '没有重复描述')
    : descGroups.length <= 2
      ? mkCheck('dup-desc', '重复描述', 0.25, 'warn', `${descGroups.length} 组页面共用描述`)
      : mkCheck('dup-desc', '重复描述', 0.25, 'fail', `${descGroups.length} 组页面共用描述`);
  groups.push({ id: 'content', label: '内容质量', weight: 0.2, checks: [thinCheck, dupTitleCheck, dupDescCheck] });

  // ---- structure ----
  const orphanRatio = ratio(orphans.length, Math.max(1, okPages.length - 1));
  const orphanCheck = orphans.length === 0
    ? mkCheck('orphan', '孤儿页', 0.35, 'pass', '所有页面都有站内入口')
    : orphanRatio <= 0.1
      ? mkCheck('orphan', '孤儿页', 0.35, 'warn', `${orphans.length} 页没有站内入链`)
      : mkCheck('orphan', '孤儿页', 0.35, 'fail', `${orphans.length} 页没有站内入链（${pct(orphanRatio)}）`);
  const deadCheck = deadLinks.length === 0
    ? mkCheck('dead-links', '死链', 0.4, 'pass', '抽样检查的站内链接都可访问')
    : deadLinks.length <= 2
      ? mkCheck('dead-links', '死链', 0.4, 'warn', `${deadLinks.length} 个站内链接不可访问`)
      : mkCheck('dead-links', '死链', 0.4, 'fail', `${deadLinks.length} 个站内链接不可访问`);
  const redirectRatio = ratio(redirects.length, pages.length);
  const redirectCheck = redirects.length === 0
    ? mkCheck('redirects', '重定向', 0.25, 'pass', '抓取到的页面没有重定向')
    : redirectRatio <= 0.1
      ? mkCheck('redirects', '重定向', 0.25, 'warn', `${redirects.length} 页带重定向`)
      : mkCheck('redirects', '重定向', 0.25, 'fail', `${redirects.length} 页带重定向（${pct(redirectRatio)}）`);
  groups.push({ id: 'structure', label: '站点结构', weight: 0.15, checks: [orphanCheck, deadCheck, redirectCheck] });

  const score = scoreGroups(groups);

  // ---- aggregated issues ----
  if (crawl.robots && crawl.robots.disallowAll) {
    issues.push(mkIssue('robots-disallow-all', 'indexability', 'critical', 'robots.txt 禁止整站抓取',
      '搜索引擎无法收录任何页面',
      'robots.txt 含 Disallow: /', '删掉 Disallow: / 规则，或确认这是有意为之'));
  }
  if (crawlFailed.length) {
    issues.push(mkIssue('crawl-failed', 'indexability', 'high', `${crawlFailed.length} 个页面抓取失败`,
      '这些页面无法被索引，或链接指向了失效地址',
      crawlFailed.slice(0, 8).map((p) => `${p.finalUrl || p.url}（${p.error || p.status}）`).join('；'),
      '修复失效链接或删除该页面，检查服务器返回 4xx/5xx 的原因',
      { pages: crawlFailed.slice(0, 20).map((p) => ({ url: p.finalUrl || p.url, detail: String(p.error || p.status) })) }));
  }
  if (!(crawl.sitemap && crawl.sitemap.urls.length)) {
    issues.push(mkIssue('sitemap-missing', 'indexability', 'medium', '没有可用的 sitemap',
      '搜索引擎发现新页面的效率降低',
      'robots.txt 未声明 sitemap，/sitemap.xml 也不存在', '生成并提交 sitemap.xml，在 robots.txt 里声明 Sitemap 行'));
  }
  if (noindexPages.length) {
    issues.push(mkIssue('noindex', 'indexability', 'medium', `${noindexPages.length} 个页面声明 noindex`,
      '这些页面不会出现在搜索结果里',
      noindexPages.slice(0, 8).map((p) => p.finalUrl || p.url).join('；'),
      '确认这些页面是否应被收录；如果需要收录就移除 noindex',
      { pages: noindexPages.slice(0, 20).map((p) => ({ url: p.finalUrl || p.url, detail: 'noindex' })) }));
  }
  if (missingTitle.length) {
    issues.push(mkIssue('title-missing', 'onpage', 'high', `${missingTitle.length} 个页面缺标题`,
      '搜索结果里无法展示标题，点击率大幅下降',
      missingTitle.slice(0, 8).map((p) => p.finalUrl || p.url).join('；'),
      '为每个页面补上唯一的 title（50–60 字符）',
      { pages: missingTitle.slice(0, 20).map((p) => ({ url: p.finalUrl || p.url, detail: '无 title' })) }));
  }
  if (missingDesc.length) {
    issues.push(mkIssue('description-missing', 'onpage', 'medium', `${missingDesc.length} 个页面缺 meta description`,
      '搜索结果摘要由搜索引擎自行截取，点击率不稳定',
      missingDesc.slice(0, 8).map((p) => p.finalUrl || p.url).join('；'),
      '为每个页面补 150–160 字符的描述',
      { pages: missingDesc.slice(0, 20).map((p) => ({ url: p.finalUrl || p.url, detail: '无 description' })) }));
  }
  if (missingH1.length) {
    issues.push(mkIssue('h1-missing', 'onpage', 'high', `${missingH1.length} 个页面缺 H1`,
      '页面主题信号缺失，影响相关性判断',
      missingH1.slice(0, 8).map((p) => p.finalUrl || p.url).join('；'),
      '给每个页面一个明确的 H1',
      { pages: missingH1.slice(0, 20).map((p) => ({ url: p.finalUrl || p.url, detail: '无 H1' })) }));
  }
  if (missingCanonical.length) {
    issues.push(mkIssue('canonical-missing', 'indexability', 'medium', `${missingCanonical.length} 个页面缺 canonical`,
      '重复 URL 变体（参数、尾斜杠）可能被当作独立页面',
      missingCanonical.slice(0, 8).map((p) => p.finalUrl || p.url).join('；'),
      '为每个可索引页面加上指向自己的 canonical',
      { pages: missingCanonical.slice(0, 20).map((p) => ({ url: p.finalUrl || p.url, detail: '无 canonical' })) }));
  }
  if (thin.length) {
    const severe = veryThin.length;
    issues.push(mkIssue('thin-content', 'content', severe ? 'high' : 'medium', `${thin.length} 个页面内容过薄`,
      '低质量页面稀释站点权重，影响整体排名',
      `${thin.length} 页少于 300 字${severe ? `，其中 ${severe} 页少于 100 字` : ''}：${thin.slice(0, 6).map((p) => p.finalUrl || p.url).join('；')}`,
      '合并薄页面或补充实质内容，不足 100 字的页面考虑 noindex',
      { pages: thin.slice(0, 20).map((p) => ({ url: p.finalUrl || p.url, detail: `${p.words || 0} 字` })) }));
  }
  if (titleGroups.length) {
    const detail = titleGroups.slice(0, 6).map(([t, g]) => `「${t.slice(0, 40)}」×${g.length}`).join('；');
    issues.push(mkIssue('duplicate-title', 'content', 'high', `${titleGroups.length} 组页面标题重复`,
      '搜索引擎无法区分这些页面的主题，通常只有一页能获得好排名',
      detail,
      '为每个页面写独有的标题；列表页/分页用不同的标题模板',
      { pages: titleGroups.slice(0, 10).map(([t, g]) => ({ url: g.map((p) => p.finalUrl || p.url).join('、'), detail: `「${t.slice(0, 40)}」×${g.length}` })) }));
  }
  if (descGroups.length) {
    issues.push(mkIssue('duplicate-description', 'content', 'medium', `${descGroups.length} 组页面描述重复`,
      '重复摘要削弱搜索结果的相关性和点击率',
      descGroups.slice(0, 6).map(([t, g]) => `「${t.slice(0, 40)}」×${g.length}`).join('；'),
      '为每个页面写独有描述',
      { pages: descGroups.slice(0, 10).map(([t, g]) => ({ url: g.map((p) => p.finalUrl || p.url).join('、'), detail: `「${t.slice(0, 40)}」×${g.length}` })) }));
  }
  if (orphans.length) {
    issues.push(mkIssue('orphan-pages', 'structure', 'medium', `${orphans.length} 个孤儿页（无站内入链）`,
      '这些页面只能靠 sitemap 被搜索引擎发现，权重传递不到',
      orphans.slice(0, 8).map((p) => p.finalUrl || p.url).join('；'),
      '从相关页面加内链指向它们，或把它们放进主导航/分类页',
      { pages: orphans.slice(0, 20).map((p) => ({ url: p.finalUrl || p.url, detail: '0 入链' })) }));
  }
  if (deadLinks.length) {
    issues.push(mkIssue('dead-links', 'structure', 'high', `${deadLinks.length} 个站内死链`,
      '用户和爬虫都会撞到 404，浪费抓取预算，降低体验',
      deadLinks.slice(0, 10).map((d) => `${d.url}（${d.status}，出自 ${d.foundOn}）`).join('；'),
      '修复失效链接或 301 到有效页面',
      { pages: deadLinks.slice(0, 20).map((d) => ({ url: d.url, detail: `${d.status} ← ${d.foundOn}` })) }));
  }
  if (redirects.length) {
    issues.push(mkIssue('redirect-chains', 'structure', 'medium', `${redirects.length} 个页面带重定向`,
      '重定向消耗抓取预算，链越长越可能丢失信号',
      redirects.slice(0, 8).map((p) => `${p.url} → ${p.finalUrl}`).join('；'),
      '把内链直接指向最终地址，减少 301 跳转',
      { pages: redirects.slice(0, 20).map((p) => ({ url: p.url, detail: `→ ${p.finalUrl}` })) }));
  }
  if (imgMissing.length) {
    issues.push(mkIssue('img-alt-missing', 'onpage', imgRatio >= 0.5 ? 'high' : 'medium', `${imgMissing.length} 个页面有缺 alt 的图片`,
      '图片无法被索引，也影响无障碍体验',
      imgMissing.slice(0, 8).map((p) => `${p.finalUrl || p.url}（${p.imagesNoAlt} 张）`).join('；'),
      '给内容图片补上描述性的 alt',
      { pages: imgMissing.slice(0, 20).map((p) => ({ url: p.finalUrl || p.url, detail: `${p.imagesNoAlt}/${p.imageCount} 张缺 alt` })) }));
  }

  issues.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || (b.pages ? b.pages.length : 0) - (a.pages ? a.pages.length : 0) || String(a.id).localeCompare(String(b.id)));
  issues.forEach((issue, i) => { issue.priority = i + 1; });

  const pageRows = pages.map((p) => {
    const served = HTML_OK(p) && !p.error; // only served HTML pages carry content flags
    return {
      url: p.finalUrl || p.url,
      depth: p.depth,
      httpStatus: p.status,
      error: p.error || null,
      title: p.title || null,
      words: p.words || 0,
      inlinks: p.inlinks || 0,
      redirectCount: p.redirectCount || 0,
      imagesNoAlt: p.imagesNoAlt || 0,
      imageCount: p.imageCount || 0,
      noindex: !!p.noindex,
      thin: served && (p.words || 0) < 300,
      missingTitle: served && !String(p.title || '').trim(),
      missingDesc: served && !(p.description || '').trim(),
      missingH1: served && !(p.h1Count > 0),
      missingCanonical: served && !p.canonical,
      dupTitle: dupTitlePages.has(p.finalUrl || p.url),
      dupDesc: dupDescPages.has(p.finalUrl || p.url),
      orphan: served && (p.inlinks || 0) === 0 && !startKeys.has(p.url) && !startKeys.has(p.finalUrl),
      failed: !served,
    };
  });

  return {
    status: 'ok',
    mode: 'site',
    url: crawl.url,
    finalUrl: crawl.url,
    origin: crawl.origin,
    fetchedAt: crawl.fetchedAt,
    durationMs: crawl.durationMs,
    stats: crawl.stats,
    robots: crawl.robots,
    sitemap: crawl.sitemap,
    pages: pageRows,
    groups,
    issues,
    notes: crawl.notes || [],
    score,
  };
}

function attemptedOf(crawl) {
  return Math.max(1, (crawl.pages || []).length);
}