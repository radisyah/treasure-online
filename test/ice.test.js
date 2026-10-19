'use strict';
/* Tes pemilihan penyedia TURN: node test/ice.test.js */
const assert = require('assert');
const { getIceServers, _resetForTests } = require('../lib/ice.js');
let pass = 0;
const T = async (name, fn) => { try { _resetForTests(); await fn(); pass++; console.log('  ✔', name); } catch (e) { console.log('  ✘', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); process.exitCode = 1; } };
const METERED = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: 'u1', credential: 'c1' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'u1', credential: 'c1' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'u1', credential: 'c1' },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'u1', credential: 'c1' }
];
const ok = body => async () => ({ ok: true, status: 200, json: async () => body });
const bad = status => async () => ({ ok: false, status, json: async () => ({}) });

(async () => {
  await T('tanpa konfigurasi → hanya STUN, relay=false', async () => {
    const r = await getIceServers({}, ok([]));
    assert.strictEqual(r.relay, false); assert.strictEqual(r.iceServers.length, 1);
  });
  await T('Metered: memanggil domain + apiKey yang benar dan mengembalikan relay', async () => {
    let called;
    const r = await getIceServers({ METERED_DOMAIN: 'https://app.metered.live/', METERED_API_KEY: 'k e y' }, async (u) => { called = u; return ok(METERED)(); });
    assert.strictEqual(called, 'https://app.metered.live/api/v1/turn/credentials?apiKey=k%20e%20y');
    assert.strictEqual(r.relay, true);
    assert(r.iceServers.some(s => s.urls.includes('turns:global.relay.metered.ca:443?transport=tcp') && s.username === 'u1'));
  });
  await T('Metered diprioritaskan di atas Cloudflare', async () => {
    const urls = [];
    const r = await getIceServers({ METERED_DOMAIN: 'a.metered.live', METERED_API_KEY: 'x', CF_TURN_KEY_ID: 'i', CF_TURN_API_TOKEN: 't' }, async u => { urls.push(u); return ok(METERED)(); });
    assert.strictEqual(urls.length, 1); assert(/metered\.live/.test(urls[0])); assert.strictEqual(r.relay, true);
  });
  await T('Metered gagal (401) → jatuh ke Cloudflare', async () => {
    const r = await getIceServers({ METERED_DOMAIN: 'a.metered.live', METERED_API_KEY: 'x', CF_TURN_KEY_ID: 'i', CF_TURN_API_TOKEN: 't' },
      async u => /metered/.test(u) ? bad(401)() : ok({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53'], username: 'a', credential: 'b' }] })());
    assert.strictEqual(r.relay, true);
    const cf = r.iceServers.find(s => s.username === 'a'); assert.deepStrictEqual(cf.urls, ['turn:turn.cloudflare.com:3478?transport=udp']);   // port 53 dibuang
  });
  await T('Metered gagal, tanpa cadangan → STUN saja (tidak melempar error)', async () => {
    const r = await getIceServers({ METERED_DOMAIN: 'a.metered.live', METERED_API_KEY: 'x' }, bad(500));
    assert.strictEqual(r.relay, false); assert.strictEqual(r.iceServers.length, 1);
  });
  await T('Metered timeout/jaringan putus → STUN saja', async () => {
    const r = await getIceServers({ METERED_DOMAIN: 'a.metered.live', METERED_API_KEY: 'x' }, async () => { throw new Error('ECONNRESET'); });
    assert.strictEqual(r.relay, false);
  });
  await T('hasil di-cache (satu panggilan untuk banyak permintaan)', async () => {
    let n = 0; const f = async () => { n++; return ok(METERED)(); };
    const env = { METERED_DOMAIN: 'a.metered.live', METERED_API_KEY: 'x' };
    await getIceServers(env, f); await getIceServers(env, f); await getIceServers(env, f);
    assert.strictEqual(n, 1);
  });
  console.log('\n' + pass + ' tes ICE lolos');
})();
