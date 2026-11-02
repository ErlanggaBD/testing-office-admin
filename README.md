# Prabu Docs Web

Aplikasi web untuk generate Invoice, Kwitansi, dan Surat Jalan dari PO PDF.

## Cara Jalan di Lokal

```bash
cd /home/erlangga/Documents/DEV/prabu-office-web
npm install
npm start
```

Buka browser ke `http://localhost:3000`, upload PO PDF, klik proses, download 3 dokumen.

## Cara Upload ke Shared Hosting

1. Upload seluruh folder `prabu-office-web` ke hosting (misal via FTP/cPanel).
2. Pastikan Node.js sudah terinstall di shared hosting (cek via cPanel > Setup Node.js App).
3. Via SSH atau cPanel terminal:
   ```bash
   cd prabu-office-web
   npm install --production
   npm start
   ```
4. Atur agar app berjalan sebagai service (via cPanel Node.js Application atau PM2).
5. Buka domain yang diatur.
