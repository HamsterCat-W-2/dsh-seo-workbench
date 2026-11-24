# dsh-seo-workbench

A DeepSeek Harness plugin that runs technical SEO audits of websites in the right sidebar.

- Package: `@local/seo-workbench`
- Tab: 「SEO 分析」 in the right sidebar
- Installed through the plugin manager as a local bundle (see `cordis.patch.yml`)

## Structure

| File | Purpose |
|---|---|
| `index.js` | Host half: audit engine (fetch, parse, checks, scoring, PSI deep check) |
| `client.js` | Client half: right-sidebar tab registration and panel UI |
| `locale/*.json` | Bundle metadata (`meta.title`, `meta.description`) |
| `icon.svg` | Plugin icon |
| `PLAN.md` | Design and step plan |

## Development steps

1. Skeleton bundle + sidebar tab (this commit)
2. Host audit engine + Node smoke test
3. Host → Client remote channel
4. Client panel UI
5. Polish: locales, DETAIL.md, icon, error states
6. Formal install verification
