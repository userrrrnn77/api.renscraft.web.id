#!/bin/bash
# Hentikan script kalau ada command yang error
set -e 

echo "🚀 Mulai build project..."
bun run build

echo "📦 Memindahkan folder dist ke server production..."
rm -rf /home/rendy/renscraft-server/dist
cp -r dist /home/rendy/renscraft-server/

echo "📄 Memindahkan package.json dan .env..."
cp package.json /home/rendy/renscraft-server/

# Cek apakah ada file .env di lokal, kalau ada langsung copy
if [ -f .env ]; then
    cp .env /home/rendy/renscraft-server/.env
    echo "✅ .env berhasil di-copy."
else
    echo "⚠️ File .env tidak ditemukan di lokal, skip copy."
fi

echo "🔄 Restarting PM2 dengan environment terbaru..."
# --update-env WAJIB dipakai biar PM2 baca ulang file .env yang baru aja di-copy
pm2 restart renscraft-api renscraft-ocr --update-env

echo "✅ Deploy selesai! Server sudah pake kode terbaru dan .env terbaru."