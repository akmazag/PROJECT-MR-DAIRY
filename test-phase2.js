/**
 * test-phase2.js — Verifikasi service layer & API router:
 * MR workflow, SOP, dashboard, analytics, master data, RBAC per action.
 */
const { createContext, loadProject } = require('./gas-mock.js');

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log('  \x1b[32mPASS\x1b[0m  ' + label); }
  else { failed++; failures.push(label); console.log('  \x1b[31mFAIL\x1b[0m  ' + label + (detail ? '  → ' + detail : '')); }
}
function section(title) { console.log('\n\x1b[1m' + title + '\x1b[0m'); }
const ok = (res) => res && res.success === true;
const errCode = (res) => (res && res.error ? res.error.code : '(tidak error)');

const ctx = createContext();
const app = loadProject(ctx);
app.setupDatabase();
app.createDemoData();

const admin = app.api('auth.login', null, { username: 'admin', password: 'admin123' }).data;
const sales = app.api('auth.login', null, { username: 'sales', password: 'sales123' }).data;
const mrUser = app.api('auth.login', null, { username: 'mr', password: 'mr123' }).data;
const viewer = app.api('auth.login', null, { username: 'viewer', password: 'viewer123' }).data;

section('1. API router & error handling');
check('action tidak dikenal ditolak rapi', errCode(app.api('tidak.ada', admin.token, {})) === 'UNKNOWN_ACTION');
check('route terproteksi tanpa token ditolak', errCode(app.api('dashboard.summary', null, {})) === 'AUTH_REQUIRED');
check('login salah mengembalikan pesan human readable',
  app.api('auth.login', null, { username: 'admin', password: 'x' }).error.message === 'Username atau password salah.');
check('response sukses berbentuk {success,data}', ok(app.api('system.status', null, {})));
check('error tidak membocorkan stack trace',
  JSON.stringify(app.api('mr.detail', admin.token, { mrId: 'MR-9999' })).indexOf('at Object') === -1);
check('auth.session mengembalikan sesi aktif',
  app.api('auth.session', null, { token: admin.token }).data.user.ROLE === 'ADMIN');

section('2. RBAC per action (backend, bukan sekadar sembunyikan tombol)');
check('VIEWER tidak bisa input MR', errCode(app.api('mr.create', viewer.token, {})) === 'FORBIDDEN');
check('VIEWER tidak bisa buka settings', errCode(app.api('settings.list', viewer.token, {})) === 'FORBIDDEN');
check('VIEWER tidak bisa lihat master data', errCode(app.api('master.accounts', viewer.token, {})) === 'FORBIDDEN');
check('VIEWER tetap bisa lihat dashboard', ok(app.api('dashboard.summary', viewer.token, {})));
check('SALES tidak bisa input MR', errCode(app.api('mr.create', sales.token, {})) === 'FORBIDDEN');
check('SALES bisa approve', app.roleHasPermission('SALES', 'mr.approve') === true);
check('MR user tidak bisa approve', errCode(app.api('mr.approve', mrUser.token, { mrId: 'x' })) === 'FORBIDDEN');
check('MR user tidak bisa ubah SOP', errCode(app.api('sop.updateRule', mrUser.token, {})) === 'FORBIDDEN');

section('3. MR workflow end-to-end');
const opts = app.api('mr.formOptions', mrUser.token, {}).data;
const acc = opts.accounts.find((a) => a.code === 'DEMO-ACCOUNT-001');
const sku = opts.skus.find((s) => s.code === 'DEMO-MILK-001');
const todayIso = app.Utils.toIsoDate(app.Utils.today());
const created = app.api('mr.create', mrUser.token, {
  accountId: acc.id, skuId: sku.id, returnQty: 9, mrDate: todayIso,
  returnReason: 'NEAR_EXPIRY', expiryDate: app.Utils.toIsoDate(app.Utils.addDays(new Date(), 45)),
  pickupDate: app.Utils.toIsoDate(app.Utils.addDays(new Date(), 2)), remark: 'Test workflow'
});
check('MR dibuat', ok(created) && !!created.data.mr.MR_ID, JSON.stringify(created.error || ''));
const mrId = created.data.mr.MR_ID;
check('cutoff date dihitung otomatis dari SETTINGS', created.data.mr.CUTOFF_DATE ===
  app.Utils.toIsoDate(app.Utils.addDays(new Date(), app.Settings.getNumber('MR_CUTOFF_DAYS', 7))));
check('nilai return diestimasi dari histori', created.data.mr.RETURN_VALUE > 0);
check('validasi otomatis dijalankan saat input', created.data.validation.checks.length >= 10);
check('status naik ke VALIDATED setelah lolos validasi', created.data.mr.MR_STATUS === 'VALIDATED',
  created.data.mr.MR_STATUS);
check('BAP tidak wajib untuk item fresh', created.data.mr.BAP_REQUIRED === false);

const blockedSo = app.api('mr.createSO', mrUser.token, { mrId: mrId });
check('SO ditolak sebelum approval', errCode(blockedSo) === 'INVALID_STATE');
const submitted = app.api('mr.submit', mrUser.token, { mrId: mrId });
check('MR dikirim untuk approval', ok(submitted) && submitted.data.mr.MR_STATUS === 'WAITING_APPROVAL');
check('approve tanpa hak ditolak', errCode(app.api('mr.approve', mrUser.token, { mrId: mrId })) === 'FORBIDDEN');
check('reject tanpa alasan ditolak',
  errCode(app.api('mr.reject', sales.token, { mrId: mrId, reason: '' })) === 'VALIDATION_ERROR');
const approved = app.api('mr.approve', sales.token, { mrId: mrId, note: 'Setuju, sesuai SOP' });
check('approval Sales berhasil', ok(approved) && approved.data.mr.MR_STATUS === 'APPROVED');
check('SALES_APPROVAL tercatat APPROVED', approved.data.mr.SALES_APPROVAL === 'APPROVED');
const so = app.api('mr.createSO', mrUser.token, { mrId: mrId });
check('SO otomatis dibuat', ok(so) && !!so.data.soNumber, JSON.stringify(so.error || ''));
check('format SO sesuai SO-MR-YYYYMMDD-XXXX', /^SO-MR-\d{8}-\d{4}$/.test(so.data.soNumber || ''), so.data.soNumber);
check('status menjadi SO_CREATED', so.data.mr.MR_STATUS === 'SO_CREATED');
const scheduled = app.api('mr.schedule', mrUser.token, {
  mrId: mrId, pickupDate: app.Utils.toIsoDate(app.Utils.addDays(new Date(), 3)), pic: 'Tim Gudang'
});
check('jadwal penarikan tersimpan', ok(scheduled) && scheduled.data.mr.MR_STATUS === 'PICKUP_SCHEDULED');
const returnsBefore = app.DB.count('RETURN_DATA');
const completed = app.api('mr.complete', mrUser.token, { mrId: mrId });
check('MR selesai', ok(completed) && completed.data.mr.MR_STATUS === 'COMPLETED');
check('realisasi MR masuk ke RETURN_DATA', app.DB.count('RETURN_DATA') === returnsBefore + 1);
check('transisi ilegal ditolak', errCode(app.api('mr.approve', sales.token, { mrId: mrId })) === 'INVALID_STATE');

section('4. Validasi data MR (STEP 2)');
const dup = app.api('mr.create', mrUser.token, {
  accountId: acc.id, skuId: sku.id, returnQty: 9, mrDate: todayIso, returnReason: 'NEAR_EXPIRY',
  expiryDate: app.Utils.toIsoDate(app.Utils.addDays(new Date(), 45))
});
const dupCheck = dup.data.validation.checks.find((c) => c.code === 'DUPLICATE');
check('duplicate MR terdeteksi', dupCheck && dupCheck.status === 'WARNING', dupCheck && dupCheck.message);
const noPickup = dup.data.validation.checks.find((c) => c.code === 'PICKUP');
check('pickup kosong ditandai WARNING', noPickup && noPickup.status === 'WARNING');
check('qty <= 0 ditolak', errCode(app.api('mr.create', mrUser.token, {
  accountId: acc.id, skuId: sku.id, returnQty: 0, mrDate: todayIso })) === 'VALIDATION_ERROR');
check('account tidak valid ditolak', errCode(app.api('mr.create', mrUser.token, {
  accountId: 'ACC-9999', skuId: sku.id, returnQty: 5, mrDate: todayIso })) === 'VALIDATION_ERROR');
const anomaly = app.api('mr.create', mrUser.token, {
  accountId: acc.id, skuId: sku.id, returnQty: 900, mrDate: todayIso,
  expiryDate: app.Utils.toIsoDate(app.Utils.addDays(new Date(), 40)),
  pickupDate: app.Utils.toIsoDate(app.Utils.addDays(new Date(), 1))
});
const anomalyCheck = anomaly.data.validation.checks.find((c) => c.code === 'QTY_ANOMALY');
check('anomali qty terdeteksi', anomalyCheck && anomalyCheck.status === 'WARNING', anomalyCheck && anomalyCheck.message);
const soBlocked = app.api('mr.createSO', mrUser.token, { mrId: dup.data.mr.MR_ID });
check('SO diblokir bila belum approve', ['INVALID_STATE', 'VALIDATION_ERROR'].indexOf(errCode(soBlocked)) !== -1);

section('5. Monitoring board');
const board = app.api('monitoring.board', admin.token, {}).data;
check('7 kolom kanban sesuai MR_FLOW', board.columns.length === 7);
check('kolom memiliki kartu', board.columns.some((c) => c.cards.length > 0));
check('kartu memuat info kunci', (() => {
  const card = board.columns.flatMap((c) => c.cards)[0];
  return card && card.accountName && card.skuName && card.RETURN_QTY !== undefined && card.sla;
})());
check('ringkasan monitoring tersedia', board.summary.total > 0 && board.summary.pending >= 0);
check('missed PO dihitung', typeof board.summary.missedPo === 'number');

section('6. SOP');
const sop = app.api('sop.workflow', admin.token, {}).data;
check('3 langkah SOP tersedia', sop.steps.length === 3);
check('SOP memuat rule, PIC, SLA, status',
  sop.steps.every((s) => s.RULE && s.PIC && s.SLA_DAYS >= 0 && s.STATUS));
check('compliance SOP dihitung', sop.steps.every((s) => s.compliance >= 0 && s.compliance <= 100));
const pickup = app.api('sop.pickup', admin.token, {}).data;
check('timeline penarikan terbentuk', Array.isArray(pickup.timeline) && pickup.summary.slaDays === 3);
const cutoff = app.api('sop.cutoff', admin.token, {}).data;
check('komitmen cutoff memuat days remaining',
  cutoff.rows.length > 0 && cutoff.rows[0].daysRemaining !== undefined);
const bap = app.api('sop.bap', admin.token, {}).data;
check('aturan BAP configurable', bap.rule === 'FRESH_EXEMPT' && bap.ruleOptions.length === 3);
check('setting di luar whitelist ditolak',
  errCode(app.api('sop.updateRule', admin.token, { key: 'APP_NAME', value: 'x' })) === 'FORBIDDEN');
const ruleUpdate = app.api('sop.updateRule', admin.token, { key: 'MR_CUTOFF_DAYS', value: '10' });
check('aturan cutoff bisa diubah tanpa ubah source code',
  ok(ruleUpdate) && app.Settings.getNumber('MR_CUTOFF_DAYS') === 10);
app.api('sop.updateRule', admin.token, { key: 'MR_CUTOFF_DAYS', value: '7' });
check('BAP_RULE hanya menerima nilai valid',
  errCode(app.api('sop.updateRule', admin.token, { key: 'BAP_RULE', value: 'SALAH' })) === 'VALIDATION_ERROR');

section('7. Dashboard');
const dash = app.api('dashboard.summary', admin.token, {}).data;
check('KPI dashboard lengkap', Object.keys(dash.kpi).length === 9, Object.keys(dash.kpi).join(','));
check('MR% punya pembanding periode sebelumnya', dash.kpi.mrPercent.previous !== undefined);
check('arah tren MR% dinilai benar (turun = baik)',
  dash.kpi.mrPercent.delta === null || dash.kpi.mrPercent.good === (dash.kpi.mrPercent.delta <= 0));
check('objective Less Return / More Freshness memakai KPI nyata',
  dash.objective.lessReturn.value >= 0 && dash.objective.moreFreshness.totalPairs > 0);
check('daftar tindak lanjut actionable', Array.isArray(dash.attention) && dash.attention.length > 0);
check('top risk tersedia', dash.topRisk.length > 0 && dash.topRisk[0].riskScore !== undefined);
check('trend dashboard 6 bulan', dash.trend.length === 6);

section('8. Analytics & report');
const an = app.api('analytics.overview', admin.token, {}).data;
check('10 chart tersedia', Object.keys(an.charts).length === 10, Object.keys(an.charts).join(','));
check('MR trend memiliki target line', an.charts.mrTrend.target === 5);
check('MR by account terisi', an.charts.mrByAccount.items.length > 0);
check('risk distribution konsisten',
  an.charts.riskDistribution.items.reduce((sum, i) => sum + i.value, 0) === app.AllocationEngine.buildMatrix({}).rows.length);
const drill = app.api('analytics.drill', admin.token, {
  dimension: 'account', key: an.charts.mrByAccount.items[0].id
}).data;
check('drill-down account mengembalikan detail', drill.rows.length > 0 && drill.type === 'matrix');
const drillStatus = app.api('analytics.drill', admin.token, { dimension: 'mrStatus', key: 'WAITING_APPROVAL' }).data;
check('drill-down status MR bekerja', drillStatus.type === 'mr');
const reports = app.api('analytics.reports', admin.token, {}).data;
check('5 report tersedia', reports.reports.length === 5);
const csv = app.api('analytics.export', admin.token, { type: 'MR' }).data;
check('export CSV terbentuk', csv.csv.split('\r\n').length > 1 && csv.filename.endsWith('.csv'));
check('CSV escaping aman', app.Utils.toCsv(['A'], [{ A: 'baris, "dengan" koma' }]).indexOf('""dengan""') !== -1);
check('VIEWER tidak bisa export', errCode(app.api('analytics.export', viewer.token, { type: 'MR' })) === 'FORBIDDEN');

section('9. Master data & settings');
const accounts = app.api('master.accounts', admin.token, {}).data;
check('daftar account tampil', accounts.rows.length > 0 && accounts.meta.total === 8);
const newAcc = app.api('master.saveAccount', admin.token, {
  ACCOUNT_CODE: 'MT-TEST-900', ACCOUNT_NAME: 'Test Account', CHANNEL: 'MODERN_TRADE',
  REGION: 'Jakarta', AREA: 'Jakarta Barat', CITY: 'Jakarta', POTENTIAL_LEVEL: 'HIGH'
});
check('account baru dibuat', ok(newAcc) && newAcc.data.created === true);
check('account code duplikat ditolak', errCode(app.api('master.saveAccount', admin.token, {
  ACCOUNT_CODE: 'MT-TEST-900', ACCOUNT_NAME: 'Duplikat' })) === 'DUPLICATE');
const toggled = app.api('master.toggleAccount', admin.token, { accountId: newAcc.data.account.ACCOUNT_ID }).data;
check('soft delete account (INACTIVE)', toggled.status === 'INACTIVE');
const users = app.api('master.users', admin.token, {}).data;
check('daftar user tidak membocorkan password',
  users.rows.length === 5 && !('PASSWORD_HASH' in users.rows[0]));
check('password baru minimal 6 karakter', errCode(app.api('master.saveUser', admin.token, {
  USERNAME: 'baru', NAME: 'User Baru', ROLE: 'MR', PASSWORD: '123' })) === 'VALIDATION_ERROR');
const settingsList = app.api('settings.list', admin.token, {}).data;
check('settings tampil beserta nilai default', settingsList.rows.length >= app.DEFAULT_SETTINGS.length);
check('settings numerik divalidasi', errCode(app.api('settings.update', admin.token, {
  items: [{ key: 'ALLOCATION_FACTOR', value: 'abc' }] })) === 'VALIDATION_ERROR');
check('settings boolean divalidasi', errCode(app.api('settings.update', admin.token, {
  items: [{ key: 'ALLOCATION_STOCK_DEDUCTION', value: 'mungkin' }] })) === 'VALIDATION_ERROR');
const updateSetting = app.api('settings.update', admin.token, {
  items: [{ key: 'TARGET_MR_PERCENT', value: '4' }] });
check('settings valid tersimpan', ok(updateSetting) && app.Settings.getNumber('TARGET_MR_PERCENT') === 4);
app.api('settings.reset', admin.token, { key: 'TARGET_MR_PERCENT' });
check('reset settings kembali ke default', app.Settings.getNumber('TARGET_MR_PERCENT') === 5);

section('10. Audit trail lengkap');
const auditRes = app.api('audit.list', admin.token, { page: 1, pageSize: 500 }).data;
const acts = auditRes.rows.map((r) => r.ACTION);
['LOGIN', 'CREATE', 'UPDATE', 'APPROVE', 'CREATE_SO', 'VALIDATE', 'EXPORT'].forEach((action) => {
  check('audit mencatat ' + action, acts.indexOf(action) !== -1);
});
check('audit bisa difilter per module',
  app.api('audit.list', admin.token, { filters: { module: 'MR' } }).data.rows.every((r) => r.MODULE === 'MR'));
check('audit terurut terbaru di atas',
  auditRes.rows.length > 1 && auditRes.rows[0].TIMESTAMP >= auditRes.rows[1].TIMESTAMP);

section('11. Ketahanan (aplikasi tidak blank saat data kosong)');
const ctx2 = createContext();
const app2 = loadProject(ctx2);
app2.setupDatabase();
const emptyAdmin = app2.api('auth.login', null, { username: 'admin', password: 'admin123' }).data;
check('dashboard tetap jalan tanpa data transaksi', ok(app2.api('dashboard.summary', emptyAdmin.token, {})));
check('distribution kosong tidak error', (() => {
  const res = app2.api('distribution.workspace', emptyAdmin.token, {});
  return ok(res) && res.data.rows.length === 0 && res.data.kpi.totalAccount === 0;
})());
check('analytics kosong tidak error', ok(app2.api('analytics.overview', emptyAdmin.token, {})));
check('monitoring kosong tidak error', ok(app2.api('monitoring.board', emptyAdmin.token, {})));
check('MR% = 0 saat belum ada sell out',
  app2.api('dashboard.summary', emptyAdmin.token, {}).data.kpi.mrPercent.value === 0);

console.log('\n' + '='.repeat(64));
console.log(`HASIL: ${passed} PASS, ${failed} FAIL`);
if (failed) { console.log('Gagal: ' + failures.join(' | ')); process.exit(1); }
console.log('='.repeat(64));
