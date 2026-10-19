@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terpasang. Unduh dari https://nodejs.org lalu jalankan ulang file ini.
  pause
  exit /b 1
)
set MIN_PLAYERS=2
echo Server lokal untuk uji coba (penyimpanan memori). Untuk online sungguhan, deploy ke Vercel (lihat README.md).
node dev-server.js
pause
