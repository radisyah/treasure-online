# TROVERAID — Mode Online (1 Room Master + 2–4 pemain) untuk Vercel

Versi online *TROVERAID* dengan cara kerja yang sama seperti **angry-birds-online**:
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
3. Master memilih level, lalu **MULAI PERTANDINGAN** (aktif bila jumlah pemain ≥ `MIN_PLAYERS` — bawaan **2** — dan semua pemain yang hadir sudah menekan SIAP).
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
3. (Opsional) **Settings → Environment Variables**: `MIN_PLAYERS` (1–4, bawaan **2**; isi `4` bila ingin wajib 4 pemain; jangan diisi bila cukup 2) dan TURN (lihat bawah).
4. **Redeploy** (variabel baru hanya berlaku untuk deployment baru).
5. Buka URL proyek → buat room → bagikan tautan/kodenya.

Bila Redis belum terhubung, API membalas: *"Database belum dikonfigurasi…"*.

## Pandangan pemain → Room Master (WebRTC DataChannel) dan TURN
Video **tidak lewat server Vercel**. Master membuat *offer*, pemain menjawab; server hanya menukar pesan sinyal lewat Redis (tidak ada WebSocket).
**Sinyal cepat (long-poll):** handshake dimulai begitu pemain selesai memuat level (Master mengirim *offer* ke pemain yang sudah `loaded`), jadi hitung mundur ±4 dtk dipakai untuk menyambungkan video dan gambar umumnya sudah tampil saat pertandingan mulai. Offer/answer dibaca lewat `GET /api/room?action=sig`: server menahan permintaan (maks. 5 dtk, cek Redis tiap 0,12 dtk) dan menjawab segera setelah pesan ada, sehingga pesan sampai dalam ±0,1 dtk, bukan menunggu polling 0,6–2 dtk. Polling `state`/`stat` tetap menjadi cadangan (mis. untuk offer ulang). Kredensial TURN juga diminta lebih awal (saat ronde dimulai) dan pengumpulan kandidat ICE tanpa TURN tidak lagi menunggu status `complete`.
**Mode siaran data posisi (bukan video).** Pemain tidak lagi mengirim video. Lewat koneksi WebRTC yang sama, hanya data kecil yang dikirim lewat *DataChannel* (tanpa urutan, tanpa kirim ulang): posisi, arah hadap, dan flag jalan/lari/senter ±20× per detik, ditambah status peti, pintu, kartu, catatan, dan terminal tiap 0,5 dtk. Totalnya kira-kira 1–3 KB/dtk per pemain. Master membangun arena yang sama (level deterministik), lalu merender keempat pandangan sendiri dengan kamera yang sama seperti pemain, dihaluskan sehingga bisa tampil **720p (1280×720) di 60 fps** mengikuti refresh layar (layar yang di-**ZOOM** dirender 1080p lewat `Net.ZOOMK`). Kualitas tidak lagi bergantung pada wifi, hanya pada GPU laptop Master. Ubah `FW`/`FH` di objek `Net` untuk resolusi lain (mis. 960×540 bila GPU Master kewalahan merender 4 layar 720p).
Konsekuensi: tampilan Master mirip, bukan identik piksel demi piksel. Partikel pemain tidak ikut tampil. **Seluruh notifikasi di layar pemain** (toast seperti "Kartu akses diperoleh", "Jebakan aktif", "Butuh Kartu Akses", isi catatan yang dibaca, dan teks prompt interaksi seperti "[E] Buka peti") **diteruskan ke tile pemain tersebut di layar Room Master** lewat DataChannel yang sama (dikirim 3× agar tahan kehilangan paket, duplikat dibuang; maks. 4 notifikasi bertumpuk per tile). Panel soal yang sedang dikerjakan tampil di tiap tile, dan statistik terlihat di baris status di bawahnya. Kebutuhan TURN jauh lebih kecil, tetapi tetap disarankan bila jaringan memblokir P2P.

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
(hanya beberapa KB/dtk per pemain).

## Performa Room Master (target 60 fps dengan 4 pemain)
Master merender 4 pandangan sekaligus di GPU laptopnya, jadi beban ada di GPU Master, bukan di jaringan. Yang sudah dioptimalkan di `public/index.html` (objek `Net`, fungsi `mvFrame`, `mvShadow`, `mvLights`):
- **Resolusi render dinamis (DRS)**: mulai dari 72 % × 720p, lalu turun cepat bila di bawah ±52 fps dan naik pelan lewat uji coba berkala (level yang gagal dilarang 60 dtk). Label di tiap tile menampilkan `60 FPS · 518p` — angka kedua = resolusi render saat ini. Bila sudah di skala terendah (50 %) dan masih berat, layar bergantian 30 fps (tanda ½).
- **Grid 4 layar tanpa bayangan & tanpa outline hitam**; keduanya aktif lagi saat satu layar di-**ZOOM** (hanya 1 layar dirender).
- **Lampu peti dibatasi 3 terdekat per layar** (jumlah lampu tetap, jadi shader tidak dikompilasi ulang antarlayar).
- **Layar pemain yang diam dirender 30 fps**; layar >100 Hz dibatasi; kanvas tile 2D tanpa alpha.
- **MSAA otomatis mati di layar HiDPI** (devicePixelRatio ≥ 1,5). Paksa: `?aa=0` / `?aa=1` di URL, atau `localStorage.troveraid_aa`.
Tips sisi Master: colok charger + mode daya *Best performance*, Chrome/Edge dengan *hardware acceleration* aktif, tutup tab/aplikasi lain, perbarui driver AMD, dan pakai **satu** jendela Master saja.

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
- Redis: pemain yang bermain ±2 perintah/dtk (statistik tiap 2 dtk), Master ±3–8 perintah/dtk (polling 1,5 dtk; 0,6 dtk selama video belum tersambung; 0,5 dtk saat memuat level),
  pemain di lobi/papan skor ±4 perintah/dtk. Long-poll sinyal menambah ±8 perintah/dtk hanya untuk peserta yang sedang menunggu offer/answer (beberapa detik per pemain; berhenti begitu video tersambung). Satu ronde 4 pemain ±10 menit ≈ 7.000–10.000 perintah.
- **Skor dihitung di perangkat pemain**, jadi tidak kebal dari kecurangan lewat konsol browser. Server hanya membatasi nilai ke rentang wajar
  (skor ≤ 10.000, dst.). Cocok untuk kelas/teman, bukan turnamen berhadiah.
- Tab yang disembunyikan membuat browser memperlambat timer; statistik tetap dikirim tetapi video bisa membeku sampai tab dibuka lagi.
- Tanpa akun/login: siapa pun yang tahu kode dan room belum penuh/berjalan bisa bergabung.

## Struktur
```
api/room.js        satu Vercel Function: semua aksi (create/join/ready/level/start/loaded/stat/finish/forfeit/abort/leave/signal) + polling + ICE + `sig` (long-poll sinyal WebRTC)
lib/store.js       Upstash Redis lewat REST (tanpa dependensi npm); memori proses hanya untuk lokal/tes
lib/ice.js         STUN + TURN (Cloudflare / Metered / coturn / statis)
lib/core.js        penyaringan statistik & hasil dari klien
public/index.html  game + klien online (objek `Net`)
dev-server.js      server lokal untuk pengembangan & tes
vercel.json        outputDirectory = public, maxDuration fungsi 10 dtk
```
