/**
 * PROJECT MR DAIRY
 * ============================================================================
 * AuditService.gs — Pencatatan seluruh aktivitas penting ke sheet AUDIT_LOG.
 *
 * Aturan: setiap mutasi data (CREATE/UPDATE/DELETE/APPROVE/REJECT/CREATE_SO/
 * CHANGE_ALLOCATION/MANUAL_OVERRIDE) dan setiap LOGIN/LOGOUT wajib dicatat.
 * Kegagalan audit tidak boleh membatalkan transaksi bisnis (fail-safe), tetapi
 * tetap ditulis ke Stackdriver log.
 * ============================================================================
 */

var AuditService = (function () {

  var MODULES = {
    AUTH: 'AUTH',
    SETUP: 'SETUP',
    DASHBOARD: 'DASHBOARD',
    DISTRIBUTION: 'DISTRIBUTION',
    ALLOCATION: 'ALLOCATION',
    MR: 'MR',
    SOP: 'SOP',
    MONITORING: 'MONITORING',
    ANALYTICS: 'ANALYTICS',
    MASTER: 'MASTER',
    SETTINGS: 'SETTINGS',
    REPORT: 'REPORT'
  };

  function shorten(value) {
    if (value === null || value === undefined) return '';
    var str = (typeof value === 'object') ? JSON.stringify(value) : String(value);
    return str.length > 480 ? str.substring(0, 477) + '...' : str;
  }

  /**
   * Catat satu aktivitas.
   * @param {Object} entry {user, action, module, recordId, description, oldValue, newValue}
   */
  function log(entry) {
    try {
      AuditRepo.insert({
        TIMESTAMP: new Date(),
        USER: Utils.str(entry.user) || 'SYSTEM',
        ACTION: Utils.upper(entry.action),
        MODULE: Utils.upper(entry.module),
        RECORD_ID: Utils.str(entry.recordId),
        DESCRIPTION: shorten(entry.description),
        OLD_VALUE: shorten(entry.oldValue),
        NEW_VALUE: shorten(entry.newValue)
      });
      return true;
    } catch (err) {
      console.error('AuditService.log gagal: ' + err);
      return false;
    }
  }

  /** Catat banyak aktivitas sekaligus (1x batch write). */
  function logBatch(entries) {
    if (!entries || !entries.length) return true;
    try {
      var now = new Date();
      AuditRepo.insertMany(entries.map(function (entry) {
        return {
          TIMESTAMP: entry.timestamp || now,
          USER: Utils.str(entry.user) || 'SYSTEM',
          ACTION: Utils.upper(entry.action),
          MODULE: Utils.upper(entry.module),
          RECORD_ID: Utils.str(entry.recordId),
          DESCRIPTION: shorten(entry.description),
          OLD_VALUE: shorten(entry.oldValue),
          NEW_VALUE: shorten(entry.newValue)
        };
      }));
      return true;
    } catch (err) {
      console.error('AuditService.logBatch gagal: ' + err);
      return false;
    }
  }

  /** Bandingkan dua object, hasilkan ringkasan perubahan untuk audit. */
  function diff(oldRow, newRow, fields) {
    var changes = [];
    (fields || Object.keys(newRow || {})).forEach(function (field) {
      var before = oldRow ? oldRow[field] : '';
      var after = newRow ? newRow[field] : '';
      var b = (before instanceof Date) ? Utils.toIsoDate(before) : Utils.str(before);
      var a = (after instanceof Date) ? Utils.toIsoDate(after) : Utils.str(after);
      if (b !== a) changes.push({ field: field, from: b, to: a });
    });
    return changes;
  }

  function describeChanges(changes) {
    if (!changes || !changes.length) return 'Tidak ada perubahan nilai.';
    return changes.map(function (c) {
      return c.field + ': ' + (c.from === '' ? '(kosong)' : c.from) + ' → ' + (c.to === '' ? '(kosong)' : c.to);
    }).join('; ');
  }

  /** Pencarian audit log + pagination server-side. */
  function search(filters, paging) {
    var rows = AuditRepo.search(filters);
    var sorted = Utils.sortBy(rows, [{ key: 'TIMESTAMP', dir: 'desc' }]);
    var page = Utils.paginate(sorted, (paging || {}).page, (paging || {}).pageSize
      || Settings.getNumber('DEFAULT_PAGE_SIZE', 25));
    return {
      rows: page.rows.map(function (r) {
        return {
          LOG_ID: r.LOG_ID,
          TIMESTAMP: Utils.toIsoDateTime(r.TIMESTAMP),
          USER: r.USER,
          ACTION: r.ACTION,
          MODULE: r.MODULE,
          RECORD_ID: r.RECORD_ID,
          DESCRIPTION: r.DESCRIPTION,
          OLD_VALUE: r.OLD_VALUE,
          NEW_VALUE: r.NEW_VALUE
        };
      }),
      meta: page.meta,
      options: {
        actions: Utils.uniq(rows.map(function (r) { return r.ACTION; })).filter(Boolean).sort(),
        modules: Utils.uniq(rows.map(function (r) { return r.MODULE; })).filter(Boolean).sort(),
        users: Utils.uniq(rows.map(function (r) { return r.USER; })).filter(Boolean).sort()
      }
    };
  }

  /** Ringkasan aktivitas terakhir untuk widget dashboard. */
  function recent(limit) {
    var rows = Utils.sortBy(AuditRepo.all(), [{ key: 'TIMESTAMP', dir: 'desc' }]).slice(0, limit || 8);
    return rows.map(function (r) {
      return {
        timestamp: Utils.toIsoDateTime(r.TIMESTAMP),
        user: r.USER,
        action: r.ACTION,
        module: r.MODULE,
        recordId: r.RECORD_ID,
        description: r.DESCRIPTION
      };
    });
  }

  return {
    MODULES: MODULES,
    log: log,
    logBatch: logBatch,
    diff: diff,
    describeChanges: describeChanges,
    search: search,
    recent: recent
  };
})();
