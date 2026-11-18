// Zero-dependency scraper for scouted-today.pk (WordPress REST API) + web UI + daily auto-run.
// Bypass is bypass.vip premium ONLY, and only runs when you click a file button.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const BUILD = 'v8';
const SITE = 'https://scouted-today.pk';
const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const DATA = path.join(__dirname, 'data');
const DOWNLOADS = path.join(__dirname, 'downloads');
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const CACHE_FILE = path.join(__dirname, 'bypass-cache.json');
const KEY_FILE = path.join(__dirname, 'bypass-key.txt');       // bypass.vip premium key
const FILESTER_KEY_FILE = path.join(__dirname, 'filester-key.txt'); // optional filester API key
const MAX_FILES = 80;
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
const localDate = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;

// ---- bypass.vip premium ----
const PREMIUM_BYPASS = 'https://api.bypass.vip/premium/bypass';
const PREMIUM_REFRESH = 'https://api.bypass.vip/premium/refresh';
const OK_TTL = 24 * 60 * 60 * 1000; // a good result is reused for a day, so a repeat click costs nothing

// Read live every call. Strip a BOM, surrounding quotes and any whitespace, which a key file often picks up.
const readKey = () => String(process.env.BYPASS_VIP_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8') : ''))
  .replace(/^\uFEFF/, '').replace(/["'`\s]/g, '');
const hasKey = () => readKey().length > 0;
const keyInfo = () => {
  const k = readKey();
  return {
    has_key: k.length > 0,
    key_length: k.length,
    key_prefix: k.slice(0, 8),
    key_clean: /^[A-Za-z0-9_-]+$/.test(k),
    source: process.env.BYPASS_VIP_KEY ? 'env' : (fs.existsSync(KEY_FILE) ? 'file' : null),
  };
};

// Optional: lets the grabber fetch originals instead of thumbnails.
const readFilmseterKey = () => String(process.env.FILESTER_API_KEY || (fs.existsSync(FILESTER_KEY_FILE) ? fs.readFileSync(FILESTER_KEY_FILE, 'utf8') : ''))
  .replace(/^\uFEFF/, '').replace(/["'`\s]/g, '');

// Hosts worth sending to the API. Anything else is already the real file.
const LOCKERS = ['linkvertise.com','linkvertise.net','linkvertise.link','link-hub.net','link-hub.com','link-to.net','up-to-down.net','file-upload.net','lootlinks.com','loot-links.com','lootlink.org','lootlabs.gg','work.ink','workink.net','mboost.me','bst.gg','booo.st','rekonise.com','social-unlock.com','sub2unlock.com','sub2unlock.net','sub2get.com','sub4unlock.io','unlocknow.net','ytsubme.com','cuty.io','cety.io','boost.ink','adfoc.us','paster.so','paster.gg','mendationforc.info','socialwolvez.com','subfinal.com'];
const isLocker = (u) => {
  try { const h = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); return LOCKERS.some((d) => h === d || h.endsWith('.' + d)); }
  catch { return false; }
};

// A result only counts if the whole string is a URL, and if it isn't bypass.vip's own page.
const isUrl = (s) => typeof s === 'string' && /^https?:\/\/[^\s]+$/i.test(s.trim());
const isOwnPage = (s) => { try { return /(^|\.)bypass\.vip$/i.test(new URL(s).hostname); } catch { return false; } };
// A destination worth trusting: a URL that is neither bypass.vip nor another locker.
const isReal = (s) => isUrl(s) && !isOwnPage(s) && !isLocker(s);

// link-hub.net and friends are aliases of linkvertise.com. The API resolves the canonical form far more reliably.
const ALIASES = ['link-hub.net','link-hub.com','link-to.net','up-to-down.net','linkvertise.net','linkvertise.link'];
function canonicalize(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!ALIASES.includes(h)) return null;
    return `https://linkvertise.com${u.pathname}`;
  } catch { return null; }
}

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}

// A failed entry written by an older build is not trustworthy, and it survives restarts.
// Drop those on boot and keep only the successes.
let purged = 0;
for (const [k, v] of Object.entries(cache)) if (!v || !isReal(v.result)) { delete cache[k]; purged++; }
if (purged) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {} }

let cacheTimer;
const saveCache = () => { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {} }, 500); };

// Every upstream response is logged so the console shows what really came back.
const trace = (tag, status, raw) => console.log(`[bypass:${tag}]`, status, String(raw || '').replace(/\s+/g, ' ').slice(0, 300));

// One raw call. Returns the parsed verdict plus the status and body for diagnostics.
async function callPremium(url, refresh) {
  const key = readKey();
  if (!key) return { status: 0, raw: '', error: 'no-key' };
  const endpoint = refresh ? PREMIUM_REFRESH : PREMIUM_BYPASS;
  let r;
  try {
    r = await fetch(`${endpoint}?url=${encodeURIComponent(url)}`, {
      headers: { 'x-api-key': key, accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    const error = e.name === 'TimeoutError' ? 'timed out' : e.message;
    trace('error', 0, error);
    return { status: 0, raw: '', error };
  }
  const raw = await r.text();
  trace(refresh ? 'refresh' : 'premium', r.status, raw);
  let j = null;
  try { j = JSON.parse(raw); } catch {}
  const out = j && typeof j.result === 'string' ? j.result.trim() : null;
  return { status: r.status, raw, json: j, out };
}

// Interpret a raw call. A linkvertise URL coming back means it did not actually unlock.
function verdict(res) {
  const { json: j, out, status, raw } = res;
  if (res.error) return { result: null, error: res.error };
  if (out && isOwnPage(out)) return { result: null, error: 'returned bypass.vip page', status, raw };
  if (j && (j.status === 'success' || j.success === true)) {
    if (!isUrl(out)) return { result: null, error: 'success without a URL', status, raw };
    if (isLocker(out)) return { result: null, error: 'still-locked', status, raw };
    return { result: out, error: null, status, raw };
  }
  if (status === 401 || status === 403) return { result: null, error: 'key rejected', status, raw };
  return { result: null, error: j?.message || j?.error || `premium API HTTP ${status}`, status, raw };
}

// Follow plain HTTP redirects (30x Location headers) only; stops at the first page that isn't a redirect.
// This costs no credits and reveals the real locker when the href in the post is a wrapper.
async function resolveRedirect(url) {
  try {
    for (let hop = 0; hop < 5; hop++) {
      const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) });
      const loc = r.headers.get('location');
      if (r.status < 300 || r.status >= 400 || !loc) return url;
      url = new URL(loc, url).href;
    }
    return url;
  } catch {
    return null;
  }
}

// Returns { result } on success or { error } on failure. Never throws.
async function bypassLink(url, { refresh = false } = {}) {
  // The href in a post is often a wrapper on the site itself. Chase it to the real locker first.
  let target = url;
  if (!isLocker(target)) {
    const final = await resolveRedirect(target);
    if (final && isLocker(final)) target = final;
    else return { result: final || target, error: null }; // already a plain destination
  }
  if (!hasKey()) return { result: null, error: 'no-key' };

  const hit = cache[target];
  if (!refresh && hit && hit.result && Date.now() - hit.at < OK_TTL) return { result: hit.result, error: null };

  const candidates = [target, canonicalize(target)].filter((v, i, a) => v && a.indexOf(v) === i);
  let result = null, error = null;
  for (const candidate of candidates) {
    ({ result, error } = verdict(await callPremium(candidate, refresh)));
    if (result) break;
  }
  // One more pass through the refresh endpoint, which skips their side cache.
  if (!result && !refresh) {
    for (const candidate of candidates) {
      ({ result, error } = verdict(await callPremium(candidate, true)));
      if (result) break;
    }
  }

  if (result) { cache[target] = { result, at: Date.now() }; saveCache(); }
  return { result, error };
}

// Pull out every outbound href from the post body (normally one locker link per post).
const extractLinks = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

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
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error(`Site returned ${r.status}`);
    rows.push(...(await r.json()).map(toRow));
    if (page >= Number(r.headers.get('x-totalpages') || r.headers.get('x-wp-totalpages') || 1)) break;
  }

  // Redirect resolution only — free, and it points at the real locker.
  await Promise.all(rows.map(async (row) => { row.redirects_to = await Promise.all(row.links.map(resolveRedirect)); }));

  const result = { date, scraped_at: new Date().toISOString(), count: rows.length, posts: rows };
  fs.writeFileSync(path.join(DATA, `${date}.json`), JSON.stringify(result, null, 2));
  return result;
}

// ---- names, extensions, zipping ----
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[.\s_]+/, '').replace(/\s+/g, ' ').trim().slice(0, 100);

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-rar-compressed': '.rar', 'application/x-7z-compressed': '.7z',
  'text/html': '.html', 'application/json': '.json',
};

// CRC32 for the zip entries.
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

// Minimal store-only zip, so no dependency is needed. Names are UTF-8 flagged.
function buildZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.buf);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(e.buf.length, 18); h.writeUInt32LE(e.buf.length, 22);
    h.writeUInt16LE(name.length, 26);
    local.push(h, name, e.buf);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(e.buf.length, 20); c.writeUInt32LE(e.buf.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + e.buf.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

// ---- filester.me ----
// The album page lists every file's real name next to a /t/<uuid> thumbnail. The uuid is the file's
// own id, so the account API can turn it into the real /d/<slug> download link.
const FILESTER = /^https?:\/\/(?:www\.)?filester\.me\/f\/([A-Za-z0-9]+)/i;

function filesterItems(html) {
  const items = [];
  for (const m of html.matchAll(/data-name="([^"]*)"[\s\S]{0,800}?\/t\/([0-9a-f-]{36})/gi)) items.push({ name: m[1].replace(/&amp;/g, '&'), uuid: m[2] });
  return items;
}

// Resolve one uuid to a real download URL. Needs the filester API key.
async function filesterOriginal(uuid, key) {
  const r = await fetch(`https://u1.filester.me/api/v1/file/${uuid}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => null);
  return j?.success ? (j.data?.url || null) : null;
}

async function fetchBuffer(url, referer) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Builds <title>.zip on disk from the album. Originals when a key is set, thumbnails otherwise.
async function grabFilester(target, title, html) {
  const m = FILESTER.exec(target);
  if (!m) return null;
  const items = filesterItems(html);
  if (!items.length) return { error: 'no-items' };

  const key = readFilmseterKey();
  const entries = [], failed = [];
  let originals = 0;

  for (const [i, it] of items.entries()) {
    const wantName = safeName(it.name) || `file-${i + 1}`;
    try {
      let url = key ? await filesterOriginal(it.uuid, key) : null;
      if (url) originals++;
      else url = `https://filester.me/t/${it.uuid}`;
      const buf = await fetchBuffer(url, target);
      if (!buf.length) throw new Error('empty');
      const ext = path.extname(wantName);
      const name = ext ? wantName : wantName + '.jpg';
      entries.push({ name, buf });
    } catch (e) {
      failed.push({ file: wantName, error: e.message });
    }
  }
  if (!entries.length) return { error: 'nothing fetched', failed };

  const zipName = `${safeName(title) || m[1]}.zip`;
  let out = path.join(DOWNLOADS, zipName);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(DOWNLOADS, `${path.basename(zipName, '.zip')} (${n}).zip`);
  fs.writeFileSync(out, buildZip(entries));

  console.log(`[grab] ${path.basename(out)}: ${entries.length} files (${originals} originals), ${failed.length} failed`);
  return { file: path.basename(out), url: '/api/zip?name=' + encodeURIComponent(path.basename(out)), count: entries.length, originals, failed };
}

// ---- generic page scraping (non-filester hosts) ----
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|mkv|mp3|m4a|wav|ogg|pdf|zip|rar|7z)$/i;
const abs = (u, base) => { try { return new URL(u, base).href; } catch { return null; } };

function extractMedia(html, pageUrl) {
  const out = new Set();
  const push = (raw) => {
    if (!raw) return;
    const a = abs(String(raw).replace(/&amp;/g, '&').trim(), pageUrl);
    if (a && /^https?:/i.test(a)) out.add(a);
  };
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url|:url)?|og:video(?::url)?|og:audio|twitter:image)["'][^>]*content=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/<(?:img|source|video|audio|picture)\b[^>]*>/gi)) {
    const tag = m[0];
    for (const attr of ['src', 'data-src', 'data-original', 'data-full', 'data-image', 'data-video', 'poster']) {
      const v = new RegExp(`\\b${attr}=["']([^"']+)["']`, 'i').exec(tag);
      if (v) push(v[1]);
    }
    const ss = /\bsrcset=["']([^"']+)["']/i.exec(tag);
    if (ss) for (const part of ss[1].split(',')) push(part.trim().split(/\s+/)[0]);
  }
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/location\.href\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  return [...out].filter((u) => { try { const p = new URL(u).pathname; return MEDIA_EXT.test(p) || /^\/d\/[A-Za-z0-9_-]+$/.test(p); } catch { return false; } });
}

function folderFor(title) {
  const base = safeName(title) || 'untitled';
  let dir = path.join(DOWNLOADS, base);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(DOWNLOADS, `${base} (${n})`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function saveOne(url, dir, pageUrl, index) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: pageUrl, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(90_000) });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const cd = r.headers.get('content-disposition') || '';
  let name = safeName((/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd) || [])[1]);
  if (!name) { try { name = safeName(decodeURIComponent(new URL(r.url || url).pathname.split('/').filter(Boolean).pop() || '')); } catch {} }
  if (!name) name = `file-${index}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += EXT_BY_TYPE[type] || '.bin';
  const ext = path.extname(name), stem = path.basename(name, ext);
  let dest = path.join(dir, name);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${stem} (${n})${ext}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  if (!fs.statSync(dest).size) { fs.unlinkSync(dest); throw new Error('empty'); }
  return path.basename(dest);
}

async function saveAll(urls, dir, pageUrl) {
  const saved = [], failed = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
    while (i < urls.length) {
      const idx = i++;
      try { saved.push(await saveOne(urls[idx], dir, pageUrl, idx)); }
      catch (e) { failed.push({ url: urls[idx], error: e.message }); }
    }
  }));
  return { saved, failed };
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
    if (u.pathname === '/') {
      // No-store so a stale copy of the page can never run against a newer server.
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
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
      return send(res, 200, { url: target, result, error, build: BUILD });
    }
    // Collects the destination page and packages it.
    if (u.pathname === '/api/grab') {
      const target = (u.searchParams.get('url') || '').trim();
      const title = u.searchParams.get('title') || '';
      if (!isUrl(target)) return send(res, 400, { error: 'url must be http(s)' });

      let page;
      try {
        page = await fetch(target, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
      } catch (e) {
        return send(res, 502, { error: 'page fetch failed: ' + (e.name === 'TimeoutError' ? 'timed out' : e.message) });
      }
      if (!page.ok) return send(res, 502, { error: `page HTTP ${page.status}` });
      const html = await page.text();

      // Album hosts get a real zip.
      const z = await grabFilester(page.url || target, title, html);
      if (z?.url) return send(res, 200, { zip: z.url, name: z.file, saved: [], failed: z.failed, found: z.count, originals: z.originals });

      // Anything else: save what the page references into a folder.
      const media = extractMedia(html, page.url || target).slice(0, MAX_FILES);
      if (!media.length) return send(res, 200, { folder: null, saved: [], failed: [], found: 0, error: z?.error ? `no-media (${z.error})` : 'no-media' });
      const dir = folderFor(title);
      const { saved, failed } = await saveAll(media, dir, page.url || target);
      if (!saved.length) { try { fs.rmdirSync(dir); } catch {} }
      console.log(`[grab] ${path.basename(dir)}: ${saved.length} saved, ${failed.length} failed of ${media.length}`);
      return send(res, 200, { folder: saved.length ? path.basename(dir) : null, saved, failed, found: media.length });
    }
    // Serves a built zip.
    if (u.pathname === '/api/zip') {
      const name = path.basename(u.searchParams.get('name') || '');
      const file = path.join(DOWNLOADS, name);
      if (!name || !fs.existsSync(file)) return send(res, 404, { error: 'no such zip' });
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'content-length': fs.statSync(file).size,
        'cache-control': 'no-store',
      });
      return fs.createReadStream(file).pipe(res);
    }
    // Opens a downloads folder in the file manager.
    if (u.pathname === '/api/reveal') {
      const name = path.basename(u.searchParams.get('folder') || '');
      const dir = name ? path.join(DOWNLOADS, name) : DOWNLOADS;
      if (!fs.existsSync(dir)) return send(res, 404, { error: 'no such folder' });
      exec(process.platform === 'win32' ? `explorer "${dir}"` : `open "${dir}"`);
      return send(res, 200, { ok: true, path: dir });
    }
    if (u.pathname === '/api/grab/debug') {
      const target = (u.searchParams.get('url') || '').trim();
      if (!isUrl(target)) return send(res, 400, { error: 'url must be http(s)' });
      const page = await fetch(target, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
      const html = await page.text();
      const items = filesterItems(html);
      const key = readFilmseterKey();
      const probe = items.slice(0, 2);
      const resolved = [];
      for (const p of probe) resolved.push({ uuid: p.uuid, name: p.name, url: key ? await filesterOriginal(p.uuid, key) : null });
      return send(res, 200, { build: BUILD, has_filester_key: !!key, items: items.length, sample: resolved });
    }
    // Diagnostics: key shape, and the raw upstream answers for both URL forms.
    if (u.pathname === '/api/bypass/debug') {
      const target = (u.searchParams.get('url') || '').trim();
      const info = keyInfo();
      if (!isUrl(target)) return send(res, 200, { info, build: BUILD, attempts: [] });
      const attempts = [];
      for (const candidate of [target, canonicalize(target)].filter((v, i, a) => v && a.indexOf(v) === i)) {
        const r = await callPremium(candidate, true);
        attempts.push({ url: candidate, status: r.status, body: String(r.raw || '').slice(0, 800), parsed_error: verdict(r).error });
      }
      return send(res, 200, { info, build: BUILD, attempts });
    }
    if (u.pathname === '/api/cache/clear') {
      const n = Object.keys(cache).length;
      cache = {};
      try { fs.writeFileSync(CACHE_FILE, '{}'); } catch {}
      return send(res, 200, { cleared: n });
    }
    if (u.pathname === '/api/download') {
      const target = (u.searchParams.get('url') || '').trim();
      const name = (u.searchParams.get('name') || '').trim();
      if (!isUrl(target)) return send(res, 400, { error: 'url must be http(s)' });
      if (isOwnPage(target)) return send(res, 400, { error: 'that is bypass.vip, not a file' });
      return sendDownload(res, target, name ? safeName(name) : null);
    }
    if (u.pathname === '/api/key') return send(res, 200, { ...keyInfo(), build: BUILD, has_filester_key: !!readFilmseterKey() });
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

// Streams one target to the browser as an attachment, under the given name or one from the URL.
async function sendDownload(res, target, forcedName) {
  let r;
  try {
    r = await fetch(target, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  } catch (e) {
    return send(res, 502, { error: 'fetch failed: ' + (e.name === 'TimeoutError' ? 'timed out' : e.message) });
  }
  if (!r.ok || !r.body) return send(res, 502, { error: `upstream HTTP ${r.status}` });

  const type = r.headers.get('content-type') || 'application/octet-stream';
  const cd = r.headers.get('content-disposition') || '';
  let name = forcedName || safeName((/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd) || [])[1]);
  if (!name) { try { name = safeName(decodeURIComponent(new URL(target).pathname.split('/').filter(Boolean).pop() || '')); } catch {} }
  if (!name) name = 'download';
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += EXT_BY_TYPE[(type || '').split(';')[0].trim().toLowerCase()] || '.bin';

  res.writeHead(200, {
    'content-type': type,
    'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
  });
  const stream = Readable.fromWeb(r.body);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

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
  console.log(`Scout scraper ${BUILD} running at ${APP_URL}  (close this window to stop it)`);
  const k = keyInfo();
  console.log(k.has_key ? `[bypass] key loaded: ${k.key_length} chars, starts ${k.key_prefix}${k.key_clean ? '' : ' (WARNING: unexpected characters)'}` : '[bypass] NO premium key — drop one in bypass-key.txt');
  console.log(readFilmseterKey() ? '[grab] filester key loaded — albums will zip at full size' : '[grab] no filester key — albums will zip thumbnails only (add filester-key.txt)');
  openBrowser();
});
