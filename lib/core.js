'use strict';
/* Aturan bersama TROVERAID 3D Online (dipakai server untuk menyaring data dari klien).
   Gameplay 3D berjalan di perangkat tiap pemain; server memegang status room, tanda hadir, statistik langsung & hasil akhir. */
const MAX_PLAYERS = 4;
const LEVELS = 5;
const MAX_SCORE = 10000;

const int = (v, a, b, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : (d === undefined ? a : d); };
const san = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

/* Statistik langsung (dikirim tiap ±2 detik) -> disaring supaya aman disimpan & ditampilkan di layar Room Master. */
function cleanStat(m) {
  m = m || {};
  return {
    time: Math.max(0, Math.min(86400, Number(m.time) || 0)),
    chests: int(m.chests, 0, 20), total: int(m.total, 0, 20), fails: int(m.fails, 0, 99), fl: int(m.fl, 0, 99),
    ok: int(m.ok, 0, 9999), bad: int(m.bad, 0, 9999), hints: int(m.hints, 0, 9999), score: int(m.score, 0, MAX_SCORE),
    loc: san(m.loc, 30), mode: san(m.mode, 50)
  };
}
/* Hasil akhir satu pemain (dikirim klien saat menang/gagal). */
function cleanResult(m) {
  m = m || {};
  return {
    status: m.status === 'win' ? 'win' : 'fail', score: int(m.score, 0, MAX_SCORE), rank: san(m.rank, 1), used: int(m.used, 0, 99999),
    chests: int(m.chests, 0, 20), total: int(m.total, 0, 20), reason: san(m.reason, 70),
    ok: int(m.ok, 0, 9999), bad: int(m.bad, 0, 9999), hints: int(m.hints, 0, 9999), fails: int(m.fails, 0, 99)
  };
}
/* Hasil kosong untuk pemain yang keluar / terputus / gagal memuat. status: 'fail' | 'dc'. */
function emptyResult(status, reason, stat) {
  return { status, score: 0, rank: '', used: 0, chests: stat ? stat.chests : 0, total: stat ? stat.total : 0, reason, ok: 0, bad: 0, hints: 0, fails: 0 };
}
module.exports = { MAX_PLAYERS, LEVELS, MAX_SCORE, int, san, cleanStat, cleanResult, emptyResult };
