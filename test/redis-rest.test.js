'use strict';
/* Menjalankan seluruh tes API melalui jalur Redis REST (ke server tiruan) alih-alih memori. */
const { spawn } = require('child_process');
const fake = require('./fake-upstash.js');
(async () => {
  const srv = await fake.start('rahasia123');
  const env = Object.assign({}, process.env, { UPSTASH_REDIS_REST_URL: 'http://localhost:' + srv.address().port, UPSTASH_REDIS_REST_TOKEN: 'rahasia123' });
  const p = spawn('node', [__dirname + '/api.test.js'], { env, stdio: 'inherit' });
  p.on('exit', code => { srv.close(); console.log(code === 0 ? '\n[Jalur Redis REST] semua tes lolos' : '\n[Jalur Redis REST] GAGAL'); process.exit(code); });
})();
