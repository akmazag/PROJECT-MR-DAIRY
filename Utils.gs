/**
 * PROJECT MR DAIRY
 * ============================================================================
 * Utils.gs — Helper murni: response envelope, error, tanggal, angka, array.
 * Tidak boleh bergantung pada service lain agar bebas dari urutan load file.
 * ============================================================================
 */

/** Error aplikasi dengan kode yang bisa dibaca frontend. */
function AppError(code, message, details) {
  this.name = 'AppError';
  this.code = code || 'APP_ERROR';
  this.message = message || 'Terjadi kesalahan pada aplikasi.';
  this.details = details || null;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

/** Lempar AppError (shorthand). */
function throwError(code, message, details) {
  throw new AppError(code, message, details);
}

var Utils = (function () {

  // -------------------------------------------------------------------------
  // Response envelope
  // -------------------------------------------------------------------------

  /** Response sukses standar. */
  function ok(data, meta) {
    var res = { success: true, data: data === undefined ? null : data };
    if (meta) res.meta = meta;
    return res;
  }

  /** Response gagal standar (human readable). */
  function fail(code, message, details) {
    return {
      success: false,
      error: {
        code: code || 'APP_ERROR',
        message: message || 'Terjadi kesalahan pada aplikasi.',
        details: details || null
      }
    };
  }

  /**
   * Bungkus eksekusi handler dengan try/catch + logging.
   * Frontend tidak pernah menerima stack trace mentah.
   */
  function guard(context, fn) {
    try {
      return fn();
    } catch (err) {
      var code = (err && err.code) ? err.code : 'INTERNAL_ERROR';
      var message = (err && err.name === 'AppError')
        ? err.message
        : 'Terjadi kesalahan pada server saat memproses ' + context + '. Silakan coba lagi.';
      console.error('[' + context + '] ' + (err && err.stack ? err.stack : err));
      return fail(code, message, (err && err.details) || null);
    }
  }

  // -------------------------------------------------------------------------
  // Tanggal
  // -------------------------------------------------------------------------

  function timezone() {
    try {
      return Session.getScriptTimeZone() || APP.TIMEZONE;
    } catch (e) {
      return APP.TIMEZONE;
    }
  }

  function now() { return new Date(); }

  /** Tanggal hari ini pada jam 00:00 (local script timezone). */
  function today() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** Parse berbagai bentuk input tanggal menjadi Date (atau null). */
  function parseDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
      var fromNum = new Date(value);
      return isNaN(fromNum.getTime()) ? null : fromNum;
    }
    var str = String(value).trim();
    if (!str) return null;
    // ISO: yyyy-MM-dd atau yyyy-MM-ddTHH:mm
    var iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(str);
    if (iso) {
      return new Date(
        Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
        Number(iso[4] || 0), Number(iso[5] || 0), Number(iso[6] || 0)
      );
    }
    // dd/MM/yyyy atau dd-MM-yyyy
    var dmy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(str);
    if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    var parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  /** Format Date menjadi string dengan pola Apps Script. */
  function formatDate(value, pattern) {
    var d = parseDate(value);
    if (!d) return '';
    return Utilities.formatDate(d, timezone(), pattern || 'dd MMM yyyy');
  }

  /** Format ISO yyyy-MM-dd (dipakai transport ke frontend). */
  function toIsoDate(value) {
    var d = parseDate(value);
    if (!d) return '';
    return Utilities.formatDate(d, timezone(), 'yyyy-MM-dd');
  }

  /** Format ISO lengkap yyyy-MM-dd HH:mm:ss. */
  function toIsoDateTime(value) {
    var d = parseDate(value);
    if (!d) return '';
    return Utilities.formatDate(d, timezone(), 'yyyy-MM-dd HH:mm:ss');
  }

  /** Kunci periode bulanan: yyyy-MM. */
  function monthKey(value) {
    var d = parseDate(value);
    if (!d) return '';
    return Utilities.formatDate(d, timezone(), 'yyyy-MM');
  }

  /** Label bulan pendek: Sep 2026. */
  function monthLabel(key) {
    if (!key) return '';
    var parts = String(key).split('-');
    if (parts.length < 2) return key;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    var idx = Number(parts[1]) - 1;
    return (months[idx] || parts[1]) + ' ' + parts[0];
  }

  function addDays(value, days) {
    var d = parseDate(value) || today();
    var out = new Date(d.getTime());
    out.setDate(out.getDate() + Number(days || 0));
    return out;
  }

  function addMonths(value, months) {
    var d = parseDate(value) || today();
    var out = new Date(d.getFullYear(), d.getMonth() + Number(months || 0), d.getDate());
    return out;
  }

  function startOfMonth(value) {
    var d = parseDate(value) || today();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function endOfMonth(value) {
    var d = parseDate(value) || today();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }

  /** Selisih hari (b - a), dibulatkan ke hari penuh. */
  function diffDays(a, b) {
    var da = parseDate(a), db = parseDate(b);
    if (!da || !db) return null;
    var ms = new Date(db.getFullYear(), db.getMonth(), db.getDate()).getTime()
      - new Date(da.getFullYear(), da.getMonth(), da.getDate()).getTime();
    return Math.round(ms / 86400000);
  }

  /** Selisih jam (b - a). */
  function diffHours(a, b) {
    var da = parseDate(a), db = parseDate(b);
    if (!da || !db) return null;
    return (db.getTime() - da.getTime()) / 3600000;
  }

  /** Daftar kunci bulan dari periode awal sampai akhir (inklusif). */
  function monthRange(from, to) {
    var start = startOfMonth(from);
    var end = startOfMonth(to);
    var keys = [];
    var cursor = new Date(start.getTime());
    var guardCount = 0;
    while (cursor <= end && guardCount < 240) {
      keys.push(monthKey(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      guardCount++;
    }
    return keys;
  }

  /** Apakah tanggal berada dalam rentang (inklusif, null = tak terbatas). */
  function inRange(value, from, to) {
    var d = parseDate(value);
    if (!d) return false;
    var f = parseDate(from);
    var t = parseDate(to);
    if (f && d < new Date(f.getFullYear(), f.getMonth(), f.getDate())) return false;
    if (t && d > new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59)) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Angka
  // -------------------------------------------------------------------------

  /** Konversi apapun menjadi number yang aman (default 0). */
  function num(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback === undefined ? 0 : fallback;
    if (typeof value === 'number') return isFinite(value) ? value : (fallback === undefined ? 0 : fallback);
    var cleaned = String(value).replace(/[^0-9,.\-]/g, '').replace(/\.(?=.*\.)/g, '');
    if (cleaned.indexOf(',') !== -1 && cleaned.indexOf('.') !== -1) cleaned = cleaned.replace(/,/g, '');
    else if (cleaned.indexOf(',') !== -1) cleaned = cleaned.replace(',', '.');
    var parsed = parseFloat(cleaned);
    return isNaN(parsed) ? (fallback === undefined ? 0 : fallback) : parsed;
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals === undefined ? 2 : decimals);
    return Math.round(num(value) * factor) / factor;
  }

  /** Pembagian aman: denominator 0 → fallback (default 0). */
  function safeDiv(numerator, denominator, fallback) {
    var d = num(denominator);
    if (!d) return fallback === undefined ? 0 : fallback;
    return num(numerator) / d;
  }

  /** Bulatkan ke kelipatan tertentu. */
  function roundToStep(value, step) {
    var s = num(step, 1);
    if (s <= 0) return Math.round(num(value));
    return Math.round(num(value) / s) * s;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(num(value), num(min)), num(max));
  }

  /** Persentase perubahan (current vs previous). */
  function deltaPercent(current, previous) {
    var p = num(previous);
    if (!p) return null;
    return ((num(current) - p) / Math.abs(p)) * 100;
  }

  // -------------------------------------------------------------------------
  // String
  // -------------------------------------------------------------------------

  function pad(value, length) {
    var str = String(value);
    while (str.length < length) str = '0' + str;
    return str;
  }

  function str(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function upper(value) { return str(value).toUpperCase(); }

  function isBlank(value) { return str(value) === ''; }

  /** Konversi nilai sheet menjadi boolean. */
  function bool(value) {
    if (typeof value === 'boolean') return value;
    var s = upper(value);
    return s === 'TRUE' || s === 'YES' || s === 'Y' || s === '1';
  }

  /** Normalisasi teks untuk pencarian (lowercase, tanpa spasi ganda). */
  function normalize(value) {
    return str(value).toLowerCase().replace(/\s+/g, ' ');
  }

  /** UUID pendek untuk token sesi / id internal. */
  function uuid() {
    return Utilities.getUuid().replace(/-/g, '');
  }

  // -------------------------------------------------------------------------
  // Array & Object
  // -------------------------------------------------------------------------

  function groupBy(rows, keyFn) {
    var map = {};
    (rows || []).forEach(function (row) {
      var key = typeof keyFn === 'function' ? keyFn(row) : row[keyFn];
      if (key === undefined || key === null) key = '';
      if (!map[key]) map[key] = [];
      map[key].push(row);
    });
    return map;
  }

  function sumBy(rows, keyFn) {
    var total = 0;
    (rows || []).forEach(function (row) {
      total += num(typeof keyFn === 'function' ? keyFn(row) : row[keyFn]);
    });
    return total;
  }

  function uniq(values) {
    var seen = {};
    var out = [];
    (values || []).forEach(function (v) {
      var key = String(v);
      if (!seen[key]) { seen[key] = true; out.push(v); }
    });
    return out;
  }

  function indexBy(rows, key) {
    var map = {};
    (rows || []).forEach(function (row) { map[row[key]] = row; });
    return map;
  }

  /** Sort multi-kolom: sortBy(rows, [{key:'MR_PERCENT', dir:'desc'}]) */
  function sortBy(rows, specs) {
    var list = (rows || []).slice();
    var rules = [].concat(specs || []);
    list.sort(function (a, b) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        var dir = (rule.dir === 'asc') ? 1 : -1;
        var av = a[rule.key];
        var bv = b[rule.key];
        if (rule.type === 'text') {
          av = normalize(av); bv = normalize(bv);
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
        } else {
          var an = num(av), bn = num(bv);
          if (an !== bn) return (an - bn) * dir;
        }
      }
      return 0;
    });
    return list;
  }

  /** Pagination server-side. */
  function paginate(rows, page, pageSize) {
    var list = rows || [];
    var size = Math.max(1, num(pageSize, 25));
    var totalPages = Math.max(1, Math.ceil(list.length / size));
    var current = Math.min(Math.max(1, num(page, 1)), totalPages);
    var start = (current - 1) * size;
    return {
      rows: list.slice(start, start + size),
      meta: {
        page: current,
        pageSize: size,
        total: list.length,
        totalPages: totalPages,
        from: list.length ? start + 1 : 0,
        to: Math.min(start + size, list.length)
      }
    };
  }

  function pick(obj, keys) {
    var out = {};
    (keys || []).forEach(function (k) { if (obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  }

  /** Statistik deskriptif sederhana untuk normalisasi skor. */
  function minMax(values) {
    var min = null, max = null;
    (values || []).forEach(function (v) {
      var n = num(v);
      if (min === null || n < min) min = n;
      if (max === null || n > max) max = n;
    });
    return { min: min === null ? 0 : min, max: max === null ? 0 : max };
  }

  /** Normalisasi nilai ke skala 0-100 berdasarkan min/max. */
  function normalizeScore(value, min, max) {
    var range = num(max) - num(min);
    if (range <= 0) return num(value) > 0 ? 100 : 0;
    return clamp(((num(value) - num(min)) / range) * 100, 0, 100);
  }

  /** CSV escaping (RFC 4180). */
  function csvCell(value) {
    var s = value === null || value === undefined ? '' : String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** Bangun CSV dari array header + array baris object. */
  function toCsv(headers, rows) {
    var lines = [headers.map(csvCell).join(',')];
    (rows || []).forEach(function (row) {
      lines.push(headers.map(function (h) { return csvCell(row[h]); }).join(','));
    });
    return lines.join('\r\n');
  }

  return {
    ok: ok,
    fail: fail,
    guard: guard,
    timezone: timezone,
    now: now,
    today: today,
    parseDate: parseDate,
    formatDate: formatDate,
    toIsoDate: toIsoDate,
    toIsoDateTime: toIsoDateTime,
    monthKey: monthKey,
    monthLabel: monthLabel,
    addDays: addDays,
    addMonths: addMonths,
    startOfMonth: startOfMonth,
    endOfMonth: endOfMonth,
    diffDays: diffDays,
    diffHours: diffHours,
    monthRange: monthRange,
    inRange: inRange,
    num: num,
    round: round,
    safeDiv: safeDiv,
    roundToStep: roundToStep,
    clamp: clamp,
    deltaPercent: deltaPercent,
    pad: pad,
    str: str,
    upper: upper,
    isBlank: isBlank,
    bool: bool,
    normalize: normalize,
    uuid: uuid,
    groupBy: groupBy,
    sumBy: sumBy,
    uniq: uniq,
    indexBy: indexBy,
    sortBy: sortBy,
    paginate: paginate,
    pick: pick,
    minMax: minMax,
    normalizeScore: normalizeScore,
    csvCell: csvCell,
    toCsv: toCsv
  };
})();
