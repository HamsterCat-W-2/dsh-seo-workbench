/**
 * Client half of @local/seo-workbench — left-sidebar panel.
 *
 * Registers a row in the left navigation sidebar (`sidebar.panellist`) and the
 * matching central panel (`main`, keyed by the same id). The panel talks to the
 * Host routes under /seo-workbench/api/ with same-origin credentialed fetch.
 */
window.__ModuleLoader__.load({
  id: '@local/seo-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    // ---------------------------------------------------------------- utils

    const AUDIT_STAGES = ['抓取页面', '解析 HTML', '抓取 robots / sitemap', '运行检查', '计算得分'];
    const DEEP_STAGES = ['请求 PageSpeed', '运行 Lighthouse', '读取 CWV 指标'];
    const SEVERITY_LABELS = { critical: '严重', high: '高', medium: '中', low: '低' };
    const LS_SETTINGS = 'seo-wb-settings';
    const LS_HISTORY = 'seo-wb-history';
    const LS_MODEL = 'seo-wb-model';

    const DEFAULT_SETTINGS = { defaultSite: '', psiKey: '', timeoutMs: 15000, maxRedirects: 5 };

    function lsGet(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    }
    function lsSet(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    }

    function normalizeUrl(raw) {
      const value = (raw || '').trim();
      if (!value) return { url: '', error: '请输入网址' };
      const candidates = value.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//) ? [value] : [`https://${value}`, `http://${value}`];
      for (const candidate of candidates) {
        try {
          const u = new URL(candidate);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
          return { url: u.href, error: '' };
        } catch {
          /* try next */
        }
      }
      return { url: '', error: '网址格式不正确（仅支持 http/https）' };
    }

    const ERROR_CODES = {
      'method-not-allowed': '宿主未加载，请重启 DSH 后重试',
      'bad-json': '请求格式错误',
      'missing-url': '缺少网址',
      'missing-input': '缺少必要参数',
      'bad-body': '请求体错误',
      internal: '服务内部错误',
      'no-model': '未选择模型，或 DSH 模型服务不可用',
      'llm-failed': '模型调用失败',
      'empty-output': '模型没有返回内容，请换个模型再试',
      'psi-failed': 'PageSpeed 请求失败',
      'models-failed': '模型列表获取失败',
    };

    async function postJson(path, body) {
      let resp;
      try {
        resp = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        throw new Error('无法连接审计服务（插件宿主未加载或已崩溃，请重启 DSH 后重试）');
      }
      let data = null;
      try {
        data = await resp.json();
      } catch {
        throw new Error('服务返回了无法解析的响应');
      }
      if (!resp.ok) {
        const code = data && typeof data.error === 'string' ? data.error : data && data.error && typeof data.error === 'object' ? data.error.code : '';
        const message = data && typeof data.error === 'object' ? data.error.message : '';
        throw new Error(message || ERROR_CODES[code] || `请求失败（${resp.status}）`);
      }
      return data;
    }

    function scoreColor(score) {
      if (score >= 80) return 'ok';
      if (score >= 60) return 'warn';
      return 'bad';
    }

    function fmtBytes(bytes) {
      if (!Number.isFinite(bytes)) return '-';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function fmtTime(iso) {
      if (!iso) return '';
      try {
        const d = new Date(iso);
        return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      } catch {
        return '';
      }
    }

    function domainOf(url) {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    }

    function rowKeyProps(open) {
      return { role: 'button', tabIndex: 0, 'aria-expanded': !!open };
    }
    function onRowKeyDown(event, current, setter, id) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setter(current === id ? null : id);
      }
    }

    function downloadText(filename, text) {
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    }

    function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      } else {
        fallbackCopy(text);
      }
    }
    function fallbackCopy(text) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      textarea.remove();
    }

    function buildMarkdown(report, deep) {
      const L = [];
      L.push(`# SEO 分析报告 — ${report.url}`);
      L.push('');
      L.push(`> 最终地址：${report.finalUrl}　|　抓取耗时：${Math.round(report.durationMs)}ms　|　生成时间：${report.fetchedAt}`);
      L.push('');
      L.push(`## 总分：${report.score.total}/100`);
      L.push('');
      L.push('| 分组 | 得分 | 权重 |');
      L.push('| --- | --- | --- |');
      for (const g of report.groups || []) {
        L.push(`| ${g.label || g.id} | ${g.score} | ${Math.round(g.weight * 100)}% |`);
      }
      L.push('');
      if ((report.issues || []).length) {
        L.push('## 问题清单');
        L.push('');
        for (const i of report.issues) {
          L.push(`### ${i.priority}. [${SEVERITY_LABELS[i.severity] || i.severity}] ${i.title}`);
          if (i.impact) L.push(`- **影响**：${i.impact}`);
          if (i.evidence) L.push(`- **证据**：${i.evidence}`);
          if (i.fix) L.push(`- **修复**：${i.fix}`);
          L.push('');
        }
      }
      L.push('## 检查明细');
      L.push('');
      for (const g of report.groups || []) {
        L.push(`### ${g.label || g.id}`);
        for (const c of g.checks || []) {
          const mark = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : c.status === 'fail' ? '❌' : 'ℹ️';
          L.push(`- ${mark} ${c.label}：${c.detail || ''}`);
        }
        L.push('');
      }
      const p = report.page;
      L.push('## 页面概况');
      L.push('');
      L.push(`- HTTP 状态：${p.httpStatus}（重定向链 ${(p.redirectChain || []).length} 跳）`);
      L.push(`- 页面大小：${fmtBytes(p.bytes)}　|　内容类型：${p.contentType || '-'}`);
      L.push(`- 标题：${p.title ? `“${p.title}”（${[...(p.title || '')].length} 字符）` : '无'}`);
      L.push(`- 描述：${p.description ? `${[...(p.description || '')].length} 字符` : '无'}`);
      L.push(`- H1：${p.h1s.length} 个；H2：${p.h2s} 个；H3：${p.h3s} 个`);
      L.push(`- 图片：${p.imageCount} 张（${p.imagesNoAlt} 张缺 alt；lazy ${p.lazyCount} 张）`);
      L.push(`- 内链 ${p.internalLinks} / 外链 ${p.externalLinks} / nofollow ${p.nofollowLinks}`);
      L.push(`- 正文字数：${p.words ? p.words.total : '-'}（中文 ${p.words ? p.words.cjk : '-'} / 英文 ${p.words ? p.words.latin : '-'}）`);
      if (p.canonical) L.push(`- canonical：${p.canonical}`);
      if (p.jsonldTypes && p.jsonldTypes.length) L.push(`- JSON-LD：${p.jsonldTypes.join('、')}`);
      L.push('');
      if (deep && deep.status === 'ok') {
        L.push('## 深度检测（PageSpeed Insights）');
        L.push('');
        L.push(`- 策略：${deep.strategy || 'mobile'}`);
        L.push(`- Performance ${Math.round((deep.performance || 0) * 100)} / SEO ${Math.round((deep.seo || 0) * 100)} / Accessibility ${Math.round((deep.accessibility || 0) * 100)} / Best Practices ${Math.round((deep.bestPractices || 0) * 100)}`);
        if (deep.cwv) {
          L.push(`- LCP ${Math.round(deep.cwv.lcpMs)}ms / CLS ${deep.cwv.cls} / INP ${Math.round(deep.cwv.inpMs)}ms / TTFB ${Math.round(deep.cwv.ttfbMs)}ms / FCP ${Math.round(deep.cwv.fcpMs)}ms`);
        }
        if (deep.schemaFound !== undefined) L.push(`- Schema 检测：${deep.schemaFound ? '发现结构化数据' : '未检测到'}`);
        if (deep.lighthouseIssues && deep.lighthouseIssues.length) {
          L.push(`- Lighthouse 失败项：${deep.lighthouseIssues.join('、')}`);
        }
        L.push('');
      }
      if ((report.notes || []).length) {
        L.push('## 备注');
        for (const n of report.notes) L.push(`- ${n}`);
        L.push('');
      }
      return L.join('\n');
    }

    // -------------------------------------------------------------- icon row

    function SeoWorkbenchIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', { x: 2.5, y: 1.5, width: 9, height: 11, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M5 4.5h4M5 6.5h4M5 8.5h2.5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('circle', { cx: 11, cy: 10.8, r: 2.2, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M12.6 12.4l1.6 1.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      );
    }

    // ---------------------------------------------------------- small pieces

    function Spinner({ label }) {
      if (!label) return null;
      return h(
        'div',
        { className: 'seo-wb-spinner-row', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'seo-wb-spinner' }),
        h('span', null, label),
      );
    }

    function Progress({ progress }) {
      if (!progress) return null;
      return h(
        'div',
        { className: 'seo-wb-progress' },
        progress.stages.map((label, idx) => {
          const state = idx < progress.stage ? 'done' : idx === progress.stage ? 'active' : 'todo';
          return h(
            'span',
            { key: label, className: `seo-wb-step seo-wb-step-${state}` },
            state === 'done' ? '✓ ' : '',
            label,
          );
        }),
      );
    }

    function ScoreRing({ score, size }) {
      const r = 42;
      const c = 2 * Math.PI * r;
      const ratio = Math.max(0, Math.min(100, score || 0)) / 100;
      const cls = scoreColor(score || 0);
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 100 100', className: `seo-wb-ring seo-wb-ring-${cls}` },
        h('circle', { cx: 50, cy: 50, r, fill: 'none', stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 10 }),
        h('circle', {
          cx: 50,
          cy: 50,
          r,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 10,
          strokeLinecap: 'round',
          strokeDasharray: `${(c * ratio).toFixed(2)} ${c.toFixed(2)}`,
          transform: 'rotate(-90 50 50)',
        }),
        h('text', { x: 50, y: 55, textAnchor: 'middle', fontSize: 24, fontWeight: 700, fill: 'currentColor' }, String(Math.round(score || 0))),
      );
    }

    function GroupBars({ groups }) {
      return h(
        'div',
        { className: 'seo-wb-group-bars' },
        (groups || []).map((g) =>
          h(
            'div',
            { key: g.id, className: 'seo-wb-group-row' },
            h('span', { className: 'seo-wb-group-label' }, g.label || g.id),
            h('span', { className: 'seo-wb-group-track' },
              h('span', { className: `seo-wb-group-fill seo-wb-fill-${scoreColor(g.score)}`, style: { width: `${g.score || 0}%` } })),
            h('span', { className: 'seo-wb-group-value' }, String(Math.round(g.score || 0))),
          ),
        ),
      );
    }

    function SeverityChip({ severity }) {
      return h('span', { className: `seo-wb-sev seo-wb-sev-${severity}` }, SEVERITY_LABELS[severity] || severity);
    }

    // ------------------------------------------------------------ sections

    function IssuesSection({ issues, openIssue, setOpenIssue }) {
      const list = issues || [];
      if (!list.length) {
        return h('div', { className: 'seo-wb-empty' }, '没有发现问题 🎉');
      }
      return h(
        'div',
        { className: 'seo-wb-issues' },
        list.map((issue) => {
          const open = openIssue === issue.id;
          return h(
            'div',
            { key: issue.id, className: `seo-wb-issue${open ? ' seo-wb-open' : ''}` },
            h(
              'div',
              { ...rowKeyProps(open), onClick: () => setOpenIssue(open ? null : issue.id), onKeyDown: (e) => onRowKeyDown(e, openIssue, setOpenIssue, issue.id), className: 'seo-wb-issue-head' },
              h('span', { className: 'seo-wb-issue-title' }, `${issue.priority}. ${issue.title}`),
              h(SeverityChip, { severity: issue.severity }),
            ),
            open
              ? h(
                  'div',
                  { className: 'seo-wb-issue-body' },
                  issue.impact ? h('div', { className: 'seo-wb-kv' }, h('dt', null, '影响'), h('dd', null, issue.impact)) : null,
                  issue.evidence ? h('div', { className: 'seo-wb-kv' }, h('dt', null, '证据'), h('dd', { className: 'seo-wb-mono' }, issue.evidence)) : null,
                  issue.fix ? h('div', { className: 'seo-wb-kv' }, h('dt', null, '修复'), h('dd', null, issue.fix)) : null,
                )
              : null,
          );
        }),
      );
    }

    function DetailsSection({ groups, openGroup, setOpenGroup }) {
      const list = groups || [];
      if (!list.length) return h('div', { className: 'seo-wb-empty' }, '没有检查数据');
      return h(
        'div',
        { className: 'seo-wb-details' },
        list.map((g) => {
          const open = openGroup === g.id;
          const pass = (g.checks || []).filter((c) => c.status === 'pass').length;
          const warn = (g.checks || []).filter((c) => c.status === 'warn').length;
          const fail = (g.checks || []).filter((c) => c.status === 'fail').length;
          return h(
            'div',
            { key: g.id, className: `seo-wb-group${open ? ' seo-wb-open' : ''}` },
            h(
              'div',
              { ...rowKeyProps(open), onClick: () => setOpenGroup(open ? null : g.id), onKeyDown: (e) => onRowKeyDown(e, openGroup, setOpenGroup, g.id), className: 'seo-wb-group-head' },
              h('span', { className: 'seo-wb-group-title' }, `${g.label || g.id}（${g.score}/100）`),
              h(
                'span',
                { className: 'seo-wb-counts' },
                fail ? h('span', { className: 'seo-wb-count seo-wb-count-fail' }, `✗ ${fail}`) : null,
                warn ? h('span', { className: 'seo-wb-count seo-wb-count-warn' }, `⚠ ${warn}`) : null,
                pass ? h('span', { className: 'seo-wb-count seo-wb-count-pass' }, `✓ ${pass}`) : null,
              ),
            ),
            open
              ? h(
                  'div',
                  { className: 'seo-wb-check-list' },
                  (g.checks || []).map((c) =>
                    h(
                      'div',
                      { key: c.id, className: `seo-wb-check seo-wb-check-${c.status}` },
                      h('span', { className: 'seo-wb-check-mark' }, c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : c.status === 'fail' ? '✗' : 'ℹ'),
                      h('div', { className: 'seo-wb-check-text' },
                        h('div', { className: 'seo-wb-check-label' }, c.label),
                        c.detail ? h('div', { className: 'seo-wb-check-detail' }, c.detail) : null),
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
        ['HTTP 状态', String(p.httpStatus) + ((p.redirectChain || []).length ? `（${(p.redirectChain || []).length} 次跳转）` : '')],
        ['页面大小', fmtBytes(p.bytes)],
        ['内容类型', p.contentType || '-'],
        ['标题', p.title ? `“${p.title}”` : '无'],
        ['描述', p.description ? `“${p.description.slice(0, 60)}${p.description.length > 60 ? '…' : ''}”` : '无'],
        ['语言', p.lang || '-'],
        ['viewport', p.viewport || '未设置'],
        ['canonical', p.canonical || '未设置'],
        ['meta robots', p.robotsMeta || '未设置'],
        ['H1/H2/H3', `${p.h1s ? p.h1s.length : 0} / ${p.h2s} / ${p.h3s}`],
        ['图片', `${p.imageCount} 张（缺 alt ${p.imagesNoAlt}，lazy ${p.lazyCount}）`],
        ['链接', `内链 ${p.internalLinks} / 外链 ${p.externalLinks} / nofollow ${p.nofollowLinks}`],
        ['字数', p.words ? `${p.words.total}（中文 ${p.words.cjk} / 英文 ${p.words.latin}）` : '-'],
        ['hreflang', (p.hreflangs || []).join('、') || '无'],
        ['JSON-LD', (p.jsonldTypes || []).join('、') || '未发现'],
      ];
      return h(
        'dl',
        { className: 'seo-wb-overview' },
        rows.map(([k, v]) => h('div', { key: k, className: 'seo-wb-kv' }, h('dt', null, k), h('dd', { className: 'seo-wb-mono' }, v))),
      );
    }

    function cwvCard(label, value, ok, warn) {
      let state = 'ok';
      if (value === null || value === undefined) state = 'na';
      else if (value > warn) state = 'bad';
      else if (value > ok) state = 'warn';
      const shown = state === 'na' ? '—' : `${typeof value === 'number' && value < 100 ? value.toFixed(2) : Math.round(value)}${typeof value === 'number' && value >= 100 ? 'ms' : ''}`;
      return h(
        'div',
        { className: `seo-wb-cwv seo-wb-cwv-${state}` },
        h('div', { className: 'seo-wb-cwv-label' }, label),
        h('div', { className: 'seo-wb-cwv-value' }, shown),
      );
    }

    function mapDeepError(err) {
      const code = err && err.code;
      const message = err && err.message;
      if (/quota\s+exceeded/i.test(message || '')) {
        return 'PageSpeed 免费匿名配额已用尽。在设置里填入你自己的 API Key，或在 profile cordis.patch.yml 的 seo-workbench 行加 config.psiKey / 环境变量 PSI_API_KEY 后重试。';
      }
      if (message) return message;
      return ERROR_CODES[code] || '深度检测失败';
    }

    function DeepSection({ deep }) {
      if (!deep) return null;
      if (deep.status === 'error') {
        return h('div', { className: 'seo-wb-deep-error' }, mapDeepError(deep.error));
      }
      const cats = [['Performance', deep.performance], ['SEO', deep.seo], ['Accessibility', deep.accessibility], ['Best Practices', deep.bestPractices]];
      return h(
        'div',
        { className: 'seo-wb-deep' },
        h('div', { className: 'seo-wb-section-title' }, `深度检测 · ${deep.strategy === 'desktop' ? '桌面端' : '移动端'}`),
        deep.cwv
          ? h(
              'div',
              { className: 'seo-wb-cwv-grid' },
              cwvCard('LCP', deep.cwv.lcpMs, 2500, 4000),
              cwvCard('CLS', deep.cwv.cls, 0.1, 0.25),
              cwvCard('INP', deep.cwv.inpMs, 200, 500),
              cwvCard('TTFB', deep.cwv.ttfbMs, 800, 1800),
              cwvCard('FCP', deep.cwv.fcpMs, 1800, 3000),
            )
          : null,
        h(
          'div',
          { className: 'seo-wb-cat-bars' },
          cats.map(([label, v]) => {
            const pct = Math.round((v || 0) * 100);
            return h(
              'div',
              { key: label, className: 'seo-wb-cat-row' },
              h('span', { className: 'seo-wb-group-label' }, label),
              h('span', { className: 'seo-wb-group-track' }, h('span', { className: `seo-wb-group-fill seo-wb-fill-${scoreColor(pct)}`, style: { width: `${pct}%` } })),
              h('span', { className: 'seo-wb-group-value' }, String(pct)),
            );
          }),
        ),
        h(
          'div',
          { className: 'seo-wb-kv' },
          h('dt', null, 'Schema 检测'),
          h('dd', null, deep.schemaFound ? '发现结构化数据' : '未检测到（纯 JS 渲染或站点无 schema）'),
        ),
        deep.lighthouseIssues && deep.lighthouseIssues.length
          ? h(
              'div',
              { className: 'seo-wb-lh' },
              h('div', { className: 'seo-wb-lh-title' }, 'Lighthouse 失败项'),
              h(
                'div',
                { className: 'seo-wb-lh-chips' },
                deep.lighthouseIssues.map((i, idx) => h('span', { key: (i && i.id) || idx, className: 'seo-wb-chip' }, (i && i.title) || String(i))),
              ),
            )
          : null,
      );
    }

    // ------------------------------------------------------------- settings

    const SETTINGS_FIELDS = [
      ['defaultSite', '默认网址', 'text', '分析框自动预填的网址', 'https://example.com'],
      ['psiKey', 'PageSpeed API Key', 'text', '可选；深度检测用，填了可避开匿名配额', 'AIza…'],
      ['timeoutMs', '抓取超时（毫秒）', 'text', '默认 15000', '15000'],
      ['maxRedirects', '最大重定向数', 'text', '默认 5', '5'],
    ];

    function SettingsPanel({ open, saved, onClose, onSave }) {
      const [draft, setDraft] = useState(null);
      useEffect(() => {
        if (open) setDraft({ ...saved });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open]);
      if (!open) return null;
      const value = draft || saved;
      const set = (key) => (e) => {
        let raw = e.target.value;
        if (key === 'timeoutMs' || key === 'maxRedirects') raw = String(raw).replace(/[^\d]/g, '');
        setDraft({ ...value, [key]: raw });
      };
      return h(
        'div',
        { className: 'seo-wb-overlay', onClick: onClose },
        h(
          'div',
          { className: 'seo-wb-settings', onClick: (e) => e.stopPropagation(), role: 'dialog', 'aria-label': '设置' },
          h('div', { className: 'seo-wb-settings-title' }, '设置'),
          SETTINGS_FIELDS.map(([key, label, type, hint, ph]) =>
            h(
              'label',
              { key, className: 'seo-wb-field' },
              h('span', { className: 'seo-wb-field-label' }, label),
              h('input', {
                type,
                value: value[key] === undefined || value[key] === null ? '' : value[key],
                placeholder: ph,
                onChange: set(key),
                'aria-label': label,
              }),
              h('span', { className: 'seo-wb-field-hint' }, hint),
            ),
          ),
          h(
            'div',
            { className: 'seo-wb-settings-actions' },
            h('button', { type: 'button', className: 'seo-wb-btn seo-wb-btn-primary', onClick: () => onSave(value) }, '保存'),
            h('button', { type: 'button', className: 'seo-wb-btn', onClick: onClose }, '取消'),
            h('button', { type: 'button', className: 'seo-wb-btn', onClick: () => setDraft({ ...DEFAULT_SETTINGS }) }, '恢复默认'),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------- main

    function SeoWorkbenchBody() {
      const [input, setInput] = useState('');
      const [busy, setBusy] = useState(null);
      const [progress, setProgress] = useState(null);
      const [report, setReport] = useState(null);
      const [deep, setDeep] = useState(null);
      const [advice, setAdvice] = useState({ loading: false, text: '', error: null });
      const [error, setError] = useState(null);
      const [tab, setTab] = useState('issues');
      const [openIssue, setOpenIssue] = useState(null);
      const [openGroup, setOpenGroup] = useState(null);
      const [copied, setCopied] = useState(null);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...lsGet(LS_SETTINGS, {}) }));
      const [history, setHistory] = useState(() => lsGet(LS_HISTORY, []));
      const [models, setModels] = useState({ providers: [] });
      const [modelSel, setModelSel] = useState(() => lsGet(LS_MODEL, '') || '');

      useEffect(() => {
        if (settings.defaultSite && !input) setInput(settings.defaultSite);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      useEffect(() => {
        fetch('/seo-workbench/api/models', { credentials: 'same-origin', cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => {
            setModels(Array.isArray(d && d.providers) ? d : { providers: [] });
            if (!modelSel && d && Array.isArray(d.providers)) {
              const firstProvider = d.providers.find((p) => p.models && p.models.length);
              if (firstProvider) {
                setModelSel(`${firstProvider.id}|${firstProvider.models[0].id}`);
                lsSet(LS_MODEL, `${firstProvider.id}|${firstProvider.models[0].id}`);
              }
            }
          })
          .catch(() => setModels({ providers: [] }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      useEffect(() => {
        lsSet(LS_SETTINGS, settings);
      }, [settings]);
      useEffect(() => {
        lsSet(LS_HISTORY, history);
      }, [history]);
      useEffect(() => {
        lsSet(LS_MODEL, modelSel);
      }, [modelSel]);

      useEffect(() => {
        if (!busy || busy === 'advice') {
          setProgress(null);
          return undefined;
        }
        setProgress({ stage: 0, stages: busy === 'audit' ? AUDIT_STAGES : DEEP_STAGES });
        const timer = setInterval(
          () => setProgress((p) => (p ? { ...p, stage: Math.min(p.stage + 1, p.stages.length - 1) } : p)),
          420,
        );
        return () => clearInterval(timer);
      }, [busy]);

      function pushHistory(entry) {
        setHistory((prev) => [entry, ...prev.filter((x) => x.id !== entry.id)].slice(0, 20));
      }

      async function runAudit() {
        const { url, error: urlError } = normalizeUrl(input);
        if (urlError) {
          setError(urlError);
          return;
        }
        setBusy('audit');
        setError(null);
        try {
          const data = await postJson('/seo-workbench/api/audit', {
            url,
            fetchTimeoutMs: Number(settings.timeoutMs) || 15000,
            maxRedirects: Number(settings.maxRedirects) || 5,
          });
          if (data.status === 'error') throw new Error((data.error && data.error.message) || '审计失败');
          setReport(data);
          setDeep(null);
          setAdvice({ loading: false, text: '', error: null });
          setTab('issues');
          setOpenIssue(null);
          setOpenGroup(null);
          pushHistory({
            id: `${data.fetchedAt}-${data.url}`,
            url: data.url,
            finalUrl: data.finalUrl,
            fetchedAt: data.fetchedAt,
            score: data.score && data.score.total,
            report: data,
          });
        } catch (err) {
          setError(err.message || String(err));
        } finally {
          setBusy(null);
        }
      }

      async function runDeep() {
        const { url, error: urlError } = normalizeUrl(input);
        if (urlError) {
          setError(urlError);
          return;
        }
        setBusy('deep');
        setError(null);
        try {
          const data = await postJson('/seo-workbench/api/deep', { url, psiKey: settings.psiKey || undefined });
          if (data.status === 'error') throw new Error(mapDeepError(data.error));
          setDeep(data);
        } catch (err) {
          setError(err.message || String(err));
        } finally {
          setBusy(null);
        }
      }

      async function runAdvice() {
        if (!report) return;
        const [provider, model] = String(modelSel || '').split('|');
        if (!provider || !model) {
          setError('请先在顶部选择模型');
          return;
        }
        setBusy('advice');
        setError(null);
        setAdvice({ loading: true, text: '', error: null });
        try {
          const data = await postJson('/seo-workbench/api/advice', {
            url: report.url,
            report: { score: report.score, groups: report.groups, issues: report.issues, notes: report.notes },
            model: { provider, model },
          });
          if (data.status === 'error') throw new Error((data.error && data.error.message) || 'AI 建议失败');
          setAdvice({ loading: false, text: data.text || '', error: null });
        } catch (err) {
          setAdvice({ loading: false, text: '', error: err.message || String(err) });
        } finally {
          setBusy(null);
        }
      }

      function removeHistory(id) {
        setHistory((prev) => prev.filter((x) => x.id !== id));
      }
      function openHistory(entry) {
        setInput(entry.url);
        setReport(entry.report);
        setDeep(null);
        setAdvice({ loading: false, text: '', error: null });
        setTab('issues');
        setOpenIssue(null);
        setOpenGroup(null);
        setError(null);
      }
      function exportMd() {
        if (!report) return;
        downloadText(`seo-report-${domainOf(report.url)}-${new Date().toISOString().slice(0, 10)}.md`, buildMarkdown(report, deep));
      }
      function copyMd() {
        if (!report) return;
        copyText(buildMarkdown(report, deep));
        setCopied('md');
        setTimeout(() => setCopied(null), 1500);
      }
      function copyAdvice() {
        if (!advice.text) return;
        copyText(advice.text);
        setCopied('advice');
        setTimeout(() => setCopied(null), 1500);
      }

      const modelOptions = [];
      for (const p of models.providers || []) {
        for (const m of p.models || []) {
          modelOptions.push({ value: `${p.id}|${m.id}`, label: `${p.name} · ${m.name}` });
        }
      }

      const issueCount = report && report.issues ? report.issues.length : 0;
      const tabLabel = (id) => (id === 'issues' ? `问题（${issueCount}）` : id === 'details' ? '检查明细' : id === 'overview' ? '页面概况' : 'AI 建议');

      return h(
        'div',
        { className: 'seo-wb-root' },
        h(SettingsPanel, {
          open: settingsOpen,
          saved: settings,
          onClose: () => setSettingsOpen(false),
          onSave: (next) => {
            setSettings({ ...DEFAULT_SETTINGS, ...next });
            setSettingsOpen(false);
            if (next.defaultSite && !input) setInput(next.defaultSite);
          },
        }),

        h(
          'div',
          { className: 'seo-wb-topbar' },
          h(
            'div',
            { className: 'seo-wb-brand' },
            h('div', { className: 'seo-wb-brand-title' }, 'SEO 分析'),
            h('div', { className: 'seo-wb-brand-sub' }, '技术 SEO 体检 · 可抓取性 / 技术基础 / On-Page / 内容质量'),
          ),
          h(
            'div',
            { className: 'seo-wb-top-actions' },
            h(
              'select',
              {
                className: 'seo-wb-select',
                value: modelSel,
                onChange: (e) => setModelSel(e.target.value),
                disabled: !modelOptions.length,
                'aria-label': '选择模型',
                title: '用于 AI 建议的模型',
              },
              h('option', { value: '' }, modelOptions.length ? '选择模型…' : '模型服务不可用'),
              modelOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
            ),
            h(
              'button',
              { type: 'button', className: 'seo-wb-btn seo-wb-btn-ghost', onClick: () => setSettingsOpen(true), 'aria-label': '设置' },
              '⚙ 设置',
            ),
          ),
        ),

        h(
          'div',
          { className: 'seo-wb-analyze' },
          h('input', {
            className: 'seo-wb-input',
            value: input,
            onChange: (e) => setInput(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !(e.isComposing || (e.nativeEvent && e.nativeEvent.isComposing))) {
                e.preventDefault();
                if (!busy) runAudit();
              }
            },
            placeholder: '输入域名，例如 example.com',
            maxLength: 2048,
            'aria-label': '要分析的网址',
            spellCheck: false,
          }),
          h(
            'button',
            { type: 'button', className: 'seo-wb-btn seo-wb-btn-primary seo-wb-analyze-btn', onClick: runAudit, disabled: !!busy },
            busy === 'audit' ? '分析中…' : '分析',
          ),
        ),

        h(Progress, { progress }),
        h(Spinner, {
          label: busy === 'deep' ? '深度检测中…' : busy === 'advice' ? '正在生成 AI 建议…' : busy === 'audit' ? '分析中…' : null,
        }),

        error ? h('div', { className: 'seo-wb-error', role: 'alert' }, h('span', { className: 'seo-wb-error-mark' }, '!'), h('span', null, error)) : null,

        report
          ? h(
              'div',
              { className: 'seo-wb-report' },
              h(
                'div',
                { className: 'seo-wb-score-card' },
                h(
                  'div',
                  { className: 'seo-wb-score-main' },
                  h(ScoreRing, { score: report.score ? report.score.total : 0, size: 96 }),
                  h(
                    'div',
                    { className: 'seo-wb-score-meta' },
                    h('div', { className: 'seo-wb-score-domain' }, domainOf(report.url)),
                    h('div', { className: 'seo-wb-score-sub' }, `HTTP ${report.page ? report.page.httpStatus : '-'} · ${fmtTime(report.fetchedAt)} · ${Math.round(report.durationMs || 0)}ms`),
                  ),
                ),
                h(GroupBars, { groups: report.groups }),
                h(
                  'div',
                  { className: 'seo-wb-actions' },
                  h('button', { type: 'button', className: 'seo-wb-btn', onClick: runDeep, disabled: !!busy }, '深度检测（CWV）'),
                  h('button', { type: 'button', className: 'seo-wb-btn', onClick: runAdvice, disabled: !!busy || !modelSel }, 'AI 建议'),
                  h('button', { type: 'button', className: 'seo-wb-btn', onClick: exportMd }, '导出 .md'),
                  h('button', { type: 'button', className: 'seo-wb-btn', onClick: copyMd }, copied === 'md' ? '已复制 ✓' : '复制'),
                ),
              ),
              h(DeepSection, { deep }),
              h(
                'div',
                { className: 'seo-wb-tabs', role: 'tablist' },
                ['issues', 'details', 'overview', 'advice'].map((id) =>
                  h(
                    'button',
                    {
                      key: id,
                      type: 'button',
                      role: 'tab',
                      'aria-selected': tab === id,
                      className: `seo-wb-tab${tab === id ? ' seo-wb-tab-active' : ''}`,
                      onClick: () => setTab(id),
                    },
                    tabLabel(id),
                  ),
                ),
              ),
              tab === 'issues'
                ? h(IssuesSection, { issues: report.issues, openIssue, setOpenIssue })
                : tab === 'details'
                  ? h(DetailsSection, { groups: report.groups, openGroup, setOpenGroup })
                  : tab === 'overview'
                    ? h(OverviewSection, { report })
                    : h(
                        'div',
                        { className: 'seo-wb-advice' },
                        advice.loading ? h(Spinner, { label: '模型思考中…' }) : null,
                        advice.error ? h('div', { className: 'seo-wb-error', role: 'alert' }, advice.error) : null,
                        advice.text
                          ? h(
                              'div',
                              { className: 'seo-wb-advice-text' },
                              h(
                                'div',
                                { className: 'seo-wb-advice-tools' },
                                h('button', { type: 'button', className: 'seo-wb-btn', onClick: copyAdvice }, copied === 'advice' ? '已复制 ✓' : '复制'),
                              ),
                              h('pre', { className: 'seo-wb-advice-pre' }, advice.text),
                            )
                          : !advice.loading && !advice.error
                            ? h('div', { className: 'seo-wb-empty' }, '点「AI 建议」用选中的模型生成修复清单')
                            : null,
                      ),
              (report.notes || []).length
                ? h(
                    'div',
                    { className: 'seo-wb-notes' },
                    h('div', { className: 'seo-wb-section-title' }, '备注'),
                    (report.notes || []).map((n, idx) => h('div', { key: idx, className: 'seo-wb-note' }, `· ${n}`)),
                  )
                : null,
            )
          : !busy
            ? h('div', { className: 'seo-wb-empty seo-wb-empty-hero' }, '输入网址，点击「分析」，查看可抓取性、技术基础、On-Page 与内容质量评分')
            : null,

        h(
          'div',
          { className: 'seo-wb-history' },
          h(
            'div',
            { className: 'seo-wb-history-head' },
            h('div', { className: 'seo-wb-section-title' }, '分析历史'),
            history.length ? h('button', { type: 'button', className: 'seo-wb-btn seo-wb-btn-mini', onClick: () => setHistory([]) }, '清空') : null,
          ),
          history.length
            ? h(
                'div',
                { className: 'seo-wb-history-list' },
                history.map((entry) =>
                  h(
                    'div',
                    { key: entry.id, className: 'seo-wb-history-row' },
                    h(
                      'button',
                      { type: 'button', className: 'seo-wb-history-main', onClick: () => openHistory(entry) },
                      h('span', { className: 'seo-wb-history-domain' }, domainOf(entry.url)),
                      h('span', { className: 'seo-wb-history-time' }, fmtTime(entry.fetchedAt)),
                    ),
                    entry.score !== undefined && entry.score !== null
                      ? h('span', { className: `seo-wb-score-chip seo-wb-score-chip-${scoreColor(entry.score)}` }, String(Math.round(entry.score)))
                      : null,
                    h(
                      'button',
                      { type: 'button', className: 'seo-wb-history-del', onClick: () => removeHistory(entry.id), 'aria-label': `删除 ${entry.url}` },
                      '✕',
                    ),
                  ),
                ),
              )
            : h('div', { className: 'seo-wb-empty' }, '还没有分析记录 — 输入网址开始第一次分析'),
        ),
      );
    }

    // ----------------------------------------------------------------- CSS

    const CSS = `
.seo-wb-root { padding: 20px 24px 40px; max-width: 900px; width: 100%; margin: 0 auto; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-family: inherit; }
.seo-wb-root * { box-sizing: border-box; }
.seo-wb-topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.seo-wb-brand { min-width: 0; }
.seo-wb-brand-title { font-size: 18px; font-weight: 700; line-height: 1.3; }
.seo-wb-brand-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.seo-wb-top-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.seo-wb-select { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; font-size: 13px; max-width: 220px; }
.seo-wb-select:disabled { opacity: .6; }
.seo-wb-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 7px 12px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; transition: border-color .15s, background .15s; }
.seo-wb-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.seo-wb-btn:disabled { opacity: .55; cursor: not-allowed; }
.seo-wb-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; font-weight: 600; }
.seo-wb-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); filter: brightness(1.08); }
.seo-wb-btn-ghost { background: transparent; }
.seo-wb-btn-mini { padding: 3px 8px; font-size: 12px; }
.seo-wb-btn:focus-visible, .seo-wb-tab:focus-visible, .seo-wb-history-main:focus-visible, .seo-wb-issue-head:focus-visible, .seo-wb-group-head:focus-visible, .seo-wb-input:focus-visible, .seo-wb-history-del:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.seo-wb-analyze { display: flex; gap: 10px; margin-top: 4px; }
.seo-wb-input { flex: 1; min-width: 0; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 14px; font-size: 14px; font-family: inherit; }
.seo-wb-input::placeholder { color: var(--dsw-alias-label-secondary); }
.seo-wb-input:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }
.seo-wb-analyze-btn { padding: 10px 22px; font-size: 14px; border-radius: 10px; }
.seo-wb-progress { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.seo-wb-step { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.seo-wb-step-active { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); background: transparent; }
.seo-wb-step-done { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.seo-wb-spinner-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.seo-wb-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: seo-wb-spin .7s linear infinite; display: inline-block; }
@keyframes seo-wb-spin { to { transform: rotate(360deg); } }
.seo-wb-error { display: flex; align-items: flex-start; gap: 8px; margin-top: 14px; padding: 10px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 1.5; }
.seo-wb-error-mark { font-weight: 800; }
.seo-wb-report { margin-top: 16px; }
.seo-wb-score-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; padding: 18px; }
.seo-wb-score-main { display: flex; align-items: center; gap: 16px; }
.seo-wb-ring { color: var(--dsw-alias-brand-primary); flex-shrink: 0; }
.seo-wb-ring-ok { color: var(--dsw-alias-state-success-primary); }
.seo-wb-ring-warn { color: var(--dsw-alias-state-warn-primary); }
.seo-wb-ring-bad { color: var(--dsw-alias-state-error-primary); }
.seo-wb-score-meta { min-width: 0; }
.seo-wb-score-domain { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.seo-wb-score-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 4px; }
.seo-wb-group-bars { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.seo-wb-group-row { display: flex; align-items: center; gap: 10px; }
.seo-wb-group-label { min-width: 64px; flex-shrink: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.seo-wb-group-track { flex: 1; height: 8px; background: var(--dsw-alias-border-l1); border-radius: 999px; overflow: hidden; }
.seo-wb-group-fill { display: block; height: 100%; border-radius: 999px; transition: width .4s ease; }
.seo-wb-fill-ok { background: var(--dsw-alias-state-success-primary); }
.seo-wb-fill-warn { background: var(--dsw-alias-state-warn-primary); }
.seo-wb-fill-bad { background: var(--dsw-alias-state-error-primary); }
.seo-wb-group-value { min-width: 30px; text-align: right; font-size: 13px; font-weight: 600; }
.seo-wb-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.seo-wb-tabs { display: flex; gap: 4px; margin-top: 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.seo-wb-tab { border: 0; background: none; font-family: inherit; font-size: 14px; color: var(--dsw-alias-label-secondary); padding: 9px 14px; border-radius: 8px 8px 0 0; cursor: pointer; border-bottom: 2px solid transparent; }
.seo-wb-tab:hover { background: var(--dsw-alias-bg-layer-2); }
.seo-wb-tab-active { color: var(--dsw-alias-label-primary); font-weight: 600; border-bottom-color: var(--dsw-alias-brand-primary); }
.seo-wb-issues, .seo-wb-details { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.seo-wb-issue, .seo-wb-group { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
.seo-wb-issue-head, .seo-wb-group-head { display: flex; align-items: center; gap: 10px; padding: 11px 14px; cursor: pointer; user-select: none; }
.seo-wb-issue-head:hover, .seo-wb-group-head:hover { background: var(--dsw-alias-bg-layer-2); }
.seo-wb-issue-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.seo-wb-group-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; }
.seo-wb-sev { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid transparent; flex-shrink: 0; }
.seo-wb-sev-critical, .seo-wb-sev-high { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.seo-wb-sev-medium { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.seo-wb-sev-low { color: var(--dsw-alias-state-idle-primary); border-color: var(--dsw-alias-border-l2); }
.seo-wb-issue-body { padding: 0 14px 12px; display: flex; flex-direction: column; gap: 8px; }
.seo-wb-counts { display: flex; gap: 6px; flex-shrink: 0; }
.seo-wb-count { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); }
.seo-wb-count-fail { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.seo-wb-count-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.seo-wb-count-pass { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.seo-wb-check-list { display: flex; flex-direction: column; gap: 4px; padding: 0 14px 12px; }
.seo-wb-check { display: flex; gap: 8px; padding: 6px 0; }
.seo-wb-check-mark { width: 18px; text-align: center; flex-shrink: 0; font-weight: 700; }
.seo-wb-check-pass .seo-wb-check-mark { color: var(--dsw-alias-state-success-primary); }
.seo-wb-check-warn .seo-wb-check-mark { color: var(--dsw-alias-state-warn-primary); }
.seo-wb-check-fail .seo-wb-check-mark { color: var(--dsw-alias-state-error-primary); }
.seo-wb-check-info .seo-wb-check-mark { color: var(--dsw-alias-label-secondary); }
.seo-wb-check-text { min-width: 0; }
.seo-wb-check-label { font-size: 13px; font-weight: 500; }
.seo-wb-check-detail { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; overflow-wrap: anywhere; }
.seo-wb-overview { display: grid; grid-template-columns: 1fr; gap: 0; margin-top: 12px; }
.seo-wb-kv { display: grid; grid-template-columns: 110px 1fr; gap: 8px; padding: 7px 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); margin: 0; font-size: 13px; }
.seo-wb-kv dt { color: var(--dsw-alias-label-secondary); }
.seo-wb-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.seo-wb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.seo-wb-deep { margin-top: 16px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.seo-wb-deep-error { margin-top: 16px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); font-size: 13px; line-height: 1.6; background: var(--dsw-alias-bg-layer-1); }
.seo-wb-section-title { font-size: 14px; font-weight: 600; }
.seo-wb-cwv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
.seo-wb-cwv { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; background: var(--dsw-alias-bg-base); }
.seo-wb-cwv-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.seo-wb-cwv-value { font-size: 18px; font-weight: 700; margin-top: 2px; }
.seo-wb-cwv-ok .seo-wb-cwv-value { color: var(--dsw-alias-state-success-primary); }
.seo-wb-cwv-warn .seo-wb-cwv-value { color: var(--dsw-alias-state-warn-primary); }
.seo-wb-cwv-bad .seo-wb-cwv-value { color: var(--dsw-alias-state-error-primary); }
.seo-wb-cat-bars { display: flex; flex-direction: column; gap: 8px; }
.seo-wb-cat-row { display: flex; align-items: center; gap: 10px; }
.seo-wb-lh { display: flex; flex-direction: column; gap: 8px; }
.seo-wb-lh-title { font-size: 13px; font-weight: 600; }
.seo-wb-lh-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.seo-wb-chip { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.seo-wb-advice { margin-top: 12px; }
.seo-wb-advice-text { display: flex; flex-direction: column; gap: 8px; }
.seo-wb-advice-tools { display: flex; justify-content: flex-end; }
.seo-wb-advice-pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: 13px; line-height: 1.7; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; margin: 0; color: var(--dsw-alias-label-primary); }
.seo-wb-advice-loading { color: var(--dsw-alias-label-secondary); font-size: 13px; }
.seo-wb-notes { margin-top: 16px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.seo-wb-note { font-size: 13px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.seo-wb-empty { margin-top: 12px; padding: 18px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 10px; color: var(--dsw-alias-label-secondary); font-size: 13px; text-align: center; }
.seo-wb-empty-hero { padding: 32px 18px; font-size: 14px; }
.seo-wb-history { margin-top: 24px; }
.seo-wb-history-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.seo-wb-history-list { display: flex; flex-direction: column; gap: 6px; }
.seo-wb-history-row { display: flex; align-items: center; gap: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 8px 12px; }
.seo-wb-history-row:hover { border-color: var(--dsw-alias-border-l2); }
.seo-wb-history-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; border: 0; background: none; font-family: inherit; cursor: pointer; color: var(--dsw-alias-label-primary); padding: 2px 0; text-align: left; }
.seo-wb-history-domain { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seo-wb-history-time { font-size: 12px; color: var(--dsw-alias-label-secondary); flex-shrink: 0; }
.seo-wb-score-chip { font-size: 12px; font-weight: 700; padding: 2px 10px; border-radius: 999px; border: 1px solid; flex-shrink: 0; }
.seo-wb-score-chip-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.seo-wb-score-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.seo-wb-score-chip-bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.seo-wb-history-del { border: 0; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; padding: 4px 6px; border-radius: 6px; flex-shrink: 0; }
.seo-wb-history-del:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); }
.seo-wb-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); z-index: 999; display: flex; align-items: center; justify-content: center; }
.seo-wb-settings { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; padding: 20px; width: 380px; max-width: 92vw; display: flex; flex-direction: column; gap: 12px; }
.seo-wb-settings-title { font-size: 16px; font-weight: 700; }
.seo-wb-field { display: flex; flex-direction: column; gap: 4px; }
.seo-wb-field-label { font-size: 13px; font-weight: 600; }
.seo-wb-field input { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; }
.seo-wb-field input:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }
.seo-wb-field-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.seo-wb-settings-actions { display: flex; gap: 8px; margin-top: 6px; }
.seo-wb-settings-actions .seo-wb-btn-primary { margin-right: auto; }
`;

    // ------------------------------------------------------------ register

    const leftEntry = { id: 'seo-workbench', order: 10, label: 'SEO 分析' };

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = CSS;
          document.head.appendChild(style);
          const disposers = [
            ctx.slots.register({ name: 'sidebar.panellist', id: leftEntry.id, order: leftEntry.order, label: leftEntry.label }, SeoWorkbenchIcon),
            ctx.slots.register({ name: 'main', key: 'seo-workbench' }, SeoWorkbenchBody),
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