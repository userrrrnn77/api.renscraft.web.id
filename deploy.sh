#!/bin/bash

echo "🚀 Mulai build project..."
bun run build

if [ $? -ne 0 ]; then
    echo "❌ Build gagal! Cek error TypeScript di atas."
    exit 1
fi

echo "📦 Memindahkan folder dist ke server production..."
rm -rf /home/rendy/renscraft-server/dist
cp -r dist /home/rendy/renscraft-server/

# Hapus juga package.json (kalau ada update dependency)
cp package.json /home/rendy/renscraft-server/

echo "🔄 Restarting PM2..."
pm2 restart renscraft-api

echo "✅ Deploy selesai! Server sudah pake kode terbaru."