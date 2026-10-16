import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const LANGS = { tr: 'tr-TR', en: 'en-US' };
const TV_MAP = { 28: 10759, 12: 10759, 14: 10765, 878: 10765, 10752: 10768, 16: 16, 35: 35, 80: 80, 99: 99, 18: 18, 10751: 10751, 9648: 9648, 37: 37 };
const OUT = 'dist';
const TMDB = (process.env.TMDB_BASE || 'https://api.themoviedb.org/3').replace(/\/$/, '');
const KEY = (process.env.TMDB_KEY || '').trim();
const IZL_URL = (process.env.IZL_URL || '').trim();
const UA = 'nuvio-katalog-build/1.0';
const CONCURRENCY = 8;
const TYPES_FILE = '.cache/izl-types.json';
const IMDB_FILE = '.cache/imdb.json';
const CHECK_FILE = '.cache/poster-check.json';
const IMDB_RETRY_MS = 7 * 24 * 3600 * 1000;
const CHECK_OK_MS = 30 * 24 * 3600 * 1000;
const CHECK_FAIL_MS = 7 * 24 * 3600 * 1000;
const IMDB_CONCURRENCY = 8;
const IMDB_GAP_MS = 30;
const CHECK_CONCURRENCY = 3;
const CHECK_GAP_MS = 100;
const CHECK_TIMEOUT_MS = 15000;
const BREAKER = 15;
const POSTER_MODES = ['izl', 'cats', 'all'];

// ── "Sende Gönder" tanıtım kartı (izlemeli.com önerileri listesinin hep ilk sırası) ──
// Görseller repodaki screenshots/ klasöründen okunur; dosyaları elle ekle.
const PROMO_ID = 'izlemeli-sende-gonder';
const PROMO_IMG = 'https://raw.githubusercontent.com/izlemeli/nuvio/refs/heads/main/screenshots/';
const PROMO_UTM = (lang) => `utm_source=nuvio&utm_medium=addon&utm_campaign=sende-gonder&utm_content=${lang}`;
const PROMO = {
  tr: {
    name: 'Sende Gönder',
    releaseInfo: 'izlemeli.com',
    description: 'Sende mutlaka izlenmeli dediğin film ve dizileri ya da bu listede olmalı dediğin yapımları izlemeli.com\'a girip topluluğumuzla paylaş! Sinefiller arasında popülerliğini artır. Önerdiğin içerikler listede görünsün.\n\nİzlemeli.com, “Bugün ne izlemeli?” sorusuna en net cevabı veren platformdur. Burada, özenle seçilmiş güncel film ve dizi önerileri sunulur.',
    url: 'https://www.izlemeli.com/',
    poster: 'sende-gonder-poster-tr.jpg',
    background: 'sende-gonder-background-tr.jpg',
    link: 'İzlemeli.com\'a git',
  },
  en: {
    name: 'Send Yours',
    releaseInfo: 'izlemeli.com',
    description: 'Share the movies and series you think are a must-watch, or any titles that deserve a spot on this list, with our community on izlemeli.com! Boost your popularity among cinephiles. The titles you recommend will appear on the list.\n\nİzlemeli.com is the platform that gives the clearest answer to “What should I watch today?” Here you\'ll find carefully selected, up-to-date movie and series recommendations.',
    url: 'https://www.izlemeli.com/',
    poster: 'sende-gonder-poster-en.jpg',
    background: 'sende-gonder-background-en.jpg',
    link: 'Go to İzlemeli.com',
  },
};

function promoUrl(code) {
  const p = PROMO[code] || PROMO.tr;
  return p.url + (p.url.includes('?') ? '&' : '?') + PROMO_UTM(code);
}

function promoMeta(code, type) {
  const p = PROMO[code] || PROMO.tr;
  const url = promoUrl(code);
  return {
    id: PROMO_ID,
    type,
    name: p.name,
    releaseInfo: p.releaseInfo,
    poster: PROMO_IMG + p.poster,
    background: PROMO_IMG + p.background,
    description: p.description,
    website: url,
    links: [{ name: p.link, category: 'website', url }],
  };
}

const fail = (m) => { console.error('✗ ' + m); process.exit(1); };

async function loadConfig() {
  if (process.env.CONFIG_FILE) return JSON.parse(await readFile(process.env.CONFIG_FILE, 'utf8'));
  const url = (process.env.CONFIG_URL || '').trim();
  if (!url) fail('CONFIG_URL secret tanımlı değil (Settings → Secrets and variables → Actions → Secrets).');
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) fail(`Ayar dosyası alınamadı: HTTP ${r.status}. Sunucu/WAF GitHub IP'lerini engelliyor olabilir.`);
  return await r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdb(p, params, { allow404 = false } = {}) {
  const q = { ...params };
  const headers = { Accept: 'application/json' };
  if (KEY.length > 40) headers.Authorization = 'Bearer ' + KEY; else q.api_key = KEY;
  const url = `${TMDB}${p}?${new URLSearchParams(q)}`;
  let last = '';
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return await r.json();
      if (r.status === 404 && allow404) return null;
      last = 'HTTP ' + r.status;
      if (r.status === 401) throw new Error('TMDB anahtarı reddedildi (401).');
      if (r.status === 429) await sleep((Number(r.headers.get('retry-after')) || 2) * 1000);
    } catch (e) {
      if (String(e.message).includes('401')) throw e;
      last = e.message;
    }
    await sleep(500 * (i + 1));
  }
  throw new Error(`TMDB isteği başarısız (${last}): ${p}`);
}

async function pool(tasks, n) {
  const res = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) { const k = i++; res[k] = await tasks[k](); }
  }));
  return res;
}

function tvGenres(v) {
  const parts = String(v ?? '').split(/([,|])/);
  let sep = ',';
  const ids = new Set();
  for (const p of parts) {
    if (p === ',' || p === '|') { sep = p; continue; }
    const n = parseInt(p, 10);
    if (n && TV_MAP[n]) ids.add(TV_MAP[n]);
  }
  return ids.size ? [...ids].join(sep) : null;
}

function typesFor(c) {
  let t = c.content === 'movie' ? ['movie'] : c.content === 'tv' ? ['tv'] : ['movie', 'tv'];
  if (c.kind === 'genre' && t.includes('tv') && tvGenres(c.value) === null) t = t.filter((x) => x !== 'tv');
  return t.length ? t : ['movie'];
}

function discoverParams(t, c, page, lang) {
  let sort = c.sort || 'popularity.desc';
  if (t === 'tv') sort = sort.replace('primary_release_date', 'first_air_date');
  const p = { language: lang, include_adult: 'false', page: String(page), sort_by: sort };
  let min = parseInt(c.minv, 10) || 0;
  if (min <= 0) {
    if (sort.startsWith('vote_average')) min = 300;
    else if (sort.includes('_date')) min = 20;
  }
  if (min > 0) p['vote_count.gte'] = String(min);
  if (sort.includes('_date.desc')) p[t === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte'] = new Date().toISOString().slice(0, 10);
  if (c.kind === 'genre') {
    const g = t === 'tv' ? tvGenres(c.value) : c.value;
    if (g) p.with_genres = String(g);
  }
  if (c.kind === 'kw' && c.value !== '' && c.value != null) p.with_keywords = String(c.value);
  const extra = String(c.extra ?? '').trim();
  if (extra) {
    for (const pair of extra.replace(/^[?&]+/, '').split('&')) {
      const i = pair.indexOf('=');
      if (i > 0) p[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  return p;
}

function toMeta(t, r, poster) {
  const title = t === 'tv' ? r.name || '' : r.title || '';
  const date = t === 'tv' ? r.first_air_date || '' : r.release_date || '';
  const m = { id: 'tmdb:' + r.id, type: t === 'tv' ? 'series' : 'movie', name: title, releaseInfo: date.slice(0, 4) };
  if (poster) m.poster = poster;
  else if (r.poster_path) m.poster = 'https://image.tmdb.org/t/p/w500' + r.poster_path;
  if (r.backdrop_path) m.background = 'https://image.tmdb.org/t/p/w1280' + r.backdrop_path;
  if (r.overview) m.description = r.overview;
  return m;
}

function cleanImdb(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (/^tt\d{5,}$/.test(s)) return s;
  if (/^\d{5,}$/.test(s)) return 'tt' + s;
  return null;
}

function posterConfig(cfg) {
  const p = cfg && cfg.poster && typeof cfg.poster === 'object' ? cfg.poster : null;
  if (!p || !POSTER_MODES.includes(p.mode)) return null;
  const tpl = (v) => {
    const s = String(v ?? '').trim();
    return /^https?:\/\//i.test(s) && s.includes('{imdb_id}') ? s : null;
  };
  const pat = { tr: tpl(p.tr), en: tpl(p.en) };
  if (!pat.tr && !pat.en) return null;
  return { mode: p.mode, pat, verify: p.verify === 1 || p.verify === true || p.verify === '1' };
}

let paceAt = 0;
async function pace(gap) {
  const now = Date.now();
  const at = Math.max(now, paceAt);
  paceAt = at + gap;
  if (at > now) await sleep(at - now);
}

async function readJson(file) {
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

async function lookupImdb(need, warns) {
  const cache = await readJson(IMDB_FILE);
  const now = Date.now();
  const found = new Map();
  const todo = [];
  for (const [k, v] of need) {
    const e = cache[k];
    const hit = typeof e === 'string' ? cleanImdb(e) : null;
    if (hit) found.set(k, hit);
    else if (e && typeof e === 'object' && now - Date.parse(e.miss) < IMDB_RETRY_MS) continue;
    else todo.push([k, v]);
  }
  let changed = false;
  let streak = 0;
  let stopped = false;
  await pool(todo.map(([k, v]) => async () => {
    if (streak >= BREAKER) {
      if (!stopped) { stopped = true; warns.push(`IMDb sorguları art arda ${BREAKER} kez başarısız; kalanlar atlandı, bu içerikler TMDB posteriyle kalır.`); }
      return;
    }
    try {
      await pace(IMDB_GAP_MS);
      const r = await tmdb(`/${v.t}/${v.id}/external_ids`, {}, { allow404: true });
      const imdb = r ? cleanImdb(r.imdb_id) : null;
      if (imdb) { cache[k] = imdb; found.set(k, imdb); }
      else cache[k] = { miss: new Date().toISOString().slice(0, 10) };
      changed = true;
      streak = 0;
    } catch (e) {
      streak++;
      warns.push(`IMDb ${k}: ${e.message}`);
    }
  }), IMDB_CONCURRENCY);
  if (changed) {
    try {
      await mkdir(path.dirname(IMDB_FILE), { recursive: true });
      await writeFile(IMDB_FILE, JSON.stringify(cache));
    } catch (e) { warns.push('IMDb önbelleği yazılamadı: ' + e.message); }
  }
  return { found, asked: todo.length, cached: need.size - todo.length };
}

async function probePoster(url) {
  for (const method of ['HEAD', 'GET']) {
    let r;
    try {
      const headers = { 'User-Agent': UA, Accept: 'image/*' };
      if (method === 'GET') headers.Range = 'bytes=0-0';
      r = await fetch(url, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    } catch (e) { return { err: e.message }; }
    if (method === 'GET') { try { await r.body.cancel(); } catch { } }
    if (r.ok) {
      const ct = String(r.headers.get('content-type') || '');
      return { ok: !ct || /^image\//i.test(ct) };
    }
    if (method === 'HEAD' && (r.status === 405 || r.status === 501)) continue;
    if (r.status === 429 || r.status >= 500) return { err: 'HTTP ' + r.status };
    return { ok: false };
  }
  return { ok: false };
}

async function posterHealthy(urls) {
  for (const u of urls.slice(0, 3)) {
    const r = await probePoster(u);
    if (!r.err) return true;
  }
  return false;
}

async function verifyPosters(urls, warns) {
  const cache = await readJson(CHECK_FILE);
  const now = Date.now();
  const okSet = new Set();
  const todo = [];
  for (const u of urls) {
    const e = cache[u];
    const ttl = e && e.ok ? CHECK_OK_MS : CHECK_FAIL_MS;
    if (e && typeof e.t === 'number' && now - e.t < ttl) { if (e.ok) okSet.add(u); }
    else todo.push(u);
  }
  let changed = false;
  let streak = 0;
  let stopped = false;
  await pool(todo.map((u) => async () => {
    if (streak >= BREAKER) {
      if (!stopped) { stopped = true; warns.push(`Poster doğrulaması art arda ${BREAKER} kez ulaşılamadı; kalanlar atlandı, bu içerikler TMDB posteriyle kalır.`); }
      return;
    }
    await pace(CHECK_GAP_MS);
    const res = await probePoster(u);
    if (res.err) { streak++; warns.push(`Poster doğrulama ${u}: ${res.err}`); return; }
    streak = 0;
    cache[u] = { ok: res.ok, t: Date.now() };
    changed = true;
    if (res.ok) okSet.add(u);
  }), CHECK_CONCURRENCY);
  const keep = {};
  for (const [u, e] of Object.entries(cache)) {
    if (e && typeof e.t === 'number' && now - e.t < (e.ok ? CHECK_OK_MS : CHECK_FAIL_MS)) keep[u] = e;
  }
  if (changed) {
    try {
      await mkdir(path.dirname(CHECK_FILE), { recursive: true });
      await writeFile(CHECK_FILE, JSON.stringify(keep));
    } catch (e) { warns.push('Poster doğrulama önbelleği yazılamadı: ' + e.message); }
  }
  return { okSet, asked: todo.length, cached: urls.size - todo.length };
}

async function preparePosters(pc, jobs, izlItems, izlDet, codes, warns) {
  const active = codes.filter((c) => pc.pat[c]);
  const catOn = (j) => pc.mode === 'all' || (pc.mode === 'cats' && !!j.c.poster);
  const izlOn = pc.mode === 'izl' || pc.mode === 'all';
  const url = (code, imdb) => pc.pat[code].split('{imdb_id}').join(imdb);

  const need = new Map();
  for (const j of jobs) {
    if (!active.includes(j.code) || !catOn(j) || !j.items) continue;
    for (const x of j.items) need.set(x.t + ':' + x.r.id, { t: x.t, id: x.r.id });
  }
  const imdb = need.size ? await lookupImdb(need, warns) : { found: new Map(), asked: 0, cached: 0 };

  const candBy = {};
  for (const c of active) candBy[c] = new Set();
  if (izlOn && izlDet) {
    for (const i of izlItems) if (i.imdb) for (const c of active) if (izlDet[c][i.id]) candBy[c].add(url(c, i.imdb));
  }
  for (const j of jobs) {
    if (!active.includes(j.code) || !catOn(j) || !j.items) continue;
    for (const x of j.items) {
      const im = imdb.found.get(x.t + ':' + x.r.id);
      if (im) candBy[j.code].add(url(j.code, im));
    }
  }
  const down = new Set();
  for (const c of active) {
    if (candBy[c].size && !(await posterHealthy([...candBy[c]]))) {
      down.add(c);
      candBy[c].clear();
      warns.push(`Poster servisine ulaşılamadı (${c}); bu dilde tüm içerikler TMDB posteriyle yazıldı.`);
    }
  }
  const cand = new Set();
  for (const c of active) for (const u of candBy[c]) cand.add(u);
  let ver = null;
  if (pc.verify && cand.size) ver = await verifyPosters(cand, warns);

  const pick = (code, im) => {
    if (!im || !pc.pat[code] || down.has(code)) return null;
    const u = url(code, im);
    return !pc.verify || (ver && ver.okSet.has(u)) ? u : null;
  };
  console.log(`Poster: mod=${pc.mode} · diller=${active.join(',')} · IMDb sorgusu=${imdb.asked} (önbellekten=${imdb.cached}) · aday adres=${cand.size}` + (ver ? ` · doğrulama sorgusu=${ver.asked} (önbellekten=${ver.cached}), geçen=${ver.okSet.size}` : ''));
  return {
    izl: (code, d) => (izlOn ? pick(code, d.imdb) : null),
    cat: (code, j, x) => (catOn(j) ? pick(code, imdb.found.get(x.t + ':' + x.r.id)) : null),
  };
}

async function loadIzlItems(izl) {
  const r = await fetch(IZL_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) fail(`Öneri listesi alınamadı: HTTP ${r.status}. WAF/güvenlik duvarını kontrol et.`);
  let j;
  try { j = await r.json(); } catch { fail('Öneri listesi geçersiz JSON.'); }
  if (!Array.isArray(j.icerikler)) fail("Öneri listesinde 'icerikler' yok.");
  const seen = new Set();
  const items = [];
  for (const x of j.icerikler) {
    const id = String(x.tmdb_id ?? '').replace(/\D/g, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const cats = String(x.taksonomi_category ?? '').split(',').map((c) => c.trim());
    items.push({ id, hint: cats.includes('Diziler'), imdb: cleanImdb(x.imdb_id) });
  }
  return izl.sort === 'site' ? items : items.reverse();
}

async function resolveIzl(items, codes, errors) {
  let types = {};
  try { types = JSON.parse(await readFile(TYPES_FILE, 'utf8')); } catch { }
  const det = {};
  codes.forEach((c) => { det[c] = {}; });
  const first = codes[0];

  await pool(items.filter((i) => !types[i.id]).map((i) => async () => {
    try {
      const [m, t] = await Promise.all(['movie', 'tv'].map((x) => tmdb(`/${x}/${i.id}`, { language: LANGS[first] }, { allow404: true })));
      const pick = m && t ? (i.hint ? 'tv' : 'movie') : m ? 'movie' : t ? 'tv' : null;
      if (!pick) return;
      types[i.id] = pick;
      det[first][i.id] = { t: pick, r: pick === 'movie' ? m : t };
    } catch (e) { errors.push(`izlemeli ${i.id}: ${e.message}`); }
  }), CONCURRENCY);

  for (const code of codes) {
    await pool(items.filter((i) => types[i.id] && !det[code][i.id]).map((i) => async () => {
      try {
        const r = await tmdb(`/${types[i.id]}/${i.id}`, { language: LANGS[code] }, { allow404: true });
        if (r) det[code][i.id] = { t: types[i.id], r };
      } catch (e) { errors.push(`izlemeli ${code}/${i.id}: ${e.message}`); }
    }), CONCURRENCY);
  }
  await mkdir(path.dirname(TYPES_FILE), { recursive: true });
  await writeFile(TYPES_FILE, JSON.stringify(types));
  return det;
}

async function fetchPage(types, cat, page, lang) {
  const res = await Promise.all(types.map((t) => tmdb('/discover/' + t, discoverParams(t, cat, page, lang))));
  const lists = res.map((r) => r.results || []);
  const max = Math.max(...lists.map((l) => l.length));
  const metas = [];
  for (let i = 0; i < max; i++) types.forEach((t, k) => { if (lists[k][i]) metas.push({ t, r: lists[k][i] }); });
  return metas;
}

async function main() {
  if (!KEY && !process.env.CONFIG_FILE_NO_KEY) fail('TMDB_KEY secret tanımlı değil.');
  const cfg = await loadConfig();
  if (!cfg || !Array.isArray(cfg.categories)) fail('config.json geçersiz (categories yok).');

  const mix = cfg.mix === 'split' ? 'split' : 'single';
  const pages = Math.min(20, Math.max(1, parseInt(cfg.pages, 10) || 5));
  const ver = parseInt(cfg.ver, 10) || 1;
  const defCode = String(cfg.default_lang || 'tr-TR').slice(0, 2).toLowerCase();
  const codes = (Array.isArray(cfg.langs) && cfg.langs.length ? cfg.langs : Object.keys(LANGS)).filter((c) => LANGS[c]);
  const defaultCode = codes.includes(defCode) ? defCode : codes[0];

  const cats = [...cfg.categories.filter((c) => c.pin), ...cfg.categories.filter((c) => !c.pin)]
    .filter((c) => c.id && !(c.kind === 'kw' && !c.value));
  if (!cats.length) fail('Aktif kategori yok.');

  const entriesOf = (c) => {
    const types = typesFor(c);
    if (types.length === 2 && mix === 'split') {
      return [
        { type: 'movie', id: `nvk-${c.id}-m`, types: ['movie'] },
        { type: 'series', id: `nvk-${c.id}-t`, types: ['tv'] },
      ];
    }
    return [{ type: types[0] === 'tv' && types.length === 1 ? 'series' : 'movie', id: `nvk-${c.id}`, types }];
  };

  // Kategoride 'langs' varsa yalnızca o dil(ler)in katalogunda yer alır (örn. ["tr"]).
  const inLang = (c, code) => !Array.isArray(c.langs) || !c.langs.length || c.langs.includes(code);

  const entries = new Map(cats.map((c) => [c, entriesOf(c)]));

  const jobs = [];
  for (const code of codes) for (const c of cats) for (const e of entries.get(c)) {
    if (!inLang(c, code)) continue;
    for (let p = 1; p <= pages; p++) jobs.push({ code, c, e, p });
  }
  console.log(`Kategori: ${cats.length} · dil: ${codes.join(',')} · sayfa: ${pages} · sayfa işi: ${jobs.length}`);

  const errors = [];
  const results = await pool(jobs.map((j) => async () => {
    try { return await fetchPage(j.e.types, j.c, j.p, LANGS[j.code]); }
    catch (err) { errors.push(`${j.code}/${j.e.id}/p${j.p}: ${err.message}`); return null; }
  }), CONCURRENCY);

  const izlCfg = cfg.izlemeli && cfg.izlemeli.on ? cfg.izlemeli : null;
  if (izlCfg && !IZL_URL) fail('IZL_URL secret tanımlı değil.');
  let izlDet = null;
  let izlItems = [];
  if (izlCfg) {
    izlItems = await loadIzlItems(izlCfg);
    console.log(`İzlemeli önerileri: ${izlItems.length} TMDB ID`);
    if (izlItems.length) izlDet = await resolveIzl(izlItems, codes, errors);
  }

  if (errors.length) {
    console.error(errors.slice(0, 15).join('\n'));
    fail(`${errors.length} istek başarısız; mevcut yayın korunuyor.`);
  }

  jobs.forEach((j, i) => { j.items = results[i]; });
  const pc = posterConfig(cfg);
  const warns = [];
  const posters = pc ? await preparePosters(pc, jobs, izlItems, izlDet, codes, warns) : null;
  if (warns.length) {
    console.warn(`! ${warns.length} poster uyarısı (üretim sürüyor):`);
    console.warn(warns.slice(0, 10).join('\n'));
  }

  await rm(OUT, { recursive: true, force: true });
  let fileCount = 0;
  const put = async (rel, data) => {
    const f = path.join(OUT, rel);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, typeof data === 'string' ? data : JSON.stringify(data));
    fileCount++;
  };
  const emit = async (code, rel, data) => {
    await put(`${code}/${rel}`, data);
    if (code === defaultCode) await put(rel, data);
  };

  for (const code of codes) {
    const catalogs = [];
    const extra = [{ name: 'skip', isRequired: false }];
    if (izlDet) {
      const valid = izlItems.filter((i) => izlDet[code][i.id]).map((i) => ({ ...izlDet[code][i.id], imdb: i.imdb }));
      const name = code === 'en' && String(izlCfg.title_en || '').trim() ? izlCfg.title_en : izlCfg.title || 'izlemeli.com önerileri';
      const groups = mix === 'split'
        ? [{ id: 'nvk-izl-m', type: 'movie', list: valid.filter((d) => d.t === 'movie') },
           { id: 'nvk-izl-s', type: 'series', list: valid.filter((d) => d.t === 'tv') }]
        : [{ id: 'nvk-izl', type: 'movie', list: valid }];
      for (const g of groups) {
        if (!g.list.length) continue;
        catalogs.push({ type: g.type, id: g.id, name, extra });
        const PER = 100;
        // Tanıtım kartı her zaman listenin başında; sayfalama bunu da kapsar.
        const all = [promoMeta(code, g.type), ...g.list.map((d) => toMeta(d.t, d.r, posters ? posters.izl(code, d) : null))];
        const nPages = Math.ceil(all.length / PER);
        for (let k = 0; k < nPages; k++) {
          const metas = all.slice(k * PER, (k + 1) * PER);
          if (k === 0) await emit(code, `catalog/${g.type}/${g.id}.json`, { metas });
          await emit(code, `catalog/${g.type}/${g.id}/skip=${k * PER}.json`, { metas });
        }
        await emit(code, `catalog/${g.type}/${g.id}/skip=${nPages * PER}.json`, { metas: [] });
      }
    }
    for (const c of cats) {
      if (!inLang(c, code)) continue;
      const title = code === 'tr' || !String(c.title_en || '').trim() ? c.title : c.title_en;
      for (const e of entries.get(c)) {
        catalogs.push({ type: e.type, id: e.id, name: title, extra });
        const per = 20 * e.types.length;
        const mine = jobs.filter((j) => j.code === code && j.c === c && j.e === e);
        for (const j of mine) {
          const skip = (j.p - 1) * per;
          const metas = j.items.map((x) => toMeta(x.t, x.r, posters ? posters.cat(code, j, x) : null));
          if (j.p === 1) await emit(code, `catalog/${e.type}/${e.id}.json`, { metas });
          await emit(code, `catalog/${e.type}/${e.id}/skip=${skip}.json`, { metas });
        }
        await emit(code, `catalog/${e.type}/${e.id}/skip=${pages * per}.json`, { metas: [] });
      }
    }
    const promoOn = catalogs.some((c) => c.id.startsWith('nvk-izl'));
    if (promoOn) {
      const p = PROMO[code] || PROMO.tr;
      const url = promoUrl(code);
      for (const type of ['movie', 'series']) {
        await emit(code, `meta/${type}/${PROMO_ID}.json`, { meta: promoMeta(code, type) });
        await emit(code, `stream/${type}/${PROMO_ID}.json`, { streams: [{ name: 'izlemeli.com', title: p.link, externalUrl: url }] });
      }
    }
    await emit(code, 'manifest.json', {
      id: 'com.izlemeli.nuvio.catalogs.' + code,
      version: '1.0.' + ver,
      name: cfg.name || 'İzlemeli Katalog',
      description: code === 'tr' ? 'TMDB tabanlı özel kataloglar' : 'Custom TMDB catalogs',
      resources: promoOn
        ? ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['izlemeli-'] }, { name: 'stream', types: ['movie', 'series'], idPrefixes: ['izlemeli-'] }]
        : ['catalog'],
      types: ['movie', 'series'],
      catalogs,
      behaviorHints: { configurable: false, adult: false, p2p: false },
    });
  }

  await put('status.json', { built_at: new Date().toISOString(), config_ver: ver, categories: cats.length, izlemeli: izlItems.length, langs: codes, pages, files: fileCount });
  await put('.nojekyll', '');
  await put('index.html', landing(cfg.name || 'İzlemeli Katalog', codes, defaultCode));
  console.log(`✓ ${fileCount} dosya üretildi → ${OUT}/`);
}

function landing(name, codes, def) {
  const names = { tr: 'Türkçe', en: 'English' };
  const rows = codes.map((c) => `<li><b>${names[c] || c}</b> <code data-p="${c}/manifest.json"></code> <button data-p="${c}/manifest.json">Kopyala</button></li>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title>
<style>body{font:16px system-ui;max-width:720px;margin:40px auto;padding:0 16px}code{background:#eee;padding:2px 6px;border-radius:4px;word-break:break-all}li{margin:12px 0}</style>
<h1>${name}</h1><p>Nuvio → Eklentiler → URL ekle alanına aşağıdaki adreslerden birini yapıştır.</p><ul>${rows}</ul>
<p>Varsayılan dil (${names[def] || def}): <code data-p="manifest.json"></code> <button data-p="manifest.json">Kopyala</button></p>
<p id="s"></p>
<script>
const u=p=>new URL(p,location.href).href;
document.querySelectorAll('code[data-p]').forEach(e=>e.textContent=u(e.dataset.p));
document.querySelectorAll('button').forEach(b=>b.onclick=()=>{navigator.clipboard.writeText(u(b.dataset.p));b.textContent='Kopyalandı'});
fetch('status.json').then(r=>r.json()).then(s=>document.getElementById('s').textContent='Son üretim: '+new Date(s.built_at).toLocaleString('tr-TR')+' · '+s.categories+' kategori');
</script>`;
}

main().catch((e) => fail(e.message));
