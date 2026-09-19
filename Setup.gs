/**
 * PROJECT MR DAIRY
 * ============================================================================
 * Setup.gs — Auto setup database, konfigurasi default, dan demo data.
 *
 * CARA PAKAI (sekali saja):
 *   1. Buka Spreadsheet → Extensions → Apps Script
 *   2. Jalankan fungsi setupDatabase()   → seluruh sheet dibuat otomatis
 *   3. Jalankan fungsi createDemoData()  → data demo masuk ke database
 *
 * Kedua fungsi bersifat IDEMPOTENT: aman dijalankan berulang, tidak membuat
 * sheet duplikat dan tidak menggandakan master/demo data.
 * ============================================================================
 */

// ===========================================================================
// 1. SETUP DATABASE
// ===========================================================================

/**
 * Entry point utama setup. Membuat seluruh struktur database dari nol.
 * @return {Object} ringkasan hasil setup
 */
function setupDatabase() {
  var started = new Date();
  var ss = DB.spreadsheet();
  var result = { created: [], existing: [], settings: 0, users: 0, sop: 0 };

  // 1. Simpan identitas spreadsheet + timezone
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.SPREADSHEET_ID, ss.getId());
  try {
    if (ss.getSpreadsheetTimeZone() !== APP.TIMEZONE) ss.setSpreadsheetTimeZone(APP.TIMEZONE);
  } catch (e) {
    console.warn('Tidak dapat mengubah timezone spreadsheet: ' + e);
  }

  // 2. Buat seluruh sheet + header + format + validation
  SHEET_ORDER.forEach(function (name) {
    var schema = getSchema(name);
    var handle = DB.getOrCreateSheet(name, schema.headers);
    if (handle.created) result.created.push(name); else result.existing.push(name);
    applySheetStyling_(handle.sheet, schema);
  });

  // 3. Rapikan spreadsheet: hapus sheet bawaan kosong & urutkan tab
  cleanupDefaultSheet_(ss);
  reorderSheets_(ss);

  // 4. Konfigurasi & master minimum
  DB.invalidateAll();
  result.settings = seedSettings_();
  result.users = seedUsers_();
  result.sop = seedSopMaster_();
  Settings.reload();

  // 5. Tandai setup selesai
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_KEYS.SETUP_DONE, 'TRUE');
  props.setProperty(PROP_KEYS.SETUP_AT, new Date().toISOString());

  AuditService.log({
    user: 'SYSTEM', action: AUDIT_ACTIONS.SETUP, module: AuditService.MODULES.SETUP,
    recordId: ss.getId(),
    description: 'Inisialisasi database selesai dalam ' + ((new Date() - started) / 1000).toFixed(1)
      + ' detik. Sheet dibuat: ' + (result.created.length || 0) + ', sheet lama dipakai ulang: '
      + (result.existing.length || 0) + '.'
  });

  var message = [
    '=====================================================',
    ' ' + APP.NAME + ' - SETUP DATABASE SELESAI',
    '=====================================================',
    ' Spreadsheet : ' + ss.getName(),
    ' Sheet baru  : ' + (result.created.length ? result.created.join(', ') : '(tidak ada, semua sudah tersedia)'),
    ' Sheet lama  : ' + (result.existing.length ? result.existing.join(', ') : '-'),
    ' Settings    : ' + result.settings + ' konfigurasi ditambahkan',
    ' Users       : ' + result.users + ' user default ditambahkan',
    ' SOP         : ' + result.sop + ' langkah SOP ditambahkan',
    '-----------------------------------------------------',
    ' LANGKAH BERIKUTNYA: jalankan createDemoData()',
    '====================================================='
  ].join('\n');
  console.log(message);
  return { success: true, message: message, detail: result };
}

/** Header styling, freeze, number format, lebar kolom, dan data validation. */
function applySheetStyling_(sheet, schema) {
  var headers = schema.headers;
  var maxRows = sheet.getMaxRows();
  var maxCols = sheet.getMaxColumns();

  // Pastikan jumlah kolom cukup
  if (maxCols < headers.length) sheet.insertColumnsAfter(maxCols, headers.length - maxCols);
  if (maxCols > headers.length + 2) {
    try { sheet.deleteColumns(headers.length + 1, maxCols - headers.length); } catch (e) { /* noop */ }
  }

  // Header
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange
    .setValues([headers])
    .setFontFamily('Inter')
    .setFontSize(10)
    .setFontWeight('bold')
    .setFontColor('#FFFFFF')
    .setBackground('#123047')
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('left')
    .setWrap(false);
  sheet.setRowHeight(1, 32);
  sheet.setFrozenRows(1);

  // Number format per kolom (1x call per kolom, hanya saat setup)
  var bodyRows = Math.max(1, maxRows - 1);
  headers.forEach(function (header, idx) {
    var type = schema.types[header] || 'text';
    var range = sheet.getRange(2, idx + 1, bodyRows, 1);
    range.setNumberFormat(DB.formatFor(type));
    if (type === 'qty' || type === 'money' || type === 'int' || type === 'decimal' || type === 'percent') {
      range.setHorizontalAlignment('right');
    }
    var width = (schema.widths && schema.widths[header]) ? schema.widths[header] : 130;
    sheet.setColumnWidth(idx + 1, width);
  });

  // Data validation untuk kolom enum
  if (schema.validations) {
    Object.keys(schema.validations).forEach(function (col) {
      var idx = headers.indexOf(col);
      if (idx === -1) return;
      var rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(schema.validations[col], true)
        .setAllowInvalid(true)          // izinkan nilai lain, tetap tandai
        .setHelpText('Nilai yang disarankan: ' + schema.validations[col].join(', '))
        .build();
      sheet.getRange(2, idx + 1, bodyRows, 1).setDataValidation(rule);
    });
  }

  // Estetika tabel
  sheet.getRange(1, 1, maxRows, headers.length).setFontFamily('Inter').setFontSize(10);
  sheet.getRange(1, 1, 1, headers.length).setFontSize(10);

  // Proteksi ringan untuk sheet kredensial
  if (schema.protectedSheet) {
    try {
      var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
      if (!protections.length) {
        sheet.protect()
          .setDescription('USERS berisi kredensial. Ubah melalui aplikasi, bukan manual.')
          .setWarningOnly(true);
      }
    } catch (e) {
      console.warn('Proteksi sheet gagal: ' + e);
    }
  }
}

/** Hapus sheet bawaan "Sheet1"/"Sheet 1" bila kosong. */
function cleanupDefaultSheet_(ss) {
  var defaults = ['Sheet1', 'Sheet 1', 'Spreadsheet1', 'Untitled'];
  ss.getSheets().forEach(function (sh) {
    if (defaults.indexOf(sh.getName()) === -1) return;
    if (sh.getLastRow() > 0 || ss.getSheets().length <= 1) return;
    try { ss.deleteSheet(sh); } catch (e) { /* noop */ }
  });
}

/** Urutkan tab sesuai SHEET_ORDER agar mudah dibaca. */
function reorderSheets_(ss) {
  SHEET_ORDER.forEach(function (name, idx) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    try {
      ss.setActiveSheet(sh);
      ss.moveActiveSheet(idx + 1);
    } catch (e) { /* noop */ }
  });
  try { ss.setActiveSheet(ss.getSheetByName(SHEETS.SETTINGS)); } catch (e) { /* noop */ }
}

/** Tulis DEFAULT_SETTINGS (hanya key yang belum ada). */
function seedSettings_() {
  var existing = {};
  DB.read(SHEETS.SETTINGS, { useCache: false }).forEach(function (row) {
    existing[Utils.upper(row.KEY)] = true;
  });
  var toAdd = DEFAULT_SETTINGS.filter(function (item) { return !existing[item[0]]; })
    .map(function (item) { return { KEY: item[0], VALUE: item[1], DESCRIPTION: item[2] }; });
  if (toAdd.length) DB.insertMany(SHEETS.SETTINGS, toAdd);
  return toAdd.length;
}

/**
 * User default untuk lingkungan demo/development.
 * PRODUCTION: ganti password melalui menu Settings setelah login pertama.
 */
function defaultUsers_() {
  return [
    { username: 'admin',   password: 'admin123',   name: 'Administrator',    role: ROLES.ADMIN,   email: 'admin@mrdairy.demo' },
    { username: 'manager', password: 'manager123', name: 'Distribution Manager', role: ROLES.MANAGER, email: 'manager@mrdairy.demo' },
    { username: 'sales',   password: 'sales123',   name: 'Sales Supervisor', role: ROLES.SALES,   email: 'sales@mrdairy.demo' },
    { username: 'mr',      password: 'mr123',      name: 'MR Administrator', role: ROLES.MR,      email: 'mr@mrdairy.demo' },
    { username: 'viewer',  password: 'viewer123',  name: 'Read Only User',   role: ROLES.VIEWER,  email: 'viewer@mrdairy.demo' }
  ];
}

function seedUsers_() {
  var existing = {};
  DB.read(SHEETS.USERS, { useCache: false }).forEach(function (row) {
    existing[Utils.normalize(row.USERNAME)] = true;
  });
  var now = new Date();
  var toAdd = defaultUsers_()
    .filter(function (u) { return !existing[Utils.normalize(u.username)]; })
    .map(function (u) {
      return {
        USERNAME: u.username,
        PASSWORD_HASH: Auth.hashPassword(u.password),
        NAME: u.name,
        ROLE: u.role,
        EMAIL: u.email,
        STATUS: 'ACTIVE',
        CREATED_AT: now,
        UPDATED_AT: now
      };
    });
  if (toAdd.length) DB.insertMany(SHEETS.USERS, toAdd);
  return toAdd.length;
}

/** SOP MR default (3 pilar sesuai PRD bagian J). */
function seedSopMaster_() {
  var existing = {};
  DB.read(SHEETS.SOP_MASTER, { useCache: false }).forEach(function (row) {
    existing[Utils.upper(row.CODE)] = true;
  });
  var now = new Date();
  var defs = [
    {
      STEP_NO: 1, CODE: 'PLOTTING_JADWAL_PENARIKAN', TITLE: 'Plotting Jadwal Penarikan',
      DESCRIPTION: 'Penjadwalan penarikan barang Market Return dari account ke gudang distributor.',
      RULE: 'Pickup date maksimum MR_PICKUP_SLA_DAYS hari setelah MR date. Jadwal wajib terisi sebelum SO dibuat.',
      PIC: 'MR Administrator', SLA_DAYS: 3, STATUS: 'ACTIVE'
    },
    {
      STEP_NO: 2, CODE: 'KOMITMEN_CUTOFF_TAGIHAN', TITLE: 'Komitmen Cutoff Potong Tagihan',
      DESCRIPTION: 'Batas waktu komitmen pemotongan tagihan atas barang Market Return.',
      RULE: 'Cutoff date = MR date + MR_CUTOFF_DAYS. MR yang melewati cutoff wajib diselesaikan pada periode tagihan berikutnya.',
      PIC: 'Finance / Sales', SLA_DAYS: 7, STATUS: 'ACTIVE'
    },
    {
      STEP_NO: 3, CODE: 'KETENTUAN_BAP', TITLE: 'Ketentuan BAP',
      DESCRIPTION: 'Berita Acara Pemeriksaan sebagai dasar administrasi barang return.',
      RULE: 'Mengikuti setting BAP_RULE. Pada mode FRESH_EXEMPT, item dengan sisa umur produk >= '
        + 'BAP_FRESH_MIN_REMAINING_DAYS hari dan nilai return <= BAP_VALUE_THRESHOLD tidak wajib BAP.',
      PIC: 'MR Administrator / Sales', SLA_DAYS: 2, STATUS: 'ACTIVE'
    }
  ];
  var toAdd = defs.filter(function (d) { return !existing[d.CODE]; })
    .map(function (d) {
      d.UPDATED_BY = 'SYSTEM';
      d.UPDATED_AT = now;
      return d;
    });
  if (toAdd.length) DB.insertMany(SHEETS.SOP_MASTER, toAdd);
  return toAdd.length;
}

// ===========================================================================
// 2. DEMO DATA
// ===========================================================================

/** PRNG deterministik agar demo data selalu identik. */
function seededRandom_(seed) {
  var state = seed || 20260919;
  return function () {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Master account demo (2 skenario wajib + 6 account realistis). */
function demoAccounts_() {
  return [
    { ACCOUNT_CODE: 'DEMO-ACCOUNT-001', ACCOUNT_NAME: 'Demo Account 001 - High Potential', CHANNEL: 'MODERN_TRADE', REGION: 'Jakarta', AREA: 'Jakarta Selatan', CITY: 'Jakarta', POTENTIAL_LEVEL: 'HIGH' },
    { ACCOUNT_CODE: 'DEMO-ACCOUNT-002', ACCOUNT_NAME: 'Demo Account 002 - Medium Potential', CHANNEL: 'GENERAL_TRADE', REGION: 'Jawa Barat', AREA: 'Bekasi', CITY: 'Bekasi', POTENTIAL_LEVEL: 'MEDIUM' },
    { ACCOUNT_CODE: 'MT-JKT-001', ACCOUNT_NAME: 'Sentra Mart Jakarta Pusat', CHANNEL: 'MODERN_TRADE', REGION: 'Jakarta', AREA: 'Jakarta Pusat', CITY: 'Jakarta', POTENTIAL_LEVEL: 'HIGH' },
    { ACCOUNT_CODE: 'MT-BDG-002', ACCOUNT_NAME: 'Sentra Mart Bandung Kota', CHANNEL: 'MODERN_TRADE', REGION: 'Jawa Barat', AREA: 'Bandung', CITY: 'Bandung', POTENTIAL_LEVEL: 'MEDIUM' },
    { ACCOUNT_CODE: 'GT-SBY-003', ACCOUNT_NAME: 'Toko Makmur Surabaya', CHANNEL: 'GENERAL_TRADE', REGION: 'Jawa Timur', AREA: 'Surabaya', CITY: 'Surabaya', POTENTIAL_LEVEL: 'MEDIUM' },
    { ACCOUNT_CODE: 'GT-SMG-004', ACCOUNT_NAME: 'Grosir Sejahtera Semarang', CHANNEL: 'GENERAL_TRADE', REGION: 'Jawa Tengah', AREA: 'Semarang', CITY: 'Semarang', POTENTIAL_LEVEL: 'LOW' },
    { ACCOUNT_CODE: 'HRC-DPS-005', ACCOUNT_NAME: 'Cafe Nusantara Denpasar', CHANNEL: 'HORECA', REGION: 'Bali', AREA: 'Denpasar', CITY: 'Denpasar', POTENTIAL_LEVEL: 'MEDIUM' },
    { ACCOUNT_CODE: 'EC-NAS-006', ACCOUNT_NAME: 'Dairy Official Store', CHANNEL: 'E_COMMERCE', REGION: 'Nasional', AREA: 'Nasional', CITY: 'Jakarta', POTENTIAL_LEVEL: 'HIGH' }
  ];
}

/** Master SKU demo. price dipakai untuk menghitung SALES_VALUE & RETURN_VALUE. */
function demoSkus_() {
  return [
    { SKU_CODE: 'DEMO-MILK-001', SKU_NAME: 'Demo UHT Milk 1L (Scenario 1)', CATEGORY: 'UHT', BRAND: 'Dairy Demo', UNIT: 'CTN', SHELF_LIFE_DAYS: 180, price: 85000 },
    { SKU_CODE: 'DEMO-MILK-002', SKU_NAME: 'Demo Fresh Milk 500ml (Scenario 2)', CATEGORY: 'FRESH_MILK', BRAND: 'Dairy Demo', UNIT: 'CTN', SHELF_LIFE_DAYS: 30, price: 120000 },
    { SKU_CODE: 'UHT-FC-1000', SKU_NAME: 'Dairy UHT Full Cream 1L', CATEGORY: 'UHT', BRAND: 'Dairy Prima', UNIT: 'CTN', SHELF_LIFE_DAYS: 180, price: 150000 },
    { SKU_CODE: 'FRESH-PAS-250', SKU_NAME: 'Fresh Milk Pasteurized 250ml', CATEGORY: 'FRESH_MILK', BRAND: 'Dairy Prima', UNIT: 'CTN', SHELF_LIFE_DAYS: 21, price: 95000 },
    { SKU_CODE: 'YOG-DRINK-180', SKU_NAME: 'Yoghurt Drink Strawberry 180ml', CATEGORY: 'YOGHURT', BRAND: 'Dairy Fresh', UNIT: 'CTN', SHELF_LIFE_DAYS: 45, price: 110000 },
    { SKU_CODE: 'CHS-SLICE-200', SKU_NAME: 'Cheddar Cheese Slice 200g', CATEGORY: 'CHEESE', BRAND: 'Dairy Prima', UNIT: 'CTN', SHELF_LIFE_DAYS: 120, price: 210000 }
  ];
}

/**
 * Skenario wajib PRD bagian W.
 * Angka disusun agar hasil kalkulasi sistem tepat:
 *   DEMO 1 → Sell Out 1.000 | Return 50  | Stock 100 → MR% = 5%
 *   DEMO 2 → Sell Out 500   | Return 75  | Stock 180 → MR% = 15%
 */
function demoScenarios_() {
  return [
    {
      accountCode: 'DEMO-ACCOUNT-001', skuCode: 'DEMO-MILK-001',
      openingStock: 110,
      sellOut: [160, 170, 165, 175, 165, 165],       // total 1.000
      returns: [10, 9, 8, 8, 8, 7],                  // total 50
      closing: [120, 130, 115, 125, 110, 100],       // stock akhir 100
      reason: 'NEAR_EXPIRY'
    },
    {
      accountCode: 'DEMO-ACCOUNT-002', skuCode: 'DEMO-MILK-002',
      openingStock: 140,
      sellOut: [90, 85, 80, 85, 80, 80],             // total 500
      returns: [12, 13, 12, 13, 12, 13],             // total 75
      closing: [150, 160, 165, 170, 175, 180],       // stock akhir 180 (menumpuk)
      reason: 'SLOW_MOVING'
    }
  ];
}

/**
 * Membuat seluruh data demo (master + transaksi + MR + allocation plan).
 * Aman dijalankan berulang: bila demo data sudah ada, fungsi hanya melaporkan.
 */
function createDemoData() {
  ensureSetup_();
  var existingAccounts = DB.read(SHEETS.ACCOUNT_MASTER, { useCache: false });
  if (existingAccounts.length) {
    var msg = 'Demo data sudah tersedia (' + existingAccounts.length + ' account). '
      + 'Gunakan resetDemoData() bila ingin membangun ulang dari awal.';
    console.log(msg);
    return { success: true, message: msg, skipped: true };
  }
  return buildDemoData_();
}

/** Hapus seluruh data transaksi + master lalu bangun ulang demo data. */
function resetDemoData() {
  ensureSetup_();
  [SHEETS.SALES_DATA, SHEETS.RETURN_DATA, SHEETS.STOCK_MOVEMENT, SHEETS.ALLOCATION_PLAN,
   SHEETS.MR_ADMIN, SHEETS.ACCOUNT_MASTER, SHEETS.SKU_MASTER].forEach(function (name) {
    DB.truncate(name);
    DB.resetSequence(name, 0);
  });
  DB.invalidateAll();
  return buildDemoData_();
}

function ensureSetup_() {
  var missing = SHEET_ORDER.filter(function (name) { return !DB.sheetExists(name); });
  if (missing.length) {
    console.log('Sheet belum lengkap (' + missing.join(', ') + '). Menjalankan setupDatabase() otomatis...');
    setupDatabase();
  }
}

function buildDemoData_() {
  var started = new Date();
  var result = {};

  // ---- Master ------------------------------------------------------------
  var now = new Date();
  var accountRows = demoAccounts_().map(function (a) {
    return {
      ACCOUNT_CODE: a.ACCOUNT_CODE, ACCOUNT_NAME: a.ACCOUNT_NAME, CHANNEL: a.CHANNEL,
      REGION: a.REGION, AREA: a.AREA, CITY: a.CITY, CLUSTER: a.POTENTIAL_LEVEL,
      POTENTIAL_LEVEL: a.POTENTIAL_LEVEL, STATUS: 'ACTIVE', CREATED_AT: now, UPDATED_AT: now
    };
  });
  DB.insertMany(SHEETS.ACCOUNT_MASTER, accountRows);

  var skuDefs = demoSkus_();
  DB.insertMany(SHEETS.SKU_MASTER, skuDefs.map(function (s) {
    return {
      SKU_CODE: s.SKU_CODE, SKU_NAME: s.SKU_NAME, CATEGORY: s.CATEGORY, BRAND: s.BRAND,
      UNIT: s.UNIT, SHELF_LIFE_DAYS: s.SHELF_LIFE_DAYS, STATUS: 'ACTIVE'
    };
  }));
  DB.invalidate(SHEETS.ACCOUNT_MASTER);
  DB.invalidate(SHEETS.SKU_MASTER);

  var accounts = DB.read(SHEETS.ACCOUNT_MASTER, { useCache: false });
  var skus = DB.read(SHEETS.SKU_MASTER, { useCache: false });
  var accountByCode = {};
  accounts.forEach(function (a) { accountByCode[a.ACCOUNT_CODE] = a; });
  var skuByCode = {};
  skus.forEach(function (s) { skuByCode[s.SKU_CODE] = s; });
  var priceByCode = {};
  skuDefs.forEach(function (s) { priceByCode[s.SKU_CODE] = s.price; });

  // ---- Periode analisis: 6 bulan terakhir (termasuk bulan berjalan) -------
  var periodCount = 6;
  var today = Utils.today();
  var months = [];
  for (var i = periodCount - 1; i >= 0; i--) {
    months.push(Utils.startOfMonth(Utils.addMonths(today, -i)));
  }

  var salesRows = [];
  var returnRows = [];
  var stockRows = [];

  /** Tanggal return dalam bulan tertentu, tidak pernah melewati hari ini. */
  function returnDate(monthStart, preferredDay) {
    var d = new Date(monthStart.getFullYear(), monthStart.getMonth(), preferredDay);
    return d > today ? today : d;
  }

  function pushSeries(account, sku, series) {
    var price = priceByCode[sku.SKU_CODE] || 100000;
    var opening = series.openingStock;
    for (var m = 0; m < months.length; m++) {
      var monthStart = months[m];
      var sellOut = series.sellOut[m];
      var ret = series.returns[m];
      var closing = series.closing[m];
      var sellIn = closing - opening + sellOut + ret;    // rantai stock konsisten

      salesRows.push({
        DATE: monthStart, ACCOUNT_ID: account.ACCOUNT_ID, SKU_ID: sku.SKU_ID,
        SELL_IN_QTY: sellIn, SELL_OUT_QTY: sellOut, SALES_VALUE: sellOut * price,
        STOCK_QTY: closing, CREATED_AT: now
      });

      if (ret > 0) {
        returnRows.push({
          RETURN_DATE: returnDate(monthStart, 25), ACCOUNT_ID: account.ACCOUNT_ID, SKU_ID: sku.SKU_ID,
          RETURN_QTY: ret, RETURN_VALUE: ret * price, RETURN_REASON: series.reason,
          EXPIRY_DATE: Utils.addDays(monthStart, Utils.num(sku.SHELF_LIFE_DAYS, 60)),
          STATUS: 'PROCESSED', CREATED_AT: now
        });
      }

      stockRows.push({
        DATE: monthStart, ACCOUNT_ID: account.ACCOUNT_ID, SKU_ID: sku.SKU_ID,
        OPENING_STOCK: opening, IN_QTY: sellIn, OUT_QTY: sellOut, RETURN_QTY: ret,
        CLOSING_STOCK: closing, CREATED_AT: now
      });

      opening = closing;
    }
  }

  // ---- Skenario demo wajib ----------------------------------------------
  demoScenarios_().forEach(function (scenario) {
    var account = accountByCode[scenario.accountCode];
    var sku = skuByCode[scenario.skuCode];
    if (!account || !sku) return;
    pushSeries(account, sku, scenario);
  });

  // ---- Account & SKU realistis (deterministik) ---------------------------
  var rand = seededRandom_(20260919);
  var otherAccounts = accounts.filter(function (a) { return a.ACCOUNT_CODE.indexOf('DEMO-') !== 0; });
  var otherSkus = skus.filter(function (s) { return s.SKU_CODE.indexOf('DEMO-') !== 0; });
  var reasons = ['NEAR_EXPIRY', 'SLOW_MOVING', 'DAMAGED', 'EXPIRED'];

  otherAccounts.forEach(function (account, ai) {
    var potential = Utils.upper(account.POTENTIAL_LEVEL);
    var base = potential === 'HIGH' ? 420 : (potential === 'MEDIUM' ? 240 : 130);
    otherSkus.forEach(function (sku, si) {
      var skuFactor = 0.7 + rand() * 0.8;
      var mrBase = 0.02 + rand() * 0.11;                       // MR% 2% - 13%
      if (Utils.num(sku.SHELF_LIFE_DAYS) <= 45) mrBase += 0.03; // produk fresh lebih berisiko
      var sellOut = [], returns = [], closing = [];
      var opening = Math.round(base * skuFactor * (0.35 + rand() * 0.25));
      var current = opening;
      for (var m = 0; m < periodCount; m++) {
        var seasonal = 1 + Math.sin((m + ai + si) / 2.2) * 0.12;
        var so = Math.max(20, Math.round(base * skuFactor * seasonal * (0.9 + rand() * 0.2)));
        var rt = Math.max(0, Math.round(so * mrBase * (0.8 + rand() * 0.4)));
        var drift = (potential === 'LOW' ? 1.06 : 0.98) + (rand() - 0.5) * 0.08;
        var close = Math.max(10, Math.round(current * drift));
        sellOut.push(so);
        returns.push(rt);
        closing.push(close);
        current = close;
      }
      pushSeries(account, sku, {
        openingStock: opening, sellOut: sellOut, returns: returns, closing: closing,
        reason: reasons[Math.floor(rand() * reasons.length)]
      });
    });
  });

  DB.insertMany(SHEETS.SALES_DATA, salesRows);
  DB.insertMany(SHEETS.RETURN_DATA, returnRows);
  DB.insertMany(SHEETS.STOCK_MOVEMENT, stockRows);
  DB.invalidateAll();

  result.accounts = accountRows.length;
  result.skus = skuDefs.length;
  result.sales = salesRows.length;
  result.returns = returnRows.length;
  result.stock = stockRows.length;

  // ---- MR Administration demo (seluruh status workflow) ------------------
  result.mr = seedDemoMr_(accountByCode, skuByCode, priceByCode, today);

  // ---- Allocation plan demo (memakai engine yang sama dengan aplikasi) ---
  result.allocation = seedDemoAllocation_(today);

  DB.invalidateAll();
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.DEMO_DONE, 'TRUE');

  AuditService.log({
    user: 'SYSTEM', action: AUDIT_ACTIONS.SETUP, module: AuditService.MODULES.SETUP,
    recordId: 'DEMO',
    description: 'Demo data dibuat: ' + result.accounts + ' account, ' + result.skus + ' SKU, '
      + result.sales + ' baris sales, ' + result.returns + ' baris return, '
      + result.mr + ' dokumen MR, ' + result.allocation + ' allocation plan.'
  });

  var message = [
    '=====================================================',
    ' DEMO DATA BERHASIL DIBUAT',
    '=====================================================',
    ' Account          : ' + result.accounts,
    ' SKU              : ' + result.skus,
    ' Sales data       : ' + result.sales + ' baris',
    ' Return data      : ' + result.returns + ' baris',
    ' Stock movement   : ' + result.stock + ' baris',
    ' MR administration: ' + result.mr + ' dokumen',
    ' Allocation plan  : ' + result.allocation + ' baris',
    '-----------------------------------------------------',
    ' SKENARIO DEMO',
    '  DEMO-ACCOUNT-001 / DEMO-MILK-001 → Sell Out 1.000, Return 50, Stock 100, MR% 5%',
    '  DEMO-ACCOUNT-002 / DEMO-MILK-002 → Sell Out 500, Return 75, Stock 180, MR% 15%',
    '-----------------------------------------------------',
    ' Durasi           : ' + ((new Date() - started) / 1000).toFixed(1) + ' detik',
    ' LANGKAH BERIKUTNYA: Deploy → New deployment → Web app',
    '====================================================='
  ].join('\n');
  console.log(message);
  return { success: true, message: message, detail: result };
}

/** Dokumen MR demo untuk setiap tahap workflow. */
function seedDemoMr_(accountByCode, skuByCode, priceByCode, today) {
  var cutoffDays = Settings.getNumber('MR_CUTOFF_DAYS', 7);
  var rows = [];
  var soSeq = 0;

  function mk(accountCode, skuCode, qty, dayOffset, status, opts) {
    var account = accountByCode[accountCode];
    var sku = skuByCode[skuCode];
    if (!account || !sku) return;
    var options = opts || {};
    var mrDate = Utils.addDays(today, dayOffset);
    var price = priceByCode[skuCode] || 100000;
    var value = qty * price;
    var expiry = Utils.addDays(mrDate, options.remainingDays === undefined ? 20 : options.remainingDays);
    var bapRequired = evaluateBapRequirement_(mrDate, expiry, value);
    var pickupDate = options.pickupDate === null ? '' : Utils.addDays(mrDate, options.pickupOffset || 3);
    var statusIndex = MR_FLOW.indexOf(status);
    var soNumber = '';
    var soStatus = 'NOT_CREATED';
    if (statusIndex >= MR_FLOW.indexOf('SO_CREATED') || status === 'COMPLETED') {
      soSeq++;
      soNumber = Settings.get('SO_NUMBER_PREFIX', 'SO-MR') + '-'
        + Utils.formatDate(mrDate, 'yyyyMMdd') + '-' + Utils.pad(soSeq, 4);
      soStatus = 'CREATED';
    }
    var approved = statusIndex >= MR_FLOW.indexOf('APPROVED') || status === 'COMPLETED';
    rows.push({
      MR_DATE: mrDate,
      ACCOUNT_ID: account.ACCOUNT_ID,
      SKU_ID: sku.SKU_ID,
      RETURN_QTY: qty,
      RETURN_VALUE: value,
      PICKUP_DATE: pickupDate,
      CUTOFF_DATE: Utils.addDays(mrDate, cutoffDays),
      BAP_REQUIRED: bapRequired,
      BAP_STATUS: bapRequired ? (approved ? 'RECEIVED' : 'PENDING') : 'NOT_REQUIRED',
      SALES_APPROVAL: status === 'REJECTED' ? 'REJECTED' : (approved ? 'APPROVED' : 'PENDING'),
      SO_NUMBER: soNumber,
      SO_STATUS: soStatus,
      MR_STATUS: status,
      REMARK: options.remark || '',
      CREATED_BY: options.createdBy || 'mr',
      CREATED_AT: mrDate,
      UPDATED_AT: new Date(),
      RETURN_REASON: options.reason || 'NEAR_EXPIRY',
      EXPIRY_DATE: expiry,
      VALIDATION_STATUS: status === 'INPUT' ? 'NOT_VALIDATED' : (options.validation || 'PASS'),
      VALIDATION_NOTES: options.validationNotes || (status === 'INPUT' ? '' : 'Validasi otomatis: data lengkap dan sesuai SOP.'),
      PIC: options.pic || 'MR Administrator',
      APPROVED_BY: approved ? 'sales' : (status === 'REJECTED' ? 'sales' : ''),
      APPROVED_AT: approved || status === 'REJECTED' ? Utils.addDays(mrDate, 1) : '',
      REJECT_REASON: status === 'REJECTED' ? (options.rejectReason || 'Qty return melebihi batas wajar dibanding sell out.') : '',
      SO_DATE: soNumber ? Utils.addDays(mrDate, 2) : '',
      COMPLETED_AT: status === 'COMPLETED' ? Utils.addDays(mrDate, 5) : ''
    });
  }

  mk('DEMO-ACCOUNT-002', 'DEMO-MILK-002', 13, -2, 'INPUT', { reason: 'SLOW_MOVING', remark: 'Stock menumpuk di gudang account.', remainingDays: 12 });
  mk('GT-SMG-004', 'FRESH-PAS-250', 24, -3, 'INPUT', { reason: 'NEAR_EXPIRY', remainingDays: 9 });
  mk('MT-BDG-002', 'YOG-DRINK-180', 18, -5, 'VALIDATED', { reason: 'NEAR_EXPIRY', remainingDays: 15 });
  mk('GT-SBY-003', 'UHT-FC-1000', 30, -6, 'VALIDATED', { reason: 'SLOW_MOVING', remainingDays: 60 });
  mk('DEMO-ACCOUNT-001', 'DEMO-MILK-001', 7, -7, 'WAITING_APPROVAL', { reason: 'NEAR_EXPIRY', remainingDays: 35 });
  mk('HRC-DPS-005', 'FRESH-PAS-250', 12, -8, 'WAITING_APPROVAL', { reason: 'DAMAGED', remainingDays: 6, validation: 'WARNING', validationNotes: 'Pickup date mendekati batas SLO penarikan.' });
  mk('MT-JKT-001', 'CHS-SLICE-200', 16, -10, 'APPROVED', { reason: 'NEAR_EXPIRY', remainingDays: 40 });
  mk('EC-NAS-006', 'UHT-FC-1000', 40, -11, 'APPROVED', { reason: 'SLOW_MOVING', remainingDays: 90 });
  mk('MT-JKT-001', 'YOG-DRINK-180', 22, -14, 'SO_CREATED', { reason: 'NEAR_EXPIRY', remainingDays: 18 });
  mk('GT-SBY-003', 'FRESH-PAS-250', 14, -16, 'SO_CREATED', { reason: 'EXPIRED', remainingDays: -2 });
  mk('MT-BDG-002', 'UHT-FC-1000', 26, -18, 'PICKUP_SCHEDULED', { reason: 'SLOW_MOVING', remainingDays: 70 });
  mk('DEMO-ACCOUNT-001', 'DEMO-MILK-001', 8, -22, 'COMPLETED', { reason: 'NEAR_EXPIRY', remainingDays: 30 });
  mk('DEMO-ACCOUNT-002', 'DEMO-MILK-002', 12, -25, 'COMPLETED', { reason: 'SLOW_MOVING', remainingDays: 14 });
  mk('GT-SMG-004', 'CHS-SLICE-200', 9, -28, 'COMPLETED', { reason: 'DAMAGED', remainingDays: 25 });
  mk('HRC-DPS-005', 'YOG-DRINK-180', 35, -30, 'REJECTED', { reason: 'OTHER', remainingDays: 20, validation: 'WARNING' });

  DB.insertMany(SHEETS.MR_ADMIN, rows);
  return rows.length;
}

/**
 * Evaluasi ketentuan BAP sesuai setting (dipakai demo & MRService).
 * @return {boolean} true bila BAP wajib
 */
function evaluateBapRequirement_(mrDate, expiryDate, returnValue) {
  var rule = Utils.upper(Settings.get('BAP_RULE', 'FRESH_EXEMPT'));
  if (rule === 'ALWAYS') return true;
  if (rule === 'NEVER') return false;
  // FRESH_EXEMPT: item fresh & bernilai wajar tidak wajib BAP
  var minRemaining = Settings.getNumber('BAP_FRESH_MIN_REMAINING_DAYS', 30);
  var valueThreshold = Settings.getNumber('BAP_VALUE_THRESHOLD', 5000000);
  var remaining = Utils.diffDays(mrDate, expiryDate);
  var isFresh = remaining !== null && remaining >= minRemaining;
  var withinValue = Utils.num(returnValue) <= valueThreshold;
  return !(isFresh && withinValue);
}

/** Allocation plan demo dibangun dari engine produksi agar angkanya konsisten. */
function seedDemoAllocation_(today) {
  var matrix = AllocationEngine.buildMatrix({});
  if (!matrix.rows.length) return 0;

  var top = Utils.sortBy(matrix.rows, [{ key: 'recommendedAllocation', dir: 'desc' }]).slice(0, 12);
  var demoRows = matrix.rows.filter(function (r) { return r.accountCode.indexOf('DEMO-') === 0; });
  var seen = {};
  var selected = [];
  demoRows.concat(top).forEach(function (r) {
    var key = r.accountId + '|' + r.skuId;
    if (seen[key]) return;
    seen[key] = true;
    selected.push(r);
  });

  var now = new Date();
  var planDate = Utils.startOfMonth(today);      // siklus perencanaan = awal bulan berjalan
  var statuses = ['APPROVED', 'SUBMITTED', 'DRAFT'];
  var rows = selected.map(function (r, idx) {
    var status = statuses[Math.min(statuses.length - 1, Math.floor(idx / 5))];
    var overridden = idx === 2;     // satu contoh manual override lengkap dengan alasan
    var planned = overridden ? Math.round(r.recommendedAllocation * 0.85) : r.recommendedAllocation;
    return {
      PLAN_DATE: planDate,
      ACCOUNT_ID: r.accountId,
      SKU_ID: r.skuId,
      AVG_SELL_OUT: r.avgSellOut,
      AVG_RETURN: r.avgReturn,
      MR_PERCENT: r.mrPercent,
      STOCK_MOVEMENT: r.stockMovement,
      POTENTIAL_LEVEL: r.potential,
      RECOMMENDED_ALLOCATION: r.recommendedAllocation,
      PLANNED_SELL_IN: planned,
      STATUS: status,
      CREATED_BY: 'manager',
      CREATED_AT: now,
      UPDATED_AT: now,
      CURRENT_STOCK: r.currentStock,
      RISK_LEVEL: r.riskLevel,
      OVERRIDE_REASON: overridden ? 'Kapasitas gudang account terbatas pada periode ini.' : '',
      APPROVED_BY: status === 'APPROVED' ? 'manager' : '',
      APPROVED_AT: status === 'APPROVED' ? now : '',
      PERIOD_FROM: matrix.meta.from,
      PERIOD_TO: matrix.meta.to
    };
  });

  DB.insertMany(SHEETS.ALLOCATION_PLAN, rows);
  return rows.length;
}

// ===========================================================================
// 3. STATUS SETUP (dipakai halaman "System Setup Status")
// ===========================================================================

/**
 * Status kesiapan sistem. Dipanggil sebelum login sehingga hanya mengembalikan
 * informasi non-sensitif (boolean + jumlah baris).
 */
function getSystemStatus() {
  var status = {
    database: { ready: false, label: 'NOT READY', detail: '' },
    sheets: { ready: false, label: 'NOT READY', total: SHEET_ORDER.length, found: 0, missing: [] },
    demoData: { ready: false, label: 'EMPTY', accounts: 0, skus: 0, sales: 0, mr: 0 },
    configuration: { ready: false, label: 'NOT READY', settings: 0, expected: DEFAULT_SETTINGS.length },
    users: { ready: false, label: 'NOT READY', total: 0 },
    setupAt: PropertiesService.getScriptProperties().getProperty(PROP_KEYS.SETUP_AT) || null,
    appName: APP.NAME,
    appVersion: APP.VERSION
  };

  try {
    var ss = DB.spreadsheet();
    status.database.ready = true;
    status.database.label = 'READY';
    status.database.detail = ss.getName();
  } catch (e) {
    status.database.detail = 'Spreadsheet belum terdeteksi.';
    return status;
  }

  var found = [];
  SHEET_ORDER.forEach(function (name) {
    if (DB.sheetExists(name)) found.push(name); else status.sheets.missing.push(name);
  });
  status.sheets.found = found.length;
  status.sheets.ready = status.sheets.missing.length === 0;
  status.sheets.label = status.sheets.ready ? 'READY' : 'INCOMPLETE';

  if (!status.sheets.ready) return status;

  status.configuration.settings = DB.count(SHEETS.SETTINGS);
  status.configuration.ready = status.configuration.settings > 0;
  status.configuration.label = status.configuration.ready ? 'READY' : 'NOT READY';

  status.users.total = DB.count(SHEETS.USERS);
  status.users.ready = status.users.total > 0;
  status.users.label = status.users.ready ? 'READY' : 'NOT READY';

  status.demoData.accounts = DB.count(SHEETS.ACCOUNT_MASTER);
  status.demoData.skus = DB.count(SHEETS.SKU_MASTER);
  status.demoData.sales = DB.count(SHEETS.SALES_DATA);
  status.demoData.mr = DB.count(SHEETS.MR_ADMIN);
  status.demoData.ready = status.demoData.accounts > 0 && status.demoData.sales > 0;
  status.demoData.label = status.demoData.ready ? 'READY' : 'EMPTY';

  return status;
}

/** True bila database siap dipakai aplikasi. */
function isDatabaseReady() {
  try {
    return SHEET_ORDER.every(function (name) { return DB.sheetExists(name); })
      && DB.count(SHEETS.USERS) > 0;
  } catch (e) {
    return false;
  }
}

/** Menu Apps Script agar setup bisa dijalankan tanpa membuka editor. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('MR DAIRY')
      .addItem('1. Setup Database', 'setupDatabase')
      .addItem('2. Buat Demo Data', 'createDemoData')
      .addSeparator()
      .addItem('Reset Demo Data', 'resetDemoData')
      .addItem('Cek Status Sistem', 'showSystemStatus')
      .addToUi();
  } catch (e) { /* onOpen tidak tersedia di semua konteks */ }
}

/** Tampilkan status sistem sebagai dialog di spreadsheet. */
function showSystemStatus() {
  var status = getSystemStatus();
  var lines = [
    'Database      : ' + status.database.label + ' (' + status.database.detail + ')',
    'Sheets        : ' + status.sheets.label + ' (' + status.sheets.found + '/' + status.sheets.total + ')',
    'Configuration : ' + status.configuration.label + ' (' + status.configuration.settings + ' settings)',
    'Users         : ' + status.users.label + ' (' + status.users.total + ' user)',
    'Demo Data     : ' + status.demoData.label + ' (' + status.demoData.accounts + ' account, '
      + status.demoData.sales + ' baris sales)'
  ].join('\n');
  try {
    SpreadsheetApp.getUi().alert(APP.NAME + ' - System Setup Status', lines, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    console.log(lines);
  }
  return status;
}
