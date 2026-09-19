/**
 * PROJECT MR DAIRY
 * ============================================================================
 * Repository.gs — Repository per entity.
 *
 * Service layer TIDAK BOLEH memanggil SpreadsheetApp langsung; seluruh akses
 * data melewati repository di file ini agar caching, validasi dan audit
 * terpusat.
 * ============================================================================
 */

/** Konversi baris internal → DTO JSON-safe untuk frontend. */
function toDto(sheetName, row) {
  if (!row) return null;
  return DB.serializeRow(row, getSchema(sheetName));
}

function toDtoList(sheetName, rows) {
  var schema = getSchema(sheetName);
  return (rows || []).map(function (row) { return DB.serializeRow(row, schema); });
}

// ===========================================================================
// USERS
// ===========================================================================
var UserRepo = (function () {

  function all() { return DB.read(SHEETS.USERS); }

  function findByUsername(username) {
    var target = Utils.normalize(username);
    return DB.findOne(SHEETS.USERS, function (row) {
      return Utils.normalize(row.USERNAME) === target;
    });
  }

  function findById(userId) { return DB.findById(SHEETS.USERS, userId); }

  function listActive() {
    return DB.readWhere(SHEETS.USERS, function (row) { return Utils.upper(row.STATUS) === 'ACTIVE'; });
  }

  function create(data) {
    var now = new Date();
    return DB.insert(SHEETS.USERS, {
      USERNAME: Utils.str(data.USERNAME),
      PASSWORD_HASH: Utils.str(data.PASSWORD_HASH),
      NAME: Utils.str(data.NAME),
      ROLE: Utils.upper(data.ROLE),
      EMAIL: Utils.str(data.EMAIL),
      STATUS: Utils.upper(data.STATUS) || 'ACTIVE',
      CREATED_AT: now,
      UPDATED_AT: now
    });
  }

  function update(userId, patch) {
    patch.UPDATED_AT = new Date();
    return DB.update(SHEETS.USERS, userId, patch);
  }

  /** Profil aman untuk dikirim ke frontend (tanpa password hash). */
  function publicProfile(row) {
    if (!row) return null;
    return {
      USER_ID: row.USER_ID,
      USERNAME: row.USERNAME,
      NAME: row.NAME,
      ROLE: Utils.upper(row.ROLE),
      EMAIL: row.EMAIL,
      STATUS: row.STATUS,
      INITIALS: Utils.str(row.NAME).split(/\s+/).slice(0, 2)
        .map(function (p) { return p.charAt(0).toUpperCase(); }).join('')
    };
  }

  return {
    all: all, findByUsername: findByUsername, findById: findById, listActive: listActive,
    create: create, update: update, publicProfile: publicProfile
  };
})();

// ===========================================================================
// ACCOUNT MASTER
// ===========================================================================
var AccountRepo = (function () {

  function all() { return DB.read(SHEETS.ACCOUNT_MASTER); }

  function active() {
    return DB.readWhere(SHEETS.ACCOUNT_MASTER, function (r) { return Utils.upper(r.STATUS) === 'ACTIVE'; });
  }

  function byId(id) { return DB.findById(SHEETS.ACCOUNT_MASTER, id); }

  function map() { return Utils.indexBy(all(), 'ACCOUNT_ID'); }

  function byCode(code) {
    var target = Utils.upper(code);
    return DB.findOne(SHEETS.ACCOUNT_MASTER, function (r) { return Utils.upper(r.ACCOUNT_CODE) === target; });
  }

  function create(data) {
    var now = new Date();
    return DB.insert(SHEETS.ACCOUNT_MASTER, {
      ACCOUNT_CODE: Utils.str(data.ACCOUNT_CODE),
      ACCOUNT_NAME: Utils.str(data.ACCOUNT_NAME),
      CHANNEL: Utils.str(data.CHANNEL),
      REGION: Utils.str(data.REGION),
      AREA: Utils.str(data.AREA),
      CITY: Utils.str(data.CITY),
      CLUSTER: Utils.upper(data.CLUSTER) || Utils.upper(data.POTENTIAL_LEVEL) || 'MEDIUM',
      POTENTIAL_LEVEL: Utils.upper(data.POTENTIAL_LEVEL) || 'MEDIUM',
      STATUS: Utils.upper(data.STATUS) || 'ACTIVE',
      CREATED_AT: now,
      UPDATED_AT: now
    });
  }

  function update(id, patch) {
    patch.UPDATED_AT = new Date();
    return DB.update(SHEETS.ACCOUNT_MASTER, id, patch);
  }

  function updateMany(patches) { return DB.updateMany(SHEETS.ACCOUNT_MASTER, patches); }

  /** Nilai unik untuk filter (region, area, channel, cluster). */
  function filterOptions() {
    var rows = active();
    return {
      regions: Utils.uniq(rows.map(function (r) { return r.REGION; })).filter(Boolean).sort(),
      areas: Utils.uniq(rows.map(function (r) { return r.AREA; })).filter(Boolean).sort(),
      channels: Utils.uniq(rows.map(function (r) { return r.CHANNEL; })).filter(Boolean).sort(),
      clusters: ENUMS.POTENTIAL_LEVEL.slice()
    };
  }

  return {
    all: all, active: active, byId: byId, map: map, byCode: byCode,
    create: create, update: update, updateMany: updateMany, filterOptions: filterOptions
  };
})();

// ===========================================================================
// SKU MASTER
// ===========================================================================
var SkuRepo = (function () {

  function all() { return DB.read(SHEETS.SKU_MASTER); }

  function active() {
    return DB.readWhere(SHEETS.SKU_MASTER, function (r) { return Utils.upper(r.STATUS) === 'ACTIVE'; });
  }

  function byId(id) { return DB.findById(SHEETS.SKU_MASTER, id); }

  function map() { return Utils.indexBy(all(), 'SKU_ID'); }

  function create(data) {
    return DB.insert(SHEETS.SKU_MASTER, {
      SKU_CODE: Utils.str(data.SKU_CODE),
      SKU_NAME: Utils.str(data.SKU_NAME),
      CATEGORY: Utils.str(data.CATEGORY),
      BRAND: Utils.str(data.BRAND),
      UNIT: Utils.str(data.UNIT) || 'CTN',
      SHELF_LIFE_DAYS: Utils.num(data.SHELF_LIFE_DAYS),
      STATUS: Utils.upper(data.STATUS) || 'ACTIVE'
    });
  }

  function update(id, patch) { return DB.update(SHEETS.SKU_MASTER, id, patch); }

  function filterOptions() {
    var rows = active();
    return {
      categories: Utils.uniq(rows.map(function (r) { return r.CATEGORY; })).filter(Boolean).sort(),
      brands: Utils.uniq(rows.map(function (r) { return r.BRAND; })).filter(Boolean).sort()
    };
  }

  return { all: all, active: active, byId: byId, map: map, create: create, update: update, filterOptions: filterOptions };
})();

// ===========================================================================
// SALES DATA
// ===========================================================================
var SalesRepo = (function () {

  function all() { return DB.read(SHEETS.SALES_DATA); }

  function inRange(from, to) {
    if (!from && !to) return all();
    return DB.readWhere(SHEETS.SALES_DATA, function (r) { return Utils.inRange(r.DATE, from, to); });
  }

  function byAccountSku(accountId, skuId, from, to) {
    return inRange(from, to).filter(function (r) {
      return (!accountId || r.ACCOUNT_ID === accountId) && (!skuId || r.SKU_ID === skuId);
    });
  }

  function insertMany(rows) { return DB.insertMany(SHEETS.SALES_DATA, rows); }

  return { all: all, inRange: inRange, byAccountSku: byAccountSku, insertMany: insertMany };
})();

// ===========================================================================
// RETURN DATA
// ===========================================================================
var ReturnRepo = (function () {

  function all() { return DB.read(SHEETS.RETURN_DATA); }

  function inRange(from, to) {
    if (!from && !to) return all();
    return DB.readWhere(SHEETS.RETURN_DATA, function (r) { return Utils.inRange(r.RETURN_DATE, from, to); });
  }

  function byAccountSku(accountId, skuId, from, to) {
    return inRange(from, to).filter(function (r) {
      return (!accountId || r.ACCOUNT_ID === accountId) && (!skuId || r.SKU_ID === skuId);
    });
  }

  function insertMany(rows) { return DB.insertMany(SHEETS.RETURN_DATA, rows); }
  function insert(row) { return DB.insert(SHEETS.RETURN_DATA, row); }

  return { all: all, inRange: inRange, byAccountSku: byAccountSku, insertMany: insertMany, insert: insert };
})();

// ===========================================================================
// STOCK MOVEMENT
// ===========================================================================
var StockRepo = (function () {

  function all() { return DB.read(SHEETS.STOCK_MOVEMENT); }

  function inRange(from, to) {
    if (!from && !to) return all();
    return DB.readWhere(SHEETS.STOCK_MOVEMENT, function (r) { return Utils.inRange(r.DATE, from, to); });
  }

  function byAccountSku(accountId, skuId, from, to) {
    return inRange(from, to).filter(function (r) {
      return (!accountId || r.ACCOUNT_ID === accountId) && (!skuId || r.SKU_ID === skuId);
    });
  }

  function insertMany(rows) { return DB.insertMany(SHEETS.STOCK_MOVEMENT, rows); }

  return { all: all, inRange: inRange, byAccountSku: byAccountSku, insertMany: insertMany };
})();

// ===========================================================================
// ALLOCATION PLAN
// ===========================================================================
var AllocationRepo = (function () {

  function all() { return DB.read(SHEETS.ALLOCATION_PLAN); }

  function byId(id) { return DB.findById(SHEETS.ALLOCATION_PLAN, id); }

  function byStatus(status) {
    var target = Utils.upper(status);
    return DB.readWhere(SHEETS.ALLOCATION_PLAN, function (r) { return Utils.upper(r.STATUS) === target; });
  }

  /** Plan terakhir untuk kombinasi account x SKU (dipakai saat re-plan). */
  function latestFor(accountId, skuId) {
    var rows = all().filter(function (r) {
      return r.ACCOUNT_ID === accountId && r.SKU_ID === skuId;
    });
    if (!rows.length) return null;
    return Utils.sortBy(rows, [{ key: 'PLAN_DATE', dir: 'desc' }])[0];
  }

  function insertMany(rows) { return DB.insertMany(SHEETS.ALLOCATION_PLAN, rows); }
  function insert(row) { return DB.insert(SHEETS.ALLOCATION_PLAN, row); }
  function update(id, patch) {
    patch.UPDATED_AT = new Date();
    return DB.update(SHEETS.ALLOCATION_PLAN, id, patch);
  }
  function updateMany(patches) {
    patches.forEach(function (p) { p.patch.UPDATED_AT = new Date(); });
    return DB.updateMany(SHEETS.ALLOCATION_PLAN, patches);
  }

  return {
    all: all, byId: byId, byStatus: byStatus, latestFor: latestFor,
    insert: insert, insertMany: insertMany, update: update, updateMany: updateMany
  };
})();

// ===========================================================================
// MR ADMIN
// ===========================================================================
var MrRepo = (function () {

  function all() { return DB.read(SHEETS.MR_ADMIN); }

  function byId(id) { return DB.findById(SHEETS.MR_ADMIN, id); }

  function byStatus(status) {
    var target = Utils.upper(status);
    return DB.readWhere(SHEETS.MR_ADMIN, function (r) { return Utils.upper(r.MR_STATUS) === target; });
  }

  function inRange(from, to) {
    if (!from && !to) return all();
    return DB.readWhere(SHEETS.MR_ADMIN, function (r) { return Utils.inRange(r.MR_DATE, from, to); });
  }

  /** Deteksi duplikat: account+SKU sama dalam rentang hari tertentu. */
  function findDuplicates(accountId, skuId, mrDate, windowDays, excludeId) {
    var center = Utils.parseDate(mrDate);
    if (!center) return [];
    return all().filter(function (r) {
      if (excludeId && r.MR_ID === excludeId) return false;
      if (r.ACCOUNT_ID !== accountId || r.SKU_ID !== skuId) return false;
      if (Utils.upper(r.MR_STATUS) === 'REJECTED') return false;
      var diff = Math.abs(Utils.diffDays(r.MR_DATE, center) || 999);
      return diff <= Utils.num(windowDays, 7);
    });
  }

  function insert(row) { return DB.insert(SHEETS.MR_ADMIN, row); }
  function insertMany(rows) { return DB.insertMany(SHEETS.MR_ADMIN, rows); }
  function update(id, patch) {
    patch.UPDATED_AT = new Date();
    return DB.update(SHEETS.MR_ADMIN, id, patch);
  }

  return {
    all: all, byId: byId, byStatus: byStatus, inRange: inRange,
    findDuplicates: findDuplicates, insert: insert, insertMany: insertMany, update: update
  };
})();

// ===========================================================================
// SOP MASTER
// ===========================================================================
var SopRepo = (function () {

  function all() {
    return Utils.sortBy(DB.read(SHEETS.SOP_MASTER), [{ key: 'STEP_NO', dir: 'asc' }]);
  }

  function byCode(code) {
    var target = Utils.upper(code);
    return DB.findOne(SHEETS.SOP_MASTER, function (r) { return Utils.upper(r.CODE) === target; });
  }

  function byId(id) { return DB.findById(SHEETS.SOP_MASTER, id); }

  function insertMany(rows) { return DB.insertMany(SHEETS.SOP_MASTER, rows); }

  function update(id, patch) {
    patch.UPDATED_AT = new Date();
    return DB.update(SHEETS.SOP_MASTER, id, patch);
  }

  return { all: all, byCode: byCode, byId: byId, insertMany: insertMany, update: update };
})();

// ===========================================================================
// AUDIT LOG
// ===========================================================================
var AuditRepo = (function () {

  function all() { return DB.read(SHEETS.AUDIT_LOG); }

  function insert(row) { return DB.insert(SHEETS.AUDIT_LOG, row); }
  function insertMany(rows) { return DB.insertMany(SHEETS.AUDIT_LOG, rows); }

  function search(filters) {
    var f = filters || {};
    return all().filter(function (r) {
      if (f.user && Utils.normalize(r.USER).indexOf(Utils.normalize(f.user)) === -1) return false;
      if (f.action && Utils.upper(r.ACTION) !== Utils.upper(f.action)) return false;
      if (f.module && Utils.upper(r.MODULE) !== Utils.upper(f.module)) return false;
      if (f.dateFrom || f.dateTo) {
        if (!Utils.inRange(r.TIMESTAMP, f.dateFrom, f.dateTo)) return false;
      }
      if (f.q) {
        var hay = Utils.normalize([r.DESCRIPTION, r.RECORD_ID, r.USER, r.ACTION, r.MODULE].join(' '));
        if (hay.indexOf(Utils.normalize(f.q)) === -1) return false;
      }
      return true;
    });
  }

  return { all: all, insert: insert, insertMany: insertMany, search: search };
})();

// ===========================================================================
// LOOKUP — gabungan master data untuk join cepat di service layer
// ===========================================================================
var Lookup = (function () {

  function accounts() { return AccountRepo.map(); }
  function skus() { return SkuRepo.map(); }

  function accountName(map, id) {
    var row = map[id];
    return row ? row.ACCOUNT_NAME : id;
  }

  function skuName(map, id) {
    var row = map[id];
    return row ? row.SKU_NAME : id;
  }

  /** Paket master data ringan untuk dropdown frontend. */
  function masterOptions() {
    var accountRows = AccountRepo.active();
    var skuRows = SkuRepo.active();
    return {
      accounts: accountRows.map(function (r) {
        return {
          id: r.ACCOUNT_ID, code: r.ACCOUNT_CODE, name: r.ACCOUNT_NAME, channel: r.CHANNEL,
          region: r.REGION, area: r.AREA, city: r.CITY, cluster: Utils.upper(r.CLUSTER),
          potential: Utils.upper(r.POTENTIAL_LEVEL)
        };
      }),
      skus: skuRows.map(function (r) {
        return {
          id: r.SKU_ID, code: r.SKU_CODE, name: r.SKU_NAME, category: r.CATEGORY,
          brand: r.BRAND, unit: r.UNIT, shelfLife: Utils.num(r.SHELF_LIFE_DAYS)
        };
      }),
      accountFilters: AccountRepo.filterOptions(),
      skuFilters: SkuRepo.filterOptions()
    };
  }

  return { accounts: accounts, skus: skus, accountName: accountName, skuName: skuName, masterOptions: masterOptions };
})();
