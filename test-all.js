/**
 * test-all.js — Menjalankan seluruh suite pengujian PROJECT MR DAIRY.
 * Jalankan: node tools/test-all.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  { name: 'PHASE 1 — Database, setup, demo data, engine', file: 'test-phase1.js' },
  { name: 'PHASE 2 — Service layer, API router, RBAC', file: 'test-phase2.js' },
  { name: 'PERFORMANCE — Kepatuhan batasan Apps Script', file: 'test-performance.js' },
  { name: 'UI — Shell, login, navigasi, responsive', file: 'ui-test.js' },
  { name: 'UI FLOWS — Alur bisnis end-to-end di browser', file: 'ui-flows.js' }
];

const results = [];
suites.forEach((suite) => {
  console.log('\n' + '━'.repeat(70));
  console.log('▶  ' + suite.name);
  console.log('━'.repeat(70));
  const run = spawnSync('node', [path.join(__dirname, suite.file)], { encoding: 'utf8' });
  const output = (run.stdout || '') + (run.stderr || '');
  const summary = (output.match(/HASIL[^\n]*/g) || ['(tidak ada ringkasan)']).pop();
  console.log(summary.replace(/\x1b\[[0-9;]*m/g, ''));
  results.push({ name: suite.name, ok: run.status === 0, summary: summary.replace(/\x1b\[[0-9;]*m/g, '') });
});

console.log('\n' + '═'.repeat(70));
console.log('RINGKASAN PENGUJIAN');
console.log('═'.repeat(70));
let allOk = true;
results.forEach((r) => {
  console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name.padEnd(46) + r.summary.replace('HASIL', '').replace(/^[A-Z ]*:/, '').trim());
  if (!r.ok) allOk = false;
});
console.log('═'.repeat(70));
console.log(allOk ? 'SELURUH SUITE LULUS' : 'ADA SUITE YANG GAGAL');
process.exit(allOk ? 0 : 1);
