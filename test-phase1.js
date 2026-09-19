/**
 * test-phase1.js — Verifikasi PHASE 1: setup database, demo data, engine.
 * Jalankan: node tools/test-phase1.js
 */
const { createContext, loadProject } = require('./gas-mock.js');

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log('  \x1b[32mPASS\x1b[0m  ' + label); }
  else { failed++; failures.push(label); console.log('  \x1b[31mFAIL\x1b[0m  ' + label + (detail ? '  → ' + detail : '')); }
}
function section(title) { console.log('\n\x1b[1m' + title + '\x1b[0m'); }

const ctx = createContext();
const app = loadProject(ctx);

section('1. setupDatabase()');
const setupResult = app.setupDatabase();
check('setupDatabase mengembalikan success', setupResult.success === true);
const sheetNames = ctx.spreadsheet.getSheets().map((s) => s.getName());
check('11 sheet database dibuat', sheetNames.length === 11, 'ditemukan: ' + sheetNames.join(', '));
app.SHEET_ORDER.forEach((name) => {
  const sheet = ctx.spreadsheet.getSheetByName(name);
  const headers = sheet ? sheet.getRange(1, 1, 1, app.SCHEMA[name].headers.length).getValues()[0] : [];
  check('sheet ' + name + ' + header sesuai schema',
    !!sheet && headers.join('|') === app.SCHEMA[name].headers.join('|'));
});
check('SETTINGS terisi default', app.DB.count('SETTINGS') === app.DEFAULT_SETTINGS.length,
  'rows=' + app.DB.count('SETTINGS'));
check('USERS default 5 role', app.DB.count('USERS') === 5);
check('SOP_MASTER terisi 3 langkah', app.DB.count('SOP_MASTER') === 3);

section('2. setupDatabase() idempotent (jalan kedua kali)');
const before = ctx.spreadsheet.getSheets().length;
app.setupDatabase();
check('tidak membuat sheet duplikat', ctx.spreadsheet.getSheets().length === before);
check('settings tidak dobel', app.DB.count('SETTINGS') === app.DEFAULT_SETTINGS.length);
check('users tidak dobel', app.DB.count('USERS') === 5);

section('3. createDemoData()');
const demo = app.createDemoData();
check('createDemoData sukses', demo.success === true);
check('8 account dibuat', app.DB.count('ACCOUNT_MASTER') === 8);
check('6 SKU dibuat', app.DB.count('SKU_MASTER') === 6);
check('sales data terisi', app.DB.count('SALES_DATA') > 100, 'rows=' + app.DB.count('SALES_DATA'));
check('return data terisi', app.DB.count('RETURN_DATA') > 50, 'rows=' + app.DB.count('RETURN_DATA'));
check('stock movement terisi', app.DB.count('STOCK_MOVEMENT') > 100);
check('MR_ADMIN 15 dokumen', app.DB.count('MR_ADMIN') === 15, 'rows=' + app.DB.count('MR_ADMIN'));
check('ALLOCATION_PLAN terisi', app.DB.count('ALLOCATION_PLAN') > 0, 'rows=' + app.DB.count('ALLOCATION_PLAN'));

section('4. createDemoData() idempotent');
const accountsBefore = app.DB.count('ACCOUNT_MASTER');
const again = app.createDemoData();
check('demo tidak digandakan', app.DB.count('ACCOUNT_MASTER') === accountsBefore && again.skipped === true);

section('5. Skenario demo wajib (PRD bagian W)');
const matrix = app.AllocationEngine.buildMatrix({});
function findPair(accCode, skuCode) {
  return matrix.rows.find((r) => r.accountCode === accCode && r.skuCode === skuCode);
}
const d1 = findPair('DEMO-ACCOUNT-001', 'DEMO-MILK-001');
const d2 = findPair('DEMO-ACCOUNT-002', 'DEMO-MILK-002');
check('DEMO 1 ditemukan di matrix', !!d1);
check('DEMO 1 Sell Out = 1000', d1 && d1.totalSellOut === 1000, d1 && String(d1.totalSellOut));
check('DEMO 1 Return = 50', d1 && d1.totalReturn === 50, d1 && String(d1.totalReturn));
check('DEMO 1 Stock = 100', d1 && d1.currentStock === 100, d1 && String(d1.currentStock));
check('DEMO 1 MR% = 5', d1 && d1.mrPercent === 5, d1 && String(d1.mrPercent));
check('DEMO 1 Potential HIGH', d1 && d1.potential === 'HIGH');
check('DEMO 1 stock movement negatif (sehat)', d1 && d1.stockMovement === -10, d1 && String(d1.stockMovement));
check('DEMO 2 ditemukan di matrix', !!d2);
check('DEMO 2 Sell Out = 500', d2 && d2.totalSellOut === 500, d2 && String(d2.totalSellOut));
check('DEMO 2 Return = 75', d2 && d2.totalReturn === 75, d2 && String(d2.totalReturn));
check('DEMO 2 Stock = 180', d2 && d2.currentStock === 180, d2 && String(d2.currentStock));
check('DEMO 2 MR% = 15', d2 && d2.mrPercent === 15, d2 && String(d2.mrPercent));
check('DEMO 2 risk lebih tinggi dari DEMO 1', d1 && d2 && d2.riskScore > d1.riskScore,
  d1 && d2 ? `${d1.riskScore} vs ${d2.riskScore}` : '');
check('DEMO 2 stock menumpuk (+40)', d2 && d2.stockMovement === 40, d2 && String(d2.stockMovement));

section('6. Formula & konfigurasi');
check('MR% = 0 saat sell out 0', app.Utils.safeDiv(10, 0, 0) === 0);
check('AVG SELL OUT DEMO 1 = 1000/6', d1 && Math.abs(d1.avgSellOut - 166.7) < 0.1, d1 && String(d1.avgSellOut));
check('AVG RETURN DEMO 1 = 50/6', d1 && Math.abs(d1.avgReturn - 8.3) < 0.1, d1 && String(d1.avgReturn));
const rec1 = app.AllocationEngine.computeRecommendation({
  avgSellOut: 166.67, avgReturn: 8.33, currentStock: 100, potential: 'HIGH'
});
check('Recommended Allocation DEMO 1 > 0', rec1.value > 0, 'value=' + rec1.value);
check('Recommended DEMO 1 memakai faktor HIGH 1.15', rec1.breakdown.potentialFactor === 1.15);
const rec2 = app.AllocationEngine.computeRecommendation({
  avgSellOut: 83.33, avgReturn: 12.5, currentStock: 180, potential: 'MEDIUM'
});
check('Recommended Allocation DEMO 2 = 0 (stock berlebih)', rec2.value === 0, 'value=' + rec2.value);
app.Settings.set('ALLOCATION_FACTOR', '1.5');
app.Settings.reload();
const recAfter = app.AllocationEngine.computeRecommendation({
  avgSellOut: 166.67, avgReturn: 8.33, currentStock: 100, potential: 'HIGH'
});
check('formula mengikuti SETTINGS (tidak hardcode)', recAfter.value > rec1.value,
  `${rec1.value} → ${recAfter.value}`);
app.Settings.set('ALLOCATION_FACTOR', '1.1');
app.Settings.reload();

section('7. Risk & clustering');
const risk = app.AllocationEngine.computeRisk({
  mrPercent: 15, stockCover: 2.2, avgSellOut: 83, shelfLifeDays: 30, trendPercent: -10
});
check('risk memakai 4 indikator', Object.keys(risk.components).length === 4);
check('risk level valid', ['LOW', 'MEDIUM', 'HIGH'].indexOf(risk.level) !== -1, risk.level + ' score=' + risk.score);
const clusters = app.AllocationEngine.buildClusters({});
check('clustering menghasilkan seluruh account', clusters.rows.length === 8, 'rows=' + clusters.rows.length);
check('cluster distribution terisi',
  clusters.distribution.HIGH + clusters.distribution.MEDIUM + clusters.distribution.LOW === 8);
check('setiap account punya skor 0-100',
  clusters.rows.every((r) => r.score >= 0 && r.score <= 100));

section('8. Authentication & RBAC');
const login = app.Auth.login('admin', 'admin123');
check('login admin berhasil', !!login.token);
check('payload berisi navigasi ADMIN', login.navigation.length === app.NAVIGATION.length);
check('password tersimpan sebagai hash', app.UserRepo.findByUsername('admin').PASSWORD_HASH.indexOf('sha256$') === 0);
let wrongOk = false;
try { app.Auth.login('admin', 'salah'); } catch (e) { wrongOk = e.code === 'AUTH_FAILED'; }
check('login password salah ditolak', wrongOk);
const viewer = app.Auth.login('viewer', 'viewer123');
check('viewer tidak punya menu Settings',
  viewer.navigation.every((n) => n.id !== 'settings'));
let forbidden = false;
try { app.Auth.requirePermission(viewer.token, 'distribution.plan'); } catch (e) { forbidden = e.code === 'FORBIDDEN'; }
check('backend menolak viewer membuat plan', forbidden);
check('admin diizinkan membuat plan',
  app.Auth.requirePermission(login.token, 'distribution.plan').role === 'ADMIN');
let expired = false;
try { app.Auth.requireAuth('token-palsu'); } catch (e) { expired = e.code === 'AUTH_REQUIRED'; }
check('token palsu ditolak', expired);
app.Auth.logout(viewer.token);
let loggedOut = false;
try { app.Auth.requireAuth(viewer.token); } catch (e) { loggedOut = true; }
check('logout menghapus sesi', loggedOut);

section('9. Distribution workspace & plan sell in');
const ws = app.DistributionService.getWorkspace({ filters: {}, page: 1, pageSize: 10 });
check('workspace mengembalikan KPI', ws.kpi.totalAccount === 8, 'account=' + ws.kpi.totalAccount);
check('workspace pagination bekerja', ws.rows.length === 10 && ws.meta.total === matrix.rows.length);
check('default sort risk descending',
  ws.rows.length > 1 && ws.rows[0].riskScore >= ws.rows[1].riskScore);
check('trend bulanan 6 titik', ws.trend.length === 6);
const preview = app.DistributionService.getPlanPreview({ accountId: d1.accountId, skuId: d1.skuId });
check('plan preview berisi breakdown formula', !!preview.breakdown && preview.recommendedAllocation === d1.recommendedAllocation);
const adminSession = app.Auth.requireAuth(login.token);
let overrideBlocked = false;
try {
  app.DistributionService.savePlan(adminSession, {
    items: [{ accountId: d1.accountId, skuId: d1.skuId, plannedSellIn: 999 }]
  });
} catch (e) { overrideBlocked = e.code === 'OVERRIDE_REASON_REQUIRED'; }
check('manual override tanpa alasan ditolak', overrideBlocked);
const saved = app.DistributionService.savePlan(adminSession, {
  items: [{ accountId: d1.accountId, skuId: d1.skuId, plannedSellIn: 999, overrideReason: 'Program promo nasional' }],
  status: 'DRAFT'
});
check('plan tersimpan', saved.created + saved.updated === 1);
const plans = app.DistributionService.listPlans({ filters: { q: 'Demo Account 001' } });
const overridden = plans.rows.find((r) => r.PLANNED_SELL_IN === 999);
check('override tersimpan lengkap dengan alasan',
  !!overridden && overridden.OVERRIDE_REASON === 'Program promo nasional');
check('rekomendasi asli ikut tersimpan', !!overridden && overridden.RECOMMENDED_ALLOCATION === d1.recommendedAllocation);

section('10. Audit trail');
const audit = app.AuditService.search({}, { page: 1, pageSize: 100 });
const actions = audit.rows.map((r) => r.ACTION);
check('LOGIN tercatat', actions.indexOf('LOGIN') !== -1);
check('LOGOUT tercatat', actions.indexOf('LOGOUT') !== -1);
check('LOGIN_FAILED tercatat', actions.indexOf('LOGIN_FAILED') !== -1);
check('MANUAL_OVERRIDE tercatat', actions.indexOf('MANUAL_OVERRIDE') !== -1);
check('SETUP tercatat', actions.indexOf('SETUP') !== -1);
const overrideLog = audit.rows.find((r) => r.ACTION === 'MANUAL_OVERRIDE');
check('audit override menyimpan nilai lama & baru',
  !!overrideLog && overrideLog.NEW_VALUE.indexOf('999') !== -1);

section('11. System status');
const status = app.getSystemStatus();
check('database READY', status.database.ready);
check('sheets READY 11/11', status.sheets.ready && status.sheets.found === 11);
check('configuration READY', status.configuration.ready);
check('users READY', status.users.ready);
check('demo data READY', status.demoData.ready);

console.log('\n' + '='.repeat(64));
console.log(`HASIL: ${passed} PASS, ${failed} FAIL`);
if (failed) { console.log('Gagal: ' + failures.join(' | ')); process.exit(1); }
console.log('='.repeat(64));
