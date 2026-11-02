# Prabu Docs Web

Aplikasi web untuk generate Invoice, Kwitansi, dan Surat Jalan dari PO PDF.

## Fitur Login

Sistem ini dilengkapi dengan login sederhana sebelum mengakses aplikasi.

**Default credentials:**
- Username: `admin`
- Password: `prabu2026`

**Ganti credentials:**
Set environment variable di shared hosting/cPanel:
- `ADMIN_USER` - username baru
- `ADMIN_PASS` - password baru
- `SESSION_SECRET` - secret untuk session (opsional, untuk keamanan)

## Cara Jalan di Lokal

```bash
cd /home/erlangga/Documents/DEV/prabu-office-web
npm install
npm start
```

Buka browser ke `http://localhost:3000`, login dengan credentials default, upload PO PDF, klik proses, download 3 dokumen.

## Cara Upload ke Shared Hosting

1. Upload file `prabu-office-web-deploy.zip` ke shared hosting via FTP/cPanel File Manager
2. Ekstrak zip di folder `public_html` atau subfolder
3. Pastikan Node.js sudah terinstall di shared hosting (cek via cPanel > Setup Node.js App)
4. Via cPanel Terminal atau SSH:
   ```bash
   cd prabu-office-web
   npm install --production
   ```
5. Setup Node.js Application di cPanel:
   - Startup file: `server.js`
   - App path: folder project
6. Jalankan app
7. Buka domain yang diatur, login dengan credentials default

## Integrasi dengan Landing Page

Jika ingin mengintegrasikan dengan landing page BiraFlow, update tombol "Sign in" di landing page untuk mengarah ke URL aplikasi ini (misal `/login.html` atau `https://domain.com/login.html`).
