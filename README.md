# dsh-seo-workbench

A DeepSeek Harness plugin that runs technical SEO audits of websites in the right sidebar.

- Package: `@local/seo-workbench`
- Tab: 「SEO 分析」 in the right sidebar (installed via the plugin manager as a local bundle)
- Host half: audit engine (fetch → parse → 21 checks in 4 weighted groups → score → issues), runs in the DSH process
- Client half: sidebar tab UI, calls the engine over the Host's local web server

## Usage

1. Open the right sidebar and pick the **SEO 分析** tab.
2. Enter a URL (scheme is optional, `https://` is assumed) and click **分析**.
3. The panel shows a 0–100 weighted total score, four group scores, a prioritized issue list
   (severity + impact → evidence → fix), the per-check detail, and a page overview.
4. **导出 .md** downloads a full Markdown report; **复制** copies it to the clipboard.
5. **深度检测（CWV）** runs a Google PageSpeed Insights check (real Core Web Vitals,
   Lighthouse category scores, and a fallback JSON-LD detection). It needs a public
   `PSI_API_KEY` — configure it in the plugin config when available.

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
6. Formal install verification — **pending: restart DSH desktop app, then verify live routes**

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
| `client.js` | Client half: sidebar tab registration and panel UI |
| `locale/*.json` | Bundle metadata (`meta.title`, `meta.description`, `meta.detail`) |
| `docs/DETAIL.md` (+ zh) | Plugin detail page |
| `docs/preview.svg` (+ zh) | Detail preview illustration |
| `icon.svg` | Plugin icon |
| `PLAN.md` | Design and step plan |
