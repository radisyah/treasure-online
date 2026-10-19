'use strict';
/* Penyimpanan room. Produksi (Vercel): Upstash Redis lewat REST (tanpa dependensi npm).
   Lokal: memori proses (hanya untuk pengembangan/tes; TIDAK andal di Vercel karena tiap request bisa di instance berbeda). */

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

function restStore(cfg) {
  const call = async (path, body) => {
    const r = await fetch(cfg.url + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('Redis ' + r.status);
    return r.json();
  };
  return {
    kind: 'redis',
    async cmd(args) { const j = await call('', args); if (j.error) throw new Error(j.error); return j.result; },
    async pipeline(cmds) {
      const arr = await call('/pipeline', cmds);
      return arr.map(x => { if (x.error) throw new Error(x.error); return x.result; });
    }
  };
}

function memoryStore() {
  const m = new Map();
  const alive = k => { const e = m.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { m.delete(k); return null; } return e; };
  const run = args => {
    const op = String(args[0]).toUpperCase(), k = args[1];
    if (op === 'GET') { const e = alive(k); return e ? e.v : null; }
    if (op === 'MGET') return args.slice(1).map(k => { const e = alive(k); return e ? e.v : null; });
    if (op === 'EXISTS') return alive(k) ? 1 : 0;
    if (op === 'DEL') { const had = !!alive(k); m.delete(k); return had ? 1 : 0; }
    if (op === 'SET') {
      let nx = false, exp = 0;
      for (let i = 3; i < args.length; i++) {
        const o = String(args[i]).toUpperCase();
        if (o === 'NX') nx = true;
        else if (o === 'EX') exp = Date.now() + Number(args[++i]) * 1000;
        else if (o === 'PX') exp = Date.now() + Number(args[++i]);
      }
      if (nx && alive(k)) return null;
      m.set(k, { v: String(args[2]), exp }); return 'OK';
    }
    throw new Error('perintah tidak didukung: ' + op);
  };
  return { kind: 'memory', async cmd(a) { return run(a); }, async pipeline(c) { return c.map(run); } };
}

let cached = null;
function getStore() {
  if (cached) return cached;
  const cfg = redisConfig();
  if (cfg) cached = restStore(cfg);
  else if (process.env.VERCEL) { const e = new Error('Database belum dikonfigurasi. Hubungkan Upstash Redis ke proyek Vercel ini lalu deploy ulang.'); e.status = 500; throw e; }
  else cached = memoryStore();
  return cached;
}
function _resetForTests() { cached = null; }
module.exports = { getStore, _resetForTests };
