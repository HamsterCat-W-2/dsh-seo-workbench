/**
 * Client half of @local/seo-workbench — a left-sidebar panel (navigation row,
 * same surface as Plugins/Settings) opening the SEO workbench in the central
 * `main` column.
 *
 * Plain JS (loaded by the ModuleLoader, no build step) using
 * React.createElement; React comes from the browser module table via
 * require('react'). All data flows through same-origin fetch to the Host
 * routes registered in index.js (/seo-workbench/api/audit, /seo-workbench/api/deep).
 * Styling uses DSH theme tokens only (no primitives imports).
 */

window.__ModuleLoader__.load({
  id: '@local/seo-workbench',
  factory(require) {
    const React = require('react');
    const { useState } = React;
    const h = React.createElement;
    const el = (type, props, ...children) => h(type, props || null, ...children);

    const API = '/seo-workbench/api/';
    const cx = (...names) => names.filter(Boolean).join(' ');

    const ERROR_CODES = {
      'method-not-allowed': '插件宿主未加载，/seo-workbench 路由未注册（请重启 DSH）',
      'bad-json': '请求格式错误',
      'missing-url': '缺少网址参数',
      'internal': '审计服务内部错误',
      'bad-body': '请求体过大或格式错误',
    };
    const SEVERITY_LABELS = { critical: '严重', high: '高', medium: '中', low: '低' };

    function normalizeUrl(input) {
      const value = String(input || '').trim();
      if (!value) return { url: '', error: '' };
      const candidates = [];
      try { candidates.push(new URL(value)); } catch {}
      try { candidates.push(new URL('https://' + value)); } catch {}
      for (const u of candidates) {
        if (u.protocol === 'http:' || u.protocol === 'https:') return { url: u.href, error: '' };
      }
      return { url: '', error: '网址格式不正确（仅支持 http/https）' };
    }

    async function postJson(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      let data;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        if (data === null) throw new Error(`接口异常（HTTP ${res.status}）`);
        const code = data.error || data.code;
        const message = data.message || (code && ERROR_CODES[code]) || code || `接口异常（HTTP ${res.status}）`;
        throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
      }
      if (data === null) throw new Error('服务返回了非 JSON 响应');
      return data;
    }

    const scoreClass = (score) => (score >= 80 ? 'ok' : score >= 60 ? 'warn' : 'bad');
    const barColor = (score) =>
      score >= 80 ? 'var(--dsw-alias-state-success-primary)' : score >= 60 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)';

    // ---------- Markdown export ----------
    function buildMarkdown(report, deep) {
      const L = [];
      L.push('# SEO 分析报告');
      L.push('');
      L.push(`- 目标地址：${report.url}`);
      L.push(`- 最终地址：${report.finalUrl}`);
      L.push(`- 分析时间：${report.fetchedAt || '—'}`);
      L.push(`- 耗时：${report.durationMs}ms`);
      L.push(`- 综合得分：**${report.score.total}/100**`);
      L.push('');
      L.push('## 分组得分');
      L.push('');
      L.push('| 分组 | 得分 |');
      L.push('| --- | --- |');
      for (const group of (report.groups || [])) L.push(`| ${group.label} | ${group.score} |`);
      L.push('');
      L.push('## 问题清单');
      L.push('');
      if (!report.issues || !report.issues.length) {
        L.push('未发现问题。');
      } else {
        for (const issue of report.issues) {
          L.push(`1. **[${issue.severity}] ${issue.title}**`);
          if (issue.impact) L.push(`   - 影响：${issue.impact}`);
          if (issue.evidence) L.push(`   - 证据：${issue.evidence}`);
          if (issue.fix) L.push(`   - 修复：${issue.fix}`);
        }
      }
      L.push('');
      L.push('## 检查明细');
      L.push('');
      for (const group of (report.groups || [])) {
        L.push(`### ${group.label}（${group.score}/100）`);
        for (const check of group.checks) L.push(`- [${check.status}] ${check.label}：${check.detail}`);
        L.push('');
      }
      L.push('## 页面概况');
      const p = report.page || {};
      L.push(`- Title：${p.title || '—'}`);
      L.push(`- Description：${p.description || '—'}`);
      L.push(`- H1：${(p.h1s || []).join(' / ') || '—'}`);
      L.push(`- 正文字数：${p.words ? p.words.total : '—'}`);
      L.push(`- 内链 / 外链：${p.internalLinks || 0} / ${p.externalLinks || 0}`);
      L.push(`- 页面体积：${p.bytes ? `${(p.bytes / 1024).toFixed(1)}KB` : '—'}`);
      L.push(`- robots.txt：${report.robots ? report.robots.status : '—'}`);
      L.push(
        `- sitemap：${report.sitemap && report.sitemap.url ? `${report.sitemap.url}（${report.sitemap.urls} 个 URL）` : '未发现'}`,
      );
      if (deep && deep.status === 'ok') {
        L.push('');
        L.push('## 深度检测（PageSpeed Insights）');
        L.push(`- Performance：${Math.round((deep.performance || 0) * 100)}`);
        L.push(`- SEO：${Math.round((deep.seo || 0) * 100)}`);
        L.push(`- Accessibility：${Math.round((deep.accessibility || 0) * 100)}`);
        L.push(`- Best Practices：${Math.round((deep.bestPractices || 0) * 100)}`);
        if (deep.cwv) {
          L.push(`- LCP：${deep.cwv.lcpMs}ms`);
          L.push(`- CLS：${deep.cwv.cls}`);
          L.push(`- INP：${deep.cwv.inpMs}ms`);
          L.push(`- TTFB：${deep.cwv.ttfbMs}ms`);
          L.push(`- FCP：${deep.cwv.fcpMs}ms`);
        }
        L.push(`- 结构化数据：${deep.schemaFound ? '检测到' : deep.schemaFound === false ? '未检测到' : '未知'}`);
      }
      if (report.notes && report.notes.length) {
        L.push('');
        L.push('## 备注');
        for (const note of report.notes) L.push(`- ${note}`);
      }
      return L.join('\n');
    }

    function downloadText(text, filename) {
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function copyText(text, focusEl) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand('copy');
        } catch {
          ok = false;
        }
        document.body.removeChild(ta);
        if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
        return ok;
      }
    }

    // ---------- UI ----------
    function SeoWorkbenchBody(props) {
      const [input, setInput] = useState('');
      const [busy, setBusy] = useState(null); // null | 'audit' | 'deep'
      const [report, setReport] = useState(null);
      const [deep, setDeep] = useState(null);
      const [error, setError] = useState('');
      const [tab, setTab] = useState('issues');
      const [openIssue, setOpenIssue] = useState(null);
      const [openGroup, setOpenGroup] = useState(null);
      const [copied, setCopied] = useState(false);

      const runAudit = async () => {
        if (busy) return;
        const { url, error: urlError } = normalizeUrl(input);
        if (urlError) {
          setError(urlError);
          return;
        }
        if (!url) return;
        setBusy('audit');
        setError('');
        setDeep(null);
        try {
          const result = await postJson('audit', { url });
          if (!result || (result.status !== 'ok' && result.status !== 'error')) {
            throw new Error('服务返回了无法识别的结果');
          }
          setReport(result);
          setTab('issues');
        } catch (err) {
          const message = String((err && err.message) || err);
          setError(
            message === 'Failed to fetch' || message === 'NetworkError when attempting to fetch resource.'
              ? '无法连接审计服务（插件宿主未加载或已崩溃，请重启 DSH 后重试）'
              : message,
          );
        } finally {
          setBusy(null);
        }
      };

      const runDeep = async () => {
        if (busy) return;
        if (!report || report.status !== 'ok') return;
        setBusy('deep');
        try {
          setDeep(await postJson('deep', { url: report.finalUrl || report.url }));
        } catch (err) {
          setDeep({ status: 'error', error: { code: 'client', message: err.message || String(err) } });
        } finally {
          setBusy(null);
        }
      };

      const onKeyDown = (event) => {
        if (event.key !== 'Enter') return;
        if (event.isComposing || (event.nativeEvent && event.nativeEvent.isComposing)) return;
        runAudit();
      };

      const exportMd = () => {
        if (!report) return;
        downloadText(buildMarkdown(report, deep), `seo-report-${Date.now()}.md`);
      };

      const copyMd = async (event) => {
        if (!report) return;
        const ok = await copyText(buildMarkdown(report, deep), event && event.currentTarget);
        setCopied(ok);
        setTimeout(() => setCopied(false), 1500);
      };

      const nodes = [];

      // Header + input
      nodes.push(
        el('div', { className: 'seo-wb-input-row' },
          el('input', {
            className: 'seo-wb-input',
            placeholder: '输入网址，如 example.com',
            value: input,
            maxLength: 2048,
            disabled: busy !== null,
            onChange: (e) => setInput(e.target.value),
            onKeyDown,
            'aria-label': '要分析的网址',
          }),
          el('button', { type: 'button', className: 'seo-wb-btn primary', disabled: busy !== null, onClick: runAudit }, busy === 'audit' ? '分析中' : '分析'),
        ),
      );

      // Busy indicator
      if (busy === 'audit') {
        nodes.push(
          el('div', { className: 'seo-wb-spinner', role: 'status', 'aria-live': 'polite' },
            el('div', { className: 'seo-wb-spinner-dot' }),
            '正在抓取并分析页面…',
          ),
        );
      }

      // Error — shown even when an older report is still on screen (the new
      // audit failed, so the stale report below must not look like its result).
      if (error) {
        nodes.push(el('div', { className: 'seo-wb-error', role: 'alert' }, error));
      }

      // Report
      if (report) {
        if (report.status === 'error') {
          nodes.push(
            el('div', { className: 'seo-wb-card' },
              el('div', { className: 'seo-wb-error' }, `分析失败：${(report.error && report.error.message) || '未知错误'}`),
            ),
          );
        } else {
          const score = report.score && typeof report.score.total === 'number' ? report.score.total : 0;
          const groups = Array.isArray(report.groups) ? report.groups : [];
          // Score overview
          nodes.push(
            el('div', { className: 'seo-wb-card' },
              el('div', { className: 'seo-wb-score-row' },
                el('div', { className: cx('seo-wb-score-big', scoreClass(score)) }, score),
                el('div', { className: 'seo-wb-groups' },
                  groups.map((group) =>
                    el('div', { className: 'seo-wb-group-row', key: group.id },
                      el('span', { style: { minWidth: '64px', flexShrink: 0, whiteSpace: 'nowrap' } }, group.label),
                      el('div', { className: 'seo-wb-bar' },
                        el('div', { className: 'seo-wb-bar-fill', style: { width: `${group.score}%`, background: barColor(group.score) } }),
                      ),
                      el('span', { style: { width: '22px', textAlign: 'right' } }, group.score),
                    ),
                  ),
                ),
              ),
            ),
          );

          // Action row
          nodes.push(
            el('div', { className: 'seo-wb-actions' },
              el('button', { type: 'button', className: 'seo-wb-btn', disabled: busy !== null, onClick: runDeep }, busy === 'deep' ? '检测中…' : '深度检测（CWV）'),
              el('button', { type: 'button', className: 'seo-wb-btn', onClick: exportMd }, '导出 .md'),
              el('button', { type: 'button', className: 'seo-wb-btn', onClick: copyMd }, copied ? '已复制 ✓' : '复制'),
            ),
          );

          if (busy === 'deep') {
            nodes.push(
              el('div', { className: 'seo-wb-spinner', role: 'status', 'aria-live': 'polite' },
                el('div', { className: 'seo-wb-spinner-dot' }),
                '正在请求 PageSpeed 深度检测…',
              ),
            );
          }

          // Deep result
          if (deep) {
            nodes.push(DeepSection({ deep }));
          }

          // Tabs
          nodes.push(
            el('div', { className: 'seo-wb-tabs', role: 'tablist', 'aria-label': '报告视图' },
              el('button', { type: 'button', className: cx('seo-wb-tab', tab === 'issues' && 'active'), role: 'tab', 'aria-selected': tab === 'issues', onClick: () => setTab('issues') }, `问题 (${(Array.isArray(report.issues) ? report.issues : []).length})`),
              el('button', { type: 'button', className: cx('seo-wb-tab', tab === 'details' && 'active'), role: 'tab', 'aria-selected': tab === 'details', onClick: () => setTab('details') }, '检查明细'),
              el('button', { type: 'button', className: cx('seo-wb-tab', tab === 'overview' && 'active'), role: 'tab', 'aria-selected': tab === 'overview', onClick: () => setTab('overview') }, '页面概况'),
            ),
          );

          if (tab === 'issues') {
            nodes.push(IssuesSection({ issues: report.issues, openIssue, setOpenIssue }));
          } else if (tab === 'details') {
            nodes.push(DetailsSection({ groups: report.groups, openGroup, setOpenGroup }));
          } else {
            nodes.push(OverviewSection({ report }));
          }

          // Notes
          if (report.notes && report.notes.length) {
            nodes.push(
              el('div', { className: 'seo-wb-note' },
                report.notes.map((note, index) => el('div', { key: index }, `※ ${note}`)),
              ),
            );
          }
        }
      }

      return el('div', { className: 'seo-wb-root' }, ...nodes);
    }

    function DeepSection({ deep }) {
      if (deep.status === 'error') {
        const raw = (deep.error && deep.error.message) || '未知错误';
        const msg = /quota\s+exceeded/i.test(raw)
          ? 'PageSpeed 免费匿名配额已用尽。在插件行配置（profile cordis.patch.yml 的 seo-workbench 行加 config.psiKey）或环境变量 PSI_API_KEY 中配置你自己的 API Key 后再试。'
          : raw;
        return el('div', { className: 'seo-wb-card' },
          el('div', { className: 'seo-wb-error' }, `深度检测失败：${msg}`),
        );
      }
      const cwv = deep.cwv;
      const metric = (value, name, good, bad, unit) => {
        if (value == null) return null;
        const cls = value <= good ? 'var(--dsw-alias-state-success-primary)' : value <= bad ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)';
        return el('div', { className: 'seo-wb-cwv', key: name },
          el('div', { className: 'v', style: { color: cls } }, `${value}${unit || ''}`),
          el('div', { className: 'k' }, name),
        );
      };
      const children = [];
      if (cwv) {
        children.push(metric(cwv.lcpMs, 'LCP', 2500, 4000, 'ms'));
        children.push(metric(cwv.cls, 'CLS', 0.1, 0.25, ''));
        children.push(metric(cwv.inpMs, 'INP', 200, 500, 'ms'));
        children.push(metric(cwv.ttfbMs, 'TTFB', 800, 1800, 'ms'));
        children.push(metric(cwv.fcpMs, 'FCP', 1800, 3000, 'ms'));
      }
      children.push(
        el('div', { className: 'seo-wb-card', key: 'categories' },
          el('div', { className: 'seo-wb-score-row' },
            el('div', { className: cx('seo-wb-score-big', scoreClass(Math.round((deep.performance || 0) * 100))), style: { fontSize: '22px' } }, Math.round((deep.performance || 0) * 100)),
            el('div', { className: 'seo-wb-groups' },
              CategoryRow('Performance', deep.performance),
              CategoryRow('SEO', deep.seo),
              CategoryRow('Accessibility', deep.accessibility),
              CategoryRow('Best Practices', deep.bestPractices),
            ),
          ),
        ),
      );
      children.push(
        el('dl', { className: 'seo-wb-kv', key: 'schema' },
          el('dt', null, '结构化数据（schema）'),
          el('dd', null, deep.schemaFound === true ? '检测到 ✓' : deep.schemaFound === false ? '未检测到 ✗' : '未知'),
        ),
      );
      if (deep.lighthouseIssues && deep.lighthouseIssues.length) {
        children.push(
          el('div', { key: 'lighthouse' },
            el('div', { className: 'seo-wb-note' }, `Lighthouse 待优化项（${deep.lighthouseIssues.length}）：`),
            deep.lighthouseIssues.map((issue, index) =>
              el('div', { className: 'seo-wb-issue', key: issue.id || index },
                el('div', { className: 'seo-wb-issue-head' },
                  el('span', { className: 'seo-wb-chip fail' }, `${Math.round((issue.score || 0) * 100)}`),
                  el('span', { className: 'seo-wb-issue-title' }, issue.title),
                ),
              ),
            ),
          ),
        );
      }
      return el('div', { className: 'seo-wb-deep' },
        el('div', { className: 'seo-wb-deep-header' }, '深度检测（PageSpeed Insights）'),
        el('div', { className: 'seo-wb-deep-grid' }, ...children),
      );
    }

    function CategoryRow(name, value) {
      const score = Math.round((value || 0) * 100);
      return el('div', { className: 'seo-wb-group-row', key: name },
        el('span', { style: { minWidth: '64px', flexShrink: 0, whiteSpace: 'nowrap' } }, name),
        el('div', { className: 'seo-wb-bar' },
          el('div', { className: 'seo-wb-bar-fill', style: { width: `${score}%`, background: barColor(score) } }),
        ),
        el('span', { style: { width: '22px', textAlign: 'right' } }, score),
      );
    }

    const rowKeyProps = (open) => ({
      role: 'button',
      tabIndex: 0,
      'aria-expanded': !!open,
    });

    function onRowKeyDown(event, current, setter, id) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setter(current === id ? null : id);
    }

    function IssuesSection({ issues, openIssue, setOpenIssue }) {
      if (!issues.length) {
        return el('div', { className: 'seo-wb-note' }, '未发现问题，继续保持 🎉');
      }
      return el('div', null,
        issues.map((issue) => {
          const open = openIssue === issue.id;
          return el('div', {
            className: 'seo-wb-issue',
            key: issue.id,
            onClick: () => setOpenIssue(open ? null : issue.id),
            onKeyDown: (e) => onRowKeyDown(e, openIssue, setOpenIssue, issue.id),
            ...rowKeyProps(open),
          },
            el('div', { className: 'seo-wb-issue-head' },
              el('span', { className: cx('seo-wb-chip', issue.severity) }, SEVERITY_LABELS[issue.severity] || issue.severity),
              el('span', { className: 'seo-wb-issue-title' }, issue.title),
              el('span', { className: 'seo-wb-note', style: { marginLeft: 'auto' } }, open ? '▾' : '▸'),
            ),
            open
              ? el('div', { className: 'seo-wb-issue-detail' },
                  issue.impact ? el('div', null, `影响：${issue.impact}`) : null,
                  issue.evidence ? el('div', null, `证据：${issue.evidence}`) : null,
                  issue.fix ? el('div', null, `修复：${issue.fix}`) : null,
                )
              : null,
          );
        }),
      );
    }

    function DetailsSection({ groups, openGroup, setOpenGroup }) {
      return el('div', null,
        groups.map((group) => {
          const open = openGroup === group.id;
          const counts = group.checks.reduce(
            (acc, c) => {
              acc[c.status] = (acc[c.status] || 0) + 1;
              return acc;
            },
            {},
          );
          return el('div', { className: 'seo-wb-card', key: group.id, style: { marginBottom: '6px' } },
            el('div', {
              className: 'seo-wb-issue-head',
              onClick: () => setOpenGroup(open ? null : group.id),
              onKeyDown: (e) => onRowKeyDown(e, openGroup, setOpenGroup, group.id),
              style: { cursor: 'pointer' },
              ...rowKeyProps(open),
            },
              el('span', { className: 'seo-wb-issue-title' }, `${group.label} ${group.score}`),
              el('span', { className: 'seo-wb-note', style: { marginLeft: 'auto' } },
                `✓${counts.pass || 0} ⚠${counts.warn || 0} ✗${counts.fail || 0}`,
              ),
              el('span', { className: 'seo-wb-note', style: { marginLeft: '4px' } }, open ? '▾' : '▸'),
            ),
            open
              ? el('dl', { style: { margin: 0 } },
                  group.checks.map((check) =>
                    el('div', { className: 'seo-wb-kv', key: check.id },
                      el('dt', null, el('span', { className: cx('seo-wb-chip', check.status) }, check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : check.status === 'fail' ? '✗' : 'ℹ')),
                      el('dd', null, `${check.label}：${check.detail}`),
                    ),
                  ),
                )
              : null,
          );
        }),
      );
    }

    function OverviewSection({ report }) {
      const p = report.page || {};
      const rows = [
        ['最终地址', report.finalUrl],
        ['HTTP 状态', String(p.httpStatus) + (p.redirectChain && p.redirectChain.length ? `（${p.redirectChain.length} 次跳转）` : '')],
        ['Title', p.title || '—'],
        ['Description', p.description || '—'],
        ['H1', (p.h1s || []).join(' / ') || '—'],
        ['页面语言', p.lang || '—'],
        ['Viewport', p.viewport || '—'],
        ['Canonical', p.canonical || '—'],
        ['正文字数', p.words ? `${p.words.total}（中文 ${p.words.cjk} / 英文 ${p.words.latin}）` : '—'],
        ['图片', `${p.imageCount || 0} 张（${p.imagesNoAlt || 0} 缺 alt）`],
        ['内链 / 外链', `${p.internalLinks || 0} / ${p.externalLinks || 0}`],
        ['页面体积', p.bytes ? `${(p.bytes / 1024).toFixed(1)}KB` : '—'],
        ['robots.txt', report.robots ? `HTTP ${report.robots.status}${report.robots.disallowAll ? '（禁止全站）' : ''}` : '—'],
        ['sitemap', report.sitemap && report.sitemap.url ? `HTTP ${report.sitemap.status}（${report.sitemap.urls} 个 URL）` : '未发现'],
        ['耗时', `${report.durationMs}ms`],
      ];
      return el('dl', { style: { margin: 0 } },
        rows.map(([k, v]) =>
          el('div', { className: 'seo-wb-kv', key: k },
            el('dt', null, k),
            el('dd', null, v),
          ),
        ),
      );
    }

    // ---------- icon (left-sidebar navigation row) ----------
    // The `sidebar.panel.icon` factory hands the component its display size.
    function SeoWorkbenchIcon(owner = {}) {
      const size = owner.size ?? 16;
      return el('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        el('rect', { x: 3, y: 2, width: 8.5, height: 11.5, rx: 1.5 }),
        el('path', { d: 'M5.2 5.2h4.1M5.2 7.4h4.1M5.2 9.6h2.6' }),
        el('circle', { cx: 11.1, cy: 10.9, r: 2.1 }),
        el('path', { d: 'M12.7 12.5l1.5 1.5' }),
      );
    }

    // ---------- registration ----------
    // Left sidebar only: a `sidebar.panellist` navigation row (icon + label)
    // whose id opens the `main` central panel registered under the same key.
    const leftEntry = {
      id: 'seo-workbench',
      order: 10,
      label: 'SEO 分析',
    };

    const CSS = `
.seo-wb-root { display:flex; flex-direction:column; gap:10px; padding:12px; font-size:13px; color: var(--dsw-alias-label-primary); max-width:860px; width:100%; margin:0 auto; }
.seo-wb-input-row { display:flex; gap:6px; }
.seo-wb-input { flex:1; min-width:0; padding:6px 8px; font-size:13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; }
.seo-wb-input:focus { outline:none; border-color: var(--dsw-alias-brand-primary); }
.seo-wb-btn { padding:5px 10px; font-size:12px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor:pointer; }
.seo-wb-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.seo-wb-btn.primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); border-color:transparent; }
.seo-wb-btn:disabled { opacity:.5; cursor:default; }
.seo-wb-actions { display:flex; gap:6px; }
.seo-wb-spinner { display:flex; gap:8px; align-items:center; color: var(--dsw-alias-label-secondary); font-size:12px; }
.seo-wb-spinner-dot { width:10px; height:10px; border-radius:50%; border:2px solid var(--dsw-alias-brand-primary); border-top-color:transparent; animation:seo-wb-spin .8s linear infinite; }
@keyframes seo-wb-spin { to { transform:rotate(360deg); } }
.seo-wb-card { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:10px; background: var(--dsw-alias-bg-layer-1); }
.seo-wb-score-row { display:flex; align-items:center; gap:12px; }
.seo-wb-score-big { font-size:34px; font-weight:600; line-height:1; }
.seo-wb-score-big.ok { color: var(--dsw-alias-state-success-primary); }
.seo-wb-score-big.warn { color: var(--dsw-alias-state-warn-primary); }
.seo-wb-score-big.bad { color: var(--dsw-alias-state-error-primary); }
.seo-wb-groups { flex:1; display:flex; flex-direction:column; gap:6px; }
.seo-wb-group-row { display:flex; align-items:center; gap:6px; font-size:12px; color: var(--dsw-alias-label-secondary); }
.seo-wb-bar { flex:1; height:6px; border-radius:3px; background: var(--dsw-alias-bg-layer-2); overflow:hidden; }
.seo-wb-bar-fill { height:100%; border-radius:3px; }
.seo-wb-tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.seo-wb-tab { padding:6px 8px; font-size:12px; cursor:pointer; color: var(--dsw-alias-label-secondary); border:0; border-bottom:2px solid transparent; background:none; font-family:inherit; }
.seo-wb-tab.active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.seo-wb-issue { border-bottom:1px solid var(--dsw-alias-border-l1); padding:8px 0; cursor:pointer; }
.seo-wb-issue:last-child { border-bottom:none; }
.seo-wb-issue-head { display:flex; align-items:center; gap:6px; }
.seo-wb-issue-title { font-size:13px; flex:1; min-width:0; word-break:break-all; }
.seo-wb-issue-detail { margin-top:6px; font-size:12px; color: var(--dsw-alias-label-secondary); display:flex; flex-direction:column; gap:4px; word-break:break-all; }
.seo-wb-tab:focus-visible, .seo-wb-btn:focus-visible, .seo-wb-issue:focus-visible, .seo-wb-issue-head:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.seo-wb-chip { font-size:11px; padding:1px 6px; border-radius:4px; white-space:nowrap; }
.seo-wb-chip.critical, .seo-wb-chip.high { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-base); }
.seo-wb-chip.medium { background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-bg-base); }
.seo-wb-chip.low { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.seo-wb-chip.pass { color: var(--dsw-alias-state-success-primary); }
.seo-wb-chip.warn { color: var(--dsw-alias-state-warn-primary); }
.seo-wb-chip.fail { color: var(--dsw-alias-state-error-primary); }
.seo-wb-chip.info { color: var(--dsw-alias-label-secondary); }
.seo-wb-kv { display:flex; justify-content:space-between; gap:8px; font-size:12px; padding:3px 0; }
.seo-wb-kv dt { color: var(--dsw-alias-label-secondary); flex-shrink:0; }
.seo-wb-kv dd { text-align:right; word-break:break-all; margin:0; }
.seo-wb-note { font-size:12px; color: var(--dsw-alias-label-secondary); }
.seo-wb-error { border:1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius:8px; padding:10px; font-size:13px; }
.seo-wb-deep-header { font-size:13px; font-weight:600; }
.seo-wb-deep-grid { display:flex; flex-direction:column; gap:8px; }
.seo-wb-cwv { border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:6px; text-align:center; }
.seo-wb-cwv .v { font-size:16px; font-weight:600; }
.seo-wb-cwv .k { font-size:11px; color: var(--dsw-alias-label-secondary); }
`;

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = CSS;
          document.head.appendChild(style);

          // Left sidebar row + its central page. Selecting a missing `main`
          // entry throws, so both are registered together.
          const disposers = [
            ctx.slots.register(
              { name: 'sidebar.panellist', id: leftEntry.id, order: leftEntry.order, label: leftEntry.label },
              SeoWorkbenchIcon,
            ),
            ctx.slots.register({ name: 'main', key: leftEntry.id }, SeoWorkbenchBody),
          ];
          return () => {
            for (const dispose of disposers) dispose();
            style.remove();
          };
        });
      },
    };
  },
});