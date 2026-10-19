'use strict';
/* Server tiruan yang meniru format REST Upstash (POST / dengan array perintah; POST /pipeline dengan array of array;
   respons {"result":...}, header Authorization: Bearer). Dipakai untuk menguji lib/store.js jalur Redis tanpa internet. */
const http = require('http');
const mem = require('../lib/store.js');
function start(token) {
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
  mem._resetForTests(); const backend = mem.getStore();       // memori sebagai "mesin Redis"
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer ' + token) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Unauthorized' })); }
      try {
        const body = JSON.parse(raw);
        if (req.url === '/pipeline') { const out = await backend.pipeline(body); return res.end(JSON.stringify(out.map(result => ({ result })))); }
        if (req.url === '/') { return res.end(JSON.stringify({ result: await backend.cmd(body) })); }
        res.statusCode = 404; res.end('{}');
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
    });
  });
  return new Promise(r => srv.listen(0, () => r(srv)));
}
module.exports = { start };
