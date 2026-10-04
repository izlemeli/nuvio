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

function toMeta(t, r) {
  const title = t === 'tv' ? r.name || '' : r.title || '';
  const date = t === 'tv' ? r.first_air_date || '' : r.release_date || '';
  const m = { id: 'tmdb:' + r.id, type: t === 'tv' ? 'series' : 'movie', name: title, releaseInfo: date.slice(0, 4) };
  if (r.poster_path) m.poster = 'https://image.tmdb.org/t/p/w500' + r.poster_path;
  if (r.backdrop_path) m.background = 'https://image.tmdb.org/t/p/w1280' + r.backdrop_path;
  if (r.overview) m.description = r.overview;
  return m;
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
    items.push({ id, hint: cats.includes('Diziler') });
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
  for (let i = 0; i < max; i++) types.forEach((t, k) => { if (lists[k][i]) metas.push(toMeta(t, lists[k][i])); });
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

  const entries = new Map(cats.map((c) => [c, entriesOf(c)]));

  const jobs = [];
  for (const code of codes) for (const c of cats) for (const e of entries.get(c)) {
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

  jobs.forEach((j, i) => { j.metas = results[i]; });

  for (const code of codes) {
    const catalogs = [];
    const extra = [{ name: 'skip', isRequired: false }];
    if (izlDet) {
      const valid = izlItems.filter((i) => izlDet[code][i.id]).map((i) => izlDet[code][i.id]);
      const name = code === 'en' && String(izlCfg.title_en || '').trim() ? izlCfg.title_en : izlCfg.title || 'izlemeli.com önerileri';
      const groups = mix === 'split'
        ? [{ id: 'nvk-izl-m', type: 'movie', list: valid.filter((d) => d.t === 'movie') },
           { id: 'nvk-izl-s', type: 'series', list: valid.filter((d) => d.t === 'tv') }]
        : [{ id: 'nvk-izl', type: 'movie', list: valid }];
      for (const g of groups) {
        if (!g.list.length) continue;
        catalogs.push({ type: g.type, id: g.id, name, extra });
        const PER = 100;
        const nPages = Math.ceil(g.list.length / PER);
        for (let k = 0; k < nPages; k++) {
          const metas = g.list.slice(k * PER, (k + 1) * PER).map((d) => toMeta(d.t, d.r));
          if (k === 0) await emit(code, `catalog/${g.type}/${g.id}.json`, { metas });
          await emit(code, `catalog/${g.type}/${g.id}/skip=${k * PER}.json`, { metas });
        }
        await emit(code, `catalog/${g.type}/${g.id}/skip=${nPages * PER}.json`, { metas: [] });
      }
    }
    for (const c of cats) {
      const title = code === 'tr' || !String(c.title_en || '').trim() ? c.title : c.title_en;
      for (const e of entries.get(c)) {
        catalogs.push({ type: e.type, id: e.id, name: title, extra });
        const per = 20 * e.types.length;
        const mine = jobs.filter((j) => j.code === code && j.c === c && j.e === e);
        for (const j of mine) {
          const skip = (j.p - 1) * per;
          if (j.p === 1) await emit(code, `catalog/${e.type}/${e.id}.json`, { metas: j.metas });
          await emit(code, `catalog/${e.type}/${e.id}/skip=${skip}.json`, { metas: j.metas });
        }
        await emit(code, `catalog/${e.type}/${e.id}/skip=${pages * per}.json`, { metas: [] });
      }
    }
    await emit(code, 'manifest.json', {
      id: 'com.izlemeli.nuvio.catalogs.' + code,
      version: '1.0.' + ver,
      name: cfg.name || 'İzlemeli Katalog',
      description: code === 'tr' ? 'TMDB tabanlı özel kataloglar' : 'Custom TMDB catalogs',
      resources: ['catalog'],
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
