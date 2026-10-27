# Google Sheets — master + file terpisah per grup

Cloudflare D1 tetap menjadi database utama. Apps Script menyinkronkan snapshot ke Sheet master, lalu ke file Google Sheets terpisah untuk grup jika mapping grup sudah terdaftar.

## Setup master

1. Buka Google Sheets master yang sudah dipakai, lalu **Extensions → Apps Script**.
2. Ganti seluruh kode Apps Script dengan isi terbaru `google-sheets/Code.gs` dari repo.
3. Di **Project Settings → Script Properties**, pastikan `SPREADSHEET_ID` berisi ID Sheet master dan `SYNC_SECRET` sama dengan `SHEETS_SYNC_SECRET` di Worker.
4. Jalankan `setupSheet()` sekali dan setujui otorisasi.
5. **Deploy → Manage deployments → Edit Web app → New version → Deploy**. Gunakan URL `/exec` yang sama.
6. Di Worker Production, pastikan `SHEETS_WEB_APP_URL` dan `SHEETS_SYNC_SECRET` sudah benar.

## Migration D1 wajib

Jalankan isi `worker/migrations/0002_chat_sheets.sql` pada database D1 Production yang dipakai Worker sebelum memakai fitur ini.

## Hubungkan Sheet khusus grup

1. Buat Google Sheets baru untuk grup.
2. Bagikan file itu kepada akun Google yang menjalankan Apps Script dengan izin **Editor**.
3. Dari grup Telegram, admin bot kirim `/admin_sheet <URL atau ID Google Sheets grup>`.
4. Worker menyimpan mapping grup → spreadsheet di D1, lalu menyinkronkan master dan Sheet grup.
5. Setelah terhubung, perubahan domain berikutnya otomatis menyinkronkan kedua tujuan.

Kirim `/admin_sheet` tanpa argumen untuk sinkronisasi ulang. Untuk mengganti Sheet grup, kirim lagi perintah dengan URL/ID baru.

## Keamanan

- Master berisi database utama. Sheet grup hanya menerima domain yang terkait dengan chat ID grup tersebut.
- Atur sharing setiap file grup sendiri; hanya pengguna yang diberi akses ke file itu yang bisa membukanya. Jangan bagikan master ke member.
- Apps Script harus berjalan sebagai akun yang memiliki akses Editor ke master dan setiap Sheet grup.
- `setupSheet()` membuat/memperbarui tab Instructions di master; tidak menghapus tab lama.
