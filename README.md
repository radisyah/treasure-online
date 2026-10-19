# Treasure Hunter 3D — Mode Online (1 Room Master + 2–4 pemain) untuk Vercel

Versi online *Treasure Hunter 3D: Math Under Pressure* dengan cara kerja yang sama seperti **angry-birds-online**:
kode room 5 karakter, token sesi di `localStorage`, polling ke satu Vercel Function (`/api/room`), dan state di **Upstash Redis**.

> Versi lama memakai server WebSocket (`server.js`) yang harus berjalan terus di laptop. Vercel bersifat *serverless* (tidak ada proses yang
> menyala terus dan tidak ada WebSocket), jadi `server.js` dan paket `ws` dihapus dan diganti API polling + Redis.

```
Browser P1..P4 ─┐                         ┌─ Upstash Redis (room, tanda hadir, statistik langsung, kunci, sinyal WebRTC)
Room Master ────┼─ polling ─ /api/room ───┤
                └                         └─ lib/core.js (penyaringan data dari klien)
```

Level, soal, dan peti sudah deterministik per level (seed tetap), jadi semua pemain otomatis mendapat arena yang sama. Server hanya memegang
status room, hitung mundur serentak, statistik langsung, dan hasil akhir. Gameplay 3D berjalan di perangkat masing-masing.

## Cara bermain
1. **Room Master**: buka situs → MAIN ONLINE → isi nama → **BUAT ROOM BARU**. Bagikan **tautan** (klik teks di bawah lobi untuk menyalin) atau **kode 5 karakter**.
2. **Pemain 1–4**: buka tautan / masukkan kode → **GABUNG ROOM** → tekan **SIAP**.
3. Master memilih level, lalu **MULAI PERTANDINGAN** (aktif bila jumlah pemain ≥ `MIN_PLAYERS` dan semuanya siap).
4. Semua pemain memuat level, hitung mundur 3-2-1 **serentak** (memakai jam server), lalu bermain. Master melihat 4 layar + timer, peti, jebakan, dan skor tiap pemain.
5. Setelah semua selesai → papan peringkat; semua kembali ke lobi (Master bisa memilih level lain). Master juga bisa **HENTIKAN** kapan saja.

Aturan khusus versi online:
- Beberapa room bisa berjalan bersamaan (versi lama hanya satu room per server). Room kedaluwarsa 6 jam setelah aktivitas terakhir.
- Pemain terputus > 60 dtk tanpa kabar saat bermain → dihitung **TERPUTUS**. Gagal memuat level dalam 30 dtk → dianggap gagal. Batas keras satu pertandingan 45 menit.
- Master keluar → room ditutup dan semua pemain dikeluarkan. Pemain keluar saat bermain → dihitung gagal.
- Muat ulang halaman di **lobi/papan skor** = tersambung kembali otomatis. Muat ulang **di tengah ronde** = dianggap keluar dari ronde itu (skor lokal hilang).
- Tab yang disembunyikan: waktu yang terlewat dipotong dari timer misi (seperti sebelumnya).

## Deploy ke Vercel
1. Taruh folder ini di repositori GitHub, lalu **Add New → Project** di Vercel (preset "Other", tanpa build command). Atau: `npm i -g vercel && vercel`.
2. Dashboard proyek → **Storage / Marketplace** → tambahkan **Upstash Redis** → hubungkan ke proyek. Otomatis terisi
   `KV_REST_API_URL` + `KV_REST_API_TOKEN` (atau `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`); keduanya didukung.
3. (Opsional) **Settings → Environment Variables**: `MIN_PLAYERS` (1–4, bawaan **4**; isi `2` untuk uji coba) dan TURN (lihat bawah).
4. **Redeploy** (variabel baru hanya berlaku untuk deployment baru).
5. Buka URL proyek → buat room → bagikan tautan/kodenya.

Bila Redis belum terhubung, API membalas: *"Database belum dikonfigurasi…"*.

## Video layar pemain → Room Master (WebRTC) dan TURN
Video **tidak lewat server Vercel**. Master membuat *offer*, pemain menjawab; server hanya menukar pesan sinyal lewat Redis (tidak ada WebSocket).
Kualitas siaran: **640×360, 30 fps, ±800 kbps** per pemain (diturunkan dari 960×540@60 versi LAN agar kuat lewat internet; ubah `SW`, `SH`, `FPS`, `BITRATE` di objek `Net` pada `public/index.html`).
Jaringan lemah → kualitas gambar yang turun, bukan fps (`maintain-framerate`). Cadangan JPEG lewat server **dihapus** karena butuh WebSocket.

**Agar Master bisa melihat dari SEMUA jaringan (4G/CGNAT, wifi sekolah/kantor, NAT ketat) wajib mengaktifkan server TURN (relay).**
STUN saja hanya menembus sebagian jaringan.

### Mengisi TURN Metered di Vercel
1. Daftar di [metered.ca](https://www.metered.ca) → **TURN Server** → buat aplikasi. Catat **nama domain** (mis. `namaapp.metered.live`) dan **API Key**.
2. Vercel → proyek → **Settings → Environment Variables**, tambahkan (centang Production, Preview, Development):
   - `METERED_DOMAIN` = `namaapp.metered.live`
   - `METERED_API_KEY` = API Key dari dashboard Metered
3. **Redeploy** (variabel baru hanya berlaku untuk deployment baru).
4. Cek: buka `/api/room?action=ice&code=KODE&token=TOKEN` dari sesi room yang sah → `relay` harus `true` dan daftar berisi `turn:`/`turns:`.

Urutan penyedia: **Metered → Cloudflare → coturn → TURN statis**. Bila Metered gagal (kunci salah / down), server otomatis mencoba penyedia berikutnya yang diisi.

| Penyedia | Variabel |
|---|---|
| **Metered.ca** (utama) | `METERED_DOMAIN`, `METERED_API_KEY` |
| Cloudflare Realtime TURN (cadangan) | `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` |
| coturn sendiri (static-auth-secret) | `TURN_URLS` (pisah koma), `TURN_SECRET` |
| TURN statis | `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` |

Koneksi video mencoba jalur langsung (P2P) dulu agar latensi terendah. Bila belum tersambung dalam ±9 detik, Master otomatis memaksa jalur relay TURN.
Fungsi Vercel dipasang di region **sin1 (Singapura)**; pilih juga region Upstash Redis **Singapore** agar sinyal & statistik cepat.

Kredensial hanya diberikan server ke peserta room (`GET /api/room?action=ice`). Tanpa TURN, tile video menampilkan
"server TURN belum diatur" bila jaringan memblokir P2P; skor dan status tetap tampil. Lalu-lintas yang lewat relay dihitung ke kuota penyedia
(≈ 0,8 Mbps × 4 pemain ≈ 1,4 GB per jam bila semua lewat relay).

## Layar penuh otomatis di HP
- **Android (Chrome dll.)**: layar penuh + kunci landscape dicoba pada **setiap ketukan** sampai berhasil (browser mewajibkan gestur pengguna, jadi tidak bisa 100% tanpa ketukan), dan masuk lagi di ketukan berikutnya bila tidak sengaja keluar. Bila pemain sengaja keluar lewat tombol layar penuh, game tidak memaksanya masuk lagi.
- **iPhone (Safari)** tidak punya API layar penuh untuk halaman web. Pemain diberi petunjuk sekali: *Bagikan → Tambah ke Layar Utama*, lalu buka dari ikon. Itu satu-satunya cara layar penuh sungguhan di iPhone (`manifest.webmanifest` + `apple-mobile-web-app-capable`).
- Di Android, "Tambah ke Layar Utama / Instal aplikasi" juga membuka game langsung fullscreen landscape tanpa ketukan.
- Layar HP dijaga tetap menyala (Screen Wake Lock) saat layar penuh/aplikasi terpasang, agar siaran video ke Room Master tidak membeku.

## Lokal
```bash
node dev-server.js        # http://localhost:3000 (penyimpanan memori, hanya untuk pengembangan)   — atau klik start.bat di Windows
npm test                  # 20 tes API + 7 tes pemilihan TURN: lewat memori DAN lewat jalur Redis REST (server tiruan format Upstash)
python3 test/e2e.py       # 3 browser Chromium: Room Master + 2 pemain (pip install playwright && playwright install chromium)
```
`test/e2e.py` memakai `test/three-stub.js` (pengganti three.js) supaya bisa jalan tanpa internet/GPU; ia hanya menguji alur online, bukan tampilan 3D.
Game memuat `three.js` dari cdnjs, jadi perangkat pemain perlu internet. Uji dengan Redis sungguhan: salin `.env.example` → `.env.local` dan isi variabelnya.

## Catatan biaya & batasan
- Redis: pemain yang bermain ±2 perintah/dtk (statistik tiap 2 dtk), Master ±3–8 perintah/dtk (polling 1,5 dtk; 0,6 dtk selama video belum tersambung),
  pemain di lobi/papan skor ±4 perintah/dtk. Satu ronde 4 pemain ±10 menit ≈ 7.000–10.000 perintah.
- **Skor dihitung di perangkat pemain**, jadi tidak kebal dari kecurangan lewat konsol browser. Server hanya membatasi nilai ke rentang wajar
  (skor ≤ 10.000, dst.). Cocok untuk kelas/teman, bukan turnamen berhadiah.
- Tab yang disembunyikan membuat browser memperlambat timer; statistik tetap dikirim tetapi video bisa membeku sampai tab dibuka lagi.
- Tanpa akun/login: siapa pun yang tahu kode dan room belum penuh/berjalan bisa bergabung.

## Struktur
```
api/room.js        satu Vercel Function: semua aksi (create/join/ready/level/start/loaded/stat/finish/forfeit/abort/leave/signal) + polling + ICE
lib/store.js       Upstash Redis lewat REST (tanpa dependensi npm); memori proses hanya untuk lokal/tes
lib/ice.js         STUN + TURN (Cloudflare / Metered / coturn / statis)
lib/core.js        penyaringan statistik & hasil dari klien
public/index.html  game + klien online (objek `Net`)
dev-server.js      server lokal untuk pengembangan & tes
vercel.json        outputDirectory = public, maxDuration fungsi 10 dtk
```
