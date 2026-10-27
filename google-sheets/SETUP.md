# Google Sheets — satu tab per Telegram group/chat

Bot memakai Apps Script sebagai bridge. Setiap grup Telegram mendapat tab Domains tersendiri di dalam satu file Google Sheets. Private chat juga mendapat tab sendiri. Semua tab tetap berada dalam satu file, jadi jangan bagikan file ini secara publik jika data tiap grup bersifat pribadi.

## Setup awal

1. Buka file Google Sheets yang mau dipakai.
2. Pilih **Extensions → Apps Script**.
3. Buka file `google-sheets/Code.gs` di repo ini, salin seluruh isinya, lalu ganti kode Apps Script yang lama.
4. Di Apps Script, buka **Project Settings → Script Properties** dan tambahkan:
   - `SPREADSHEET_ID`: ID file Google Sheets, yaitu teks di antara `/d/` dan `/edit` pada URL.
   - `SYNC_SECRET`: secret acak yang panjang. Jangan kirim atau commit secret ini.
5. Pilih fungsi `setupSheet` lalu klik **Run** sekali. Setujui izin Google. Ini membuat tab Instructions.
6. Klik **Deploy → Manage deployments**, edit deployment Web app yang sudah ada (atau buat deployment baru), pilih **Execute as: Me**, dan izinkan akses yang dapat menerima request dari Cloudflare Worker. Deploy versi terbaru dan salin URL yang berakhir dengan `/exec`.
7. Di Cloudflare Worker `domain-expiry-reminder` → **Settings → Variables and Secrets**, set:
   - `SHEETS_WEB_APP_URL` = URL Apps Script `/exec`
   - `SHEETS_SYNC_SECRET` = nilai yang sama dengan Script Property `SYNC_SECRET`
8. Pastikan `ADMIN_TELEGRAM_ID` atau `ADMIN_TELEGRAM_IDS` berisi Telegram user ID admin.
9. Di grup Telegram, kirim `/admin_sheet`. Bot akan membuat/memperbarui tab khusus untuk grup tersebut. Coba `/add` atau `/import`; perubahan domain berikutnya otomatis tersinkron.

## Nama tab

Tab diberi nama seperti `Group - Nama Grup [-100123...]` atau `Private - Nama Pengguna [123...]`. Chat ID ditambahkan agar nama grup yang sama tidak bertabrakan. Setiap sinkronisasi mengganti isi tab tersebut dengan snapshot terbaru dari grup itu saja; tab grup lain tidak dihapus atau diubah.

## Penting

- Perubahan pada file Apps Script belum berlaku sampai deployment Web app dipublikasikan ke versi terbaru.
- Satu file spreadsheet masih memiliki akses berbagi yang sama untuk semua tab. Kalau setiap grup perlu benar-benar terpisah dan tidak boleh melihat data grup lain, gunakan satu file spreadsheet terpisah per grup dengan pengaturan berbagi tersendiri; tab terpisah bukan batas keamanan.
- Jika sinkronisasi gagal, cek Cloudflare Worker logs dan Apps Script Executions.
