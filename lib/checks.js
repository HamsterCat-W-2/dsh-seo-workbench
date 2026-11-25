/**
 * Check definitions for the SEO audit.
 *
 * Each check returns a record: { id, label, weight, status, detail, evidence?, impact?, fix?, severity? }.
 * Groups are weighted: 可抓取与索引 0.35 > 技术基础 0.25 > On-Page 0.30 > 内容质量 0.10.
 * status: 'pass' | 'warn' | 'fail' | 'info' (info is reported, not scored).
 */

import { parseHreflangCode } from './hreflang.js';

export const GROUP_WEIGHTS = { crawl: 0.35, technical: 0.25, onpage: 0.3, content: 0.1 };

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function mk(id, label, weight, status, detail, extra = {}) {
  return { id, label, weight, status, detail, ...extra };
}

function isAbsoluteUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function fmtKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function runChecks(ctx) {
  const { finalUrl, page, parsed, robots, sitemap, notes } = ctx;
  const groups = [];

  // ---------- 可抓取与索引 ----------
  const crawl = [];
  {
    const ok = page.status >= 200 && page.status < 300;
    crawl.push(
      mk('http-status', 'HTTP 状态码', 0.2, ok ? 'pass' : 'fail', `${page.status} ${ok ? '正常' : '异常'}`, {
        evidence: `最终状态码 ${page.status}${page.redirectChain.length ? `，经过 ${page.redirectChain.length} 次跳转` : ''}`,
        ...(ok
          ? {}
          : {
              severity: 'critical',
              impact: '搜索引擎抓取不到该页面，收录会失败。',
              fix: '确认 URL 是否有效，服务端应返回 200。',
            }),
      }),
    );
  }
  {
    const status = robots.status;
    let check;
    if (status >= 200 && status < 300) {
      if (robots.disallowAll) {
        check = mk('robots-txt', 'robots.txt', 0.2, 'fail', 'robots.txt 禁止全站抓取', {
          evidence: 'Disallow: /',
          severity: 'critical',
          impact: '全站内容都不会被搜索引擎收录。',
          fix: '在 robots.txt 中放开需要被抓取的路径。',
        });
      } else {
        check = mk('robots-txt', 'robots.txt', 0.2, 'pass', 'robots.txt 可访问，未禁止全站抓取');
      }
    } else if (status === 404) {
      check = mk('robots-txt', 'robots.txt', 0.2, 'warn', '未找到 robots.txt', {
        evidence: 'HTTP 404',
        impact: '站点无法向搜索引擎声明抓取规则与 Sitemap 地址。',
        fix: '生成 robots.txt，声明 Disallow 规则与 Sitemap 地址。',
      });
    } else {
      check = mk('robots-txt', 'robots.txt', 0.2, 'fail', `robots.txt 不可访问（${status || '连接失败'}）`, {
        evidence: `HTTP ${status || '网络错误'}`,
        impact: '抓取规则无法被搜索引擎读取。',
        fix: '确认 robots.txt 可正常访问并返回 200。',
      });
    }
    crawl.push(check);
  }
  {
    const found = !!sitemap.url;
    let check;
    if (found && sitemap.status >= 200 && sitemap.status < 300 && sitemap.urls > 0) {
      check = mk('sitemap', 'XML Sitemap', 0.2, 'pass', `发现 sitemap（${sitemap.urls} 个 URL）`, {
        evidence: sitemap.url,
      });
    } else if (found && sitemap.status >= 200 && sitemap.status < 300) {
      check = mk('sitemap', 'XML Sitemap', 0.2, 'warn', '发现 sitemap 但未解析到 URL', {
        evidence: sitemap.url,
        impact: 'sitemap 可能为空或格式异常，收录发现速度变慢。',
        fix: '检查 sitemap.xml 是否包含 <url><loc> 条目。',
      });
    } else {
      check = mk('sitemap', 'XML Sitemap', 0.2, 'warn', '未发现 sitemap.xml', {
        impact: '新页面与更新页面的发现速度变慢。',
        fix: '生成 sitemap.xml，并在 robots.txt 中声明 Sitemap 地址。',
      });
    }
    crawl.push(check);
  }
  {
    const canonical = parsed.canonical;
    let check;
    if (!canonical) {
      check = mk('canonical', 'Canonical 标签', 0.2, 'warn', '缺少 canonical 标签', {
        impact: '可能出现重复内容导致收录被分散。',
        fix: '为每个页面添加 <link rel="canonical" href="绝对地址">。',
      });
    } else if (!isAbsoluteUrl(canonical)) {
      check = mk('canonical', 'Canonical 标签', 0.2, 'warn', `canonical 不是绝对地址：${canonical}`, {
        impact: '相对地址在不同路径下解析可能出错。',
        fix: 'canonical 使用完整绝对 URL。',
      });
    } else {
      check = mk('canonical', 'Canonical 标签', 0.2, 'pass', `canonical 已声明：${canonical}`);
    }
    crawl.push(check);
  }
  {
    const robotsMeta = (parsed.robotsMeta || '').toLowerCase();
    let check;
    if (!robotsMeta) {
      check = mk('meta-robots', 'Meta Robots', 0.2, 'pass', '未设置 robots meta，默认可收录');
    } else if (robotsMeta.includes('noindex')) {
      check = mk('meta-robots', 'Meta Robots', 0.2, 'fail', `robots meta 包含 noindex：${parsed.robotsMeta}`, {
        evidence: parsed.robotsMeta,
        severity: 'critical',
        impact: '该页面不会被搜索引擎收录。',
        fix: '若不是有意禁止收录，移除 noindex。',
      });
    } else if (robotsMeta.includes('nofollow')) {
      check = mk('meta-robots', 'Meta Robots', 0.2, 'warn', `robots meta 包含 nofollow：${parsed.robotsMeta}`, {
        evidence: parsed.robotsMeta,
        impact: '页面上的链接不会被搜索引擎跟踪。',
        fix: '确认是否需要 nofollow。',
      });
    } else {
      check = mk('meta-robots', 'Meta Robots', 0.2, 'pass', `robots meta：${parsed.robotsMeta}`);
    }
    crawl.push(check);
  }
  groups.push({ id: 'crawl', label: '可抓取与索引', weight: GROUP_WEIGHTS.crawl, checks: crawl });

  // ---------- 技术基础 ----------
  const technical = [];
  {
    const isHttps = finalUrl.startsWith('https://');
    technical.push(
      mk('https', 'HTTPS', 0.2, isHttps ? 'pass' : 'fail', isHttps ? '页面使用 HTTPS' : '页面未使用 HTTPS', {
        evidence: finalUrl,
        ...(isHttps
          ? {}
          : {
              severity: 'high',
              impact: 'HTTP 站点会被浏览器标记不安全，也影响搜索排名。',
              fix: '启用 HTTPS 并做全站 301 跳转。',
            }),
      }),
    );
    if (!isHttps) {
      technical.push(mk('mixed-content', '混合内容（Mixed Content）', 0.1, 'info', '页面为 HTTP，无法评估混合内容'));
    } else if (parsed.mixedContent) {
      technical.push(
        mk('mixed-content', '混合内容（Mixed Content）', 0.1, 'fail', '发现 HTTP 资源引用', {
          evidence: '页面 src/href 中存在 http:// 引用',
          severity: 'high',
          impact: '浏览器会拦截 http:// 资源，影响渲染与体验。',
          fix: '将页面内所有资源改为 https:// 地址。',
        }),
      );
    } else {
      technical.push(mk('mixed-content', '混合内容（Mixed Content）', 0.1, 'pass', '未发现混合内容'));
    }
  }
  {
    const viewport = parsed.viewport;
    let check;
    if (!viewport) {
      check = mk('viewport', '移动端 Viewport', 0.15, 'fail', '缺少 viewport meta 标签', {
        severity: 'high',
        impact: '移动端会按桌面宽度缩放，移动体验差。',
        fix: '添加 <meta name="viewport" content="width=device-width, initial-scale=1">。',
      });
    } else if (/width\s*=\s*device-width/i.test(viewport)) {
      check = mk('viewport', '移动端 Viewport', 0.15, 'pass', '已声明 width=device-width');
    } else {
      check = mk('viewport', '移动端 Viewport', 0.15, 'warn', `viewport 内容：${viewport}`, {
        impact: '移动端适配可能不完整。',
        fix: '使用 width=device-width, initial-scale=1。',
      });
    }
    technical.push(check);
  }
  {
    const lang = parsed.lang;
    technical.push(
      mk('html-lang', 'HTML lang 属性', 0.05, lang ? 'pass' : 'warn', lang ? `已声明 lang="${lang}"` : '缺少 lang 属性', {
        ...(lang
          ? {}
          : {
              impact: '搜索引擎与朗读工具判断页面语言会受影响。',
              fix: '在 <html> 上声明 lang，如 lang="zh-CN"。',
            }),
      }),
    );
  }
  {
    const entries = (parsed.hreflangs || []).filter((e) => e && e.hreflang);
    const count = entries.length;
    if (!count) {
      technical.push(
        mk('hreflang', 'Hreflang', 0.05, 'info', '未声明 hreflang（单语言站点可忽略）'),
      );
    } else {
      const problems = [];
      let hasXDefault = false;
      let selfRef = false;
      const pageUrl = String(finalUrl || page.url || '').trim();
      for (const e of entries) {
        const code = String(e.hreflang).toLowerCase();
        if (code === 'x-default') hasXDefault = true;
        const parsedCode = parseHreflangCode(e.hreflang);
        if (!parsedCode.valid) problems.push(parsedCode.reason);
        let target = null;
        try {
          target = new URL(e.href, pageUrl || undefined).toString();
        } catch {
          target = null;
        }
        if (target && pageUrl && target === pageUrl) selfRef = true;
      }
      if (!hasXDefault) problems.push('缺少 x-default');
      if (!selfRef) problems.push('缺少指向自身的条目（自引用）');
      technical.push(
        mk(
          'hreflang',
          'Hreflang',
          0.05,
          problems.length ? 'warn' : 'pass',
          problems.length
            ? `${count} 个 hreflang，但有 ${problems.length} 个问题：${problems.join('；')}`
            : `已声明 ${count} 个 hreflang，码合法且含自引用与 x-default`,
          problems.length
            ? {
                severity: 'medium',
                impact: 'hreflang 声明不合规时整套标注可能被忽略，多语言站点难以正确互链。',
                fix: '使用合法语言码（en-GB 而非 en-UK），给每页加自引用条目和 x-default 回退。',
              }
            : {},
        ),
      );
    }
  }
  {
    const bytes = page.bytes;
    let check;
    if (bytes < 200 * 1024) {
      check = mk('page-weight', '页面体积', 0.15, 'pass', `HTML 体积 ${fmtKb(bytes)}`);
    } else if (bytes <= 1024 * 1024) {
      check = mk('page-weight', '页面体积', 0.15, 'warn', `HTML 体积 ${fmtKb(bytes)}（建议 <200KB）`, {
        impact: '体积偏大会拖慢首屏渲染。',
        fix: '精简内联脚本/样式，压缩 HTML，减少 DOM 数量。',
      });
    } else {
      check = mk('page-weight', '页面体积', 0.15, 'fail', `HTML 体积 ${fmtKb(bytes)}（建议 <200KB）`, {
        severity: 'high',
        impact: '体积过大明显拖慢加载速度。',
        fix: '精简内联资源，压缩 HTML，开启服务端压缩。',
      });
    }
    technical.push(check);
  }
  {
    technical.push(
      mk(
        'links',
        '链接概况',
        0,
        'info',
        `内链 ${parsed.internalLinks} 个，外链 ${parsed.externalLinks} 个，nofollow ${parsed.nofollowLinks} 个`,
      ),
    );
  }
  groups.push({ id: 'technical', label: '技术基础', weight: GROUP_WEIGHTS.technical, checks: technical });

  // ---------- On-Page ----------
  const onpage = [];
  {
    const title = parsed.title;
    let check;
    if (!title) {
      check = mk('title-length', 'Title 标签', 0.2, 'fail', '缺少 <title>', {
        severity: 'critical',
        impact: '搜索引擎无法判断页面主题，几乎不可能获得有利排名。',
        fix: '为页面添加 50–60 字符（中文字符）的 <title>。',
      });
    } else {
      const len = [...title].length;
      if (len >= 50 && len <= 60) {
        check = mk('title-length', 'Title 标签', 0.2, 'pass', `标题长度 ${len}（建议 50–60）`, { evidence: title });
      } else if ((len >= 30 && len < 50) || (len > 60 && len <= 70)) {
        check = mk('title-length', 'Title 标签', 0.2, 'warn', `标题长度 ${len}（建议 50–60）`, {
          evidence: title,
          impact: '标题过短浪费排名词机会，过长可能在结果页被截断。',
          fix: len < 50 ? '适当补充品牌词或核心关键词。' : '精简到 60 字符以内。',
        });
      } else {
        check = mk('title-length', 'Title 标签', 0.2, 'fail', `标题长度 ${len}（建议 50–60）`, {
          evidence: title,
          severity: 'high',
          impact: '标题长度严重偏离，影响相关性判断与点击率。',
          fix: len < 30 ? '增加描述性关键词，至少 30 字符。' : '精简标题，控制在 60 字符以内。',
        });
      }
    }
    onpage.push(check);
  }
  {
    const description = parsed.description;
    let check;
    if (!description) {
      check = mk('meta-description', 'Meta Description', 0.2, 'fail', '缺少 meta description', {
        severity: 'high',
        impact: '搜索结果摘要由引擎自行截取，点击率可能下降。',
        fix: '为页面添加 150–160 字符（中文字符）的 meta description。',
      });
    } else {
      const len = [...description].length;
      if (len >= 150 && len <= 160) {
        check = mk('meta-description', 'Meta Description', 0.2, 'pass', `描述长度 ${len}（建议 150–160）`);
      } else if ((len >= 80 && len < 150) || (len > 160 && len <= 220)) {
        check = mk('meta-description', 'Meta Description', 0.2, 'warn', `描述长度 ${len}（建议 150–160）`, {
          evidence: description,
          impact: '描述过短信息量不足，过长会被截断。',
          fix: len < 150 ? '补充卖点信息，接近 150 字符。' : '精简到 160 字符以内。',
        });
      } else {
        check = mk('meta-description', 'Meta Description', 0.2, 'fail', `描述长度 ${len}（建议 150–160）`, {
          evidence: description,
          severity: 'high',
          impact: '描述长度严重偏离，影响摘要质量。',
          fix: len < 80 ? '补充内容，至少 80 字符。' : '精简描述，控制在 220 字符以内。',
        });
      }
    }
    onpage.push(check);
  }
  {
    const h1s = parsed.h1s;
    let check;
    if (h1s.length === 0) {
      check = mk('h1', 'H1 标题', 0.2, 'fail', '页面缺少 H1', {
        severity: 'high',
        impact: '无法向搜索引擎传达页面主主题。',
        fix: '添加包含核心关键词的 H1，且每页只保留一个。',
      });
    } else if (h1s.length === 1) {
      check = mk('h1', 'H1 标题', 0.2, 'pass', `H1：${h1s[0].slice(0, 120)}`);
    } else {
      check = mk('h1', 'H1 标题', 0.2, 'warn', `页面有 ${h1s.length} 个 H1`, {
        evidence: h1s.slice(0, 3).join(' | '),
        impact: '多个 H1 会稀释页面主主题。',
        fix: '保留一个 H1，其余改为 H2。',
      });
    }
    onpage.push(check);
  }
  {
    const h2 = parsed.h2Count;
    const h3 = parsed.h3Count;
    let check;
    if (h2 === 0) {
      check = mk('heading-hierarchy', '标题层级', 0.1, 'warn', '缺少 H2 标题', {
        evidence: `H2 0 个，H3 ${h3} 个`,
        impact: '内容层级不清晰，影响可读性与主题归组。',
        fix: '用 H2 划分主要章节，H3 用于子章节。',
      });
    } else {
      check = mk('heading-hierarchy', '标题层级', 0.1, 'pass', `H2 ${h2} 个，H3 ${h3} 个`);
    }
    onpage.push(check);
  }
  {
    const total = parsed.imageCount;
    let check;
    if (total === 0) {
      check = mk('img-alt', '图片 Alt', 0.15, 'info', '页面没有图片');
    } else if (parsed.imagesNoAlt === 0) {
      check = mk('img-alt', '图片 Alt', 0.15, 'pass', `全部 ${total} 张图片都有 alt`);
    } else if (parsed.imagesNoAlt < total * 0.5) {
      check = mk('img-alt', '图片 Alt', 0.15, 'warn', `${parsed.imagesNoAlt}/${total} 张图片缺少 alt`, {
        impact: '图片搜索流量与可访问性受损。',
        fix: '为所有内容图片补充描述性 alt 文本。',
      });
    } else {
      check = mk('img-alt', '图片 Alt', 0.15, 'fail', `${parsed.imagesNoAlt}/${total} 张图片缺少 alt`, {
        severity: 'high',
        impact: '图片搜索流量与可访问性受损。',
        fix: '为所有内容图片补充描述性 alt 文本。',
      });
    }
    onpage.push(check);
  }
  {
    const total = parsed.imageCount;
    let check;
    if (total > 5 && parsed.lazyCount === 0) {
      check = mk('lazy-loading', '图片懒加载', 0.05, 'warn', `页面有 ${total} 张图片但未启用 loading="lazy"`, {
        impact: '首屏无关图片会拖慢加载。',
        fix: '为首屏外图片添加 loading="lazy"。',
      });
    } else if (total > 5) {
      check = mk('lazy-loading', '图片懒加载', 0.05, 'pass', `已对 ${parsed.lazyCount} 张图片启用懒加载`);
    } else {
      check = mk('lazy-loading', '图片懒加载', 0.05, 'info', `图片数量较少（${total} 张），无需评估懒加载`);
    }
    onpage.push(check);
  }
  {
    const types = parsed.jsonldTypes;
    let check;
    if (types.length > 0) {
      check = mk('schema', '结构化数据（JSON-LD）', 0.1, 'pass', `检测到类型：${types.slice(0, 4).join(' / ')}`);
    } else {
      check = mk('schema', '结构化数据（JSON-LD）', 0.1, 'warn', '未检测到 JSON-LD 结构化数据', {
        impact: '缺少富媒体搜索结果（评分、面包屑、FAQ 等）机会。',
        fix: '为内容添加合适的 JSON-LD（Article / Product / BreadcrumbList 等）。',
      });
      notes.push('结构化数据检测基于服务端输出的 HTML：纯前端 JS 注入的 JSON-LD 检测不到，可用「深度检测」走 PageSpeed 兜底。');
    }
    onpage.push(check);
  }
  groups.push({ id: 'onpage', label: 'On-Page', weight: GROUP_WEIGHTS.onpage, checks: onpage });

  // ---------- 内容质量 ----------
  const content = [];
  {
    const words = parsed.words.total;
    let check;
    if (words >= 300) {
      check = mk('thin-content', '内容厚度', 0.7, 'pass', `正文约 ${words} 字`);
    } else if (words >= 100) {
      check = mk('thin-content', '内容厚度', 0.7, 'warn', `正文约 ${words} 字（建议 ≥300）`, {
        impact: '内容过少可能被判定为低质量页面。',
        fix: '补充对用户有价值的内容。',
      });
    } else {
      check = mk('thin-content', '内容厚度', 0.7, 'fail', `正文约 ${words} 字，内容过少`, {
        severity: 'high',
        impact: '可能被判定为低质量页或软 404。',
        fix: '补充真实内容，或将该页设为 noindex。',
      });
    }
    content.push(check);
  }
  {
    const title = parsed.title;
    const description = parsed.description;
    let check;
    if (title && description && title === description) {
      check = mk('duplicate-meta', '标题与描述重复', 0.3, 'warn', '标题与描述完全相同', {
        impact: '描述未提供额外信息，浪费摘要位置。',
        fix: '让描述补充标题之外的信息。',
      });
    } else {
      check = mk('duplicate-meta', '标题与描述重复', 0.3, 'pass', '标题与描述不相同');
    }
    content.push(check);
    notes.push('跨页重复的标题/描述需要整站分析（Phase 2 爬虫）才能判断。');
  }
  groups.push({ id: 'content', label: '内容质量', weight: GROUP_WEIGHTS.content, checks: content });

  // ---------- issues（fail/warn → 修复清单） ----------
  const issues = [];
  for (const group of groups) {
    for (const check of group.checks) {
      if (check.status !== 'fail' && check.status !== 'warn') continue;
      const severity = check.status === 'fail' ? check.severity || 'high' : 'medium';
      issues.push({
        id: check.id,
        group: group.id,
        severity,
        title: check.label,
        impact: check.impact || '',
        evidence: check.evidence || check.detail || '',
        fix: check.fix || '',
        priority: 0,
      });
    }
  }
  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id));
  issues.forEach((issue, index) => {
    issue.priority = index + 1;
  });

  return { groups, issues };
}