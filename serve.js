/**
 * serve.js — Harness lokal: menjalankan UI Apps Script di browser biasa.
 * Backend memakai file .gs asli melalui gas-mock, frontend memakai
 * Index/CSS/JS/Components/partial yang sama persis dengan produksi.
 *
 * Jalankan: node tools/serve.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createContext, loadProject } = require('./gas-mock.js');

const APP_DIR = path.join(__dirname, '..', 'apps-script');
const PORT = Number(process.argv[2] || 8123);

const ctx = createContext();
const app = loadProject(ctx);
app.setupDatabase();
app.createDemoData();

/** Resolusi <?!= include('X'); ?> secara rekursif seperti HtmlService. */
function renderTemplate(name, depth) {
  if ((depth || 0) > 6) return '';
  let html = fs.readFileSync(path.join(APP_DIR, name + '.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('([^']+)'\)\s*;?\s*\?>/g, (_, file) => renderTemplate(file, (depth || 0) + 1));
  return html;
}

function buildIndex() {
  let html = renderTemplate('Index');
  html = html.replace(/<\?!=\s*bootstrap\s*\?>/g, JSON.stringify(app.getBootstrap_()));
  // Suntik jembatan API lokal (produksi memakai google.script.run)
  html = html.replace('</script>\n\n<?!= include', '</script>\n<?!= include');
  const bridge = `
<script>
window.__MRD_LOCAL__ = function (action, token, payload) {
  return fetch('/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action, token: token, payload: payload })
  }).then(function (r) { return r.json(); });
};
window.__ERRORS__ = [];
window.addEventListener('error', function (e) { window.__ERRORS__.push(String(e.message) + ' @ ' + e.filename + ':' + e.lineno); });
window.addEventListener('unhandledrejection', function (e) { window.__ERRORS__.push('unhandled: ' + JSON.stringify(e.reason)); });
</script>`;
  return html.replace('window.BOOTSTRAP =', 'window.BOOTSTRAP =').replace('</body>', bridge + '\n</body>');
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let out;
      try {
        const { action, token, payload } = JSON.parse(body || '{}');
        out = app.api(action, token, payload);
      } catch (err) {
        out = { success: false, error: { code: 'HARNESS_ERROR', message: String(err && err.message || err) } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.url === '/reset') {
    app.resetDemoData();
    res.writeHead(200).end('reset ok');
    return;
  }
  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildIndex());
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Gagal merender template: ' + err.message);
  }
});

server.listen(PORT, () => console.log('MR DAIRY harness: http://localhost:' + PORT));
