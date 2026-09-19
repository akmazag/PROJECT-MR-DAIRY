/**
 * ui-test.js — Uji UI sungguhan dengan Chromium (Playwright) terhadap
 * harness lokal. Memastikan tidak ada JS error, halaman ter-render, dan
 * alur utama berfungsi. Jalankan: node tools/ui-test.js [--shot]
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8137;
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

(async () => {
  const server = spawn('node', [path.join(__dirname, 'serve.js'), String(PORT)], { stdio: 'ignore' });
  await wait(1800);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  try {
    section('1. Boot & Login');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    check('halaman login tampil', await page.isVisible('#login-screen'));
    check('tidak ada layar putih kosong', await page.isVisible('.auth__headline'));
    check('akun demo tersedia', (await page.$$('.demo-account')).length === 4);

    await page.click('.demo-account[data-u="admin"]');
    check('klik akun demo mengisi form', (await page.inputValue('#login-username')) === 'admin');
    await page.click('#login-submit');
    await page.waitForSelector('#app:not([hidden])', { timeout: 10000 });
    check('masuk ke aplikasi', await page.isVisible('#app'));
    check('layar login benar-benar hilang dari layout',
      await page.evaluate(() => getComputedStyle(document.getElementById('login-screen')).display === 'none'));
    check('boot & setup screen tidak ikut layout',
      await page.evaluate(() => ['boot-screen', 'setup-screen'].every((id) =>
        getComputedStyle(document.getElementById(id)).display === 'none')));
    check('sidebar menampilkan 9 menu ADMIN', (await page.$$('[data-nav]')).length === 9);
    check('identitas user tampil', (await page.textContent('#user-name')).trim() === 'Administrator');

    section('2. Dashboard');
    await page.waitForSelector('[data-kpi-grid] .kpi', { timeout: 10000 });
    const kpiCount = (await page.$$('[data-kpi-grid] .kpi')).length;
    check('8 KPI card ter-render', kpiCount === 8, 'ditemukan ' + kpiCount);
    const mrKpi = await page.textContent('[data-kpi-grid] .kpi:nth-child(2) .kpi__value');
    check('KPI MR% terisi angka', /\d/.test(mrKpi), mrKpi);
    check('chart trend ter-render (SVG)', (await page.$$('[data-chart-trend] svg')).length === 1);
    check('objective Less Return tampil', (await page.textContent('[data-objective]')).indexOf('Less Return') !== -1);
    check('tabel prioritas risiko terisi', (await page.$$('[data-top-risk] tbody tr')).length > 0);
    check('panel tindak lanjut terisi', (await page.$$('[data-attention] .check-item')).length > 0);
    check('filter bar ter-render', await page.isVisible('#page-dashboard .filterbar'));
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/01-dashboard.png', fullPage: true });

    section('3. Interaksi dashboard');
    await page.click('[data-trend-switch] button[data-metric="volume"]');
    await wait(400);
    check('switch metrik trend bekerja', (await page.$$('[data-chart-trend] svg')).length === 1);
    await page.hover('[data-chart-trend] svg rect:last-child').catch(() => {});
    await page.click('#btn-notification');
    await page.waitForSelector('#drawer.is-open', { timeout: 5000 });
    check('drawer notifikasi terbuka', await page.isVisible('#drawer.is-open'));
    await page.click('#drawer-close');
    await wait(300);
    check('drawer tertutup', !(await page.isVisible('#drawer.is-open')));

    section('4. Navigasi & RBAC');
    const navIds = await page.$$eval('[data-nav]', (els) => els.map((e) => e.getAttribute('data-nav')));
    check('menu lengkap untuk ADMIN',
      ['dashboard', 'distribution', 'mr', 'sop', 'monitoring', 'analytics', 'master', 'audit', 'settings']
        .every((id) => navIds.indexOf(id) !== -1), navIds.join(','));
    for (const id of navIds) {
      await page.click('[data-nav="' + id + '"]');
      await wait(500);
      const visible = await page.isVisible('#page-' + id);
      check('halaman ' + id + ' tampil', visible);
    }

    section('5. Filter & sesi');
    await page.click('[data-nav="dashboard"]');
    await wait(600);
    await page.selectOption('#page-dashboard [data-filter="region"]', 'Jakarta').catch(() => {});
    await page.click('#page-dashboard [data-filter-apply]');
    await wait(900);
    check('filter region diterapkan tanpa error', await page.isVisible('[data-kpi-grid] .kpi'));
    await page.click('#page-dashboard [data-filter-reset]');
    await wait(700);

    await page.reload({ waitUntil: 'networkidle' });
    await wait(1200);
    check('sesi bertahan setelah reload', await page.isVisible('#app'));

    section('6. Responsive');
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(500);
    check('sidebar tersembunyi di mobile', !(await page.isVisible('#sidebar.is-open')));
    check('tombol menu mobile tampil', await page.isVisible('#btn-menu'));
    await page.click('#btn-menu');
    await wait(400);
    check('sidebar drawer terbuka di mobile', await page.isVisible('#sidebar.is-open'));
    await page.click('#overlay');
    await wait(300);
    if (WANT_SHOTS) await page.screenshot({ path: SHOT_DIR + '/02-mobile.png', fullPage: true });
    // Uji yang benar-benar dirasakan user: halaman tidak bisa digeser ke samping
    check('tidak ada horizontal scroll di 390px', await page.evaluate(() => {
      window.scrollTo(200, 0);
      const x = window.scrollX;
      window.scrollTo(0, 0);
      return x === 0;
    }), 'scrollX setelah digeser');
    check('KPI 2 kolom di mobile', await page.evaluate(() => {
      const cards = document.querySelectorAll('#page-dashboard [data-kpi-grid] .kpi');
      if (cards.length < 2) return false;
      return Math.abs(cards[0].getBoundingClientRect().top - cards[1].getBoundingClientRect().top) < 2;
    }));
    await page.setViewportSize({ width: 768, height: 1024 });
    await wait(400);
    check('tablet 768px tanpa overflow',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.setViewportSize({ width: 1440, height: 900 });
    await wait(400);
    // Sticky topbar harus tetap menempel setelah halaman di-scroll
    await page.evaluate(() => window.scrollTo(0, 400));
    await wait(300);
    check('topbar sticky tetap di atas', await page.evaluate(() => {
      const r = document.querySelector('.topbar').getBoundingClientRect();
      return r.top >= -1 && r.top <= 1;
    }), await page.evaluate(() => String(document.querySelector('.topbar').getBoundingClientRect().top)));
    await page.evaluate(() => window.scrollTo(0, 0));

    section('7. Console bersih');
    const runtimeErrors = await page.evaluate(() => window.__ERRORS__ || []);
    check('tidak ada runtime error', runtimeErrors.length === 0, runtimeErrors.join(' | '));
    // Abaikan error jaringan lingkungan sandbox (Google Fonts diblokir proxy TLS).
    const realConsoleErrors = consoleErrors.filter((e) =>
      e.indexOf('favicon') === -1 && e.indexOf('ERR_CERT') === -1
      && e.indexOf('fonts.googleapis') === -1 && e.indexOf('fonts.gstatic') === -1);
    check('tidak ada console error', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 3).join(' | '));

    section('8. Logout');
    await page.click('#user-chip');
    await page.waitForSelector('#drawer.is-open');
    await page.click('#btn-logout');
    await wait(800);
    check('kembali ke halaman login', await page.isVisible('#login-screen'));
  } catch (err) {
    failed++;
    failures.push('EXCEPTION: ' + err.message);
    console.log('\n\x1b[31mEXCEPTION\x1b[0m ' + err.message);
    try { await page.screenshot({ path: SHOT_DIR + '/error.png' }); } catch (e) { }
  }

  await browser.close();
  server.kill();

  console.log('\n' + '='.repeat(64));
  console.log(`HASIL UI: ${passed} PASS, ${failed} FAIL`);
  if (failed) { console.log('Gagal: ' + failures.join(' | ')); process.exit(1); }
  console.log('='.repeat(64));
})();
