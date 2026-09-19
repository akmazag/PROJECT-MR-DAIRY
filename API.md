# API Contract — PROJECT MR DAIRY

Seluruh komunikasi frontend ↔ backend melewati **satu pintu**:

```js
google.script.run
  .withSuccessHandler(handle)
  .withFailureHandler(handleError)
  .api(action, token, payload);
```

Keuntungan pola ini: autentikasi, otorisasi, penanganan error, dan audit terpusat di satu
tempat (`Code.gs`), dan menambah fitur berarti menambah satu baris pada tabel route.

---

## 1. Bentuk response

Sukses:

```json
{ "success": true, "data": { "...": "..." } }
```

Gagal:

```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Return Qty harus lebih besar dari 0.", "details": null }
}
```

Frontend tidak pernah menerima stack trace. Pesan selalu berbahasa manusia dan siap
ditampilkan langsung kepada user.

## 2. Autentikasi

1. `api('auth.login', null, { username, password })` → `{ token, user, navigation, permissions, app }`
2. Token disimpan di `localStorage` dan dikirim pada setiap panggilan berikutnya.
3. Server memvalidasi token pada session store (CacheService + PropertiesService) dan
   membaca role dari sana — **role dari frontend tidak pernah dipercaya**.
4. Sesi diperpanjang otomatis (sliding) bila sisa waktu < 50% dari `SESSION_TIMEOUT_MINUTES`.
5. `AUTH_REQUIRED` / `AUTH_EXPIRED` membuat frontend kembali ke halaman login.

## 3. Kode error

| Kode | Arti |
|------|------|
| `UNKNOWN_ACTION` | Action tidak terdaftar pada router |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` | Belum login atau sesi habis |
| `AUTH_FAILED` / `AUTH_LOCKED` / `AUTH_INACTIVE` | Kredensial salah, terkunci sementara, atau akun nonaktif |
| `FORBIDDEN` | Role tidak memiliki permission |
| `VALIDATION_ERROR` | Input tidak valid |
| `OVERRIDE_REASON_REQUIRED` | Manual override allocation tanpa alasan |
| `INVALID_STATE` | Transisi status tidak diizinkan |
| `NOT_FOUND` | Data tidak ditemukan |
| `DUPLICATE` | Kode/username sudah dipakai |
| `LOCK_TIMEOUT` | Transaksi lain sedang menulis |
| `SHEET_NOT_FOUND` / `NO_SPREADSHEET` | Database belum siap |
| `INTERNAL_ERROR` | Kesalahan tak terduga (detail ada di Execution log) |

## 4. Daftar action

| Action | Permission | Keterangan |
|--------|------------|------------|
| `analytics.drill` | `analytics.view` | Drill-down satu titik chart |
| `analytics.export` | `report.export` | Export CSV |
| `analytics.overview` | `analytics.view` | 10 chart + ringkasan |
| `analytics.report` | `analytics.view` | Preview report (paginated) |
| `analytics.reports` | `analytics.view` | Katalog report |
| `audit.list` | `audit.view` | Audit log (filter + pagination) |
| `auth.changePassword` | _login saja_ | Ganti password sendiri |
| `auth.login` | _publik_ | Login, mengembalikan token + navigasi + permission |
| `auth.logout` | _publik_ | Akhiri sesi |
| `auth.session` | _publik_ | Ambil sesi aktif dari token (untuk restore setelah refresh) |
| `dashboard.summary` | `dashboard.view` | KPI, trend, objective, tindak lanjut |
| `distribution.applyCluster` | `distribution.plan` | Terapkan usulan cluster ke master |
| `distribution.clusters` | `distribution.view` | Hasil clustering account |
| `distribution.planPreview` | `distribution.view` | Rincian rekomendasi satu pasangan |
| `distribution.planStatus` | `distribution.approve` | Approve / reject / ubah status rencana |
| `distribution.plans` | `distribution.view` | Daftar rencana tersimpan |
| `distribution.review` | `distribution.review` | Review Data account / account x SKU |
| `distribution.savePlan` | `distribution.plan` | Simpan plan sell in (mendukung batch) |
| `distribution.submitPlan` | `distribution.plan` | Ubah status rencana menjadi SUBMITTED |
| `distribution.workspace` | `distribution.view` | KPI + trend + tabel allocation (paginated) |
| `master.accounts` | `master.view` | Daftar account |
| `master.saveAccount` | `master.edit` | Tambah / ubah account |
| `master.saveSku` | `master.edit` | Tambah / ubah SKU |
| `master.saveUser` | `user.manage` | Tambah / ubah user |
| `master.skus` | `master.view` | Daftar SKU |
| `master.toggleAccount` | `master.edit` | Aktif / nonaktifkan account (soft delete) |
| `master.toggleSku` | `master.edit` | Aktif / nonaktifkan SKU |
| `master.users` | `user.manage` | Daftar user (tanpa password hash) |
| `monitoring.board` | `monitoring.view` | STEP 5 papan Kanban + ringkasan SLA |
| `mr.approve` | `mr.approve` | STEP 3 approval Sales (opsional langsung buat SO) |
| `mr.complete` | `mr.complete` | Selesaikan MR + catat realisasi return |
| `mr.create` | `mr.create` | STEP 1 input admin (validasi otomatis dijalankan) |
| `mr.createSO` | `mr.createSO` | STEP 4 buat SO otomatis |
| `mr.detail` | `mr.view` | Detail MR + validasi + timeline + audit |
| `mr.formOptions` | `mr.view` | Opsi & default untuk form input MR |
| `mr.list` | `mr.view` | Daftar dokumen MR (filter + pagination) |
| `mr.reject` | `mr.approve` | Tolak dokumen (wajib alasan) |
| `mr.schedule` | `mr.schedule` | Tetapkan jadwal penarikan |
| `mr.submit` | `mr.update` | Kirim ke Sales |
| `mr.update` | `mr.update` | Ubah dokumen sebelum approval |
| `mr.validate` | `mr.validate` | STEP 2 jalankan ulang validasi |
| `settings.list` | `settings.view` | Seluruh business rule + nilai default |
| `settings.reset` | `settings.edit` | Kembalikan satu setting ke default |
| `settings.update` | `settings.edit` | Simpan perubahan business rule |
| `sop.bap` | `sop.view` | Ketentuan BAP + dampaknya |
| `sop.cutoff` | `sop.view` | Komitmen cutoff potong tagihan |
| `sop.pickup` | `sop.view` | Timeline jadwal penarikan |
| `sop.updateRule` | `sop.edit` | Ubah aturan SOP (whitelist key) |
| `sop.updateSop` | `sop.edit` | Ubah definisi SOP |
| `sop.workflow` | `sop.view` | 3 langkah SOP + tingkat kepatuhan |
| `system.demo` | `setup.run` | Buat / reset demo data |
| `system.master` | _login saja_ | Master data ringan + enum + setting untuk frontend |
| `system.setup` | `setup.run` | Jalankan setupDatabase() dari aplikasi |
| `system.status` | _publik_ | Status kesiapan database (dipakai sebelum login) |

## 5. Menambah action baru

1. Tambahkan fungsi pada service terkait (`*Service.gs`).
2. Daftarkan satu baris pada `getApiRoutes_()` di `Code.gs`:
   ```js
   'modul.aksi': {
     permission: 'modul.permission',
     handler: function (session, payload) { return ModulService.aksi(session, payload); }
   }
   ```
3. Bila permission baru, tambahkan ke `PERMISSIONS` pada `Config.gs`.
4. Panggil dari frontend: `Api.call('modul.aksi', payload)`.

Router otomatis menangani autentikasi, otorisasi, envelope response, dan logging error.
