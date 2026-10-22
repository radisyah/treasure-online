"""Tes e2e: 3 browser Chromium (Room Master + 2 pemain) melawan dev-server (penyimpanan memori, MIN_PLAYERS=2).
   Jalankan:  pip install playwright && playwright install chromium   lalu   python3 test/e2e.py
   Tanpa internet/GPU: three.js diganti test/three-stub.js (hanya menguji alur online, bukan tampilan 3D).
   Hook tes (window.__t) disuntikkan lewat intersepsi route; file produksi tidak diubah. """
import os, subprocess, sys, time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = os.environ.get('PORT', '3411')
BASE = 'http://localhost:' + PORT
STUB = open(os.path.join(ROOT, 'test', 'three-stub.js'), encoding='utf-8').read()
passed, failed = 0, 0


def check(name, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  ✔', name)
    else:
        failed += 1
        print('  ✘', name, extra)


def wait(pg, js, timeout=20000, label=''):
    try:
        pg.wait_for_function(js, timeout=timeout)
        return True
    except Exception:
        return False


def new_page(ctx, logs, tag):
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: logs.append(tag + ' PAGEERROR: ' + str(e)))
    pg.on('console', lambda m: logs.append(tag + ' ' + m.type + ': ' + m.text) if m.type in ('error',) else None)

    def index(route):
        r = route.fetch()
        body = r.text().replace('boot();\n})();', 'window.__t={G,Net,winLevel,failLevel};boot();\n})();')
        route.fulfill(response=r, body=body)
    pg.route(lambda u: urlparse(u).path == '/' and urlparse(u).netloc == urlparse(BASE).netloc, index)
    pg.route('**/three.min.js', lambda r: r.fulfill(body=STUB, content_type='text/javascript'))
    pg.route('https://fonts.*/**', lambda r: r.abort())
    return pg


def open_online(pg, url):
    pg.goto(url)
    wait(pg, "document.getElementById('menu').classList.contains('show')")
    pg.click('#mOnline')
    pg.fill('#njName', 'x')


def main():
    env = dict(os.environ, PORT=PORT, MIN_PLAYERS='2')
    srv = subprocess.Popen(['node', os.path.join(ROOT, 'dev-server.js')], env=env, stdout=subprocess.PIPE, text=True)
    srv.stdout.readline()
    logs = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'])
            cm, c1, c2 = b.new_context(), b.new_context(), b.new_context()
            M, P1, P2 = new_page(cm, logs, 'M'), new_page(c1, logs, 'P1'), new_page(c2, logs, 'P2')

            print('Room Master membuat room')
            open_online(M, BASE + '/')
            M.fill('#njName', 'Guru')
            M.click('#njCreate')
            ok = wait(M, "document.getElementById('lobby').classList.contains('show') && /KODE ROOM: [A-Z0-9]{5}/.test(document.getElementById('lbCode').textContent)")
            code = M.inner_text('#lbCode').split(':')[1].strip() if ok else ''
            check('lobi Master tampil dengan kode 5 karakter', ok and len(code) == 5, code)
            check('tautan ajakan tampil untuk Master', ('?room=' + code) in M.inner_text('#lbAddr'))
            check('tombol MULAI nonaktif sebelum pemain masuk', M.is_disabled('#lbStart'))

            print('Dua pemain bergabung lewat tautan ?room=KODE')
            open_online(P1, BASE + '/?room=' + code.lower())
            check('kode terisi otomatis & huruf besar', P1.input_value('#njCode') == code)
            P1.fill('#njName', 'Ayu'); P1.click('#njJoin')
            open_online(P2, BASE + '/?room=' + code)
            P2.fill('#njName', 'Budi'); P2.click('#njJoin')
            check('P1 masuk lobi', wait(P1, "document.getElementById('lobby').classList.contains('show')"))
            check('P2 masuk lobi', wait(P2, "document.getElementById('lobby').classList.contains('show')"))
            check('Master melihat 2 pemain (via polling)', wait(M, "document.querySelectorAll('#lbSlots .slotrow .nm').length>=3 && /Ayu/.test(document.getElementById('lbSlots').textContent) && /Budi/.test(document.getElementById('lbSlots').textContent)", 8000))

            print('Muat ulang halaman di lobi → sesi tersambung kembali')
            P1.reload()
            check('P1 kembali ke lobi yang sama setelah reload', wait(P1, "document.getElementById('lobby').classList.contains('show') && /Ayu/.test(document.getElementById('lbSlots').textContent)", 8000))

            print('Siap & mulai pertandingan')
            P1.click('#lbReady'); P2.click('#lbReady')
            check('tombol MULAI aktif setelah semua siap', wait(M, "!document.getElementById('lbStart').disabled", 8000))
            M.select_option('#lbLevel', '2')
            time.sleep(0.5)
            M.click('#lbStart')
            check('Master masuk tampilan 4 layar', wait(M, "document.getElementById('masterview').classList.contains('show')", 8000))
            check('pemain memuat level lalu hitung mundur serentak → PLAYING', wait(P1, "__t.G.state==='PLAYING'", 25000) and wait(P2, "__t.G.state==='PLAYING'", 25000))
            check('level yang dimainkan = level pilihan Master (2)', P1.evaluate('__t.G.def.id') == 2 and P2.evaluate('__t.G.def.id') == 2)

            print('Statistik langsung & video')
            check('Master menerima statistik pemain', wait(M, "/💰/.test(document.querySelector('#mvGrid .mvt .f2').textContent)", 10000))
            linked = wait(M, "Object.values(__t.Net.links).some(l=>l.ok)", 25000)
            check('video WebRTC tersambung ke Master (lewat sinyal Redis/polling)', linked, '(butuh ICE lokal; abaikan bila lingkungan memblokir)')
            if linked:
                # mode data pose: tidak ada <video>; notifikasi layar pemain harus tampil di tile Master
                P1.evaluate("__t.Net.pushNote('Uji notifikasi pemain 1','good',4000)")
                P2.evaluate("__t.Net.pushNote('Uji notifikasi pemain 2','warn',4000)")
                check('notifikasi Pemain 1 tampil di tile Master (slot 1)', wait(M, "/Uji notifikasi pemain 1/.test(document.querySelectorAll('#mvGrid .mvt')[0].querySelector('.mvtoasts').textContent)", 6000))
                check('notifikasi Pemain 2 tampil di tile Master (slot 2)', wait(M, "/Uji notifikasi pemain 2/.test(document.querySelectorAll('#mvGrid .mvt')[1].querySelector('.mvtoasts').textContent)", 6000))
                check('notifikasi dikirim 3x tetapi hanya tampil sekali (duplikat dibuang)', M.evaluate("document.querySelectorAll('#mvGrid .mvt')[0].querySelectorAll('.mvtoast').length") == 1)
                check('resolusi tile Master default 720p', M.evaluate('__t.Net.FW') == 1280 and M.evaluate('__t.Net.FH') == 720)

            print('Akhir ronde: P1 menang, P2 gagal')
            P1.evaluate('__t.winLevel()')
            check('P1 melihat layar hasil online', wait(P1, "document.getElementById('result').classList.contains('show')", 8000))
            P2.evaluate("__t.failLevel('Waktu habis')")
            check('papan peringkat memuat 2 baris hasil di P1', wait(P1, "document.querySelectorAll('#rBoard table tr').length>=3", 10000))
            check('P1 dikenali sebagai pemenang (Selesai) & P2 Gagal', wait(P1, "/Selesai/.test(document.getElementById('rBoard').textContent) && /Gagal/.test(document.getElementById('rBoard').textContent)", 5000))
            check('Master kembali ke fase lobi (ronde berakhir)', wait(M, "__t.Net.room && __t.Net.room.phase==='lobby'", 8000))
            P1.click('#rBtns button'); P2.click('#rBtns button')
            check('pemain kembali ke lobi dengan papan hasil ronde terakhir', wait(P1, "document.getElementById('lobby').classList.contains('show') && /Hasil ronde terakhir/.test(document.getElementById('lbBoard').textContent)", 5000))

            print('Ronde 2: Master menghentikan pertandingan')
            P1.click('#lbReady'); P2.click('#lbReady')
            wait(M, "!document.getElementById('lbStart').disabled", 8000)
            M.click('#mvLobby') if M.is_visible('#mvLobby') else None
            M.click('#lbStart')
            check('ronde 2 dimulai', wait(P1, "__t.G.state==='PLAYING'", 25000) and wait(P2, "__t.G.state==='PLAYING'", 25000))
            M.click('#mvAbort'); M.click('#cYes')
            check('pemain dikembalikan ke lobi saat Master menghentikan', wait(P1, "document.getElementById('lobby').classList.contains('show') && __t.G.state==='MAIN_MENU'", 10000) and wait(P2, "document.getElementById('lobby').classList.contains('show')", 10000))
            check('toast pemberitahuan tampil', 'dihentikan' in P1.inner_text('#toast'))

            print('Pemain keluar & Master menutup room')
            P2.click('#lbLeave'); P2.click('#cYes')
            check('P2 kembali ke menu utama', wait(P2, "document.getElementById('menu').classList.contains('show')", 8000))
            check('slot P2 kosong di lobi Master', wait(M, "!/Budi/.test(document.getElementById('lbSlots').textContent)", 8000))
            M.click('#lbLeave'); M.click('#cYes')
            check('Master keluar → pemain tersisa dikeluarkan ke menu', wait(P1, "document.getElementById('menu').classList.contains('show')", 8000) and 'ditutup' in P1.inner_text('#toast'))
            b.close()
    finally:
        srv.terminate()
    errs = [l for l in logs if 'PAGEERROR' in l or 'Kesalahan pada loop' in l]
    print('\nError halaman terdeteksi:', len(errs))
    for l in errs[:6]:
        print('   ', l[:240])
    print('\n%d lolos, %d gagal' % (passed, failed))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
