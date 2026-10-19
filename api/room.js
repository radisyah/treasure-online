'use strict';
/* Treasure Hunter 3D Online — satu Vercel Function (/api/room), state di Upstash Redis.
   Pola sama dengan angry-birds-online: kode ruangan 5 karakter, token sesi, polling, kunci per-room, tenggat "malas" lewat polling.
   Peran: 1 Room Master (menonton, tidak bermain) + 2–4 pemain (kursi/slot 2..5, sama seperti server WebSocket lama). */
const crypto = require('crypto');
const core = require('../lib/core.js');
const { getStore } = require('../lib/store.js');
const { getIceServers } = require('../lib/ice.js');

const TTL = 6 * 3600;                  // room hilang 6 jam setelah aktivitas terakhir
const CLOSED_TTL = 600;                // room yang sudah ditutup Master disimpan sebentar agar pemain tahu
const PRES_TTL = 20;                   // detik; tanda hadir (diperbarui tiap polling / kirim statistik)
const STAT_TTL = 3600;                 // detik; statistik langsung pemain
const FRESH_MS = 15000;                // statistik lebih baru dari ini = pemain dianggap online saat bermain
const DROP_MS = 60000;                 // tanpa statistik selama ini saat bermain = pemain dianggap terputus
const LOAD_MS = 30000;                 // pemain yang belum selesai memuat level setelah ini dianggap gagal
const GO_DELAY_MS = 4000;              // jeda dari "semua siap" ke "mulai" (hitung mundur 3-2-1 serentak berdasar jam server)
const MAX_GAME_MS = 45 * 60 * 1000;    // batas keras satu pertandingan
const SIG_TTL = 900;                   // detik; pesan sinyal WebRTC (offer/answer)
const MAX_SDP = 24000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SEATS = ['2', '3', '4', '5'];    // slot pemain; indeks array = slot - 2

const minPlayers = () => Math.max(1, Math.min(4, parseInt(process.env.MIN_PLAYERS || '4', 10) || 4));
const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = n => crypto.randomBytes(n).toString('hex');
const roomKey = c => 'room:' + c, presKey = (c, id) => 'pres:' + c + ':' + id, statKey = (c, id) => 'stat:' + c + ':' + id;
const sigKey = (c, g, id, k) => 'sig:' + c + ':' + g + ':' + id + ':' + k;   // k: 'o' (offer Master) / 'a' (answer pemain)
const parse = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
const int0 = v => core.int(v, 0, 1e6, 0);

/* ---------- logika room ---------- */
const seated = room => room.slots.map((p, i) => p ? { s: i + 2, p } : null).filter(Boolean);
const playerAt = (room, s) => room.slots[s - 2] || null;
const liveOf = (room, raw) => { const s = parse(raw); return s && s.r === room.roundNo ? s : null; };   // statistik milik ronde ini

function abortRound(room, reason) {
  room.phase = 'lobby'; room.abort = { round: room.roundNo, reason };
  room.part = [];
  seated(room).forEach(({ p }) => { p.ready = false; p.result = null; p.loaded = false; });
}
function checkLoaded(room, now) {
  if (room.phase !== 'loading') return;
  const act = room.part.filter(s => { const p = playerAt(room, s); return p && !p.result; });
  if (!act.length) return abortRound(room, 'Semua pemain terputus.');
  if (act.every(s => playerAt(room, s).loaded)) { room.phase = 'playing'; room.goAt = now + GO_DELAY_MS; }
}
function checkEnd(room) {
  if (room.phase !== 'playing') return;
  if (room.part.every(s => { const p = playerAt(room, s); return p && p.result; })) {
    room.phase = 'lobby';
    seated(room).forEach(({ p }) => { p.ready = false; });
  }
}
/* Tenggat dijalankan lewat polling karena serverless tidak punya proses latar. */
function needsTick(room, stats, now) {
  if (room.phase === 'loading') return now - room.loadAt > LOAD_MS && room.part.some(s => { const p = playerAt(room, s); return p && !p.loaded && !p.result; });
  if (room.phase !== 'playing') return false;
  if (now > room.goAt + MAX_GAME_MS) return true;
  return room.part.some(s => { const p = playerAt(room, s); return p && !p.result && now - Math.max(room.goAt, (stats[s] && stats[s].t) || 0) > DROP_MS; });
}
function tick(room, stats, now) {
  if (!needsTick(room, stats, now)) return false;
  if (room.phase === 'loading') {
    room.part.forEach(s => { const p = playerAt(room, s); if (p && !p.loaded && !p.result) p.result = core.emptyResult('dc', 'Gagal memuat level', stats[s]); });
    checkLoaded(room, now);
    return true;
  }
  const hard = now > room.goAt + MAX_GAME_MS;
  room.part.forEach(s => {
    const p = playerAt(room, s); if (!p || p.result) return;
    if (hard || now - Math.max(room.goAt, (stats[s] && stats[s].t) || 0) > DROP_MS) p.result = core.emptyResult('dc', hard ? 'Waktu pertandingan habis' : 'Terputus dari server', stats[s]);
  });
  checkEnd(room);
  return true;
}

/* pres: { m, '2'..'5' } boolean; stats: { slot: stat } */
function connectedOf(room, s, p, pres, stats, now) {
  if (p.left) return false;
  if (room.phase === 'playing' && !p.result && stats[s]) return now - stats[s].t < FRESH_MS;
  return !!pres[s];
}
function viewFor(room, seat, now, pres, stats) {
  pres = pres || {}; stats = stats || {};
  const isM = seat === 'master';
  const out = {
    code: room.code, v: room.v, serverNow: now, phase: room.phase, level: room.level, roundNo: room.roundNo, goAt: room.goAt || 0,
    min: minPlayers(), abort: room.abort || null, closed: room.closed || null,
    role: isM ? 'master' : 'player', slot: isM ? 1 : seat,
    master: { name: room.master.name, online: !!pres.m },
    players: room.slots.map((p, i) => p ? {
      slot: i + 2, name: p.name, ready: !!p.ready, left: !!p.left, connected: connectedOf(room, i + 2, p, pres, stats, now),
      part: room.part.includes(i + 2), result: p.result || null
    } : null)
  };
  if (isM && room.phase === 'playing') { out.stats = {}; Object.keys(stats).forEach(s => { out.stats[s] = Object.assign(core.cleanStat(stats[s]), { t: stats[s].t }); }); }
  return out;
}

/* ---------- akses data ---------- */
async function withRoom(code, fn) {
  const store = getStore(), lk = 'lock:' + code, id = rid(6);
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = (await store.cmd(['SET', lk, id, 'NX', 'PX', 4000])) === 'OK';
    if (!got) await sleep(30 + Math.random() * 40);
  }
  if (!got) throw fail(503, 'Server sedang sibuk. Coba lagi.');
  try {
    const raw = await store.cmd(['GET', roomKey(code)]);
    if (!raw) throw fail(404, 'Room tidak ditemukan atau sudah kedaluwarsa.');
    const room = JSON.parse(raw);
    const out = await fn(room);
    room.v++;
    await store.cmd(['SET', roomKey(code), JSON.stringify(room), 'EX', room.closed ? CLOSED_TTL : TTL]);
    return out;
  } finally { await store.cmd(['DEL', lk]).catch(() => { }); }
}
function seatOf(room, token) {
  if (!token) throw fail(401, 'Sesi tidak valid.');
  if (room.master.token === token) return 'master';
  const f = seated(room).find(x => x.p.token === token && !x.p.left);
  if (f) return f.s;
  throw fail(401, 'Sesi tidak valid. Gabung ulang ke room.');
}
const playerOf = (room, token) => {
  const seat = seatOf(room, token);
  if (seat === 'master') throw fail(403, 'Room Master tidak ikut bermain.');
  return { s: seat, p: playerAt(room, seat) };
};
const requireMaster = (room, token) => { if (seatOf(room, token) !== 'master') throw fail(403, 'Hanya Room Master yang bisa melakukan ini.'); };
const normCode = c => { c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (c.length !== 5) throw fail(400, 'Kode room harus 5 karakter.'); return c; };
async function presOf(code) {
  const raws = await getStore().cmd(['MGET'].concat(['m'].concat(SEATS).map(i => presKey(code, i))));
  const o = { m: !!raws[0] }; SEATS.forEach((id, i) => { o[id] = !!raws[i + 1]; }); return o;
}
async function readStats(code, room) {
  const raws = await getStore().cmd(['MGET'].concat(SEATS.map(i => statKey(code, i))));
  const out = {};
  SEATS.forEach((id, i) => { const s = liveOf(room, raws[i]); if (s) out[id] = s; });
  return out;
}
const allOnline = () => ({ m: true, '2': true, '3': true, '4': true, '5': true });
const closedGuard = room => { if (room.closed) throw fail(409, 'Room ini sudah ditutup.'); };

/* ---------- aksi ---------- */
async function actCreate(b) {
  const name = core.san(b.name, 14) || 'Master';
  const store = getStore(), now = Date.now(), token = rid(12);
  for (let i = 0; i < 12; i++) {
    let code = ''; for (let k = 0; k < 5; k++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const room = {
      code, v: 1, createdAt: now, phase: 'lobby', level: 1, roundNo: 0, goAt: 0, loadAt: 0, abort: null, closed: null,
      master: { token, name }, slots: [null, null, null, null], part: []
    };
    const ok = await store.cmd(['SET', roomKey(code), JSON.stringify(room), 'NX', 'EX', TTL]);
    if (ok === 'OK') return { code, token, role: 'master', slot: 1, room: viewFor(room, 'master', now, allOnline(), {}) };
  }
  throw fail(503, 'Gagal membuat room. Coba lagi.');
}
async function actJoin(b) {
  const code = normCode(b.code), now = Date.now();
  return withRoom(code, async room => {
    if (b.token) { // sambung ulang
      try { const seat = seatOf(room, b.token); return { code, token: b.token, role: seat === 'master' ? 'master' : 'player', slot: seat === 'master' ? 1 : seat, room: viewFor(room, seat, now, allOnline(), {}) }; } catch (e) { /* lanjut sebagai pemain baru */ }
    }
    closedGuard(room);
    if (room.phase !== 'lobby') throw fail(409, 'Pertandingan sedang berlangsung. Tunggu ronde selesai.');
    const pres = await presOf(code);
    let slot = 0;
    for (let s = 2; s <= 5; s++) { const p = playerAt(room, s); if (!p || p.left || !pres[s]) { slot = s; break; } }   // slot kosong atau pemain yang sudah tidak hadir
    if (!slot) throw fail(409, 'Room penuh (maksimal ' + core.MAX_PLAYERS + ' pemain).');
    const name = core.san(b.name, 14) || ('Pemain ' + (slot - 1)), token = rid(12);
    room.part = room.part.filter(s => s !== slot);
    room.slots[slot - 2] = { token, name, ready: false, left: false, loaded: false, result: null };
    await getStore().cmd(['SET', presKey(code, slot), '1', 'EX', PRES_TTL]);
    return { code, token, role: 'player', slot, room: viewFor(room, slot, now, Object.assign(allOnline(), pres, { [slot]: true }), {}) };
  });
}
async function actReady(b) {
  const code = normCode(b.code), now = Date.now();
  return withRoom(code, room => {
    const { s, p } = playerOf(room, b.token); closedGuard(room);
    if (room.phase !== 'lobby') throw fail(409, 'Pertandingan sudah dimulai.');
    p.ready = !!b.ready;
    return { room: viewFor(room, s, now, allOnline(), {}) };
  });
}
async function actLevel(b) {
  const code = normCode(b.code), now = Date.now();
  return withRoom(code, room => {
    requireMaster(room, b.token); closedGuard(room);
    if (room.phase !== 'lobby') throw fail(409, 'Level hanya bisa diganti di lobby.');
    room.level = core.int(b.level, 1, core.LEVELS, 1);
    return { room: viewFor(room, 'master', now, allOnline(), {}) };
  });
}
async function actStart(b) {
  const code = normCode(b.code), now = Date.now();
  return withRoom(code, async room => {
    requireMaster(room, b.token); closedGuard(room);
    if (room.phase !== 'lobby') throw fail(409, 'Pertandingan tidak bisa dimulai sekarang.');
    const pres = await presOf(code), min = minPlayers();
    const here = seated(room).filter(x => !x.p.left && pres[x.s]);
    if (here.length < min) throw fail(400, 'Butuh ' + min + ' pemain di lobby (sekarang ' + here.length + ').');
    if (!here.every(x => x.p.ready)) throw fail(400, 'Belum semua pemain siap.');
    room.slots = room.slots.map((p, i) => (p && !p.left && pres[i + 2]) ? p : null);   // pemain yang terputus dikeluarkan
    room.part = seated(room).map(x => x.s);
    room.phase = 'loading'; room.roundNo++; room.loadAt = now; room.goAt = 0; room.abort = null;
    seated(room).forEach(({ p }) => { p.result = null; p.loaded = false; });
    return { room: viewFor(room, 'master', now, pres, {}) };
  });
}
async function actLoaded(b) {
  const code = normCode(b.code), now = Date.now();
  return withRoom(code, room => {
    const { s, p } = playerOf(room, b.token);
    if (room.phase === 'loading' && room.part.includes(s) && !p.result) { p.loaded = true; checkLoaded(room, now); }
    return { room: viewFor(room, s, now, allOnline(), {}) };
  });
}
/* Statistik langsung: tanpa kunci (1 GET + pipeline). Balasan memberi tahu klien bila status room berubah / pemain sudah dianggap keluar. */
async function actStat(b) {
  const code = normCode(b.code), now = Date.now(), store = getStore();
  const room = parse(await store.cmd(['GET', roomKey(code)]));
  if (!room) throw fail(404, 'Room tidak ditemukan atau sudah kedaluwarsa.');
  const { s, p } = playerOf(room, b.token);
  const out = { phase: room.phase, roundNo: room.roundNo, v: room.v, serverNow: now, closed: room.closed || null };
  if (room.phase === 'playing' && room.part.includes(s)) {
    if (p.result) { out.out = true; return out; }
    const live = Object.assign(core.cleanStat(b), { t: now, r: room.roundNo });
    const r = await store.pipeline([
      ['SET', statKey(code, s), JSON.stringify(live), 'EX', STAT_TTL],
      ['SET', presKey(code, s), '1', 'EX', PRES_TTL],
      ['GET', sigKey(code, room.roundNo, s, 'o')]
    ]);
    const offer = parse(r[2]);    // penawaran siaran video dari Room Master (dikirim hanya bila belum dikenal pemain)
    if (offer && offer.n !== int0(b.sigN)) out.offer = offer;
  }
  return out;
}
async function actFinish(b) {
  const code = normCode(b.code), now = Date.now();
  return withRoom(code, room => {
    const { s, p } = playerOf(room, b.token);
    if (room.phase !== 'playing' || !room.part.includes(s)) throw fail(409, 'Pertandingan tidak sedang berjalan.');
    if (!p.result) { p.result = core.cleanResult(b); checkEnd(room); }
    return { room: viewFor(room, s, now, allOnline(), {}) };
  });
}
async function actForfeit(b) {
  const code = normCode(b.code), now = Date.now();
  return withRoom(code, async room => {
    const { s, p } = playerOf(room, b.token);
    if ((room.phase === 'playing' || room.phase === 'loading') && room.part.includes(s) && !p.result) {
      const stats = await readStats(code, room);
      p.result = core.emptyResult('fail', 'Keluar dari pertandingan', stats[s]);
      if (room.phase === 'loading') checkLoaded(room, now); else checkEnd(room);
    }
    return { room: viewFor(room, s, now, allOnline(), {}) };
  });
}
async function actAbort(b) {
  const code = normCode(b.code), now = Date.now();
  return withRoom(code, room => {
    requireMaster(room, b.token);
    if (room.phase === 'lobby') throw fail(409, 'Tidak ada pertandingan yang berjalan.');
    abortRound(room, 'Pertandingan dihentikan oleh room master.');
    return { room: viewFor(room, 'master', now, allOnline(), {}) };
  });
}
async function actLeave(b) {
  const code = normCode(b.code), now = Date.now();
  return withRoom(code, async room => {
    const seat = seatOf(room, b.token);
    if (seat === 'master') { room.closed = { reason: 'Room master keluar. Room ditutup.' }; return { room: viewFor(room, 'master', now, {}, {}) }; }
    const p = playerAt(room, seat);
    if (room.phase === 'lobby') room.slots[seat - 2] = null;
    else {
      if (room.part.includes(seat) && !p.result) {
        const stats = await readStats(code, room);
        p.result = core.emptyResult('fail', 'Keluar dari pertandingan', stats[seat]);
      }
      p.left = true; p.ready = false;
      if (room.phase === 'loading') checkLoaded(room, now); else checkEnd(room);
    }
    return { room: viewFor(room, seat, now, {}, {}) };
  });
}
/* Sinyal WebRTC untuk siaran layar pemain ke Room Master. Master -> pemain: offer; pemain -> Master: answer. Video lewat P2P/TURN, bukan lewat server ini. */
async function actSignal(b) {
  const code = normCode(b.code), store = getStore();
  const room = parse(await store.cmd(['GET', roomKey(code)]));
  if (!room) throw fail(404, 'Room tidak ditemukan atau sudah kedaluwarsa.');
  const seat = seatOf(room, b.token);
  if (room.phase !== 'playing') throw fail(409, 'Pertandingan tidak sedang berjalan.');
  const sdp = String(b.sdp || ''), n = int0(b.n);
  if (!sdp || sdp.length > MAX_SDP) throw fail(400, 'SDP tidak valid.');
  let id, kind;
  if (b.kind === 'offer') {
    if (seat !== 'master') throw fail(403, 'Hanya Room Master yang mengirim penawaran.');
    id = String(b.to); const p = SEATS.includes(id) && playerAt(room, Number(id));
    if (!p || p.result || p.left) throw fail(404, 'Pemain tidak ditemukan.');
    kind = 'o';
  } else if (b.kind === 'answer') {
    if (seat === 'master') throw fail(403, 'Room Master tidak menjawab.');
    id = String(seat); kind = 'a';
  } else throw fail(400, 'Jenis sinyal tidak dikenal.');
  await store.cmd(['SET', sigKey(code, room.roundNo, id, kind), JSON.stringify({ n, sdp }), 'EX', SIG_TTL]);
  return {};
}
/* Polling: satu round-trip (GET room + tanda hadir + statistik [+ jawaban sinyal]), lalu 1 SET tanda hadir. Menulis room hanya bila ada tenggat lewat. */
async function actState(q) {
  const code = normCode(q.code), token = String(q.token || ''), have = Number(q.v) || 0, now = Date.now(), store = getStore();
  const cmds = [
    ['GET', roomKey(code)],
    ['MGET'].concat(['m'].concat(SEATS).map(i => presKey(code, i))),
    ['MGET'].concat(SEATS.map(i => statKey(code, i)))
  ];
  const gNo = int0(q.g), wantSigs = gNo > 0;    // Room Master yang memantau juga mengambil jawaban siaran dari pemain
  if (wantSigs) cmds.push(['MGET'].concat(SEATS.map(i => sigKey(code, gNo, i, 'a'))));
  const first = await store.pipeline(cmds);
  if (!first[0]) throw fail(404, 'Room tidak ditemukan atau sudah kedaluwarsa.');
  let room = JSON.parse(first[0]);
  const seat = seatOf(room, token);
  const me = seat === 'master' ? 'm' : String(seat);
  await store.cmd(['SET', presKey(code, me), '1', 'EX', PRES_TTL]);
  const pres = { m: !!first[1][0] }; SEATS.forEach((id, i) => { pres[id] = !!first[1][i + 1]; });
  pres[me] = true;
  const stats = {}; SEATS.forEach((id, i) => { const s = liveOf(room, first[2][i]); if (s) stats[id] = s; });
  if (needsTick(room, stats, now)) {
    await withRoom(code, r => { tick(r, stats, now); });
    room = JSON.parse(await store.cmd(['GET', roomKey(code)]));
  }
  if (room.v === have && !(seat === 'master' && room.phase === 'playing')) return { unchanged: true, v: room.v, serverNow: now, online: pres };
  const view = viewFor(room, seat, now, pres, stats);
  if (seat === 'master' && room.phase === 'playing' && wantSigs && room.roundNo === gNo) {
    // `an` = "slot:n,slot:n" jawaban yang sudah diproses Master (tidak dikirim ulang)
    const known = {}; String(q.an || '').split(',').forEach(x => { const [i, n] = x.split(':'); if (i) known[i] = Number(n); });
    const sigs = {}; SEATS.forEach((id, i) => { const a = parse(first[3][i]); if (a && known[id] !== a.n) sigs[id] = a; });
    if (Object.keys(sigs).length) view.sigs = sigs;
  }
  return { room: view };
}
/* Daftar STUN/TURN untuk WebRTC. Hanya untuk sesi yang sah di room (kredensial TURN tidak dibagikan ke sembarang orang). */
async function actIce(q) {
  const code = normCode(q.code), store = getStore();
  const room = parse(await store.cmd(['GET', roomKey(code)]));
  if (!room) throw fail(404, 'Room tidak ditemukan atau sudah kedaluwarsa.');
  seatOf(room, String(q.token || ''));
  return getIceServers();
}

/* ---------- handler HTTP (Vercel) ---------- */
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { throw fail(400, 'Body tidak valid.'); } }
  return {};
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let out;
    if (req.method === 'GET') out = (req.query && req.query.action === 'ice') ? await actIce(req.query) : await actState(req.query || {});
    else if (req.method === 'POST') {
      const b = readBody(req);
      const acts = { create: actCreate, join: actJoin, ready: actReady, level: actLevel, start: actStart, loaded: actLoaded, stat: actStat, finish: actFinish, forfeit: actForfeit, abort: actAbort, leave: actLeave, signal: actSignal };
      if (!acts[b.action]) throw fail(400, 'Aksi tidak dikenal.');
      out = await acts[b.action](b);
    } else throw fail(405, 'Metode tidak didukung.');
    res.status(200).json(Object.assign({ ok: true }, out));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    res.status(status).json({ ok: false, error: status >= 500 && !e.status ? 'Terjadi kesalahan di server.' : e.message });
  }
};
module.exports._internal = { needsTick, tick, viewFor };
