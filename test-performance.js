/**
 * test-performance.js — Uji kepatuhan terhadap batasan Google Apps Script
 * (PRD bagian S): batch read/write, tidak ada getRange per baris,
 * cache efektif, dan tidak ada N+1 saat dataset membesar.
 */
const { createContext, loadProject, STATS, resetStats } = require('./gas-mock.js');

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m  ' + label + (detail ? '  (' + detail + ')' : '')); }
  else { failed++; failures.push(label); console.log('  \x1b[31mFAIL\x1b[0m  ' + label + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
function measure(fn) {
  resetStats();
  const start = Date.now();
  const result = fn();
  return { result: result, ms: Date.now() - start, stats: Object.assign({}, STATS) };
}

const ctx = createContext();
const app = loadProject(ctx);

section('1. Setup & demo data');
const setup = measure(() => app.setupDatabase());
check('setupDatabase memakai batch write', setup.stats.setValues < 60,
  setup.stats.setValues + ' setValues, ' + setup.stats.getValues + ' getValues');
const demo = measure(() => app.createDemoData());
check('demo data ditulis per-tabel (bukan per-baris)', demo.stats.setValues <= 25,
  demo.stats.setValues + ' setValues untuk ' + app.DB.count('SALES_DATA') + ' baris sales + '
  + app.DB.count('RETURN_DATA') + ' return + ' + app.DB.count('STOCK_MOVEMENT') + ' stock');
check('rasio baris per write tinggi', demo.stats.writes / Math.max(1, demo.stats.setValues) > 20,
  Math.round(demo.stats.writes / demo.stats.setValues) + ' baris per setValues');

const login = app.api('auth.login', null, { username: 'admin', password: 'admin123' }).data;
const token = login.token;

section('2. Pembacaan dashboard');
const dash1 = measure(() => app.api('dashboard.summary', token, {}));
check('dashboard sukses', dash1.result.success === true);
check('dashboard tidak melakukan getRange per baris', dash1.stats.getRange < 60,
  dash1.stats.getRange + ' getRange, ' + dash1.stats.getValues + ' getValues');
const dash2 = measure(() => app.api('dashboard.summary', token, {}));
check('panggilan kedua dilayani cache', dash2.stats.getValues <= dash1.stats.getValues,
  'getValues ' + dash1.stats.getValues + ' → ' + dash2.stats.getValues);
check('tidak ada write saat membaca dashboard', dash2.stats.setValues === 0);

section('3. Pagination server-side');
const page1 = measure(() => app.api('distribution.workspace', token, { page: 1, pageSize: 10 }));
const page2 = measure(() => app.api('distribution.workspace', token, { page: 2, pageSize: 10 }));
check('halaman 1 dan 2 memakai jumlah baca yang sama (tidak load ulang semua)',
  page2.stats.getValues <= page1.stats.getValues,
  page1.stats.getValues + ' vs ' + page2.stats.getValues);
check('frontend hanya menerima 10 baris', page1.result.data.rows.length === 10);
check('meta pagination dikirim', page1.result.data.meta.total > 10);

section('4. Skala data besar (N+1 check)');
// Tambah 300 dokumen MR sekaligus untuk menguji perilaku pada dataset besar
const accounts = app.AccountRepo.all();
const skus = app.SkuRepo.all();
const bulk = [];
for (let i = 0; i < 300; i++) {
  bulk.push({
    MR_DATE: app.Utils.addDays(app.Utils.today(), -(i % 60)),
    ACCOUNT_ID: accounts[i % accounts.length].ACCOUNT_ID,
    SKU_ID: skus[i % skus.length].SKU_ID,
    RETURN_QTY: 5 + (i % 20), RETURN_VALUE: 100000 * (1 + (i % 5)),
    PICKUP_DATE: app.Utils.addDays(app.Utils.today(), -(i % 60) + 3),
    CUTOFF_DATE: app.Utils.addDays(app.Utils.today(), -(i % 60) + 7),
    BAP_REQUIRED: false, BAP_STATUS: 'NOT_REQUIRED', SALES_APPROVAL: 'PENDING',
    SO_NUMBER: '', SO_STATUS: 'NOT_CREATED', MR_STATUS: 'INPUT', REMARK: 'bulk test',
    CREATED_BY: 'mr', CREATED_AT: new Date(), UPDATED_AT: new Date(),
    RETURN_REASON: 'NEAR_EXPIRY', VALIDATION_STATUS: 'PASS', PIC: 'Tim MR'
  });
}
const bulkInsert = measure(() => app.DB.insertMany('MR_ADMIN', bulk));
check('300 dokumen ditulis dalam 1 setValues', bulkInsert.stats.setValues <= 2,
  bulkInsert.stats.setValues + ' setValues');
const bigList = measure(() => app.api('mr.list', token, { page: 1, pageSize: 25 }));
check('list 315 dokumen tetap efisien', bigList.stats.getValues < 30,
  bigList.stats.getValues + ' getValues untuk ' + app.DB.count('MR_ADMIN') + ' baris');
check('list tetap benar', bigList.result.data.meta.total >= 300);
const board = measure(() => app.api('monitoring.board', token, { limitPerColumn: 25 }));
check('kanban membatasi kartu per kolom', board.result.data.columns.every((c) => c.cards.length <= 25));
check('kanban tidak membaca ulang berkali-kali', board.stats.getValues < 30, board.stats.getValues + ' getValues');

section('5. Update tunggal & massal');
const one = measure(() => app.DB.update('MR_ADMIN', bulk[0].MR_ID, { REMARK: 'diubah' }));
check('update 1 baris hanya menyentuh baris itu', one.stats.setValues === 1 && one.stats.writes === 1,
  one.stats.setValues + ' setValues, ' + one.stats.writes + ' baris');
check('update tunggal tidak membaca seluruh sheet', one.stats.cells < app.DB.count('MR_ADMIN') * 10,
  one.stats.cells + ' sel dibaca');
const many = measure(() => app.DB.updateMany('MR_ADMIN',
  bulk.slice(0, 50).map((r) => ({ id: r.MR_ID, patch: { REMARK: 'massal' } }))));
check('update 50 baris tetap 1 setValues', many.stats.setValues === 1, many.stats.setValues + ' setValues');

section('6. Konsistensi cache setelah write');
const beforeMr = app.api('dashboard.summary', token, {}).data.kpi.pendingMr.value;
app.DB.insertMany('MR_ADMIN', [Object.assign({}, bulk[0], { MR_ID: '', REMARK: 'cek cache' })]);
const afterMr = app.api('dashboard.summary', token, {}).data.kpi.pendingMr.value;
check('dashboard langsung mencerminkan data baru (cache di-invalidate)', afterMr === beforeMr + 1,
  beforeMr + ' → ' + afterMr);

section('7. Waktu eksekusi (indikatif, bukan latensi Sheets nyata)');
const heavy = measure(() => app.api('analytics.overview', token, {}));
check('analytics selesai < 1500ms di mesin uji', heavy.ms < 1500, heavy.ms + 'ms');
const login2 = measure(() => app.api('auth.login', null, { username: 'manager', password: 'manager123' }));
check('login ringan (< 20 getValues)', login2.stats.getValues < 20, login2.stats.getValues + ' getValues');
check('login tidak memuat dataset transaksi', login2.stats.cells < 5000, login2.stats.cells + ' sel');

console.log('\n' + '='.repeat(64));
console.log(`HASIL PERFORMANCE: ${passed} PASS, ${failed} FAIL`);
if (failed) { console.log('Gagal: ' + failures.join(' | ')); process.exit(1); }
console.log('='.repeat(64));
