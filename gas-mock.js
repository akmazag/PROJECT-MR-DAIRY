/**
 * gas-mock.js — Emulator ringan Google Apps Script untuk menjalankan file .gs
 * PROJECT MR DAIRY di Node.js (dipakai untuk automated test, bukan produksi).
 *
 * Yang diemulasikan: SpreadsheetApp, CacheService, PropertiesService,
 * LockService, Utilities, Session.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Spreadsheet
// ---------------------------------------------------------------------------
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n, len) { return String(n).padStart(len, '0'); }

function formatDate(date, tz, pattern) {
  const d = new Date(date);
  const map = {
    yyyy: d.getFullYear(),
    MMM: MONTHS_SHORT[d.getMonth()],
    MM: pad(d.getMonth() + 1, 2),
    dd: pad(d.getDate(), 2),
    HH: pad(d.getHours(), 2),
    mm: pad(d.getMinutes(), 2),
    ss: pad(d.getSeconds(), 2)
  };
  return pattern.replace(/yyyy|MMM|MM|dd|HH|mm|ss/g, (m) => map[m]);
}

const STATS = { getRange: 0, getValues: 0, setValues: 0, cells: 0, writes: 0 };

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col;
    this.numRows = numRows; this.numCols = numCols;
  }
  getValues() {
    STATS.getValues++;
    STATS.cells += this.numRows * this.numCols;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = [];
      for (let c = 0; c < this.numCols; c++) {
        const cell = this.sheet._cell(this.row + r, this.col + c);
        rowArr.push(cell === undefined ? '' : cell);
      }
      out.push(rowArr);
    }
    return out;
  }
  setValues(values) {
    STATS.setValues++;
    STATS.writes += values.length;
    values.forEach((rowArr, r) => {
      rowArr.forEach((value, c) => this.sheet._setCell(this.row + r, this.col + c, value));
    });
    return this;
  }
  setValue(value) { return this.setValues([[value]]); }
  setNumberFormat() { return this; }
  setNumberFormats() { return this; }
  setDataValidation() { return this; }
  setFontFamily() { return this; }
  setFontSize() { return this; }
  setFontWeight() { return this; }
  setFontColor() { return this; }
  setBackground() { return this; }
  setVerticalAlignment() { return this; }
  setHorizontalAlignment() { return this; }
  setWrap() { return this; }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.grid = [];            // grid[row-1][col-1]
    this.maxRows = 1000;
    this.maxColumns = 26;
    this.protections = [];
  }
  _cell(row, col) { return (this.grid[row - 1] || [])[col - 1]; }
  _setCell(row, col, value) {
    if (!this.grid[row - 1]) this.grid[row - 1] = [];
    this.grid[row - 1][col - 1] = value;
    if (row > this.maxRows) this.maxRows = row;
    if (col > this.maxColumns) this.maxColumns = col;
  }
  getName() { return this.name; }
  getRange(row, col, numRows = 1, numCols = 1) {
    STATS.getRange++;
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getLastRow() {
    let last = 0;
    this.grid.forEach((rowArr, idx) => {
      if (rowArr && rowArr.some((v) => v !== '' && v !== null && v !== undefined)) last = idx + 1;
    });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.grid.forEach((rowArr) => {
      if (!rowArr) return;
      for (let c = rowArr.length; c > 0; c--) {
        const v = rowArr[c - 1];
        if (v !== '' && v !== null && v !== undefined) { last = Math.max(last, c); break; }
      }
    });
    return last;
  }
  getMaxRows() { return Math.max(this.maxRows, this.getLastRow()); }
  getMaxColumns() { return Math.max(this.maxColumns, this.getLastColumn()); }
  insertColumnsAfter(after, howMany) { this.maxColumns += howMany; return this; }
  deleteColumns(start, howMany) {
    this.grid.forEach((rowArr) => { if (rowArr) rowArr.splice(start - 1, howMany); });
    this.maxColumns = Math.max(1, this.maxColumns - howMany);
    return this;
  }
  deleteRow(row) { this.grid.splice(row - 1, 1); return this; }
  deleteRows(start, howMany) { this.grid.splice(start - 1, howMany); return this; }
  setFrozenRows() { return this; }
  setRowHeight() { return this; }
  setColumnWidth() { return this; }
  getProtections() { return this.protections; }
  protect() {
    const protection = {
      setDescription() { return this; },
      setWarningOnly() { return this; }
    };
    this.protections.push(protection);
    return protection;
  }
}

class FakeSpreadsheet {
  constructor(name) { this.name = name; this.sheets = []; this.timezone = 'Asia/Jakarta'; }
  getId() { return 'FAKE_SPREADSHEET_ID'; }
  getName() { return this.name; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find((s) => s.getName() === name) || null; }
  insertSheet(name) { const sheet = new FakeSheet(name); this.sheets.push(sheet); return sheet; }
  deleteSheet(sheet) { this.sheets = this.sheets.filter((s) => s !== sheet); }
  setActiveSheet(sheet) { this.active = sheet; return sheet; }
  moveActiveSheet(pos) {
    if (!this.active) return;
    this.sheets = this.sheets.filter((s) => s !== this.active);
    this.sheets.splice(pos - 1, 0, this.active);
  }
  getSpreadsheetTimeZone() { return this.timezone; }
  setSpreadsheetTimeZone(tz) { this.timezone = tz; }
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------
function createContext(options = {}) {
  const spreadsheet = new FakeSpreadsheet(options.name || 'PROJECT MR DAIRY - DATABASE');
  const cacheStore = new Map();
  const propStore = new Map();

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    openById: () => spreadsheet,
    ProtectionType: { SHEET: 'SHEET' },
    newDataValidation: () => ({
      requireValueInList() { return this; },
      setAllowInvalid() { return this; },
      setHelpText() { return this; },
      build() { return {}; }
    }),
    getUi: () => { throw new Error('No UI in test context'); }
  };

  const CacheService = {
    getScriptCache: () => ({
      get: (key) => (cacheStore.has(key) ? cacheStore.get(key) : null),
      put: (key, value) => cacheStore.set(key, value),
      putAll: (entries) => Object.keys(entries).forEach((k) => cacheStore.set(k, entries[k])),
      getAll: (keys) => {
        const out = {};
        keys.forEach((k) => { if (cacheStore.has(k)) out[k] = cacheStore.get(k); });
        return out;
      },
      remove: (key) => cacheStore.delete(key),
      removeAll: (keys) => keys.forEach((k) => cacheStore.delete(k))
    })
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (propStore.has(key) ? propStore.get(key) : null),
      setProperty: (key, value) => { propStore.set(key, String(value)); },
      deleteProperty: (key) => propStore.delete(key),
      getProperties: () => Object.fromEntries(propStore)
    })
  };

  const LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  };

  const Utilities = {
    formatDate,
    getUuid: () => crypto.randomUUID(),
    computeDigest: (_algo, text) => {
      const hash = crypto.createHash('sha256').update(text, 'utf8').digest();
      return Array.from(hash).map((b) => (b > 127 ? b - 256 : b));
    },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    base64Encode: (text) => Buffer.from(text, 'utf8').toString('base64')
  };

  const Session = { getScriptTimeZone: () => 'Asia/Jakarta', getActiveUser: () => ({ getEmail: () => 'test@demo' }) };

  const HtmlService = {
    createTemplateFromFile: () => ({ evaluate: () => ({}) }),
    createHtmlOutputFromFile: (f) => ({ getContent: () => `<!-- ${f} -->` }),
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
  };

  const sandbox = {
    SpreadsheetApp, CacheService, PropertiesService, LockService, Utilities, Session, HtmlService,
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, isNaN, isFinite,
    parseInt, parseFloat, RegExp, Error, TypeError
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, spreadsheet, cacheStore, propStore };
}

const LOAD_ORDER = [
  'Config.gs', 'Utils.gs', 'Database.gs', 'Repository.gs', 'AuditService.gs', 'Auth.gs',
  'DistributionService.gs', 'MRService.gs', 'SOPService.gs', 'DashboardService.gs',
  'AnalyticsService.gs', 'MasterService.gs', 'Setup.gs', 'Code.gs'
];

function loadProject(context, dir) {
  const base = dir || path.join(__dirname, '..', 'apps-script');
  LOAD_ORDER.forEach((file) => {
    const full = path.join(base, file);
    if (!fs.existsSync(full)) return;
    const code = fs.readFileSync(full, 'utf8');
    try {
      vm.runInContext(code, context.sandbox, { filename: file });
    } catch (err) {
      throw new Error(`Gagal memuat ${file}: ${err.message}`);
    }
  });
  return context.sandbox;
}

function resetStats() { Object.keys(STATS).forEach((k) => { STATS[k] = 0; }); }

module.exports = { createContext, loadProject, FakeSpreadsheet, LOAD_ORDER, STATS, resetStats };
