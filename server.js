// Zero-dependency scraper for scouted-today.pk (WordPress REST API) + web UI + daily auto-run.
// Bypass is bypass.vip premium ONLY, and only runs when you click a file button.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Readable } = require('stream');

const SITE = 'https://scouted-today.pk';
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const CACHE_FILE = path.join(__dirname, 'bypass-cache.json');
const KEY_FILE = path.join(__dirname, 'bypass-key.txt'); // bypass.vip premium key
fs.mkdirSync(DATA, { recursive: true });

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
const localDate = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;

// ---- bypass.vip premium ----
const PREMIUM_BYPASS = 'https://api.bypass.vip/premium/bypass';
const PREMIUM_REFRESH = 'https://api.bypass.vip/premium/refresh';
const OK_TTL = 24 * 60 * 60 * 1000; // a good result is reused for a day, so a repeat click costs nothing
const FAIL_TTL = 10 * 60 * 1000;    // a failure is retried after ten minutes

// Read live every call, so you can drop the key in without restarting.
const readKey = () => process.env.BYPASS_VIP_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '');
const hasKey = () => readKey().length > 0;

// Hosts worth sending to the API. Anything else is already the real file.
const LOCKERS = ['linkvertise.com','linkvertise.net','linkvertise.link','link-hub.net','link-hub.com','link-to.net','up-to-down.net','file-upload.net','lootlinks.com','loot-links.com','lootlink.org','lootlabs.gg','work.ink','workink.net','mboost.me','bst.gg','booo.st','rekonise.com','social-unlock.com','sub2unlock.com','sub2unlock.net','sub2get.com','sub4unlock.io','unlocknow.net','ytsubme.com','cuty.io','cety.io','boost.ink','adfoc.us','paster.so','paster.gg','mendationforc.info','socialwolvez.com','subfinal.com'];
const isLocker = (u) => {
  try { const h = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); return LOCKERS.some((d) => h === d || h.endsWith('.' + d)); }
  catch { return false; }
};

// A result only counts if the whole string is a URL, and if it isn't bypass.vip's own page.
const isUrl = (s) => typeof s === 'string' && /^https?:\/\/[^\s]+$/i.test(s.trim());
const isOwnPage = (s) => { try { return /(^|\.)bypass\.vip$/i.test(new URL(s).hostname); } catch { return false; } };

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
let cacheTimer;
const saveCache = () => { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {} }, 500); };

// Every upstream response is logged so the console shows what really came back.
const trace = (tag, status, raw) => console.log(`[bypass:${tag}]`, status, String(raw || '').replace(/\s+/g, ' ').slice(0, 300));

async function premiumBypass(url, refresh) {
  const key = readKey();
  if (!key) return { result: null, error: 'no-key' };
  const endpoint = refresh ? PREMIUM_REFRESH : PREMIUM_BYPASS;
  const r = await fetch(`${endpoint}?url=${encodeURIComponent(url)}`, {
    headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(25_000),
  });
  const raw = await r.text();
  trace(refresh ? 'refresh' : 'premium', r.status, raw);
  let j = null;
  try { j = JSON.parse(raw); } catch {}
  const out = j && typeof j.result === 'string' ? j.result.trim() : null;
  if (j && (j.status === 'success' || j.success === true) && isUrl(out) && !isOwnPage(out)) return { result: out, error: null };
  return { result: null, error: j?.message || j?.error || `premium API HTTP ${r.status}` };
}

// Returns { result } on success or { error } on failure. Never throws.
async function bypassLink(url, { refresh = false } = {}) {
  if (!isLocker(url)) return { result: url, error: null };
  if (!hasKey()) return { result: null, error: 'no-key' };

  const hit = cache[url];
  if (!refresh && hit && Date.now() - hit.at < (hit.result ? OK_TTL : FAIL_TTL)) return { result: hit.result, error: hit.error || null };

  let result = null, error = null;
  try { ({ result, error } = await premiumBypass(url, refresh)); }
  catch (e) { error = e.name === 'TimeoutError' ? 'timed out' : e.message; }

  cache[url] = { result, error, at: Date.now() };
  saveCache();
  return { result, error };
}

// Pull out every outbound href from the post body (normally one locker link per post).
const extractLinks = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

// Follow plain HTTP redirects (30x Location headers) only; stops at the first page that isn't a redirect.
// This costs no credits and reveals the real locker (e.g. link-hub.net) when the href is a wrapper.
async function resolveRedirect(url) {
  try {
    for (let hop = 0; hop < 5; hop++) {
      const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10_000) });
      const loc = r.headers.get('location');
      if (r.status < 300 || r.status >= 400 || !loc) return url;
      url = new URL(loc, url).href;
    }
    return url;
  } catch {
    return null;
  }
}

function toRow(p) {
  const m = p._embedded?.['wp:featuredmedia']?.[0];
  return {
    id: p.id,
    date: p.date,
    title: p.title.rendered,
    post_url: p.link,
    thumbnail: m?.media_details?.sizes?.medium?.source_url || m?.source_url || null,
    full_image: m?.source_url || null, // original upload, so zooming stays sharp
    links: extractLinks(p.content.rendered),
  };
}

// Dates are in the site's own timezone (WP interprets after/before that way).
// No bypassing here: posts come back fast and nothing is charged until you click.
async function scrapeDay(date) {
  const rows = [];
  for (let page = 1; ; page++) {
    const url = `${SITE}/?rest_route=/wp/v2/posts&per_page=100&page=${page}&after=${date}T00:00:00&before=${nextDay(date)}T00:00:00&_embed=wp:featuredmedia`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Site returned ${r.status}`);
    rows.push(...(await r.json()).map(toRow));
    if (page >= Number(r.headers.get('x-wp-totalpages') || 1)) break;
  }

  // Redirect resolution only — free, and it points at the real locker.
  await Promise.all(rows.map(async (row) => { row.redirects_to = await Promise.all(row.links.map(resolveRedirect)); }));

  const result = { date, scraped_at: new Date().toISOString(), count: rows.length, posts: rows };
  fs.writeFileSync(path.join(DATA, `${date}.json`), JSON.stringify(result, null, 2));
  return result;
}

// ---- downloading ----
// Strip anything awkward from a filename we hand back to the OS.
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[.\s_]+/, '').replace(/\s+/g, ' ').trim().slice(0, 120);

// Best-effort name: upstream header first, then the URL's last path segment, then a generic name.
function filenameFor(url, headerName, type) {
  const fromHeader = safeName(headerName);
  if (fromHeader) return fromHeader;
  let base = '';
  try { base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch {}
  base = safeName(base);
  if (base && base.includes('.')) return base;
  const ext = { 'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-7z-compressed': '.7z', 'application/x-rar-compressed': '.rar', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3' }[(type || '').split(';')[0].trim().toLowerCase()] || '';
  if (base) return base + (ext || '.html');
  return 'download' + ext;
}

// Streams the resolved target to the browser as an attachment. Never buffers the whole file.
async function sendDownload(res, target) {
  let r;
  try {
    r = await fetch(target, {
      headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return send(res, 502, { error: 'fetch failed: ' + (e.name === 'TimeoutError' ? 'timed out' : e.message) });
  }
  if (!r.ok || !r.body) return send(res, 502, { error: `upstream HTTP ${r.status}` });

  const type = r.headers.get('content-type') || 'application/octet-stream';
  const cd = r.headers.get('content-disposition') || '';
  const headerName = (/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd) || [])[1];
  const name = filenameFor(r.url || target, headerName, type);

  res.writeHead(200, {
    'content-type': type,
    'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
    'x-download-name': name,
  });
  const stream = Readable.fromWeb(r.body);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ---- auto-run ----
const loadSchedule = () => { try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')); } catch { return { enabled: false, time: '23:30', last_run: null, last_result: null }; } };
const saveSchedule = (s) => fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(s, null, 2));

setInterval(async () => {
  const s = loadSchedule();
  const now = new Date();
  const today = localDate(now);
  const hhmm = now.toTimeString().slice(0, 5);
  if (!s.enabled || hhmm < s.time || s.last_run === today) return;
  s.last_run = today; // set first so a slow/failed run doesn't retrigger every tick
  saveSchedule(s);
  try {
    const r = await scrapeDay(today);
    s.last_result = `${today}: ${r.count} posts`;
  } catch (e) {
    s.last_result = `${today}: FAILED - ${e.message}`;
  }
  saveSchedule(s);
  console.log('[auto-run]', s.last_result);
}, 30_000);

// ---- http ----
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({}); } }); });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html');
    if (u.pathname === '/api/scrape') {
      const d = u.searchParams.get('date');
      if (!isDate(d)) return send(res, 400, { error: 'date must be YYYY-MM-DD' });
      return send(res, 200, await scrapeDay(d));
    }
    if (u.pathname === '/api/bypass') {
      const target = (u.searchParams.get('url') || '').trim();
      if (!isUrl(target)) return send(res, 400, { error: 'url must be http(s)' });
      if (!hasKey()) return send(res, 400, { error: 'no-key' });
      const { result, error } = await bypassLink(target, { refresh: u.searchParams.has('refresh') });
      return send(res, 200, { url: target, result, error });
    }
    if (u.pathname === '/api/download') {
      const target = (u.searchParams.get('url') || '').trim();
      if (!isUrl(target)) return send(res, 400, { error: 'url must be http(s)' });
      if (isOwnPage(target)) return send(res, 400, { error: 'that is bypass.vip, not a file' });
      return sendDownload(res, target);
    }
    if (u.pathname === '/api/key') {
      // Lets the UI say whether a key is present, without ever exposing it.
      return send(res, 200, { has_key: hasKey(), source: process.env.BYPASS_VIP_KEY ? 'env' : (fs.existsSync(KEY_FILE) ? 'file' : null) });
    }
    if (u.pathname === '/api/saved') {
      const d = u.searchParams.get('date');
      if (isDate(d)) {
        const f = path.join(DATA, `${d}.json`);
        if (!fs.existsSync(f)) return send(res, 404, { error: 'no saved day' });
        return send(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')));
      }
      return send(res, 200, fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 10)).sort().reverse());
    }
    if (u.pathname === '/api/schedule') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (!/^\d{2}:\d{2}$/.test(b.time || '')) return send(res, 400, { error: 'time must be HH:MM' });
        const s = { ...loadSchedule(), enabled: !!b.enabled, time: b.time };
        // Don't fire immediately for today if the chosen time has already passed.
        if (s.enabled && new Date().toTimeString().slice(0, 5) >= s.time) s.last_run = localDate();
        saveSchedule(s);
      }
      return send(res, 200, loadSchedule());
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
    else res.destroy();
  }
});

const APP_URL = `http://localhost:${PORT}`;
const openBrowser = () => process.argv.includes('--open') && exec(process.platform === 'win32' ? `start "" ${APP_URL}` : `open ${APP_URL}`);
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Already running at ${APP_URL}`);
  openBrowser();
  setTimeout(() => process.exit(0), 500);
});
// 127.0.0.1 only: the UI has no login, so don't expose it to the local network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Scout scraper running at ${APP_URL}  (close this window to stop it)`);
  console.log(hasKey() ? '[bypass] premium key loaded — resolving on click only' : '[bypass] NO premium key — drop one in bypass-key.txt');
  openBrowser();
});