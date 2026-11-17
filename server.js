// Zero-dependency scraper for scouted-today.pk (WordPress REST API) + web UI + daily auto-run.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const SITE = 'https://scouted-today.pk';
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const CACHE_FILE = path.join(__dirname, 'bypass-cache.json');
fs.mkdirSync(DATA, { recursive: true });

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
const localDate = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;

// ---- bypass.vip ----
const BYPASS_API = 'https://api.bypass.vip/bypass?url=';
const OK_TTL = 24 * 60 * 60 * 1000;   // trust a good result for a day
const FAIL_TTL = 10 * 60 * 1000;      // retry a failure after ten minutes

// Hosts worth sending to the API. Anything else is already the real file.
const LOCKERS = ['linkvertise.com','linkvertise.net','link-to.net','up-to-down.net','file-upload.net','lootlinks.com','loot-links.com','lootlink.org','lootlabs.gg','work.ink','workink.net','mboost.me','bst.gg','booo.st','rekonise.com','social-unlock.com','sub2unlock.com','sub2unlock.net','sub2get.com','sub4unlock.io','unlocknow.net','ytsubme.com','cuty.io','cety.io','boost.ink','adfoc.us','paster.so','paster.gg','mendationforc.info','socialwolvez.com','subfinal.com'];
const isLocker = (u) => {
  try { const h = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); return LOCKERS.some((d) => h === d || h.endsWith('.' + d)); }
  catch { return false; }
};

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
let cacheTimer;
const saveCache = () => { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {} }, 500); };

// Returns the real destination, or null if the bypass failed.
async function bypassLink(url, { refresh = false } = {}) {
  if (!isLocker(url)) return url;
  const hit = cache[url];
  if (!refresh && hit && Date.now() - hit.at < (hit.result ? OK_TTL : FAIL_TTL)) return hit.result;
  let result = null;
  try {
    const r = await fetch(BYPASS_API + encodeURIComponent(url), {
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => null);
    if (j && j.status === 'success' && typeof j.result === 'string' && /^https?:\/\//.test(j.result)) result = j.result;
  } catch {}
  cache[url] = { result, at: Date.now() };
  saveCache();
  return result;
}

// Small pool so a full day doesn't fire dozens of requests at once.
async function bypassAll(urls, limit = 4) {
  const out = new Array(urls.length).fill(null);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, async () => {
    while (i < urls.length) { const idx = i++; out[idx] = await bypassLink(urls[idx]); }
  }));
  return out;
}

// Pull out every outbound href from the post body (normally one locker link per post).
const extractLinks = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

// Follow plain HTTP redirects (30x Location headers) only; stops at the first page that isn't a redirect.
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
async function scrapeDay(date) {
  const rows = [];
  for (let page = 1; ; page++) {
    const url = `${SITE}/?rest_route=/wp/v2/posts&per_page=100&page=${page}&after=${date}T00:00:00&before=${nextDay(date)}T00:00:00&_embed=wp:featuredmedia`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Site returned ${r.status}`);
    rows.push(...(await r.json()).map(toRow));
    if (page >= Number(r.headers.get('x-wp-totalpages') || 1)) break;
  }

  // Resolve redirects first: the real locker is sometimes one hop away from the href in the post.
  await Promise.all(rows.map(async (row) => { row.redirects_to = await Promise.all(row.links.map(resolveRedirect)); }));

  // Bypass whatever is actually a locker (raw href or its redirect target), once per unique URL.
  const targets = new Map();
  for (const row of rows) row.links.forEach((l, i) => {
    const t = isLocker(l) ? l : (isLocker(row.redirects_to[i]) ? row.redirects_to[i] : null);
    if (t) targets.set(t, null);
  });
  const keys = [...targets.keys()];
  const values = await bypassAll(keys);
  keys.forEach((k, i) => targets.set(k, values[i]));

  rows.forEach((row) => {
    row.bypassed = row.links.map((l, i) => {
      const t = isLocker(l) ? l : (isLocker(row.redirects_to[i]) ? row.redirects_to[i] : null);
      return t ? targets.get(t) : l;
    });
  });

  const result = { date, scraped_at: new Date().toISOString(), count: rows.length, posts: rows };
  fs.writeFileSync(path.join(DATA, `${date}.json`), JSON.stringify(result, null, 2));
  return result;
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
      const target = u.searchParams.get('url');
      if (!/^https?:\/\//.test(target || '')) return send(res, 400, { error: 'url must be http(s)' });
      const result = await bypassLink(target, { refresh: u.searchParams.has('refresh') });
      return send(res, 200, { url: target, result });
    }
    if (u.pathname === '/api/saved') {
      const d = u.searchParams.get('date');
      if (isDate(d)) return send(res, 200, JSON.parse(fs.readFileSync(path.join(DATA, `${d}.json`), 'utf8')));
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
    send(res, 500, { error: e.message });
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
  openBrowser();
});
