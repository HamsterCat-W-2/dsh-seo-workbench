# dsh-seo-workbench

A DeepSeek Harness plugin that runs technical SEO audits of websites from a dedicated workbench.

- **Left sidebar**: a **SEO 分析** navigation row (same surface as Plugins/Settings) opens the workbench page in the central column
- **Right sidebar**: the same-name **SEO 分析** tab opens the compact panel

- Package: `@local/seo-workbench`
- Host half: audit engine (fetch → parse → 21 checks in 4 weighted groups → score → issues), runs in the DSH process
- Client half: left-sidebar row + right-sidebar tab (shared panel UI), calls the engine over the Host's local web server

## Usage

1. Open the **SEO 分析** workbench — from the left navigation sidebar row, or from the right sidebar tab.
2. Enter a URL (scheme is optional, `https://` is assumed) and click **分析**.
3. The workbench shows a 0–100 weighted total score, four group scores, a prioritized issue list
   (severity + impact → evidence → fix), the per-check detail, and a page overview.
4. **导出 .md** downloads a full Markdown report; **复制** copies it to the clipboard.
5. **深度检测（CWV）** runs a Google PageSpeed Insights check (real Core Web Vitals,
   Lighthouse category scores, and a fallback JSON-LD detection). It works without a key at
   reduced quota; set `PSI_API_KEY` in the environment (or a plugin row `config.psiKey`)
   for the official quota.

## Configuration

This bundle intentionally does **not** export a `Config` schema: linked bundles cannot
resolve external `@deepseek-ai/*` packages (their real path never reaches the profile's
`node_modules`), and such an import aborts activation. Tunables are still read from the
row `config` object — add a `config:` block to the patch row in the profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: seo-workbench
      name: '@local/seo-workbench'
      config:
        fetchTimeoutMs: 15000   # per-request timeout
        maxRedirects: 5         # redirect hops followed per page
        userAgent: ''           # empty = built-in Chrome-like UA
        psiKey: ''              # PageSpeed Insights key (or env PSI_API_KEY)
```

`PSI_API_KEY` from the environment is used when `config.psiKey` is empty.

## Check inventory

| Group (weight) | Checks |
|---|---|
| 可抓取与索引 (0.35) | HTTP status & redirects, robots.txt, sitemap discovery, canonical, meta robots |
| 技术基础 (0.25) | HTTPS, mixed content, viewport, html lang, hreflang, page weight, link counts |
| On-Page (0.30) | title length, meta description length, H1 structure, heading hierarchy, image alt, lazy loading, JSON-LD schema |
| 内容质量 (0.10) | content thickness, duplicate title/description |

## Development steps

1. Skeleton bundle + sidebar tab — done, installed & slot-verified
2. Host audit engine + Node smoke test (`node scripts/smoke.mjs`) — done, passing
3. Host → Client channel (webServer routes + same-origin fetch) — done
4. Client panel UI — done
5. Polish: locales, DETAIL.md, previews, icon — done
6. Formal install verification — done (live audit + deep routes verified)
7. Left-sidebar entry + right-sidebar tab — done (waiting on page reload to see the row)

## Notes & limitations

- Analysis reads the server-rendered HTML only (no JavaScript execution). JSON-LD injected by
  client-side JS is not detected by the basic audit; the deep check falls back to PSI's
  structured-data audit.
- Single-page analysis; cross-page duplicate titles/descriptions and site-wide crawling are
  roadmap items (Phase 2).
- Replacing an installed bundle under the same package name requires restarting DSH so the
  fresh Host/Client modules load.

## Structure

| File | Purpose |
|---|---|
| `index.js` | Host half: webServer routes (`/seo-workbench/api/audit`, `/deep`) |
| `lib/engine.js` | `runAudit()` orchestration |
| `lib/fetch.js` | HTTP fetch w/ redirect chain, timeout, size cap |
| `lib/parse.js` | Dependency-free HTML / robots.txt / sitemap parsing |
| `lib/checks.js` | The 21 checks + group weights |
| `lib/score.js` | Weighted scoring |
| `lib/psi.js` | PageSpeed Insights deep check |
| `client.js` | Client half: left-sidebar row + `main` panel + right-sidebar tab (shared UI) |
| `locale/*.json` | Bundle metadata (`meta.title`, `meta.description`, `meta.detail`) |
| `docs/DETAIL.md` (+ zh) | Plugin detail page |
| `docs/preview.svg` (+ zh) | Detail preview illustration |
| `icon.svg` | Plugin icon |
| `PLAN.md` | Design and step plan |
