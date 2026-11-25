# dsh-seo-workbench

A DeepSeek Harness plugin that runs technical SEO audits of websites from a dedicated workbench.

- **Entry point**: a **SEO 分析** row in the left navigation sidebar (same surface as Plugins/Settings) opens the workbench page in the central column

- Package: `@local/seo-workbench`
- Host half: audit engine (fetch → parse → 21 checks in 4 weighted groups → score → issues), runs in the DSH process
- Client half: left-sidebar row + central panel UI, calls the engine over the Host's local web server

## Usage

1. Click **SEO 分析** in the left navigation sidebar to open the workbench page.
2. Pick a mode above the input: **单页分析** (quick health check of one URL) or **站点体检**
   (crawl the site and aggregate cross-page findings). Enter a URL (scheme is optional,
   `https://` is assumed) and click **分析 / 站点体检**. While it runs, the analysis pipeline
   is shown as a step flow (fetch → parse → robots/sitemap → checks → score; site mode:
   robots/sitemap → crawl links → fetch pages → dead links → aggregate).
3. The workbench shows a 0–100 weighted total score, four group scores, a prioritized issue list
   (severity + impact → evidence → fix), the per-check detail, and a page overview.
4. **导出 .md** downloads a full Markdown report; **复制** copies it to the clipboard.
5. **深度检测（CWV）** measures real Core Web Vitals (LCP / CLS / TTFB / FCP + TBT)
   in a throwaway headless checkout of the local **Google Chrome**, right on this machine —
   no Google API key, no network quota, and it also sees JS-rendered JSON-LD schema.
   A Google PageSpeed Insights fallback (and its optional key) is used only when Chrome
   is unavailable; `<chrome path>` can be overridden with `SEO_WB_CHROME_PATH` or the plugin
   row `config.chromePath`.
6. **AI 建议** sends the report to the model selected in the top bar and returns a prioritized
   fix plan. The model dropdown is fed by the Host's live provider/model catalog
   (`/seo-workbench/api/models`).
7. **站点体检** (`POST /seo-workbench/api/site-audit`) BFS-crawls the site: seeds from
   `robots.txt` Sitemap lines (or `/sitemap.xml`) plus the homepage's internal links, stays on
   the same host, respects `Disallow`, and is bounded by the page cap. It reports a 站点概览
   (pages fetched/failed/skipped, dead links, sitemap size), a per-page table with flags
   (thin content, missing title/description/H1/canonical, duplicate title/description, orphan,
   failed), and a 4-group site score (可索引性 / On-Page / 内容质量 / 站点结构).
8. **分析历史** keeps the last 20 audits (localStorage); click a row to restore its report,
   delete a single row, or clear all. 深度检测 and AI 建议 results are saved into the same
   entry — badges `深度` / `AI` / `站点` mark which ones the entry already has.
9. **⚙ 设置** configures a default site (prefills the input), a PageSpeed API Key, the fetch
   timeout, the max redirect count, the 站点体检 page cap (maxPages), two optional path
   filters for the crawl (**只抓这些路径** `includePattern` / **排除这些路径**
   `excludePattern`), and **路径配额** (`pathQuotas`): newline-separated `regex=pages`
   lines that sample a high-volume path instead of excluding it entirely — e.g.
   `^/detail/=10` crawls at most 10 `/detail/*` pages, leaving the page cap for the rest of
   the site. All regexes match each internal link's `pathname + search`. Settings persist in
   localStorage and override the row `config` per request.

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
        psiKey: ''              # PageSpeed Insights key (only used when local Chrome is unavailable)
        chromePath: ''          # optional override for the Chrome binary path (or env SEO_WB_CHROME_PATH)
        maxPages: 30            # 站点体检 page cap (2–200)
        includePattern: ''      # optional regex; only crawl internal links whose path+query matches
        excludePattern: ''      # optional regex; skip internal links whose path+query matches (e.g. ^/detail/)
        pathQuotas: ''          # optional, newline-separated "regex=pages" quotas, e.g. ^/detail/=10
```

The deep check (`lib/localdeep.js`) is a one-shot headless Chrome run, so it measures a lab
Core Web Vitals snapshot (LCP/CLS/TTFB/FCP + TBT). INP is interaction-driven and can't be
measured by a lab run; the card shows `—` locally. Chrome is launched with `--no-sandbox`
(a short-lived profiling instance, own throwaway profile dir, killed afterwards).

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
7. Left-sidebar entry (`sidebar.panellist` row + `main` panel) — done
8. UI redesign: top bar (model select + settings), input + analyze, history, pipeline progress, AI 建议 — done (Host restart needed for the new `/models` + `/advice` routes)
9. 站点体检 crawl mode (BFS crawler + cross-page aggregation + site UI) — done (Host restart needed for the `/site-audit` route)

## Notes & limitations

- Analysis reads the server-rendered HTML only (no JavaScript execution). JSON-LD injected by
  client-side JS is not detected by the basic audit; the deep check (local Chrome) runs the
  page and sees the rendered JSON-LD, and the result is shown in the deep-check section.
- The deep check is a local Chrome lab measurement (LCP/CLS/TTFB/FCP + TBT, mobile viewport);
  INP needs real user interaction and shows `—`. Google PageSpeed Insights is only used as a
  fallback when Chrome is unavailable.
- 站点体检 is bounded (default 30 pages, configurable up to 200), respects `robots.txt`
  `Disallow`, and only follows same-host internal links. Heuristic cross-page thresholds
  (e.g. thin content < 300 words) are not calibrated per site type; dead-link sampling and
  orphan detection are best-effort over the crawled subset.
- Replacing an installed bundle under the same package name requires restarting DSH so the
  fresh Host/Client modules load.

## Structure

| File | Purpose |
|---|---|
| `index.js` | Host half: webServer routes (`/seo-workbench/api/audit`, `/deep`, `/models`, `/advice`, `/site-audit`) |
| `lib/engine.js` | `runAudit()` orchestration |
| `lib/fetch.js` | HTTP fetch w/ redirect chain, timeout, size cap |
| `lib/parse.js` | Dependency-free HTML / robots.txt / sitemap parsing |
| `lib/checks.js` | The 21 checks + group weights |
| `lib/score.js` | Weighted scoring |
| `lib/crawl.js` | 站点体检 BFS crawler (robots-respecting, same-host, bounded) |
| `lib/site.js` | Cross-page aggregation → site report |
| `lib/localdeep.js` | Local Chrome (CDP) CWV measurement for the deep check |
| `lib/psi.js` | PageSpeed Insights deep check (fallback when Chrome is unavailable) |
| `client.js` | Client half: left-sidebar row + `main` panel UI |
| `locale/*.json` | Bundle metadata (`meta.title`, `meta.description`, `meta.detail`) |
| `docs/DETAIL.md` (+ zh) | Plugin detail page |
| `docs/preview.svg` (+ zh) | Detail preview illustration |
| `icon.svg` | Plugin icon |
| `PLAN.md` | Design and step plan |
