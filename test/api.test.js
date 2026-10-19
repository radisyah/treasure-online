'use strict';
/* Tes integrasi server: node test/api.test.js  (memori, atau Redis REST bila variabel env diset) */
const assert = require('assert');
process.env.MIN_PLAYERS = '2';
const { start } = require('../dev-server.js');
const { getStore } = require('../lib/store.js');

let base, pass = 0;
const api = async (method, body, q) => {
  const r = await fetch(base + '/api/room' + (q ? '?' + new URLSearchParams(q) : ''), { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  return Object.assign({ http: r.status }, await r.json());
};
const post = (action, o) => api('POST', Object.assign({ action }, o));
const state = (c, t, v, extra) => api('GET', null, Object.assign({ code: c, token: t, v: v || 0 }, extra));
const T = async (name, fn) => { try { await fn(); pass++; console.log('  ✔', name); } catch (e) { console.log('  ✘', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); process.exitCode = 1; } };
const win = (score, extra) => Object.assign({ status: 'win', score, rank: 'A', used: 120, chests: 5, total: 5, ok: 12, bad: 1, hints: 0, fails: 0 }, extra);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = await start(0); base = 'http://localhost:' + srv.address().port;
  console.log('Tes API pada', base, '(' + getStore().kind + ')');
  let code, M, A, B, C;

  await T('buat room (pembuat = Room Master), kode 5 karakter', async () => {
    M = await post('create', { name: '<i>Guru</i>' });
    assert(M.ok && M.code.length === 5 && M.role === 'master' && M.slot === 1 && M.room.phase === 'lobby' && M.room.min === 2);
    code = M.code; assert.strictEqual(M.room.master.name, 'iGuru/i');
    assert.deepStrictEqual(M.room.players, [null, null, null, null]);
  });
  await T('gabung pemain → slot 2,3; kode salah 404; kode pendek 400; token salah 401', async () => {
    A = await post('join', { code, name: 'Ayu' }); assert(A.ok && A.role === 'player' && A.slot === 2);
    B = await post('join', { code, name: 'Budi' }); assert(B.ok && B.slot === 3 && B.room.players[0].name === 'Ayu');
    assert.strictEqual((await post('join', { code: 'ZZZZZ', name: 'x' })).http, 404);
    assert.strictEqual((await post('join', { code: 'AB', name: 'x' })).http, 400);
    assert.strictEqual((await state(code, 'salah')).http, 401);
  });
  await T('sambung ulang dengan token yang sama tidak menambah pemain', async () => {
    const r = await post('join', { code, token: A.token, name: 'x' }); assert(r.ok && r.slot === 2 && r.room.players.filter(Boolean).length === 2);
  });
  await T('room penuh setelah 4 pemain (semua hadir)', async () => {
    C = await post('join', { code, name: 'Cici' }); const D = await post('join', { code, name: 'Dodi' }); assert(C.ok && D.ok && D.slot === 5);
    const E = await post('join', { code, name: 'Eka' }); assert.strictEqual(E.http, 409);
    await post('leave', { code, token: D.token }); await post('leave', { code, token: C.token });   // kembali ke 2 pemain
  });
  await T('hanya Master yang bisa ganti level & mulai; pemain 403', async () => {
    assert.strictEqual((await post('level', { code, token: A.token, level: 3 })).http, 403);
    assert.strictEqual((await post('start', { code, token: A.token })).http, 403);
    const r = await post('level', { code, token: M.token, level: 99 }); assert(r.ok && r.room.level === 5);
    await post('level', { code, token: M.token, level: 3 });
  });
  await T('mulai ditolak bila belum semua siap', async () => {
    const r = await post('start', { code, token: M.token }); assert.strictEqual(r.http, 400); assert(/siap/i.test(r.error));
    await post('ready', { code, token: A.token, ready: true });
    assert.strictEqual((await post('start', { code, token: M.token })).http, 400);
    await post('ready', { code, token: B.token, ready: true });
  });
  await T('mulai → fase loading, ronde 1; gabung baru ditolak; Master tidak bisa "loaded"', async () => {
    const r = await post('start', { code, token: M.token }); assert(r.ok && r.room.phase === 'loading' && r.room.roundNo === 1 && r.room.level === 3);
    assert.deepStrictEqual(r.room.players.map(p => p && p.part), [true, true, null, null]);
    assert.strictEqual((await post('join', { code, name: 'Telat' })).http, 409);
    assert.strictEqual((await post('loaded', { code, token: M.token })).http, 403);
  });
  await T('semua "loaded" → fase playing dengan goAt ±4 dtk di depan', async () => {
    let r = await post('loaded', { code, token: A.token }); assert.strictEqual(r.room.phase, 'loading');
    r = await post('loaded', { code, token: B.token }); assert.strictEqual(r.room.phase, 'playing');
    assert(r.room.goAt - r.room.serverNow > 3000 && r.room.goAt - r.room.serverNow <= 4000);
  });
  await T('statistik disaring & hanya terlihat oleh Master; pemain tidak melihat statistik', async () => {
    const s = await post('stat', { code, token: A.token, time: 99999999, chests: 99, total: 5, score: 999999, loc: '<b>Gua</b>', mode: 'Menjelajah' });
    assert(s.ok && s.phase === 'playing' && s.roundNo === 1);
    const m = await state(code, M.token, 0); assert(m.ok && m.room.stats && m.room.stats['2']);
    assert.strictEqual(m.room.stats['2'].chests, 20); assert.strictEqual(m.room.stats['2'].score, 10000); assert.strictEqual(m.room.stats['2'].loc, 'bGua/b');
    const p = await state(code, B.token, 0); assert(!JSON.stringify(p.room).includes('"stats"'));
    assert.strictEqual(m.room.players[0].connected, true);
  });
  await T('Master tak bisa kirim stat/finish; pemain A selesai, ronde belum berakhir', async () => {
    assert.strictEqual((await post('stat', { code, token: M.token })).http, 403);
    const r = await post('finish', Object.assign({ code, token: A.token }, win(8000, { rank: '<S>' })));
    assert(r.ok && r.room.phase === 'playing' && r.room.players[0].result.score === 8000 && r.room.players[0].result.rank === 'S');
    const again = await post('finish', Object.assign({ code, token: A.token }, win(1))); assert(again.ok && again.room.players[0].result.score === 8000);   // idempoten
    const s = await post('stat', { code, token: A.token }); assert(s.out === true);
  });
  await T('sinyal WebRTC: Master offer → pemain terima di balasan stat → jawab → Master terima via polling', async () => {
    assert.strictEqual((await post('signal', { code, token: A.token, kind: 'offer', to: '3', n: 1, sdp: 'v=0' })).http, 403);
    assert.strictEqual((await post('signal', { code, token: M.token, kind: 'offer', to: '2', n: 1, sdp: 'v=0' })).http, 404);   // A sudah selesai
    assert.strictEqual((await post('signal', { code, token: M.token, kind: 'offer', to: '3', n: 1, sdp: '' })).http, 400);
    assert((await post('signal', { code, token: M.token, kind: 'offer', to: '3', n: 1, sdp: 'v=0 OFFER' })).ok);
    const s = await post('stat', { code, token: B.token, sigN: 0 }); assert(s.offer && s.offer.n === 1 && s.offer.sdp === 'v=0 OFFER');
    const s2 = await post('stat', { code, token: B.token, sigN: 1 }); assert(!s2.offer);
    assert((await post('signal', { code, token: B.token, kind: 'answer', n: 1, sdp: 'v=0 ANSWER' })).ok);
    const m = await state(code, M.token, 0, { g: 1, an: '' }); assert(m.room.sigs && m.room.sigs['3'].sdp === 'v=0 ANSWER');
    const m2 = await state(code, M.token, 0, { g: 1, an: '3:1' }); assert(!m2.room.sigs);
  });
  await T('semua selesai → kembali ke lobi, ready direset, hasil tetap ada untuk papan peringkat', async () => {
    const r = await post('finish', Object.assign({ code, token: B.token }, win(9000)));
    assert(r.ok && r.room.phase === 'lobby'); assert(r.room.players.filter(Boolean).every(p => !p.ready && p.result));
    const m = await state(code, M.token, 0); assert.strictEqual(m.room.phase, 'lobby'); assert(!m.room.stats);
  });
  await T('ronde 2: Master menghentikan → abort tercatat, hasil dihapus', async () => {
    await post('ready', { code, token: A.token, ready: true }); await post('ready', { code, token: B.token, ready: true });
    let r = await post('start', { code, token: M.token }); assert(r.ok && r.room.roundNo === 2);
    assert.strictEqual((await post('abort', { code, token: A.token })).http, 403);
    r = await post('abort', { code, token: M.token }); assert(r.ok && r.room.phase === 'lobby' && r.room.abort.round === 2);
    assert(r.room.players.filter(Boolean).every(p => !p.result && !p.part));
    assert.strictEqual((await post('abort', { code, token: M.token })).http, 409);
  });
  await T('ronde 3: pemain forfeit lalu pemain lain selesai → ronde berakhir', async () => {
    await post('ready', { code, token: A.token, ready: true }); await post('ready', { code, token: B.token, ready: true });
    await post('start', { code, token: M.token });
    await post('loaded', { code, token: A.token }); await post('loaded', { code, token: B.token });
    let r = await post('forfeit', { code, token: A.token }); assert(r.ok && r.room.players[0].result.status === 'fail' && r.room.phase === 'playing');
    r = await post('finish', Object.assign({ code, token: B.token }, { status: 'fail', reason: 'Waktu habis', chests: 2, total: 5, score: 50 }));
    assert(r.room.phase === 'lobby' && r.room.players[1].result.status === 'fail' && r.room.abort === null);
  });
  await T('pemain keluar saat loading → hasil gagal; semua keluar → ronde dibatalkan', async () => {
    await post('ready', { code, token: A.token, ready: true }); await post('ready', { code, token: B.token, ready: true });
    await post('start', { code, token: M.token });
    await post('leave', { code, token: A.token });
    assert.strictEqual((await state(code, A.token)).http, 401);   // pemain yang sudah keluar tak bisa dipakai lagi
    await post('leave', { code, token: B.token });
    const m = await state(code, M.token, 0); assert.strictEqual(m.room.phase, 'lobby'); assert(m.room.abort && /terputus/i.test(m.room.abort.reason));
  });
  await T('tenggat malas: pemain tanpa statistik > 60 dtk dianggap terputus (lewat polling)', async () => {
    const { needsTick, tick } = require('../api/room.js')._internal;
    const room = { phase: 'playing', goAt: 1000, roundNo: 1, part: [2, 3], slots: [{ result: null }, { result: { status: 'win' } }, null, null] };
    assert(!needsTick(room, {}, 1000 + 59000)); assert(needsTick(room, {}, 1000 + 61000));
    assert(!needsTick(room, { '2': { t: 1000 + 50000 } }, 1000 + 61000));
    assert(tick(room, { '2': { t: 1, chests: 3, total: 5 } }, 1000 + 61000));
    assert(room.slots[0].result.status === 'dc' && room.slots[0].result.chests === 3 && room.phase === 'lobby');
    const ld = { phase: 'loading', loadAt: 0, part: [2], roundNo: 1, slots: [{ loaded: false, result: null }, null, null, null] };
    assert(!needsTick(ld, {}, 29000)); assert(tick(ld, {}, 31000)); assert(ld.phase === 'lobby' && ld.abort);   // semua gagal memuat → batal
  });
  await T('Master keluar → room ditutup; pemain tahu lewat polling; tak bisa gabung', async () => {
    const A2 = await post('join', { code, name: 'Ayu2' }); assert(A2.ok);
    assert((await post('leave', { code, token: M.token })).ok);
    const s = await state(code, A2.token, 0); assert(s.ok && s.room.closed && /ditutup/.test(s.room.closed.reason));
    assert.strictEqual((await post('join', { code, name: 'Baru' })).http, 409);
  });
  await T('slot pemain yang tidak hadir bisa diambil pemain baru di lobi', async () => {
    const M2 = await post('create', { name: 'M2' }), c = M2.code, store = getStore();
    const P = [];
    for (let i = 0; i < 4; i++) P.push(await post('join', { code: c, name: 'P' + i }));
    assert.strictEqual((await post('join', { code: c, name: 'X' })).http, 409);
    await store.cmd(['DEL', 'pres:' + c + ':3']);   // pemain slot 3 menghilang (tab ditutup)
    const X = await post('join', { code: c, name: 'Pengganti' }); assert(X.ok && X.slot === 3);
    assert.strictEqual((await state(c, P[1].token)).http, 401);   // tokennya sudah tidak berlaku
  });
  await T('polling: "unchanged" bila versi sama, membawa tanda hadir', async () => {
    const m = await state(code === undefined ? '' : code, M.token, 0).catch(() => null); // room lama ditutup: hanya pastikan tidak crash
    const M3 = await post('create', { name: 'M3' }); const s0 = await state(M3.code, M3.token, 0); assert(s0.room && !s0.unchanged);
    const s1 = await state(M3.code, M3.token, s0.room.v); assert(s1.unchanged && s1.online.m === true);
  });
  await T('aksi tak dikenal 400, metode salah 405', async () => {
    assert.strictEqual((await post('hack', {})).http, 400);
    assert.strictEqual((await fetch(base + '/api/room', { method: 'PUT' })).status, 405);
  });

  console.log('\n' + pass + ' tes lolos' + (process.exitCode ? ' — ADA YANG GAGAL' : ''));
  srv.close();
})();
