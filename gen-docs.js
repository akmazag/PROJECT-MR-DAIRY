/**
 * gen-docs.js — Membangun dokumentasi schema & settings langsung dari Config.gs
 * sehingga dokumen tidak pernah menyimpang dari kode.
 * Jalankan: node tools/gen-docs.js
 */
const fs = require('fs');
const path = require('path');
const { createContext, loadProject } = require('./gas-mock.js');

const ctx = createContext();
const app = loadProject(ctx);
const DOCS = path.join(__dirname, '..', 'docs');
if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS, { recursive: true });

const TYPE_LABEL = {
  text: 'Teks', int: 'Bilangan bulat', qty: 'Kuantitas', money: 'Nilai uang',
  percent: 'Persentase', decimal: 'Desimal', date: 'Tanggal', datetime: 'Tanggal & waktu', bool: 'Boolean'
};

function schemaDoc() {
  const lines = [];
  lines.push('# Database Schema — PROJECT MR DAIRY');
  lines.push('');
  lines.push('> Dokumen ini digenerate dari `apps-script/Config.gs` (`node tools/gen-docs.js`).');
  lines.push('> Seluruh sheet dibuat otomatis oleh `setupDatabase()`. Tidak ada sheet yang perlu dibuat manual.');
  lines.push('');
  lines.push('## Ringkasan');
  lines.push('');
  lines.push('| # | Sheet | Fungsi | Kolom | Primary key |');
  lines.push('|---|-------|--------|-------|-------------|');
  app.SHEET_ORDER.forEach((name, i) => {
    const s = app.SCHEMA[name];
    lines.push(`| ${i + 1} | \`${name}\` | ${s.description} | ${s.headers.length} | \`${s.idField}\` |`);
  });
  lines.push('');
  lines.push('## Relasi antar sheet');
  lines.push('');
  lines.push('```');
  lines.push('ACCOUNT_MASTER ──┐');
  lines.push('                 ├──< SALES_DATA      (ACCOUNT_ID, SKU_ID)');
  lines.push('SKU_MASTER ──────┤');
  lines.push('                 ├──< RETURN_DATA     (ACCOUNT_ID, SKU_ID)');
  lines.push('                 ├──< STOCK_MOVEMENT  (ACCOUNT_ID, SKU_ID)');
  lines.push('                 ├──< ALLOCATION_PLAN (ACCOUNT_ID, SKU_ID)');
  lines.push('                 └──< MR_ADMIN        (ACCOUNT_ID, SKU_ID)');
  lines.push('');
  lines.push('USERS ──────────────> AUDIT_LOG.USER, *.CREATED_BY, *.APPROVED_BY');
  lines.push('SETTINGS ───────────> dibaca seluruh service (business rules)');
  lines.push('SOP_MASTER ─────────> aturan yang dipakai modul MR');
  lines.push('```');
  lines.push('');

  app.SHEET_ORDER.forEach((name) => {
    const s = app.SCHEMA[name];
    lines.push(`## ${name}`);
    lines.push('');
    lines.push(s.description);
    lines.push('');
    lines.push('| Kolom | Tipe | Keterangan |');
    lines.push('|-------|------|------------|');
    s.headers.forEach((h) => {
      const type = s.types[h] || 'text';
      let note = '';
      if (h === s.idField) note = `Primary key, format \`${s.idPrefix}-0001\``;
      if (s.validations && s.validations[h]) {
        note = (note ? note + '. ' : '') + 'Nilai: ' + s.validations[h].map((v) => `\`${v}\``).join(', ');
      }
      if (h.endsWith('_ID') && h !== s.idField) note = note || 'Relasi ke master';
      lines.push(`| \`${h}\` | ${TYPE_LABEL[type] || type} | ${note} |`);
    });
    lines.push('');
  });

  lines.push('## Enum yang dipakai aplikasi');
  lines.push('');
  Object.keys(app.ENUMS).forEach((key) => {
    lines.push(`- **${key}**: ${app.ENUMS[key].map((v) => '`' + v + '`').join(', ')}`);
  });
  lines.push('');
  lines.push('## Urutan status MR');
  lines.push('');
  lines.push('```');
  lines.push(app.MR_FLOW.join(' → '));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function settingsDoc() {
  const lines = [];
  lines.push('| Key | Default | Keterangan |');
  lines.push('|-----|---------|------------|');
  app.DEFAULT_SETTINGS.forEach((item) => {
    lines.push(`| \`${item[0]}\` | \`${item[1]}\` | ${item[2]} |`);
  });
  return lines.join('\n');
}

function roleMatrixDoc() {
  const lines = [];
  const roles = app.ENUMS.ROLE;
  lines.push('| Permission | ' + roles.join(' | ') + ' |');
  lines.push('|------------|' + roles.map(() => '---').join('|') + '|');
  Object.keys(app.PERMISSIONS).forEach((perm) => {
    const row = roles.map((r) => (app.PERMISSIONS[perm].indexOf(r) !== -1 ? '✅' : '—'));
    lines.push(`| \`${perm}\` | ` + row.join(' | ') + ' |');
  });
  return lines.join('\n');
}

function apiDoc() {
  const routes = app.getApiRoutes_();
  const lines = [];
  lines.push('| Action | Permission | Keterangan |');
  lines.push('|--------|------------|------------|');
  Object.keys(routes).sort().forEach((action) => {
    const route = routes[action];
    const perm = route.public ? '_publik_' : (route.permission ? '`' + route.permission + '`' : '_login saja_');
    lines.push(`| \`${action}\` | ${perm} | |`);
  });
  return lines.join('\n');
}

const FRAGMENTS = path.join(__dirname, '.generated');
if (!fs.existsSync(FRAGMENTS)) fs.mkdirSync(FRAGMENTS, { recursive: true });

fs.writeFileSync(path.join(DOCS, 'DATABASE-SCHEMA.md'), schemaDoc());
fs.writeFileSync(path.join(FRAGMENTS, 'settings-table.md'), settingsDoc());
fs.writeFileSync(path.join(FRAGMENTS, 'role-matrix.md'), roleMatrixDoc());
fs.writeFileSync(path.join(FRAGMENTS, 'api-table.md'), apiDoc());
console.log('docs/DATABASE-SCHEMA.md diperbarui (' + app.SHEET_ORDER.length + ' sheet)');
console.log('Fragment tabel settings / role matrix / API tersedia di tools/.generated/');
console.log('→ salin ke docs/BUSINESS-LOGIC.md dan docs/API.md bila schema berubah.');
