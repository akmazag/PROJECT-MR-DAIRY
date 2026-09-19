/**
 * PROJECT MR DAIRY
 * ============================================================================
 * Database.gs — Data Access Layer ke Google Sheets.
 *
 * PRINSIP PERFORMANCE (wajib dipatuhi seluruh service):
 *   1. Baca sekali dengan getValues(), jangan getRange() per baris.
 *   2. Tulis sekali dengan setValues(), jangan setValue() per sel.
 *   3. Dataset yang sering dibaca disimpan di CacheService (chunked, 90KB/chunk).
 *   4. Seluruh operasi tulis dibungkus LockService.
 *   5. Cache di-invalidate secara eksplisit setiap kali terjadi write.
 * ============================================================================
 */

var DB = (function () {

  var CACHE_PREFIX = 'MRD_TBL_';
  var CHUNK_SIZE = 90000;   // < 100KB limit CacheService
  var MAX_CACHE_BYTES = 900000;
  var LOCK_TIMEOUT_MS = 25000;

  var _ss = null;
  var _memo = {};           // memoization per-eksekusi (request scope)

  // -------------------------------------------------------------------------
  // Spreadsheet & Sheet
  // -------------------------------------------------------------------------

  /**
   * Spreadsheet aktif. Script container-bound memakai getActiveSpreadsheet();
   * bila tidak tersedia (mis. dijalankan dari trigger web app standalone)
   * fallback ke ID yang disimpan saat setupDatabase().
   */
  function spreadsheet() {
    if (_ss) return _ss;
    try {
      _ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (e) {
      _ss = null;
    }
    if (!_ss) {
      var id = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.SPREADSHEET_ID);
      if (!id) {
        throwError('NO_SPREADSHEET',
          'Spreadsheet database belum terdeteksi. Jalankan setupDatabase() dari Apps Script editor terlebih dahulu.');
      }
      _ss = SpreadsheetApp.openById(id);
    }
    return _ss;
  }

  function sheet(name) {
    var sh = spreadsheet().getSheetByName(name);
    if (!sh) {
      throwError('SHEET_NOT_FOUND',
        'Sheet "' + name + '" belum tersedia. Jalankan setupDatabase() untuk membuat struktur database.');
    }
    return sh;
  }

  function sheetExists(name) {
    return !!spreadsheet().getSheetByName(name);
  }

  /**
   * Buat sheet bila belum ada, lengkap dengan header.
   * Tidak pernah membuat duplikat: sheet yang sudah ada dipakai ulang dan
   * header-nya disinkronkan (kolom baru ditambahkan di belakang).
   */
  function getOrCreateSheetInternal(name, headers) {
    var ss = spreadsheet();
    var sh = ss.getSheetByName(name);
    var created = false;
    if (!sh) {
      sh = ss.insertSheet(name);
      created = true;
    }
    if (headers && headers.length) {
      var lastCol = sh.getLastColumn();
      var existing = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
      var existingClean = existing.filter(function (h) { return Utils.str(h) !== ''; });
      if (!existingClean.length) {
        sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      } else {
        // Tambahkan kolom yang belum ada (migrasi ringan, data lama tetap aman).
        var missing = headers.filter(function (h) { return existingClean.indexOf(h) === -1; });
        if (missing.length) {
          sh.getRange(1, existingClean.length + 1, 1, missing.length).setValues([missing]);
        }
      }
    }
    return { sheet: sh, created: created };
  }

  // -------------------------------------------------------------------------
  // Cache
  // -------------------------------------------------------------------------

  function cache() {
    return CacheService.getScriptCache();
  }

  function cacheKey(name) { return CACHE_PREFIX + name; }

  function cachePut(name, payload, ttl) {
    try {
      var json = JSON.stringify(payload);
      if (json.length > MAX_CACHE_BYTES) return;            // terlalu besar → skip cache
      var chunks = Math.ceil(json.length / CHUNK_SIZE);
      var entries = {};
      for (var i = 0; i < chunks; i++) {
        entries[cacheKey(name) + '_' + i] = json.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      }
      entries[cacheKey(name) + '_meta'] = String(chunks);
      cache().putAll(entries, ttl);
    } catch (e) {
      console.warn('cachePut gagal untuk ' + name + ': ' + e);
    }
  }

  function cacheGet(name) {
    try {
      var metaKey = cacheKey(name) + '_meta';
      var meta = cache().get(metaKey);
      if (!meta) return null;
      var chunks = Number(meta);
      var keys = [];
      for (var i = 0; i < chunks; i++) keys.push(cacheKey(name) + '_' + i);
      var values = cache().getAll(keys);
      var json = '';
      for (var j = 0; j < chunks; j++) {
        var part = values[cacheKey(name) + '_' + j];
        if (part === undefined || part === null) return null;  // chunk expired sebagian
        json += part;
      }
      return JSON.parse(json);
    } catch (e) {
      console.warn('cacheGet gagal untuk ' + name + ': ' + e);
      return null;
    }
  }

  /** Naikkan stamp global sehingga seluruh hasil komputasi turunan ikut invalid. */
  function bumpStamp() {
    try {
      PropertiesService.getScriptProperties().setProperty('MRD_CACHE_STAMP', String(Date.now()));
    } catch (e) { /* noop */ }
  }

  /**
   * Hapus cache satu tabel (dipanggil setiap write).
   * Stamp global ikut dinaikkan agar hasil turunan (matrix allocation,
   * analytics, dashboard) tidak menyajikan angka basi setelah ada perubahan.
   */
  function invalidate(name) {
    delete _memo[name];
    bumpStamp();
    try {
      var metaKey = cacheKey(name) + '_meta';
      var meta = cache().get(metaKey);
      var keys = [metaKey];
      if (meta) {
        for (var i = 0; i < Number(meta); i++) keys.push(cacheKey(name) + '_' + i);
      }
      cache().removeAll(keys);
    } catch (e) {
      console.warn('invalidate gagal untuk ' + name + ': ' + e);
    }
  }

  function invalidateAll() {
    SHEET_ORDER.forEach(invalidate);
    _memo = {};
    bumpStamp();
  }

  /**
   * Cache generik untuk hasil komputasi (mis. matrix allocation).
   * Key otomatis di-namespace dengan stamp global sehingga seluruh hasil
   * turunan ikut invalid saat ada write ke database.
   */
  function remember(key, ttlSeconds, producer) {
    var stamp = '';
    try {
      stamp = PropertiesService.getScriptProperties().getProperty('MRD_CACHE_STAMP') || '0';
    } catch (e) { stamp = '0'; }
    var fullKey = 'CALC_' + key + '_' + stamp;
    var cached = cacheGet(fullKey);
    if (cached) return cached;
    var value = producer();
    cachePut(fullKey, value, Math.max(30, Math.min(21600, ttlSeconds || 300)));
    return value;
  }

  /** Hash pendek & stabil untuk membangun cache key dari object filter. */
  function hashKey(obj) {
    var json = JSON.stringify(obj || {});
    var hash = 0;
    for (var i = 0; i < json.length; i++) {
      hash = ((hash << 5) - hash) + json.charCodeAt(i);
      hash |= 0;
    }
    return (hash >>> 0).toString(36);
  }

  function ttlFor(name) {
    var master = [SHEETS.USERS, SHEETS.ACCOUNT_MASTER, SHEETS.SKU_MASTER, SHEETS.SETTINGS, SHEETS.SOP_MASTER];
    var isMaster = master.indexOf(name) !== -1;
    // Settings dibaca lewat Settings.gs sendiri; fallback aman bila belum siap.
    var seconds = 300;
    try {
      seconds = isMaster ? Settings.getNumber('MASTER_CACHE_TTL_SECONDS', 1500)
        : Settings.getNumber('CACHE_TTL_SECONDS', 300);
    } catch (e) { /* setting belum tersedia saat setup awal */ }
    return Math.max(30, Math.min(21600, seconds));
  }

  // -------------------------------------------------------------------------
  // Konversi nilai
  // -------------------------------------------------------------------------

  var NUMERIC_TYPES = { int: 1, qty: 1, money: 1, percent: 1, decimal: 1 };

  /** Ubah nilai mentah sheet menjadi nilai typed sesuai schema. */
  function coerceIn(value, type) {
    if (type === 'date' || type === 'datetime') return Utils.parseDate(value);
    if (NUMERIC_TYPES[type]) return Utils.num(value);
    if (type === 'bool') return Utils.bool(value);
    return Utils.str(value);
  }

  /** Ubah nilai aplikasi menjadi nilai yang ditulis ke sheet. */
  function coerceOut(value, type) {
    if (value === undefined || value === null || value === '') {
      return (type === 'date' || type === 'datetime') ? '' : (NUMERIC_TYPES[type] ? '' : '');
    }
    if (type === 'date' || type === 'datetime') return Utils.parseDate(value) || '';
    if (NUMERIC_TYPES[type]) return Utils.num(value);
    if (type === 'bool') return Utils.bool(value);
    return Utils.str(value);
  }

  /** Bentuk JSON-safe (dipakai cache dan transport). */
  function serializeRow(row, schema) {
    var out = {};
    schema.headers.forEach(function (h) {
      var type = schema.types[h] || 'text';
      var value = row[h];
      if (type === 'date') out[h] = Utils.toIsoDate(value);
      else if (type === 'datetime') out[h] = Utils.toIsoDateTime(value);
      else out[h] = value === undefined ? (NUMERIC_TYPES[type] ? 0 : '') : value;
    });
    if (row._row) out._row = row._row;
    return out;
  }

  function hydrateRow(row, schema) {
    var out = {};
    schema.headers.forEach(function (h) {
      out[h] = coerceIn(row[h], schema.types[h] || 'text');
    });
    out._row = row._row;
    return out;
  }

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  /**
   * Baca seluruh baris sebuah sheet sebagai array object.
   * @param {string} name       nama sheet
   * @param {Object} [options]  { useCache:boolean (default true), raw:boolean }
   * @return {Array<Object>}    setiap object berisi kolom + _row (nomor baris sheet)
   */
  function read(name, options) {
    var opts = options || {};
    var useCache = opts.useCache !== false;
    var schema = getSchema(name);

    if (useCache && _memo[name]) return _memo[name];

    if (useCache) {
      var cached = cacheGet(name);
      if (cached) {
        var hydrated = cached.map(function (row) { return hydrateRow(row, schema); });
        _memo[name] = hydrated;
        return hydrated;
      }
    }

    var sh = sheet(name);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) {
      _memo[name] = [];
      if (useCache) cachePut(name, [], ttlFor(name));
      return [];
    }

    var values = sh.getRange(1, 1, lastRow, lastCol).getValues();   // 1x batch read
    var headers = values[0].map(function (h) { return Utils.str(h); });
    var rows = [];
    for (var r = 1; r < values.length; r++) {
      var rowValues = values[r];
      var obj = { _row: r + 1 };
      var empty = true;
      for (var c = 0; c < headers.length; c++) {
        var header = headers[c];
        if (!header) continue;
        var type = schema.types[header] || 'text';
        obj[header] = coerceIn(rowValues[c], type);
        if (rowValues[c] !== '' && rowValues[c] !== null) empty = false;
      }
      // kolom pada schema yang belum ada di sheet → default kosong
      schema.headers.forEach(function (h) {
        if (obj[h] === undefined) obj[h] = coerceIn('', schema.types[h] || 'text');
      });
      if (!empty) rows.push(obj);
    }

    _memo[name] = rows;
    if (useCache) {
      cachePut(name, rows.map(function (row) { return serializeRow(row, schema); }), ttlFor(name));
    }
    return rows;
  }

  /** Baca dengan filter predikat (tetap 1x batch read). */
  function readWhere(name, predicate) {
    return read(name).filter(predicate);
  }

  /** Cari 1 baris berdasarkan id field schema. */
  function findById(name, id) {
    var schema = getSchema(name);
    var target = Utils.str(id);
    var rows = read(name);
    for (var i = 0; i < rows.length; i++) {
      if (Utils.str(rows[i][schema.idField]) === target) return rows[i];
    }
    return null;
  }

  function findOne(name, predicate) {
    var rows = read(name);
    for (var i = 0; i < rows.length; i++) {
      if (predicate(rows[i])) return rows[i];
    }
    return null;
  }

  function count(name) {
    if (!sheetExists(name)) return 0;
    var sh = spreadsheet().getSheetByName(name);
    return Math.max(0, sh.getLastRow() - 1);
  }

  // -------------------------------------------------------------------------
  // WRITE
  // -------------------------------------------------------------------------

  /** Jalankan fungsi di dalam script lock (mencegah race condition). */
  function withLock(fn) {
    var lock = LockService.getScriptLock();
    var acquired = false;
    try {
      acquired = lock.tryLock(LOCK_TIMEOUT_MS);
      if (!acquired) {
        throwError('LOCK_TIMEOUT', 'Sistem sedang memproses transaksi lain. Silakan coba beberapa saat lagi.');
      }
      return fn();
    } finally {
      if (acquired) {
        try { lock.releaseLock(); } catch (e) { /* noop */ }
      }
    }
  }

  function rowToValues(obj, schema, headers) {
    return headers.map(function (h) {
      return coerceOut(obj[h], schema.types[h] || 'text');
    });
  }

  function sheetHeaders(sh) {
    var lastCol = sh.getLastColumn();
    if (lastCol < 1) return [];
    return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return Utils.str(h); });
  }

  /**
   * Insert banyak baris sekaligus (1x setValues).
   * ID otomatis di-generate bila kosong.
   */
  function insertMany(name, objects) {
    if (!objects || !objects.length) return [];
    var schema = getSchema(name);
    return withLock(function () {
      var sh = sheet(name);
      var headers = sheetHeaders(sh);
      var ids = nextIds(name, objects.length);
      var matrix = objects.map(function (obj, i) {
        if (schema.idPrefix && !obj[schema.idField]) obj[schema.idField] = ids[i];
        return rowToValues(obj, schema, headers);
      });
      var startRow = sh.getLastRow() + 1;
      var range = sh.getRange(startRow, 1, matrix.length, headers.length);
      range.setValues(matrix);                                   // 1x batch write
      applyRangeFormats(sh, schema, headers, startRow, matrix.length);
      invalidate(name);
      return objects;
    });
  }

  function insert(name, object) {
    return insertMany(name, [object])[0];
  }

  /**
   * Update 1 baris berdasarkan ID (2 API call: baca kolom ID + tulis 1 baris).
   * @return {Object} baris setelah update
   */
  function update(name, id, patch) {
    var schema = getSchema(name);
    return withLock(function () {
      var sh = sheet(name);
      var headers = sheetHeaders(sh);
      var idCol = headers.indexOf(schema.idField) + 1;
      if (idCol < 1) throwError('SCHEMA_ERROR', 'Kolom ID tidak ditemukan pada sheet ' + name + '.');
      var lastRow = sh.getLastRow();
      if (lastRow < 2) throwError('NOT_FOUND', 'Data ' + id + ' tidak ditemukan.');

      var idValues = sh.getRange(2, idCol, lastRow - 1, 1).getValues();
      var targetRow = -1;
      for (var i = 0; i < idValues.length; i++) {
        if (Utils.str(idValues[i][0]) === Utils.str(id)) { targetRow = i + 2; break; }
      }
      if (targetRow === -1) throwError('NOT_FOUND', 'Data dengan ID ' + id + ' tidak ditemukan.');

      var range = sh.getRange(targetRow, 1, 1, headers.length);
      var current = range.getValues()[0];
      var merged = {};
      headers.forEach(function (h, idx) {
        merged[h] = coerceIn(current[idx], schema.types[h] || 'text');
      });
      Object.keys(patch || {}).forEach(function (key) {
        if (headers.indexOf(key) !== -1) merged[key] = patch[key];
      });
      range.setValues([rowToValues(merged, schema, headers)]);
      invalidate(name);
      merged._row = targetRow;
      return merged;
    });
  }

  /**
   * Update banyak baris sekaligus — 2 API call terlepas dari jumlah baris.
   * @param {string} name
   * @param {Array<{id:string, patch:Object}>} patches
   */
  function updateMany(name, patches) {
    if (!patches || !patches.length) return 0;
    var schema = getSchema(name);
    return withLock(function () {
      var sh = sheet(name);
      var headers = sheetHeaders(sh);
      var lastRow = sh.getLastRow();
      if (lastRow < 2) return 0;

      var range = sh.getRange(2, 1, lastRow - 1, headers.length);
      var values = range.getValues();                            // 1x batch read
      var idIdx = headers.indexOf(schema.idField);
      var byId = {};
      for (var i = 0; i < values.length; i++) byId[Utils.str(values[i][idIdx])] = i;

      var touched = 0;
      patches.forEach(function (item) {
        var idx = byId[Utils.str(item.id)];
        if (idx === undefined) return;
        var merged = {};
        headers.forEach(function (h, c) { merged[h] = coerceIn(values[idx][c], schema.types[h] || 'text'); });
        Object.keys(item.patch || {}).forEach(function (key) {
          if (headers.indexOf(key) !== -1) merged[key] = item.patch[key];
        });
        values[idx] = rowToValues(merged, schema, headers);
        touched++;
      });

      if (touched) {
        range.setValues(values);                                 // 1x batch write
        invalidate(name);
      }
      return touched;
    });
  }

  /** Hapus baris berdasarkan ID (hard delete). */
  function remove(name, id) {
    var schema = getSchema(name);
    return withLock(function () {
      var sh = sheet(name);
      var headers = sheetHeaders(sh);
      var idCol = headers.indexOf(schema.idField) + 1;
      var lastRow = sh.getLastRow();
      if (lastRow < 2) return false;
      var idValues = sh.getRange(2, idCol, lastRow - 1, 1).getValues();
      for (var i = 0; i < idValues.length; i++) {
        if (Utils.str(idValues[i][0]) === Utils.str(id)) {
          sh.deleteRow(i + 2);
          invalidate(name);
          return true;
        }
      }
      return false;
    });
  }

  /** Kosongkan isi sheet (header tetap). Dipakai reset demo data. */
  function truncate(name) {
    return withLock(function () {
      var sh = sheet(name);
      var lastRow = sh.getLastRow();
      if (lastRow > 1) sh.deleteRows(2, lastRow - 1);
      invalidate(name);
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Format & sequence
  // -------------------------------------------------------------------------

  var NUMBER_FORMATS = {
    text: '@',
    int: '#,##0',
    qty: '#,##0',
    money: '#,##0',
    percent: '0.00"%"',
    decimal: '#,##0.00',
    date: 'dd/MM/yyyy',
    datetime: 'dd/MM/yyyy HH:mm:ss',
    bool: '@'
  };

  function formatFor(type) {
    return NUMBER_FORMATS[type] || '@';
  }

  /** Terapkan number format pada range baris tertentu (1x batch call). */
  function applyRangeFormats(sh, schema, headers, startRow, numRows) {
    if (!numRows) return;
    var formats = headers.map(function (h) { return formatFor(schema.types[h] || 'text'); });
    var matrix = [];
    for (var i = 0; i < numRows; i++) matrix.push(formats);
    sh.getRange(startRow, 1, numRows, headers.length).setNumberFormats(matrix);
  }

  /**
   * Generator ID berurutan per sheet: PREFIX-0001.
   * Counter disimpan di ScriptProperties agar tidak perlu membaca sheet.
   */
  function nextIds(name, howMany) {
    var schema = getSchema(name);
    if (!schema.idPrefix) return [];
    var props = PropertiesService.getScriptProperties();
    var key = PROP_KEYS.SEQ_PREFIX + name;
    var current = Number(props.getProperty(key) || 0);
    if (!current) current = highestSequence(name, schema);
    var ids = [];
    for (var i = 1; i <= howMany; i++) {
      ids.push(schema.idPrefix + '-' + Utils.pad(current + i, 4));
    }
    props.setProperty(key, String(current + howMany));
    return ids;
  }

  function nextId(name) {
    return nextIds(name, 1)[0];
  }

  /** Cari nomor urut tertinggi dari data eksisting (sekali saat counter kosong). */
  function highestSequence(name, schema) {
    var rows = read(name, { useCache: false });
    var max = 0;
    var re = new RegExp('^' + schema.idPrefix + '-(\\d+)$');
    rows.forEach(function (row) {
      var m = re.exec(Utils.str(row[schema.idField]));
      if (m) max = Math.max(max, Number(m[1]));
    });
    return max;
  }

  /** Reset counter sequence (dipakai setelah truncate). */
  function resetSequence(name, value) {
    PropertiesService.getScriptProperties()
      .setProperty(PROP_KEYS.SEQ_PREFIX + name, String(value || 0));
  }

  // -------------------------------------------------------------------------
  // Utility untuk setup & status
  // -------------------------------------------------------------------------

  function tableStats() {
    var ss = spreadsheet();
    return SHEET_ORDER.map(function (name) {
      var sh = ss.getSheetByName(name);
      return {
        sheet: name,
        exists: !!sh,
        rows: sh ? Math.max(0, sh.getLastRow() - 1) : 0,
        columns: sh ? sh.getLastColumn() : 0,
        description: SCHEMA[name] ? SCHEMA[name].description : ''
      };
    });
  }

  return {
    spreadsheet: spreadsheet,
    sheet: sheet,
    sheetExists: sheetExists,
    getOrCreateSheet: getOrCreateSheetInternal,
    read: read,
    readWhere: readWhere,
    findById: findById,
    findOne: findOne,
    count: count,
    insert: insert,
    insertMany: insertMany,
    update: update,
    updateMany: updateMany,
    remove: remove,
    truncate: truncate,
    withLock: withLock,
    invalidate: invalidate,
    invalidateAll: invalidateAll,
    remember: remember,
    hashKey: hashKey,
    nextId: nextId,
    nextIds: nextIds,
    resetSequence: resetSequence,
    serializeRow: serializeRow,
    formatFor: formatFor,
    applyRangeFormats: applyRangeFormats,
    tableStats: tableStats
  };
})();

/**
 * Helper global sesuai spesifikasi PRD bagian D.
 * Membuat sheet bila belum ada, lengkap dengan header. Aman dipanggil berulang.
 */
function getOrCreateSheet(name, headers) {
  return DB.getOrCreateSheet(name, headers).sheet;
}

/**
 * Settings — pembaca business rule dari sheet SETTINGS dengan cache.
 * Seluruh angka bisnis WAJIB dibaca melalui modul ini.
 */
var Settings = (function () {

  var _map = null;

  function load(force) {
    if (_map && !force) return _map;
    _map = {};
    try {
      var rows = DB.read(SHEETS.SETTINGS);
      rows.forEach(function (row) {
        var key = Utils.upper(row.KEY);
        if (key) _map[key] = Utils.str(row.VALUE);
      });
    } catch (e) {
      _map = {};        // sheet belum dibuat (first run) → pakai default
    }
    return _map;
  }

  function resolveKey(key) {
    var k = Utils.upper(key);
    return SETTING_ALIASES[k] ? SETTING_ALIASES[k] : k;
  }

  function defaultOf(key) {
    var k = resolveKey(key);
    for (var i = 0; i < DEFAULT_SETTINGS.length; i++) {
      if (DEFAULT_SETTINGS[i][0] === k) return DEFAULT_SETTINGS[i][1];
    }
    return null;
  }

  function get(key, fallback) {
    var map = load();
    var k = resolveKey(key);
    var value = map[k];
    if (value === undefined || value === '') {
      var def = defaultOf(k);
      if (def !== null && def !== undefined) return def;
      return fallback === undefined ? '' : fallback;
    }
    return value;
  }

  function getNumber(key, fallback) {
    var raw = get(key, null);
    if (raw === null || raw === '') return fallback === undefined ? 0 : fallback;
    return Utils.num(raw, fallback === undefined ? 0 : fallback);
  }

  function getBool(key, fallback) {
    var raw = get(key, null);
    if (raw === null || raw === '') return !!fallback;
    return Utils.bool(raw);
  }

  function all() {
    var map = load();
    var out = {};
    DEFAULT_SETTINGS.forEach(function (item) { out[item[0]] = item[1]; });
    Object.keys(map).forEach(function (k) { out[k] = map[k]; });
    return out;
  }

  /** Tulis satu setting (dipakai modul Settings di UI). */
  function set(key, value) {
    var k = resolveKey(key);
    var existing = DB.findOne(SHEETS.SETTINGS, function (row) { return Utils.upper(row.KEY) === k; });
    if (existing) {
      DB.update(SHEETS.SETTINGS, existing.KEY, { VALUE: Utils.str(value) });
    } else {
      DB.insert(SHEETS.SETTINGS, { KEY: k, VALUE: Utils.str(value), DESCRIPTION: '' });
    }
    _map = null;
    return true;
  }

  function reload() { return load(true); }

  return { get: get, getNumber: getNumber, getBool: getBool, all: all, set: set, reload: reload };
})();
