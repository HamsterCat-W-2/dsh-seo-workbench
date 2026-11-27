// Semrush data pull through a local, visible Chrome driven over the DevTools
// protocol (CDP). No API key, no cloud indexing: the browser keeps the user's
// own Semrush session, the host reuses that window across pulls.
//
// The window is persistent on purpose (unlike lib/localdeep.js, which uses a
// throwaway headless profile per run): Semrush requires a login, and a fresh
// profile per run would mean logging in on every pull. Chrome is started with
// --no-sandbox because its sandbox helper cannot initialize under the Electron
// host (same reason as localdeep).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME_CANDIDATES = [
  process.env.SEO_WB_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
  'chrome',
].filter(Boolean);

const PORT = clampInt(process.env.SEO_WB_CDP_PORT, 1024, 65535, 9333);
const PROFILE_DIR = process.env.SEO_WB_CDP_PROFILE || join(homedir(), '.dsh', 'seo-workbench', 'chrome-profile');
const HOME_URL = 'https://www.semrush.com/';
const TEXT_LIMIT = 24000;
const SHOT_LIMIT = 3_000_000; // base64 chars; skip the screenshot above this

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome(explicit) {
  const list = explicit ? [explicit, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  for (const candidate of list) {
    if (!candidate) continue;
    const isPath = candidate.includes('/');
    if (!isPath || existsSync(candidate)) return candidate;
  }
  return null;
}

export function profileDir() {
  return PROFILE_DIR;
}

export function cdpPort() {
  return PORT;
}

async function probe() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Make sure the debug Chrome is up. Starts it (visible window, persistent
 * profile) when it is not, and waits for the DevTools endpoint.
 *
 * @returns {Promise<{ok:true, started:boolean} | {ok:false, error:{code:string,message:string}}>}
 */
export async function ensureBrowser(options = {}) {
  const port = clampInt(options.port, 1024, 65535, PORT);
  const existing = await probe();
  if (existing) return { ok: true, started: false };
  const chromePath = findChrome(options.chromePath);
  if (!chromePath) {
    return {
      ok: false,
      error: {
        code: 'chrome-unavailable',
        message: `没有找到可用的 Google Chrome（${CHROME_CANDIDATES.join(' / ')}），无法打开 Semrush 浏览器窗口。`,
      },
    };
  }
  try {
    mkdirSync(PROFILE_DIR, { recursive: true });
  } catch {
    /* ignore — Chrome reports the real failure below */
  }
  const child = spawn(
    chromePath,
    [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-dev-shm-usage',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1300,900',
      HOME_URL,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    await wait(250);
    if (await probe()) return { ok: true, started: true };
  }
  return {
    ok: false,
    error: {
      code: 'chrome-timeout',
      message: `Chrome 调试端口（127.0.0.1:${port}）没有响应，Semrush 窗口可能没能启动。`,
    },
  };
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let idc = 0;
    const timer = setTimeout(() => reject(new Error('DevTools 连接超时')), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          const id = ++idc;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP ${method} 超时`));
              }
            }, 20000);
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('无法连接 Chrome DevTools'));
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || 'CDP 调用失败'));
        else res(msg.result);
      }
    };
  });
}

async function pageTarget() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    return pages[0] || null;
  } catch {
    return null;
  }
}

async function ensurePageTarget() {
  const existing = await pageTarget();
  if (existing) return existing;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, { method: 'PUT' });
    if (res.ok) {
      const created = await res.json();
      if (created && created.webSocketDebuggerUrl) return created;
    }
  } catch {
    /* fall through */
  }
  return null;
}

const EXTRACT_SRC = `(() => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const out = {
    href: location.href,
    title: document.title,
    text: '',
    tables: [],
    hasPasswordInput: !!document.querySelector('input[type="password"]'),
    hasLoginLink: Array.from(document.querySelectorAll('a')).some((a) => /log\\s*in|sign\\s*in|登录/i.test(clean(a.innerText))),
  };
  try { out.text = clean((document.body && document.body.innerText) || '').slice(0, ${TEXT_LIMIT}); } catch (e) { /* ignore */ }
  try {
    const tables = Array.from(document.querySelectorAll('table')).slice(0, 6);
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr')).slice(0, 80)
        .map((tr) => Array.from(tr.cells).map((cell) => clean(cell.innerText)).filter(Boolean))
        .filter((row) => row.length);
      if (rows.length) out.tables.push(rows);
    }
  } catch (e) { /* ignore */ }
  return JSON.stringify(out);
})()`;

/** Semrush URL for one research kind. */
export function semrushUrl(kind, target) {
  const raw = String(target || '').trim();
  const bare = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (kind === 'keywords') {
    return `https://www.semrush.com/analytics/organic/overview/?q=${encodeURIComponent(bare)}&searchType=domain`;
  }
  if (kind === 'keyword') {
    return `https://www.semrush.com/analytics/keywordoverview/?q=${encodeURIComponent(raw)}`;
  }
  return `https://www.semrush.com/analytics/overview/?q=${encodeURIComponent(bare)}&searchType=domain`;
}

/** Login wall detection from the extracted page facts. */
/**
 * The mirror tool that resells Semrush (zh.trends.fast.wmxpro.com and friends)
 * moves its host from time to time; the panel keeps the last good link in
 * settings, and every page URL is derived from that link's origin.
 */
export const MIRROR_FALLBACK = 'https://zh.trends.fast.wmxpro.com';

export function mirrorBase(link) {
  if (link) {
    try {
      const parsed = new URL(String(link).trim());
      if (/^https?:$/.test(parsed.protocol)) return parsed.origin;
    } catch {
      /* fall through to the default */
    }
  }
  return MIRROR_FALLBACK;
}

function bareHost(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

/**
 * Build a mirror-tool URL for the pages the panel exposes:
 *   keyword → 关键词概览 (one keyword)
 *   compare → 比较域名 (own domain vs one competitor)
 *   gap     → 关键词差异 (missing keywords, own vs competitor)
 */
export function mirrorUrl(kind, own, options = {}) {
  const base = mirrorBase(options.base || options.link);
  const db = String(options.db || 'us').trim() || 'us';
  const domain = bareHost(own);
  const competitor = bareHost(options.competitor);
  if (kind === 'keyword') {
    const keyword = String(options.keyword || '').trim();
    if (!keyword) return '';
    return `${base}/analytics/keywordoverview/?q=${encodeURIComponent(keyword)}&db=${encodeURIComponent(db)}`;
  }
  if (kind === 'compare') {
    if (!domain || !competitor) return '';
    return `${base}/analytics/comparedomains/?q=${encodeURIComponent(domain)}&compareWith=${encodeURIComponent(competitor)}%3Adomain&searchType=domain&db=${encodeURIComponent(db)}`;
  }
  if (kind === 'gap') {
    if (!domain || !competitor) return '';
    return `${base}/analytics/keywordgap/?q=${encodeURIComponent(domain)}&searchType=domain&rankType=missing&db=${encodeURIComponent(db)}&compareWith=${encodeURIComponent(competitor)}%3Adomain%3Aorganic`;
  }
  return '';
}

export function detectLoginWall(facts) {
  const href = String((facts && facts.href) || '');
  const text = String((facts && facts.text) || '');
  const hasPasswordInput = Boolean(facts && facts.hasPasswordInput);
  if (/\/login|\/signin|\/register/i.test(href)) return true;
  if (hasPasswordInput) return true;
  const wall = /(Log In|Sign In|Sign in|Start for free|TRY SEMRUSH FOR FREE|登录|立即登录|免费试用|登录已过期)/;
  const dashboard = /(Domain Overview|Organic Research|Keyword Overview|Competitors|域名概览|自然搜索|关键词概览|竞争对手|Backlinks)/;
  return wall.test(text) && !dashboard.test(text);
}

/**
 * Open a Semrush URL in the debug browser and read the page back.
 *
 * @returns {Promise<object>} { status:'ok'|'login-required'|'error', href, title, text, tables, loginRequired, browserStarted, shot }
 */
export async function pullSemrush(target, options = {}) {
  const kind = options.kind === 'keywords' ? 'keywords' : options.kind === 'keyword' ? 'keyword' : 'overview';
  const url = options.url || semrushUrl(kind, target);
  const waitMs = clampInt(options.waitMs, 2000, 40000, 9000);
  const wantShot = options.screenshot !== false;
  const browser = await ensureBrowser(options);
  if (!browser.ok) return { status: 'error', error: browser.error, url };
  const targetInfo = await ensurePageTarget();
  if (!targetInfo) {
    return { status: 'error', error: { code: 'no-page-target', message: '调试窗口里没有可用的标签页。' }, url };
  }
  let cdp;
  try {
    cdp = await connectCdp(targetInfo.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url });
    const steps = Math.ceil(waitMs / 500);
    for (let i = 0; i < steps; i += 1) {
      await wait(500);
      try {
        const state = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (state && state.result && state.result.value === 'complete') break;
      } catch {
        /* keep waiting */
      }
    }
    await wait(2000); // let SPA hydration / data requests settle
    const facts = await cdp.send('Runtime.evaluate', { expression: EXTRACT_SRC, returnByValue: true });
    const parsed = facts && facts.result && typeof facts.result.value === 'string' ? JSON.parse(facts.result.value) : {};
    const loginRequired = detectLoginWall(parsed);
    let shot = null;
    if (wantShot) {
      try {
        const shotResult = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (shotResult && shotResult.data && shotResult.data.length <= SHOT_LIMIT) shot = shotResult.data;
      } catch {
        /* ignore screenshot failures */
      }
    }
    return {
      status: loginRequired ? 'login-required' : 'ok',
      url,
      href: parsed.href || url,
      title: parsed.title || '',
      text: parsed.text || '',
      tables: Array.isArray(parsed.tables) ? parsed.tables : [],
      loginRequired,
      browserStarted: browser.started,
      shot,
    };
  } catch (error) {
    return {
      status: 'error',
      url,
      error: { code: 'cdp-failed', message: (error && error.message) || String(error || '未知错误') },
    };
  } finally {
    if (cdp) cdp.close();
  }
}

/** Prompt that turns Semrush page text into strict JSON. */
export function buildSemrushParsePrompt(url, text, tables, meta = {}) {
  const context = [];
  if (meta.kind === 'keyword') context.push(`页面类型：关键词概览，目标是关键词「${meta.keyword || ''}」。`);
  if (meta.kind === 'compare') context.push(`页面类型：比较域名，对比「${meta.own || ''}」（您）与「${meta.competitor || ''}」（竞品）。`);
  if (meta.kind === 'gap') context.push(`页面类型：关键词差异，对比「${meta.own || ''}」（您）与「${meta.competitor || ''}」（竞品）。`);
  if (meta.kind === 'compare' || meta.kind === 'gap') {
    context.push('overview 填「您」这一列的指标，competitor 填竞品这一列的指标；页面里写 n/a 的给 null。');
  }
  return [
    '下面是从 Semrush（SEO 工具）页面上抓取到的文本，请从中提取结构化数据。',
    `页面：${url}`,
    ...context,
    '',
    '只输出一个 JSON 对象，不要 Markdown 代码块、不要任何解释。结构：',
    '{',
    '  "overview": { "authorityScore": null, "organicKeywords": null, "organicTraffic": null, "organicTrafficCost": null, "backlinks": null, "referringDomains": null },',
    '  "competitor": { "domain": "", "authorityScore": null, "organicKeywords": null, "organicTraffic": null, "backlinks": null, "referringDomains": null },',
    '  "keywords": [ { "keyword": "", "position": null, "volume": null, "traffic": null, "kd": null, "url": "" } ],',
    '  "competitors": [ { "domain": "", "commonKeywords": null, "competition": "", "organicKeywords": null, "organicTraffic": null } ],',
    '  "notes": []',
    '}',
    '',
    '硬性规则：',
    '1. 只使用文本里真实出现过的数据；没有就填 null 或空数组，绝对不要编造数字。',
    '2. keywords 最多 20 条，按相关度/位置排序；competitors 最多 10 条。',
    '3. 数字不要带逗号或单位，单位写进 notes。',
    '4. 如果页面其实是登录页或没有数据，overview 全为 null 并在 notes 里写明原因。',
    '',
    tables && tables.length
      ? `页面表格（前 ${Math.min(tables.length, 4)} 个，供参考）：\n${tables
          .slice(0, 4)
          .map((rows, i) => `表 ${i + 1}：\n${rows
            .slice(0, 30)
            .map((row) => (Array.isArray(row) ? row.join(' | ') : String(row)))
            .join('\n')}`)
          .join('\n')}`
      : '',
    '',
    '页面文本：',
    String(text || '').slice(0, 20000),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Shape one parsed item into a plain record (no invented fields). */
export function normalizeSemrushParse(data) {
  const out = { overview: null, competitor: null, keywords: [], competitors: [], notes: [] };
  if (!data || typeof data !== 'object') return out;
  if (data.competitor && typeof data.competitor === 'object') {
    const cmp = {};
    for (const key of ['domain', 'authorityScore', 'organicKeywords', 'organicTraffic', 'backlinks', 'referringDomains']) {
      cmp[key] = key === 'domain' ? String(data.competitor.domain || '').trim() : numOrNull(data.competitor[key]);
    }
    if (cmp.domain) out.competitor = cmp;
  }
  if (data.overview && typeof data.overview === 'object') {
    const ov = {};
    for (const key of ['authorityScore', 'organicKeywords', 'organicTraffic', 'organicTrafficCost', 'backlinks', 'referringDomains']) {
      ov[key] = numOrNull(data.overview[key]);
    }
    out.overview = ov;
  }
  if (Array.isArray(data.keywords)) {
    for (const item of data.keywords.slice(0, 20)) {
      if (!item || typeof item !== 'object') continue;
      const keyword = String(item.keyword || '').trim();
      if (!keyword) continue;
      out.keywords.push({
        keyword,
        position: numOrNull(item.position),
        volume: numOrNull(item.volume),
        traffic: numOrNull(item.traffic),
        kd: numOrNull(item.kd),
        url: String(item.url || '').trim(),
      });
    }
  }
  if (Array.isArray(data.competitors)) {
    for (const item of data.competitors.slice(0, 10)) {
      if (!item || typeof item !== 'object') continue;
      const domain = String(item.domain || '').trim();
      if (!domain) continue;
      out.competitors.push({
        domain,
        commonKeywords: numOrNull(item.commonKeywords),
        competition: String(item.competition || '').trim(),
        organicKeywords: numOrNull(item.organicKeywords),
        organicTraffic: numOrNull(item.organicTraffic),
      });
    }
  }
  if (Array.isArray(data.notes)) {
    out.notes = data.notes.map((note) => String(note || '').trim()).filter(Boolean).slice(0, 8);
  }
  return out;
}

function numOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// User-Chrome channel: drive the user's own (logged-in) Chrome through a tiny
// AppleScript helper app. The DSH app itself has no NSAppleEventsUsageDescription,
// so macOS denies it AppleEvents (-10004); the helper bundle carries its own
// ad-hoc signature and is authorized once by the user. argv[1] is the AppleScript
// file to run; stdout is written to HELPER_OUT.
// ---------------------------------------------------------------------------

const HELPER_OUT = process.env.SEO_WB_HELPER_OUT || '/tmp/ctrl/out.txt';
// The helper app runs a FIXED script path by default (argv is dropped when the
// applet is already running, so --args is unreliable) — write there instead.
const HELPER_SCRIPT = process.env.SEO_WB_HELPER_SCRIPT || '/tmp/ctrl/script.applescript';
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function helperAppPath(options = {}) {
  const candidates = [
    options.helperApp,
    process.env.SEO_WB_HELPER,
    join(PLUGIN_ROOT, '.helper', 'run.app'),
    '/tmp/ctrl/run.app',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export function asAppleString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Single-line JS (AppleScript string literals cannot carry raw newlines).
const EXTRACT_JS = "(function(){var out={href:location.href,title:document.title,ready:document.readyState,hasPasswordInput:false,hasLoginLink:false,text:'',tables:[]};try{out.hasPasswordInput=!!document.querySelector('input[type=password]');}catch(e){}try{var as=Array.prototype.slice.call(document.querySelectorAll('a')),hit=false;for(var i=0;i<as.length;i++){var h=as[i].getAttribute('href')||'';if(h.indexOf('/login')>=0||h.indexOf('/signin')>=0){hit=true;break;}}out.hasLoginLink=hit;}catch(e){}try{if(document.body){out.text=(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,24000);}}catch(e){}try{var tbs=document.querySelectorAll('table');for(var i=0;i<tbs.length&&i<6;i++){var rows=[],trs=tbs[i].querySelectorAll('tr');for(var j=0;j<trs.length&&j<80;j++){var cells=trs[j].querySelectorAll('th,td'),vals=[];for(var k=0;k<cells.length;k++){vals.push((cells[k].innerText||'').trim());}rows.push(vals.join(' | '));}var kept=rows.filter(function(r){return r;});if(kept.length){out.tables.push(kept);}}}catch(e){}return JSON.stringify(out);})()";

export function buildUserChromeScript(url, waitMs) {
  let origin = '';
  try { origin = new URL(url).origin; } catch { origin = ''; }
  const lines = [
    'tell application "Google Chrome"',
    '  set targetURL to ' + asAppleString(url),
    '  set theTab to missing value',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
  ];
  const domain = (() => { try { return new URL(url).hostname.replace(/^www\./i, '').replace(/^zh\./i, ''); } catch { return ''; } })();
  if (domain) lines.push('      if (URL of t) contains ' + asAppleString(domain) + ' then set theTab to t');
  else if (origin) lines.push('      if (URL of t) starts with ' + asAppleString(origin) + ' then set theTab to t');
  lines.push(
    '    end repeat',
    '  end repeat',
    '  if theTab is missing value then',
    '    set theTab to make new tab at end of tabs of window 1 with properties {URL:targetURL}',
    '  else',
    '    set URL of theTab to targetURL',
    '  end if',
    '  delay ' + Math.max(2, Math.round(waitMs / 1000)),
    '  set out to ""',
    '  try',
    '    set out to execute theTab javascript ' + asAppleString(EXTRACT_JS),
    '  on error errMsg number errNum',
    '    set out to "ERR " & errMsg & " " & errNum',
    '  end try',
    'end tell',
    'return out',
  );
  return lines.join('\n');
}

export async function runChromeScript(scriptText, options = {}) {
  const helper = helperAppPath(options);
  if (!helper) {
    return { ok: false, error: { code: 'helper-missing', message: '缺少浏览器辅助 app（.helper/run.app），先运行一次「准备浏览器通道」。' } };
  }
  const scriptPath = HELPER_SCRIPT;
  const timeoutMs = clampInt(options.timeoutMs, 5000, 120000, 90000);
  try {
    writeFileSync(scriptPath, scriptText + '\n', 'utf8');
    try { unlinkSync(HELPER_OUT); } catch { /* ignore */ }
    const child = spawn('open', ['-a', helper, '--args', scriptPath], { stdio: 'ignore' });
    child.on('error', () => {});
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await wait(300);
      let raw = '';
      try { raw = readFileSync(HELPER_OUT, 'utf8'); } catch { continue; }
      if (!raw) continue;
      const trimmed = raw.trim();
      if (/^ERR /.test(trimmed)) return { ok: false, error: { code: 'applescript-error', message: trimmed } };
      return { ok: true, raw: trimmed };
    }
    return { ok: false, error: { code: 'helper-timeout', message: '浏览器辅助 app 没有在 ' + Math.round(timeoutMs / 1000) + ' 秒内返回结果（可能未授权「自动化」权限）。' } };
  } finally {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

export async function pullUserChrome(url, options = {}) {
  const target = String(url || '').trim();
  if (!target) return { status: 'error', url: target, error: { code: 'missing-input', message: 'url is required' } };
  const waitMs = clampInt(options.waitMs, 2000, 40000, 9000);
  const run = await runChromeScript(buildUserChromeScript(target, waitMs), options);
  if (!run.ok) return { status: 'error', url: target, error: run.error };
  let parsed = {};
  try {
    parsed = JSON.parse(run.raw);
  } catch {
    return { status: 'error', url: target, error: { code: 'bad-page-data', message: '页面数据解析失败：' + run.raw.slice(0, 160) } };
  }
  const loginRequired = detectLoginWall(parsed);
  return {
    status: loginRequired ? 'login-required' : 'ok',
    url: target,
    href: parsed.href || '',
    title: parsed.title || '',
    text: parsed.text || '',
    tables: Array.isArray(parsed.tables) ? parsed.tables : [],
    loginRequired,
    browserStarted: false,
    channel: 'user-chrome',
    shot: null,
  };
}

export async function activeTabUrl(options = {}) {
  const script = [
    'tell application "Google Chrome"',
    '  set out to ""',
    '  try',
    '    set t to active tab of front window',
    '    set out to (URL of t) & (ASCII character 9) & (title of t)',
    '  on error errMsg number errNum',
    '    set out to "ERR " & errMsg & " " & errNum',
    '  end try',
    'end tell',
    'return out',
  ].join('\n');
  const run = await runChromeScript(script, options);
  if (!run.ok) return { status: 'error', error: run.error };
  const raw = run.raw;
  if (/^ERR /.test(raw)) return { status: 'error', error: { code: 'applescript-error', message: raw } };
  const idx = raw.indexOf('\t');
  return { status: 'ok', url: idx >= 0 ? raw.slice(0, idx).trim() : raw, title: idx >= 0 ? raw.slice(idx + 1) : '' };
}
