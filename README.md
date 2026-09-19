# PROJECT MR DAIRY

**Distribution Planning & Market Return Management**
Aplikasi web berbasis **Google Apps Script + Google Sheets** untuk menurunkan Market Return
dairy melalui allocation planning yang akurat dan administrasi MR yang terstruktur.

> Objective: **Less Return. More Freshness.**

```
                    PROJECT MR DAIRY
                           │
             ┌─────────────┴─────────────┐
   DISTRIBUTION PLANNING          MR ADMINISTRATION
        Review Data                   Input MR
        Clustering                    Validasi
        Plan Sell In                  Approval Sales
        Allocation                    Create SO
             └─────────────┬─────────────┘
                     MONITORING
                           │
              ┌────────────┴────────────┐
       Less Market Return        More Freshness
```

---

## 1. Mulai dalam 5 langkah

| # | Langkah | Detail |
|---|---------|--------|
| 1 | Buat Google Spreadsheet baru | Beri nama mis. `PROJECT MR DAIRY — DATABASE`. **Tidak perlu membuat sheet apa pun.** |
| 2 | Buka `Extensions → Apps Script` | Hapus `Code.gs` bawaan |
| 3 | Salin seluruh file dari `apps-script/` | 14 file `.gs` + 14 file `.html` (nama file harus sama persis, tanpa ekstensi `.gs`/`.html` saat dibuat di editor) |
| 4 | Jalankan `setupDatabase()` lalu `createDemoData()` | Pilih fungsi di toolbar editor → Run → Authorize |
| 5 | `Deploy → New deployment → Web app` | Execute as **Me**, akses sesuai kebutuhan → buka URL |

Panduan lengkap beserta screenshot langkah: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

### Akun demo

| Username | Password | Role | Akses utama |
|----------|----------|------|-------------|
| `admin` | `admin123` | ADMIN | Seluruh modul + Settings + Master Data |
| `manager` | `manager123` | MANAGER | Dashboard, Planning, Approval rencana, Monitoring |
| `sales` | `sales123` | SALES | Approval MR, Dashboard, Monitoring |
| `mr` | `mr123` | MR | Input MR, Validasi, Create SO, Jadwal penarikan |
| `viewer` | `viewer123` | VIEWER | Read-only |

> **Produksi:** ganti seluruh password default melalui `Settings → Master Data → User`
> segera setelah deployment pertama.

---

## 2. Yang dikerjakan aplikasi ini

**Distribution Planning**
- Menghitung AVG Sell Out, AVG Return, MR%, dan Stock Movement per **Account × SKU**
- Clustering account (HIGH / MEDIUM / LOW) dari 4 indikator, bukan hanya volume
- Indikator risiko Market Return dari 4 indikator (MR%, stock cover, shelf life, tren sell out)
- Recommended Allocation dengan formula yang **sepenuhnya configurable**
- Determine Plan Sell In: terima rekomendasi, ubah manual (wajib alasan), submit, approve

**MR Administration**
- Input admin → validasi otomatis 11 pemeriksaan → approval Sales → **create SO otomatis**
  (`SO-MR-YYYYMMDD-XXXX`) → jadwal penarikan → selesai
- SOP MR: plotting jadwal penarikan, komitmen cutoff potong tagihan, ketentuan BAP
- Monitoring Kanban 7 tahap + pelacakan SLA + deteksi missed PO
- Audit trail untuk setiap login, perubahan, approval, override dan pembuatan SO

**Analytics & Report**
- 10 chart interaktif dengan drill-down
- 5 report siap export CSV (Excel compatible)

---

## 3. Struktur file

```
apps-script/                       ← salin seluruh isinya ke Apps Script editor
├── appsscript.json                Manifest (timezone, webapp config)
│
├── Config.gs                      Schema 11 sheet, enum, permission matrix, 60 business rule
├── Utils.gs                       Helper: response envelope, tanggal, angka, array, CSV
├── Database.gs                    Data Access Layer: batch I/O, cache, lock, sequence, Settings
├── Repository.gs                  Repository per entity + lookup master
├── Auth.gs                        Hash password, session, requireAuth/requireRole/requirePermission
├── AuditService.gs                Audit trail terpusat
├── Setup.gs                       setupDatabase(), createDemoData(), resetDemoData(), status
├── DistributionService.gs         AllocationEngine + workspace, review, plan sell in, clustering
├── MRService.gs                   Workflow MR end-to-end + validasi + SO + monitoring
├── SOPService.gs                  3 pilar SOP + editor aturan
├── DashboardService.gs            KPI dashboard + pembanding periode + tindak lanjut
├── AnalyticsService.gs            10 chart, drill-down, 5 report, export CSV
├── MasterService.gs               CRUD account/SKU/user + settings
├── Code.gs                        doGet, include, API router tunggal + RBAC
│
├── Index.html                     Shell aplikasi (sidebar, topbar, drawer, modal, toast)
├── CSS.html                       Design system
├── JS.html                        Core frontend (router, api client, filter global, state)
├── Components.html                Icon sprite, UI atoms, chart engine SVG
├── Login.html                     Halaman login
├── Dashboard.html                 Overview
├── Distribution.html              Distribution Planning (allocation, clustering, rencana)
├── MR.html                        MR Administration
├── SOP.html                       SOP MR
├── Monitoring.html                Kanban monitoring
├── Analytics.html                 Analytics & report
├── MasterData.html                Master account, SKU, user
├── Audit.html                     Audit log
└── Settings.html                  Business rules + system setup status

docs/                              Dokumentasi
├── PRD.md                         Product requirement final
├── DATABASE-SCHEMA.md             Skema 11 sheet (digenerate dari Config.gs)
├── BUSINESS-LOGIC.md              Seluruh formula, threshold, role matrix
├── DEPLOYMENT.md                  Setup, deploy, troubleshooting
├── TESTING.md                     Checklist uji + hasil suite otomatis
├── PERFORMANCE.md                 Catatan optimasi Apps Script
└── API.md                         Daftar action API + kontrak response

tools/                             Perkakas pengembangan (tidak perlu di-deploy)
├── gas-mock.js                    Emulator Apps Script untuk Node
├── serve.js                       Harness lokal: UI produksi + backend .gs asli
├── test-phase1.js                 Uji database, setup, demo data, engine
├── test-phase2.js                 Uji service layer, API router, RBAC
├── test-performance.js            Uji kepatuhan batasan Apps Script
├── ui-test.js                     Uji UI (Playwright)
├── ui-flows.js                    Uji alur bisnis end-to-end (Playwright)
├── test-all.js                    Menjalankan seluruh suite
└── gen-docs.js                    Generate dokumentasi schema dari kode
```

---

## 4. Arsitektur

```
Frontend (HTML Service)
   │  google.script.run.api(action, token, payload)
   ▼
Code.gs — API Router        ← autentikasi, otorisasi, error envelope, audit
   ▼
Service Layer               ← seluruh business logic & kalkulasi
   ▼
Repository.gs               ← akses per entity
   ▼
Database.gs (DAL)           ← batch getValues/setValues, cache, LockService
   ▼
Google Sheets
```

Aturan yang dijaga ketat:
- **Tidak ada business logic di frontend.** Frontend hanya render, interaksi, filter, state, feedback.
- **Role tidak pernah dipercaya dari frontend.** Setiap request membawa token; server membaca role dari session store.
- **Tidak ada angka bisnis hardcoded.** Seluruh threshold/faktor berada di sheet `SETTINGS`.
- **Tidak ada akses Sheets per baris.** Semua baca/tulis dilakukan batch.

---

## 5. Data demo

`createDemoData()` mengisi 8 account, 6 SKU, 6 bulan transaksi, 15 dokumen MR dan 14 allocation plan.
Dua skenario wajib dirancang agar perbedaan algoritmanya langsung terlihat:

| | DEMO 1 | DEMO 2 |
|---|--------|--------|
| Account | `DEMO-ACCOUNT-001` (High Potential) | `DEMO-ACCOUNT-002` (Medium Potential) |
| SKU | `DEMO-MILK-001` (UHT, shelf life 180 hari) | `DEMO-MILK-002` (Fresh, shelf life 30 hari) |
| Sell Out | 1.000 | 500 |
| Return | 50 | 75 |
| Stock akhir | 100 (menurun, −10) | 180 (menumpuk, +40) |
| **MR%** | **5,00%** | **15,00%** |
| Risiko | LOW–MEDIUM | HIGH |
| Recommended Allocation | ±103 qty | **0 qty** (stock sudah menutupi kebutuhan) |

Penjelasan cara angka tersebut dihitung: **[docs/BUSINESS-LOGIC.md](docs/BUSINESS-LOGIC.md)**

---

## 6. Menjalankan pengujian (opsional, untuk pengembang)

Seluruh logika `.gs` dapat diuji di Node tanpa membuka Google Sheets, dan UI diuji di
Chromium sungguhan melawan backend `.gs` yang sama.

```bash
node tools/test-all.js      # seluruh suite
node tools/serve.js         # buka http://localhost:8123 untuk mencoba UI lokal
```

| Suite | Cakupan | Hasil |
|-------|---------|-------|
| `test-phase1.js` | Setup database, idempotensi, demo data, formula, clustering, auth | 83 PASS |
| `test-phase2.js` | Workflow MR, SOP, dashboard, analytics, master data, RBAC, empty state | 95 PASS |
| `test-performance.js` | Batch I/O, cache, pagination, N+1, invalidasi | 22 PASS |
| `ui-test.js` | Boot, login, navigasi, responsive, sticky, console bersih | 41 PASS |
| `ui-flows.js` | Alur bisnis end-to-end + RBAC 4 role di browser | 84 PASS |

Detail: **[docs/TESTING.md](docs/TESTING.md)**

---

## 7. Dokumentasi

| Dokumen | Isi |
|---------|-----|
| [docs/PRD.md](docs/PRD.md) | Tujuan, ruang lingkup, information architecture, user flow |
| [docs/DATABASE-SCHEMA.md](docs/DATABASE-SCHEMA.md) | 11 sheet, kolom, tipe, enum, relasi |
| [docs/BUSINESS-LOGIC.md](docs/BUSINESS-LOGIC.md) | Formula, threshold, clustering, risk, SOP, role matrix, daftar settings |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Setup, deployment, konfigurasi akses, troubleshooting |
| [docs/TESTING.md](docs/TESTING.md) | Checklist uji manual + suite otomatis |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Strategi performa Apps Script dan angkanya |
| [docs/API.md](docs/API.md) | Kontrak API, daftar action, penanganan error |
