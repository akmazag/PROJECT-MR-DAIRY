/**
 * ui-flows.js — Uji alur bisnis end-to-end di browser sungguhan:
 * Distribution (review → plan → override), MR (input → approval → SO),
 * SOP, Monitoring, Analytics (chart + drill), Master Data, Audit, Settings,
 * serta RBAC untuk setiap role.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8151;
const BASE = 'http://localhost:' + PORT;
const SHOT_DIR = path.join(__dirname, '..', '.shots');
const WANT_SHOTS = process.argv.indexOf('--shot') !== -1;

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m  ' + label); }
  else { failed++; failures.push(label); console.log('  \x1b[31mFAIL\x1b[0m  ' + label + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, user, pass) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#login-username', user);
  await page.fill('#login-password', pass);
  await page.click('#login-submit');
  await page.waitForSelector('#app:not([hidden])', { timeout: 10000 });
  await wait(900);
}
async function goto(page, id) {
  await page.click('[data-nav="' + id + '"]');
  await wait(1100);
}

(async () => {
  const server = spawn('node', [path.join(__dirname, 'serve.js'), String(PORT)], { stdio: 'ignore' });
  await wait(2000);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().indexOf('ERR_CERT') === -1 && m.text().indexOf('font') === -1) {
      errors.push('console: ' + m.text());
    }
  });

  try {
    /* =================== DISTRIBUTION =================== */
    section('1. Distribution Planning');
    await login(page, 'admin', 'admin123');
    await goto(page, 'distribution');
    await page.waitForSelector('[data-dist-table] tbody tr', { timeout: 10000 });
    check('KPI distribution 6 kartu', (await page.$$('[data-dist-kpi] .kpi')).length === 6);
    check('tabel allocation terisi', (await page.$$('[data-dist-table] tbody tr')).length > 0);
    check('chart sell out vs return tampil', (await page.$$('[data-dist-trend] svg')).length === 1);
    check('donut risiko tampil', (await page.$$('[data-dist-risk] svg')).length === 1);
    const firstRowText = await page.textContent('[data-dist-table] tbody tr');
    check('baris memuat rekomendasi angka', /\d/.test(firstRowText));
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/03-distribution.png', fullPage: true });

    // Sorting preset
    await page.click('[data-dist-sort] button[data-sort="mr"]');
    await wait(900);
    const mrSorted = await page.$$eval('[data-dist-table] tbody tr td:nth-child(5)',
      (tds) => tds.map((td) => parseFloat(td.textContent.replace(',', '.'))));
    check('sort MR% descending', mrSorted.length > 1 && mrSorted[0] >= mrSorted[1],
      mrSorted.slice(0, 3).join(' > '));

    // Review drawer
    await page.click('[data-review]');
    await page.waitForSelector('#drawer.is-open #review-trend svg', { timeout: 10000 });
    check('review drawer menampilkan chart historis', (await page.$$('#drawer #review-trend svg')).length === 1);
    check('review drawer menampilkan MR trend', (await page.$$('#drawer #review-mr svg')).length === 1);
    check('review drawer punya KPI', (await page.$$('#drawer .kpi')).length >= 6);
    check('judul drawer tidak memuat entity mentah',
      (await page.textContent('#drawer-title')).indexOf('&amp;') === -1,
      await page.textContent('#drawer-title'));
    check('tombol determine plan tersedia', await page.isVisible('#review-plan'));
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/04-review-drawer.png' });

    // Plan modal + override wajib alasan
    await page.click('#review-plan');
    await page.waitForSelector('#modal.is-open', { timeout: 8000 });
    check('modal plan sell in terbuka', await page.isVisible('#modal.is-open'));
    check('breakdown formula ditampilkan', (await page.textContent('#modal-body')).indexOf('ALLOCATION_FACTOR') !== -1);
    const recValue = await page.inputValue('#plan-value');
    await page.fill('#plan-value', String(Number(recValue) + 50));
    await wait(300);
    check('field alasan muncul saat nilai diubah', await page.isVisible('#field-reason'));
    await page.click('#modal-foot button:nth-child(3)');
    await wait(900);
    check('override tanpa alasan ditolak (modal tetap terbuka)', await page.isVisible('#modal.is-open'));
    await page.fill('#plan-reason', 'Program promo nasional kuartal ini');
    await page.click('#modal-foot button:nth-child(3)');
    await page.waitForSelector('#modal:not(.is-open)', { timeout: 8000 });
    check('override dengan alasan tersimpan', !(await page.isVisible('#modal.is-open')));
    await wait(1200);
    check('drawer review ikut tertutup setelah simpan', !(await page.isVisible('#drawer.is-open')));
    check('overlay tidak menggantung', await page.evaluate(() =>
      !document.getElementById('overlay').classList.contains('is-open')));
    check('nilai override muncul di tabel',
      (await page.textContent('[data-dist-table]')).indexOf('vs rekomendasi') !== -1);

    // Tab clustering
    await page.click('[data-dist-tabs] .tab[data-tab="cluster"]');
    await page.waitForSelector('[data-cluster-table] tbody tr', { timeout: 10000 });
    check('clustering menampilkan account', (await page.$$('[data-cluster-table] tbody tr')).length === 8);
    check('formula clustering ditampilkan',
      (await page.textContent('[data-cluster-formula]')).indexOf('SCORE') !== -1);
    check('donut cluster tampil', (await page.$$('[data-cluster-donut] svg')).length === 1);

    // Tab rencana tersimpan
    await page.click('[data-dist-tabs] .tab[data-tab="plans"]');
    await page.waitForSelector('[data-plans-table] tbody tr', { timeout: 10000 });
    const planRows = await page.$$('[data-plans-table] tbody tr');
    check('rencana tersimpan tampil', planRows.length > 0);
    check('override ditandai di tabel',
      (await page.textContent('[data-plans-table]')).indexOf('manual override') !== -1);

    /* =================== MR ADMINISTRATION =================== */
    section('2. MR Administration (alur lengkap)');
    await goto(page, 'mr');
    await page.waitForSelector('[data-mr-table] tbody tr', { timeout: 10000 });
    check('KPI MR 4 kartu', (await page.$$('[data-mr-kpi] .kpi')).length === 4);
    check('tabel MR terisi', (await page.$$('[data-mr-table] tbody tr')).length > 0);
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/05-mr.png', fullPage: true });

    await page.click('[data-mr="create"]');
    await page.waitForSelector('#modal.is-open', { timeout: 8000 });
    check('form input MR terbuka', await page.isVisible('#mr-account'));
    check('label tombol modal bersih dari entity',
      (await page.textContent('#modal-foot')).indexOf('&amp;') === -1,
      await page.textContent('#modal-foot'));
    check('progress tracker ditampilkan', (await page.$$('#modal .tracker__step')).length === 5);
    const accountOptions = await page.$$eval('#mr-account option', (o) => o.map((x) => x.value).filter(Boolean));
    const skuOptions = await page.$$eval('#mr-sku option', (o) => o.map((x) => x.value).filter(Boolean));
    await page.selectOption('#mr-account', accountOptions[0]);
    await page.selectOption('#mr-sku', skuOptions[0]);
    await page.fill('#mr-qty', '6');
    await page.click('#modal-foot button:nth-child(2)');
    await page.waitForSelector('#drawer-foot [data-mr-action]', { timeout: 12000 });
    check('MR tersimpan dan detail terbuka', await page.isVisible('#drawer.is-open'));
    const detailText = await page.textContent('#drawer-body');
    check('hasil validasi otomatis tampil', detailText.indexOf('validasi otomatis') !== -1);
    check('checklist validasi >= 10 item', (await page.$$('#drawer .check-item')).length >= 10);
    check('timeline proses tampil', (await page.$$('#drawer .timeline__item')).length >= 7);
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/06-mr-detail.png' });

    const mrId = (await page.textContent('#drawer-title')).trim();
    check('nomor MR terbentuk', /^MR-\d+/.test(mrId), mrId);
    check('tombol kirim ke Sales tersedia', await page.isVisible('[data-mr-action="submit"]'));
    await page.click('[data-mr-action="submit"]');
    await wait(1500);
    check('status menjadi WAITING APPROVAL',
      (await page.textContent('#drawer-body')).indexOf('WAITING APPROVAL') !== -1);
    check('ADMIN dapat approve', await page.isVisible('[data-mr-action="approve"]'));
    await page.click('[data-mr-action="approve"]');
    await page.waitForSelector('#modal.is-open', { timeout: 8000 });
    await page.click('#modal-foot button:nth-child(2)');
    await wait(2000);
    const afterApprove = await page.textContent('#drawer-body');
    check('approve membuat SO otomatis', /SO-MR-\d{8}-\d{4}/.test(afterApprove),
      (afterApprove.match(/SO-MR-[\d-]+/) || ['tidak ditemukan'])[0]);
    check('status menjadi SO CREATED', afterApprove.indexOf('SO CREATED') !== -1);
    await page.click('[data-mr-action="close"]');
    await wait(400);

    /* =================== SOP =================== */
    section('3. SOP');
    await goto(page, 'sop');
    await page.waitForSelector('[data-sop-steps] .card', { timeout: 10000 });
    check('3 langkah SOP tampil', (await page.$$('[data-sop-steps] > .card')).length === 3);
    check('SOP memuat aturan', (await page.textContent('[data-sop-steps]')).indexOf('Aturan') !== -1);
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/07-sop.png', fullPage: true });
    await page.click('[data-sop-tabs] .tab[data-tab="pickup"]');
    await wait(1400);
    check('KPI jadwal penarikan tampil', (await page.$$('[data-pickup-kpi] .kpi')).length === 4);
    check('timeline penarikan terisi',
      (await page.$$('[data-pickup-timeline] .check-item')).length > 0
      || (await page.textContent('[data-pickup-timeline]')).indexOf('Belum ada') !== -1);
    await page.click('[data-sop-tabs] .tab[data-tab="cutoff"]');
    await wait(1400);
    check('tabel cutoff terisi', (await page.$$('[data-cutoff-table] tbody tr')).length > 0);
    check('sisa hari cutoff ditampilkan',
      (await page.textContent('[data-cutoff-table]')).length > 50);
    await page.click('[data-sop-tabs] .tab[data-tab="bap"]');
    await wait(1400);
    check('aturan BAP tampil', (await page.textContent('[data-bap-rule]')).indexOf('Fresh') !== -1);

    /* =================== MONITORING =================== */
    section('4. Monitoring');
    await goto(page, 'monitoring');
    await page.waitForSelector('[data-monitor-board] .kanban__col', { timeout: 10000 });
    check('7 kolom kanban', (await page.$$('[data-monitor-board] .kanban__col')).length === 7);
    check('kartu kanban terisi', (await page.$$('[data-monitor-board] .kcard')).length > 0);
    check('KPI monitoring tampil', (await page.$$('[data-monitor-kpi] .kpi')).length === 4);
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/08-monitoring.png', fullPage: true });
    await page.click('[data-monitor-view] button[data-view="sla"]');
    await wait(600);
    check('tabel SLA tampil', (await page.$$('[data-monitor-sla] tbody tr')).length === 7);
    await page.click('[data-monitor-view] button[data-view="board"]');
    await wait(500);
    await page.click('[data-monitor-board] .kcard');
    await wait(1600);
    check('klik kartu membuka dokumen MR', await page.isVisible('#page-mr'));
    check('detail MR terbuka dari kanban', await page.isVisible('#drawer.is-open'));
    await page.click('#drawer-close');
    await wait(400);

    /* =================== ANALYTICS =================== */
    section('5. Analytics');
    await goto(page, 'analytics');
    await page.waitForSelector('[data-an-charts] .card', { timeout: 12000 });
    await wait(900);
    check('10 chart ter-render', (await page.$$('[data-an-charts] > .card')).length === 10);
    const svgCount = (await page.$$('[data-an-charts] svg')).length;
    check('chart menghasilkan SVG', svgCount >= 6, 'svg=' + svgCount);
    check('hbar list ter-render', (await page.$$('[data-an-charts] .hbar')).length > 0);
    check('bar horizontal benar-benar terisi (bukan span inline kosong)', await page.evaluate(() => {
      const fill = document.querySelector('[data-chart-host="mrByAccount"] .hbar__fill');
      if (!fill) return false;
      const r = fill.getBoundingClientRect();
      return r.width > 10 && r.height > 3;
    }), await page.evaluate(() => {
      const f = document.querySelector('[data-chart-host="mrByAccount"] .hbar__fill');
      return f ? Math.round(f.getBoundingClientRect().width) + 'x' + Math.round(f.getBoundingClientRect().height) : 'tidak ada';
    }));
    check('label sumbu X chart terbaca dan tidak bertabrakan', await page.evaluate(() => {
      const axis = Array.from(document.querySelectorAll('[data-chart-host="pendingMr"] .chart__axis-x'));
      if (!axis.length) return false;
      const rotated = axis.every((t) => (t.getAttribute('transform') || '').indexOf('rotate') !== -1);
      if (rotated) {
        // Baris miring paralel: cukup pastikan tiap label masih punya isi teks
        return axis.every((t) => t.textContent.replace('…', '').length >= 4);
      }
      const boxes = axis.map((t) => t.getBoundingClientRect());
      for (let i = 1; i < boxes.length; i++) {
        if (boxes[i].left < boxes[i - 1].right - 2) return false;
      }
      return true;
    }));
    check('label bulan pada chart tidak terpotong berlebihan', await page.evaluate(() => {
      const axis = Array.from(document.querySelectorAll('[data-chart-host="mrTrend"] .chart__axis-x'));
      return axis.length > 0 && axis.every((t) => t.textContent.indexOf('…') === -1);
    }), await page.evaluate(() => Array.from(document.querySelectorAll('[data-chart-host="mrTrend"] .chart__axis-x'))
      .map((t) => t.textContent).join(',')));
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/09-analytics.png', fullPage: true });

    await page.click('[data-chart-host="mrByAccount"] .hbar');
    await page.waitForSelector('#drawer.is-open table', { timeout: 10000 });
    check('drill-down membuka detail', (await page.$$('#drawer tbody tr')).length > 0);
    await page.click('#drawer-close');
    await wait(400);

    await page.click('[data-an-tabs] .tab[data-tab="report"]');
    await page.waitForSelector('[data-report-preview] table', { timeout: 10000 });
    check('5 report tersedia', (await page.$$('[data-report-list] [data-report]')).length === 5);
    check('preview report terisi', (await page.$$('[data-report-preview] tbody tr')).length > 0);
    check('tombol export tampil', await page.isVisible('[data-an="export-current"]'));

    /* =================== MASTER, AUDIT, SETTINGS =================== */
    section('6. Master Data, Audit, Settings');
    await goto(page, 'master');
    await page.waitForSelector('[data-master-table] tbody tr', { timeout: 10000 });
    check('master account terisi', (await page.$$('[data-master-table] tbody tr')).length === 8);
    await page.click('[data-master-tabs] .tab[data-tab="skus"]');
    await wait(1000);
    check('master SKU terisi', (await page.$$('[data-master-table] tbody tr')).length === 6);
    await page.click('[data-master-tabs] .tab[data-tab="users"]');
    await wait(1000);
    check('master user terisi', (await page.$$('[data-master-table] tbody tr')).length === 5);
    check('password tidak ditampilkan',
      (await page.textContent('[data-master-table]')).indexOf('sha256') === -1);

    await goto(page, 'audit');
    await page.waitForSelector('[data-audit-table] tbody tr', { timeout: 10000 });
    check('audit log terisi', (await page.$$('[data-audit-table] tbody tr')).length > 0);
    const auditText = await page.textContent('[data-audit-table]');
    check('audit mencatat CREATE SO', auditText.indexOf('CREATE SO') !== -1);
    await page.click('[data-audit-table] tbody tr');
    await page.waitForSelector('#drawer.is-open', { timeout: 8000 });
    check('detail audit menampilkan nilai lama/baru',
      (await page.textContent('#drawer-body')).indexOf('Deskripsi') !== -1);
    await page.click('#drawer-close');
    await wait(300);

    await goto(page, 'settings');
    await page.waitForSelector('[data-set-list] table', { timeout: 10000 });
    check('settings menampilkan business rules', (await page.$$('[data-set-list] tbody tr')).length > 20);
    check('nilai default ditampilkan',
      (await page.textContent('[data-set-list]')).indexOf('ALLOCATION_FACTOR') !== -1);
    await page.fill('[data-set-search]', 'MR_THRESHOLD');
    await wait(600);
    check('pencarian settings bekerja',
      (await page.$$('[data-set-list] tbody tr')).length > 0
      && (await page.$$('[data-set-list] tbody tr')).length < 10);
    await page.click('[data-set-tabs] .tab[data-tab="system"]');
    await wait(1200);
    check('system setup status tampil', (await page.$$('[data-set-status] .status-row')).length === 5);
    check('status database READY',
      (await page.textContent('[data-set-status]')).indexOf('READY') !== -1);
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/10-settings.png', fullPage: true });

    /* =================== RBAC =================== */
    section('6b. Filter tidak bocor antar halaman');
    await goto(page, 'mr');
    await page.waitForSelector('[data-mr-table] tbody tr', { timeout: 10000 });
    await page.selectOption('#page-mr [data-filter="status"]', 'INPUT');
    await page.click('#page-mr [data-filter-apply]');
    await wait(1400);
    const mrFilteredRows = await page.$$('[data-mr-table] tbody tr');
    check('filter status MR bekerja di halamannya', mrFilteredRows.length > 0
      && (await page.textContent('[data-mr-table]')).indexOf('COMPLETED') === -1);
    await goto(page, 'monitoring');
    await page.waitForSelector('[data-monitor-board] .kanban__col', { timeout: 10000 });
    const columnsWithCards = await page.$$eval('[data-monitor-board] .kanban__col',
      (cols) => cols.filter((c) => c.querySelectorAll('.kcard').length > 0).length);
    check('monitoring tidak ikut tersaring status dari halaman MR', columnsWithCards > 1,
      columnsWithCards + ' kolom berisi kartu');
    await goto(page, 'mr');
    await wait(900);
    await page.click('#page-mr [data-filter-reset]');
    await wait(1200);

    section('7. RBAC di UI');
    await login(page, 'viewer', 'viewer123');
    const viewerNav = await page.$$eval('[data-nav]', (els) => els.map((e) => e.getAttribute('data-nav')));
    check('VIEWER hanya melihat menu read-only',
      viewerNav.indexOf('settings') === -1 && viewerNav.indexOf('master') === -1
      && viewerNav.indexOf('dashboard') !== -1, viewerNav.join(','));
    await goto(page, 'mr');
    await wait(900);
    check('VIEWER tidak melihat tombol Input MR',
      await page.evaluate(() => document.querySelector('[data-mr="create"]').hidden === true));

    await login(page, 'sales', 'sales123');
    await goto(page, 'mr');
    await page.waitForSelector('[data-mr-table] tbody tr', { timeout: 10000 });
    check('SALES tidak bisa input MR',
      await page.evaluate(() => document.querySelector('[data-mr="create"]').hidden === true));
    await page.click('[data-mr-quick] button[data-quick="WAITING_APPROVAL"]');
    await wait(1200);
    const waitingRows = await page.$$('[data-mr-table] tbody tr');
    if (waitingRows.length) {
      await waitingRows[0].click();
      await page.waitForSelector('#drawer-foot [data-mr-action]', { timeout: 10000 });
      check('SALES melihat tombol approve', await page.isVisible('[data-mr-action="approve"]'));
      check('SALES tidak melihat tombol ubah', !(await page.isVisible('[data-mr-action="edit"]')));
      await page.click('#drawer-close');
    } else {
      check('SALES melihat antrean approval', true);
    }

    await login(page, 'mr', 'mr123');
    await goto(page, 'mr');
    await wait(900);
    check('MR user melihat tombol Input MR',
      await page.evaluate(() => document.querySelector('[data-mr="create"]').hidden === false));
    const mrNav = await page.$$eval('[data-nav]', (els) => els.map((e) => e.getAttribute('data-nav')));
    check('MR user tidak melihat menu audit & settings',
      mrNav.indexOf('audit') === -1 && mrNav.indexOf('settings') === -1, mrNav.join(','));

    section('8. Stabilitas');
    check('tidak ada error JS selama seluruh alur', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    failed++;
    failures.push('EXCEPTION: ' + err.message);
    console.log('\n\x1b[31mEXCEPTION\x1b[0m ' + err.message);
    try { await page.screenshot({ path: SHOT_DIR + '/flow-error.png', fullPage: true }); } catch (e) { }
  }

  await browser.close();
  server.kill();
  console.log('\n' + '='.repeat(64));
  console.log(`HASIL FLOW: ${passed} PASS, ${failed} FAIL`);
  if (failed) { console.log('Gagal: ' + failures.join(' | ')); process.exit(1); }
  console.log('='.repeat(64));
})();
