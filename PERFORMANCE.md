# Performance Notes — PROJECT MR DAIRY

Google Apps Script memiliki batas waktu eksekusi (±6 menit/eksekusi) dan kuota panggilan
layanan. Biaya terbesar hampir selalu berasal dari **jumlah panggilan API Spreadsheet**,
bukan dari perhitungan JavaScript. Seluruh keputusan teknis di bawah ini mengikuti prinsip itu.

---

## 1. Strategi yang diterapkan

| # | Strategi | Implementasi |
|---|----------|--------------|
| 1 | Batch read | `DB.read()` membaca seluruh sheet dengan **satu** `getValues()` lalu memetakannya menjadi object |
| 2 | Batch write | `DB.insertMany()` dan `DB.updateMany()` menulis dengan **satu** `setValues()` berapa pun jumlah barisnya |
| 3 | Hindari `getRange()` berulang | Tidak ada akses per sel/baris di seluruh service layer |
| 4 | Tidak ada API call di dalam loop | Loop hanya menyusun array di memori, penulisan dilakukan setelah loop |
| 5 | CacheService | Dataset di-cache per tabel, dipecah menjadi potongan 90KB agar tidak menabrak limit 100KB/key |
| 6 | PropertiesService | Menyimpan `SPREADSHEET_ID`, status setup, counter ID, session, dan stamp cache |
| 7 | LockService | Seluruh operasi tulis dibungkus `DB.withLock()` (timeout 25 detik) |
| 8 | Pagination server-side | `Utils.paginate()` — frontend hanya menerima baris yang ditampilkan |
| 9 | Lazy loading | Data halaman baru diambil saat halaman dibuka, bukan saat login |
| 10 | Debounce search | Input pencarian menunda panggilan ±300ms |
| 11 | Login ringan | Login hanya membaca sheet `USERS` |
| 12 | Dashboard agregat | Dashboard memakai matrix agregat, bukan raw transaksi |
| 13 | Detail on-demand | Review, detail MR, dan drill-down baru memanggil server saat dibuka |
| 14 | Cache master data | Master data memakai TTL lebih panjang (`MASTER_CACHE_TTL_SECONDS`, default 25 menit) |
| 15 | Hindari nested loop besar | Agregasi memakai map/bucket (O(n)), bukan pencarian bersarang |

---

## 2. Lapisan cache

```
Request  →  memo per-eksekusi (_memo)        ← nol biaya, hidup selama 1 eksekusi
         →  CacheService per tabel (chunked) ← TTL 5 menit (transaksi) / 25 menit (master)
         →  CacheService hasil komputasi     ← key mengandung "cache stamp" global
         →  Google Sheets                    ← hanya bila seluruh lapisan di atas miss
```

**Invalidasi:** setiap write memanggil `DB.invalidate(sheet)` yang (a) menghapus cache tabel dan
(b) menaikkan *cache stamp* global. Karena key hasil komputasi mengandung stamp tersebut,
seluruh turunannya (matrix allocation, dashboard, analytics) ikut kedaluwarsa seketika.
Diverifikasi otomatis oleh `test-performance.js` ("dashboard langsung mencerminkan data baru").

---

## 3. Angka terukur

Diukur dengan instrumentasi jumlah panggilan API Spreadsheet pada `tools/test-performance.js`
(dataset demo + 300 dokumen MR tambahan):

| Operasi | Panggilan `getValues` | Panggilan `setValues` | Catatan |
|---------|----------------------:|----------------------:|---------|
| `setupDatabase()` | 5 | 26 | Sekali seumur instalasi |
| `createDemoData()` (≈500 baris) | — | 8 | ±64 baris per penulisan |
| `dashboard.summary` (cold) | 8 | 0 | Membaca 4 tabel + master |
| `dashboard.summary` (warm) | 0 | 0 | Seluruhnya dari cache |
| `distribution.workspace` halaman 2 | 0 | 0 | Pagination tidak membaca ulang |
| `mr.list` untuk 315 dokumen | 1 | 0 | Tidak ada N+1 |
| Insert 300 dokumen MR | — | 1 | Satu `setValues` |
| Update 1 baris MR | 2 | 1 | Hanya baris terkait |
| Update 50 baris MR | 1 | 1 | Tetap satu penulisan |
| `auth.login` | 1 | — | 9 sel dibaca |

---

## 4. Pengalaman di frontend

- **Skeleton, bukan spinner berkepanjangan.** KPI, chart, dan tabel memiliki skeleton
  masing-masing sehingga tata letak tidak melompat saat data tiba.
- **Tidak ada layar putih.** Boot screen tampil sebelum bootstrap, halaman bertransisi
  dengan animasi 260ms.
- **`requestAnimationFrame`** dipakai sebelum render besar agar frame tidak tersendat.
- **Chart SVG buatan sendiri** (tanpa library eksternal) — tidak ada request jaringan
  tambahan dan ukuran payload tetap kecil.
- **Re-render chart di-debounce** saat resize (180ms).

---

## 5. Bila data tumbuh besar

| Situasi | Tindakan |
|---------|----------|
| > 50.000 baris transaksi | Arsipkan periode lama ke spreadsheet terpisah; aplikasi hanya membutuhkan periode analisis aktif |
| Eksekusi mendekati batas waktu | Persempit rentang tanggal default (`ANALYSIS_PERIOD_MONTHS`), turunkan `DEFAULT_PAGE_SIZE` |
| Cache sering miss (payload > 900KB) | Sistem otomatis melewati cache; pertimbangkan pemecahan data per region/periode |
| Banyak user bersamaan | `LockService` mengantre penulisan; pembacaan tidak terkunci sehingga tetap lancar |
