'use strict';
/* Daftar ICE (STUN + TURN) untuk siaran gameplay Room Master.
   STUN saja hanya tembus sebagian jaringan. Agar video bisa sampai ke Master di SEMUA jaringan (4G/CGNAT, wifi sekolah/kantor,
   NAT simetris) harus ada relay TURN. Penyedia dicoba berurutan; bila satu gagal / tidak memberi relay, lanjut ke berikutnya:
     1. Metered.ca               : METERED_DOMAIN (mis. namaapp.metered.live) + METERED_API_KEY
     2. Cloudflare Realtime TURN : CF_TURN_KEY_ID + CF_TURN_API_TOKEN
     3. coturn sendiri (rahasia bersama) : TURN_URLS (pisah koma) + TURN_SECRET
     4. TURN statis              : TURN_URLS (pisah koma) + TURN_USERNAME + TURN_CREDENTIAL
   Tanpa salah satunya → hanya STUN (relay: false) dan klien memberi tahu bahwa TURN belum diatur. */
const crypto = require('crypto');

const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
const TTL_S = 86400;              // masa berlaku kredensial TURN (Cloudflare / coturn)
const CACHE_MS = 30 * 60 * 1000;  // kredensial dipakai ulang agar tidak memanggil penyedia tiap permintaan
const FAIL_CACHE_MS = 20 * 1000;
const FETCH_MS = 4000;            // batas waktu panggilan ke penyedia (fungsi Vercel hanya 10 dtk)
const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
let cache = null;

const urlsOf = s => [].concat((s && s.urls) || (s && s.url) || []);
function hasRelay(servers) {
  return servers.some(s => urlsOf(s).some(u => /^turns?:/i.test(u)));
}
/* Ambil hanya entri yang valid; buang port 53 (browser memblokirnya & memperlambat pengumpulan kandidat). */
function clean(servers) {
  return (Array.isArray(servers) ? servers : []).map(s => {
    const urls = urlsOf(s).filter(u => typeof u === 'string' && !/:53(\?|$)/.test(u));
    const o = { urls };
    if (s.username) o.username = s.username;
    if (s.credential) o.credential = s.credential;
    return o;
  }).filter(s => s.urls.length);
}
async function fetchJson(fetchFn, url, opts) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ac && setTimeout(() => ac.abort(), FETCH_MS);
  try { return await fetchFn(url, Object.assign({}, opts, ac ? { signal: ac.signal } : {})); }
  finally { if (t) clearTimeout(t); }
}

const PROVIDERS = [
  { name: 'Metered', on: e => e.METERED_DOMAIN && e.METERED_API_KEY, async get(env, fetchFn) {
    const host = String(env.METERED_DOMAIN).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const r = await fetchJson(fetchFn, 'https://' + host + '/api/v1/turn/credentials?apiKey=' + encodeURIComponent(String(env.METERED_API_KEY).trim()));
    if (!r.ok) throw new Error('Metered TURN ' + r.status);
    return clean(await r.json());
  } },
  { name: 'Cloudflare', on: e => e.CF_TURN_KEY_ID && e.CF_TURN_API_TOKEN, async get(env, fetchFn) {
    const r = await fetchJson(fetchFn, 'https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(env.CF_TURN_KEY_ID) + '/credentials/generate-ice-servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.CF_TURN_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_S })
    });
    if (!r.ok) throw new Error('Cloudflare TURN ' + r.status);
    return clean((await r.json()).iceServers);
  } },
  { name: 'coturn', on: e => list(e.TURN_URLS).length && e.TURN_SECRET, async get(env) {
    const username = (Math.floor(Date.now() / 1000) + TTL_S) + ':th3d';
    const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    return [{ urls: list(env.TURN_URLS), username, credential }];
  } },
  { name: 'statis', on: e => list(e.TURN_URLS).length && e.TURN_USERNAME && e.TURN_CREDENTIAL, async get(env) {
    return [{ urls: list(env.TURN_URLS), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }];
  } }
];

async function fromProviders(env, fetchFn) {
  let lastErr = null;
  for (const p of PROVIDERS) {
    if (!p.on(env)) continue;
    try {
      const servers = await p.get(env, fetchFn);
      if (hasRelay(servers)) return { servers, provider: p.name };
      lastErr = new Error(p.name + ' tidak memberi server TURN');
    } catch (e) { lastErr = e; }
    console.error('ICE:', lastErr.message);
  }
  if (lastErr) throw lastErr;
  return { servers: [], provider: null };
}

async function getIceServers(env = process.env, fetchFn = globalThis.fetch) {
  if (cache && cache.until > Date.now()) return cache.value;
  let turn = [], ttl = CACHE_MS;
  try { turn = (await fromProviders(env, fetchFn)).servers; }
  catch (e) { ttl = FAIL_CACHE_MS; }
  const iceServers = [STUN].concat(turn);
  const value = { iceServers, relay: hasRelay(iceServers) };
  cache = { value, until: Date.now() + ttl };
  return value;
}
function _resetForTests() { cache = null; }
module.exports = { getIceServers, hasRelay, _resetForTests };
