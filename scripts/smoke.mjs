/**
 * Standalone smoke test for the SEO engine — no DSH needed.
 *
 *   node scripts/smoke.mjs
 *
 * Serves a deliberately junk page on 127.0.0.1, runs runAudit against it and
 * asserts the report shape, redirect chain, robots/sitemap discovery, and the
 * expected issue set.
 */

import http from 'node:http';
import { runAudit } from '../lib/engine.js';
import { hasMixedContent } from '../lib/parse.js';
import { crawlSite } from '../lib/crawl.js';
import { buildSiteReport } from '../lib/site.js';

const PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>这是一个用于测试 SEO 引擎标题长度检测的超长标题，它的长度明显超过了七十个字符，用来验证当标题过长时检测结果是否按预期标记为需要修复的问题，并且包含一些额外的说明文字来确保长度确实足够长</title>
</head>
<body>
  <h1>主标题一</h1><h1>主标题二</h1>
  <h2>二级标题</h2>
  <img src="/a.png"><img src="/b.png" alt=""><img src="/c.png" alt="说明">
  <a href="/internal">内链</a><a href="https://example.com/external" rel="nofollow">外链</a>
  <p>正文内容</p>
</body>
</html>`;

const GOOD_PAGE = (port) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${'标'.repeat(55)}</title>
  <meta name="description" content="${'述'.repeat(155)}">
  <link rel="canonical" href="http://127.0.0.1:${port}/good">
  <link rel="alternate" hreflang="en" href="http://127.0.0.1:${port}/good?lang=en">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Good","url":"http://127.0.0.1:${port}/good"}</script>
</head>
<body>
  <h1>主标题</h1>
  <h2>二级一</h2><h2>二级二</h2>
  <a href="/good">内链</a>
  <p>${'文'.repeat(340)}</p>
</body>
</html>`;

const NOINDEX_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>禁索引测试页面标题用于验证检查器对 noindex 的识别是否准确可靠</title>
  <meta name="robots" content="noindex, nofollow">
</head>
<body><h1>标题</h1><p>${'文'.repeat(340)}</p></body>
</html>`;

// ---- site fixture: home links to dup-a/dup-b (same title+desc), thin,
// ---- orphan (sitemap-only), dead-404, and the robots-disallowed /admin.
const SITE_DUP = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>重复标题页面（完全相同的标题用于验证跨页重复检测是否按预期工作）</title>
  <meta name="description" content="重复描述内容完全相同的一段描述文字用于验证描述重复检测">
</head>
<body><h1>重复页标题</h1><p>${'文'.repeat(120)}</p><a href="/site/">首页</a></body>
</html>`;

const SITE_THIN = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>薄内容测试页面</title>
  <meta name="description" content="薄内容描述">
</head>
<body><h1>薄内容</h1><p>只有很少的正文。</p><a href="/site/">首页</a></body>
</html>`;

const SITE_ORPHAN = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>孤儿页测试页面（仅 sitemap 可达，无站内入链）</title>
  <meta name="description" content="孤儿页描述">
</head>
<body><h1>孤儿页</h1><p>${'文'.repeat(150)}</p></body>
</html>`;

const SITE_HOME = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>站点首页（测试站点体检模式的入口页面，标题长度在正常范围内）</title>
  <meta name="description" content="站点首页的描述文字，长度适中也完整清晰，用于站点体检的入口页检查">
</head>
<body>
  <h1>站点首页</h1>
  <p>${'文'.repeat(180)}</p>
  <a href="/dup-a">重复页 A</a>
  <a href="/dup-b">重复页 B</a>
  <a href="/thin">薄内容页</a>
  <a href="/dead-404">死链</a>
  <a href="/admin">管理后台</a>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/robots.txt') {
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(
      `User-agent: *\nDisallow: /private\nDisallow: /admin\nSitemap: http://127.0.0.1:${port}/sitemap.xml\n`,
    );
    return;
  }
  if (url === '/sitemap.xml') {
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(
      `<?xml version="1.0"?><urlset><url><loc>http://127.0.0.1:${port}/</loc></url><url><loc>http://127.0.0.1:${port}/dup-a</loc></url><url><loc>http://127.0.0.1:${port}/dup-b</loc></url><url><loc>http://127.0.0.1:${port}/thin</loc></url><url><loc>http://127.0.0.1:${port}/orphan</loc></url></urlset>`,
    );
    return;
  }
  if (url === '/old') {
    res.writeHead(301, { location: '/' });
    res.end();
    return;
  }
  if (url === '/good') {
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(GOOD_PAGE(port));
    return;
  }
  if (url === '/noindex') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(NOINDEX_PAGE);
    return;
  }
  if (url === '/site/' || url === '/site') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SITE_HOME);
    return;
  }
  if (url === '/dup-a' || url === '/dup-b') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SITE_DUP);
    return;
  }
  if (url === '/thin') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SITE_THIN);
    return;
  }
  if (url === '/orphan') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SITE_ORPHAN);
    return;
  }
  if (url === '/admin') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>管理后台</title></head><body><h1>后台</h1></body></html>');
    return;
  }
  if (url === '/dead-404') {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>404</title></head><body>Not Found</body></html>');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

try {
  const report = await runAudit(`${base}/`, { timeoutMs: 5000 });
  assert(report.status === 'ok', `status 应为 ok，实际 ${report.status}: ${JSON.stringify(report.error)}`);
  assert(report.page.httpStatus === 200, 'HTTP 状态应为 200');
  assert(report.groups.length === 4, `应返回 4 个分组，实际 ${report.groups.length}`);
  assert(typeof report.score.total === 'number', 'score.total 应为数字');
  assert(report.robots.status === 200 && !report.robots.disallowAll, 'robots.txt 应可访问且未禁止全站');
  assert(report.sitemap.urls === 5, `sitemap 应有 5 个 URL，实际 ${report.sitemap.urls}`);
  assert(report.page.h1s.length === 2, '应检测到 2 个 H1');
  assert(report.page.imagesNoAlt === 1, '应检测到 1 张缺失 alt 的图片');
  assert(report.page.internalLinks >= 1 && report.page.externalLinks === 1, '内链/外链计数不对');

  const issueIds = report.issues.map((issue) => issue.id);
  for (const expected of ['title-length', 'meta-description', 'h1', 'https', 'viewport', 'canonical', 'schema']) {
    assert(issueIds.includes(expected), `issues 应包含 ${expected}`);
  }
  assert(report.issues[0].priority === 1, 'issues 应按 priority 排序');

  const redirect = await runAudit(`${base}/old`, { timeoutMs: 5000 });
  assert(redirect.page.redirectChain.length === 1, '应记录 1 次重定向');
  assert(redirect.finalUrl === `${base}/`, `重定向后 finalUrl 应为 ${base}/`);

  const bad = await runAudit('ftp://example.com', { timeoutMs: 5000 });
  assert(bad.status === 'error' && bad.error.code === 'unsupported-protocol', '非 http/https 应返回 unsupported-protocol');

  // A page that should mostly pass: schema + canonical + hreflang + healthy title/desc/H1.
  const good = await runAudit(`${base}/good`, { timeoutMs: 5000 });
  const goodChecks = Object.fromEntries(
    good.groups.flatMap((g) => g.checks.map((c) => [c.id, c.status])),
  );
  assert(good.page.httpStatus === 200, 'good 页 HTTP 状态应为 200');
  for (const id of ['schema', 'title-length', 'meta-description', 'h1', 'heading-hierarchy', 'canonical']) {
    assert(goodChecks[id] === 'pass', `good 页 ${id} 检查应为 pass，实际 ${goodChecks[id]}`);
  }
  assert(good.page.hreflangs.length === 1, '应检测到 1 个 hreflang');
  assert(
    !good.issues.some((i) => ['title-length', 'meta-description', 'h1'].includes(i.id)),
    'good 页不应产生 title/meta/H1 问题',
  );

  // noindex must surface as a critical crawl issue.
  const noindex = await runAudit(`${base}/noindex`, { timeoutMs: 5000 });
  const mr = noindex.issues.find((i) => i.id === 'meta-robots');
  assert(mr, 'noindex 页应产生 meta-robots 问题');
  assert(mr.severity === 'critical', `meta-robots 严重度应为 critical，实际 ${mr.severity}`);

  // Mixed-content scope: subresources only, not plain external links.
  assert(hasMixedContent('<a href="http://plain.example">link</a>') === false, '普通外链不算混合内容');
  assert(hasMixedContent('<link rel="canonical" href="http://x/">') === false, 'canonical 链接不算混合内容');
  assert(hasMixedContent('<img src="http://x/a.png">') === true, 'img src=http 是混合内容');
  assert(hasMixedContent('<script src="http://x/a.js"></script>') === true, 'script src=http 是混合内容');
  assert(hasMixedContent('<link rel="stylesheet" href="http://x/a.css">') === true, 'stylesheet href=http 是混合内容');

  // ---- site crawl mode: cross-page aggregation report.
  const crawl = await crawlSite(`${base}/site/`, { maxPages: 30, maxDepth: 3, concurrency: 4, fetchTimeoutMs: 5000 });
  assert(crawl.status === 'ok', `站点抓取应为 ok，实际 ${crawl.status}: ${JSON.stringify(crawl.error)}`);
  assert(crawl.stats.pages >= 4, `站点应抓取 >= 4 页，实际 ${crawl.stats.pages}`);
  assert(crawl.stats.skippedDisallowed >= 1, '应跳过 robots 禁止的 /admin，实际 skippedDisallowed 为 ' + crawl.stats.skippedDisallowed);
  assert(crawl.robots.sitemaps.length === 1, 'robots.txt 的 Sitemap 行应被识别');
  assert(crawl.sitemap.urls.length === 5, `站点 sitemap 应有 5 个 URL，实际 ${crawl.sitemap.urls.length}`);

  const site = buildSiteReport(crawl);
  assert(site.status === 'ok' && site.mode === 'site', 'site 报告应 status ok / mode site');
  assert(typeof site.score.total === 'number', 'site score.total 应为数字');
  assert(site.groups.length === 4, `site 报告应有 4 个分组，实际 ${site.groups.length}`);
  const deadLinkIssue = site.issues.find((i) => i.id === 'dead-links');
  assert(deadLinkIssue && deadLinkIssue.pages.length >= 1, '站点体检 dead-links 问题应携带 >= 1 个页面');

  const siteIssueIds = site.issues.map((i) => i.id);
  for (const expected of ['duplicate-title', 'duplicate-description', 'thin-content', 'orphan-pages', 'dead-links']) {
    assert(siteIssueIds.includes(expected), `站点体检 issues 应包含 ${expected}，实际 ${siteIssueIds.join(',')}`);
  }
  assert(site.issues.every((i) => i.pages && i.pages.length >= 0), 'site 问题应携带 pages 明细');
  const orphanRows = site.pages.filter((p) => p.orphan);
  assert(orphanRows.length >= 1, '应标记出孤儿页');
  assert(orphanRows.some((p) => p.url.includes('/orphan')), `孤儿页应包含 /orphan，实际 ${orphanRows.map((p) => p.url).join(',')}`);
  const dupRows = site.pages.filter((p) => p.dupTitle);
  assert(dupRows.length >= 2, `应标记 >= 2 个重复标题页，实际 ${dupRows.length}`);
  assert(dupRows.some((p) => p.url.includes('/dup-a')) && dupRows.some((p) => p.url.includes('/dup-b')), `重复标题页应包含 /dup-a 与 /dup-b，实际 ${dupRows.map((p) => p.url).join(',')}`);
  const thinRow = site.pages.find((p) => p.thin && p.url.includes('/thin'));
  assert(thinRow, '应标记薄内容页 /thin');
  const deadRow = site.pages.find((p) => p.failed && p.url.includes('/dead-404'));
  assert(deadRow, '应标记死链页 /dead-404 为 failed');

  console.log('PASS smoke test');
  console.log(
    JSON.stringify(
      {
        score: report.score,
        issues: report.issues.map((i) => `${i.severity}:${i.id}`),
        groupChecks: report.groups.map((g) => `${g.id}:${g.checks.length}`),
        robots: report.robots,
        sitemap: report.sitemap,
      },
      null,
      2,
    ),
  );
} finally {
  server.close();
}