/**
 * PROJECT MR DAIRY
 * ============================================================================
 * Config.gs — Single source of truth untuk schema database, enum, business
 * rule default, permission matrix dan navigation.
 *
 * ATURAN PENTING:
 *   - Tidak ada business value yang di-hardcode di service layer.
 *     Semua angka bisnis berasal dari sheet SETTINGS (lihat DEFAULT_SETTINGS)
 *     sehingga administrator dapat mengubahnya tanpa menyentuh source code.
 *   - File ini hanya berisi deklarasi (literal + function declaration) supaya
 *     aman terhadap urutan load file Apps Script.
 * ============================================================================
 */

/** Identitas aplikasi. */
var APP = {
  NAME: 'PROJECT MR DAIRY',
  SUBTITLE: 'Distribution Planning & Market Return Management',
  VERSION: '1.0.0',
  OBJECTIVE: 'Less Return. More Freshness.',
  TIMEZONE: 'Asia/Jakarta'
};

/** Nama seluruh sheet database. */
var SHEETS = {
  USERS: 'USERS',
  ACCOUNT_MASTER: 'ACCOUNT_MASTER',
  SKU_MASTER: 'SKU_MASTER',
  SALES_DATA: 'SALES_DATA',
  RETURN_DATA: 'RETURN_DATA',
  STOCK_MOVEMENT: 'STOCK_MOVEMENT',
  ALLOCATION_PLAN: 'ALLOCATION_PLAN',
  MR_ADMIN: 'MR_ADMIN',
  SOP_MASTER: 'SOP_MASTER',
  SETTINGS: 'SETTINGS',
  AUDIT_LOG: 'AUDIT_LOG'
};

/** Role aplikasi. */
var ROLES = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  SALES: 'SALES',
  MR: 'MR',
  VIEWER: 'VIEWER'
};

/** Enum status & klasifikasi. */
var ENUMS = {
  USER_STATUS: ['ACTIVE', 'INACTIVE'],
  ROLE: ['ADMIN', 'MANAGER', 'SALES', 'MR', 'VIEWER'],
  POTENTIAL_LEVEL: ['HIGH', 'MEDIUM', 'LOW'],
  RISK_LEVEL: ['LOW', 'MEDIUM', 'HIGH'],
  MASTER_STATUS: ['ACTIVE', 'INACTIVE'],
  ALLOCATION_STATUS: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'COMPLETED'],
  MR_STATUS: ['INPUT', 'VALIDATED', 'WAITING_APPROVAL', 'APPROVED', 'SO_CREATED', 'PICKUP_SCHEDULED', 'COMPLETED', 'REJECTED'],
  SO_STATUS: ['NOT_CREATED', 'CREATED', 'CANCELLED'],
  BAP_STATUS: ['NOT_REQUIRED', 'PENDING', 'RECEIVED'],
  SALES_APPROVAL: ['PENDING', 'APPROVED', 'REJECTED'],
  VALIDATION_STATUS: ['NOT_VALIDATED', 'PASS', 'WARNING', 'ERROR'],
  RETURN_STATUS: ['OPEN', 'PROCESSED', 'CANCELLED'],
  RETURN_REASON: ['NEAR_EXPIRY', 'EXPIRED', 'DAMAGED', 'SLOW_MOVING', 'WRONG_DELIVERY', 'OTHER'],
  SOP_STATUS: ['ACTIVE', 'DRAFT', 'INACTIVE'],
  CHANNEL: ['MODERN_TRADE', 'GENERAL_TRADE', 'HORECA', 'E_COMMERCE'],
  SKU_CATEGORY: ['UHT', 'FRESH_MILK', 'YOGHURT', 'CHEESE', 'BUTTER', 'CREAM']
};

/** Urutan workflow MR (dipakai progress tracker & kanban). */
var MR_FLOW = ['INPUT', 'VALIDATED', 'WAITING_APPROVAL', 'APPROVED', 'SO_CREATED', 'PICKUP_SCHEDULED', 'COMPLETED'];

/**
 * Tipe kolom → dipakai Setup.gs untuk number format dan Utils untuk coercion.
 *   text | int | qty | money | percent | decimal | date | datetime | bool
 */
var SCHEMA = {
  USERS: {
    name: 'USERS',
    idField: 'USER_ID',
    idPrefix: 'USR',
    description: 'Master user, kredensial dan role untuk RBAC.',
    headers: ['USER_ID', 'USERNAME', 'PASSWORD_HASH', 'NAME', 'ROLE', 'EMAIL', 'STATUS', 'CREATED_AT', 'UPDATED_AT'],
    types: {
      USER_ID: 'text', USERNAME: 'text', PASSWORD_HASH: 'text', NAME: 'text', ROLE: 'text',
      EMAIL: 'text', STATUS: 'text', CREATED_AT: 'datetime', UPDATED_AT: 'datetime'
    },
    widths: { USER_ID: 110, USERNAME: 130, PASSWORD_HASH: 260, NAME: 190, ROLE: 110, EMAIL: 220, STATUS: 100 },
    validations: { ROLE: ENUMS.ROLE, STATUS: ENUMS.USER_STATUS },
    protectedSheet: true
  },

  ACCOUNT_MASTER: {
    name: 'ACCOUNT_MASTER',
    idField: 'ACCOUNT_ID',
    idPrefix: 'ACC',
    description: 'Master account / customer beserta hasil clustering potensi.',
    headers: ['ACCOUNT_ID', 'ACCOUNT_CODE', 'ACCOUNT_NAME', 'CHANNEL', 'REGION', 'AREA', 'CITY', 'CLUSTER', 'POTENTIAL_LEVEL', 'STATUS', 'CREATED_AT', 'UPDATED_AT'],
    types: {
      ACCOUNT_ID: 'text', ACCOUNT_CODE: 'text', ACCOUNT_NAME: 'text', CHANNEL: 'text', REGION: 'text',
      AREA: 'text', CITY: 'text', CLUSTER: 'text', POTENTIAL_LEVEL: 'text', STATUS: 'text',
      CREATED_AT: 'datetime', UPDATED_AT: 'datetime'
    },
    widths: { ACCOUNT_ID: 110, ACCOUNT_CODE: 140, ACCOUNT_NAME: 230, CHANNEL: 140, REGION: 120, AREA: 130, CITY: 130, CLUSTER: 110, POTENTIAL_LEVEL: 140, STATUS: 100 },
    validations: { POTENTIAL_LEVEL: ENUMS.POTENTIAL_LEVEL, STATUS: ENUMS.MASTER_STATUS, CLUSTER: ENUMS.POTENTIAL_LEVEL }
  },

  SKU_MASTER: {
    name: 'SKU_MASTER',
    idField: 'SKU_ID',
    idPrefix: 'SKU',
    description: 'Master produk dairy beserta shelf life (dipakai MR risk).',
    headers: ['SKU_ID', 'SKU_CODE', 'SKU_NAME', 'CATEGORY', 'BRAND', 'UNIT', 'SHELF_LIFE_DAYS', 'STATUS'],
    types: {
      SKU_ID: 'text', SKU_CODE: 'text', SKU_NAME: 'text', CATEGORY: 'text', BRAND: 'text',
      UNIT: 'text', SHELF_LIFE_DAYS: 'int', STATUS: 'text'
    },
    widths: { SKU_ID: 110, SKU_CODE: 140, SKU_NAME: 240, CATEGORY: 130, BRAND: 130, UNIT: 90, SHELF_LIFE_DAYS: 140, STATUS: 100 },
    validations: { STATUS: ENUMS.MASTER_STATUS }
  },

  SALES_DATA: {
    name: 'SALES_DATA',
    idField: 'SALES_ID',
    idPrefix: 'SLS',
    description: 'Transaksi Sell In / Sell Out per periode, account dan SKU.',
    headers: ['SALES_ID', 'DATE', 'ACCOUNT_ID', 'SKU_ID', 'SELL_IN_QTY', 'SELL_OUT_QTY', 'SALES_VALUE', 'STOCK_QTY', 'CREATED_AT'],
    types: {
      SALES_ID: 'text', DATE: 'date', ACCOUNT_ID: 'text', SKU_ID: 'text', SELL_IN_QTY: 'qty',
      SELL_OUT_QTY: 'qty', SALES_VALUE: 'money', STOCK_QTY: 'qty', CREATED_AT: 'datetime'
    },
    widths: { SALES_ID: 120, DATE: 110, ACCOUNT_ID: 110, SKU_ID: 110, SELL_IN_QTY: 120, SELL_OUT_QTY: 130, SALES_VALUE: 150, STOCK_QTY: 110 }
  },

  RETURN_DATA: {
    name: 'RETURN_DATA',
    idField: 'RETURN_ID',
    idPrefix: 'RTN',
    description: 'Realisasi Market Return per periode, account dan SKU.',
    headers: ['RETURN_ID', 'RETURN_DATE', 'ACCOUNT_ID', 'SKU_ID', 'RETURN_QTY', 'RETURN_VALUE', 'RETURN_REASON', 'EXPIRY_DATE', 'STATUS', 'CREATED_AT'],
    types: {
      RETURN_ID: 'text', RETURN_DATE: 'date', ACCOUNT_ID: 'text', SKU_ID: 'text', RETURN_QTY: 'qty',
      RETURN_VALUE: 'money', RETURN_REASON: 'text', EXPIRY_DATE: 'date', STATUS: 'text', CREATED_AT: 'datetime'
    },
    widths: { RETURN_ID: 120, RETURN_DATE: 120, ACCOUNT_ID: 110, SKU_ID: 110, RETURN_QTY: 110, RETURN_VALUE: 150, RETURN_REASON: 150, EXPIRY_DATE: 120, STATUS: 110 },
    validations: { RETURN_REASON: ENUMS.RETURN_REASON, STATUS: ENUMS.RETURN_STATUS }
  },

  STOCK_MOVEMENT: {
    name: 'STOCK_MOVEMENT',
    idField: 'MOVEMENT_ID',
    idPrefix: 'MOV',
    description: 'Pergerakan stock di account (opening → closing) per periode.',
    headers: ['MOVEMENT_ID', 'DATE', 'ACCOUNT_ID', 'SKU_ID', 'OPENING_STOCK', 'IN_QTY', 'OUT_QTY', 'RETURN_QTY', 'CLOSING_STOCK', 'CREATED_AT'],
    types: {
      MOVEMENT_ID: 'text', DATE: 'date', ACCOUNT_ID: 'text', SKU_ID: 'text', OPENING_STOCK: 'qty',
      IN_QTY: 'qty', OUT_QTY: 'qty', RETURN_QTY: 'qty', CLOSING_STOCK: 'qty', CREATED_AT: 'datetime'
    },
    widths: { MOVEMENT_ID: 130, DATE: 110, ACCOUNT_ID: 110, SKU_ID: 110, OPENING_STOCK: 130, IN_QTY: 100, OUT_QTY: 100, RETURN_QTY: 110, CLOSING_STOCK: 130 }
  },

  ALLOCATION_PLAN: {
    name: 'ALLOCATION_PLAN',
    idField: 'ALLOCATION_ID',
    idPrefix: 'ALC',
    description: 'Hasil Determine Plan Sell In: rekomendasi sistem + keputusan user.',
    // 15 kolom pertama = spesifikasi PRD. Sisanya = extension (audit override & approval).
    headers: ['ALLOCATION_ID', 'PLAN_DATE', 'ACCOUNT_ID', 'SKU_ID', 'AVG_SELL_OUT', 'AVG_RETURN', 'MR_PERCENT', 'STOCK_MOVEMENT', 'POTENTIAL_LEVEL', 'RECOMMENDED_ALLOCATION', 'PLANNED_SELL_IN', 'STATUS', 'CREATED_BY', 'CREATED_AT', 'UPDATED_AT', 'CURRENT_STOCK', 'RISK_LEVEL', 'OVERRIDE_REASON', 'APPROVED_BY', 'APPROVED_AT', 'PERIOD_FROM', 'PERIOD_TO'],
    types: {
      ALLOCATION_ID: 'text', PLAN_DATE: 'date', ACCOUNT_ID: 'text', SKU_ID: 'text', AVG_SELL_OUT: 'decimal',
      AVG_RETURN: 'decimal', MR_PERCENT: 'percent', STOCK_MOVEMENT: 'decimal', POTENTIAL_LEVEL: 'text',
      RECOMMENDED_ALLOCATION: 'qty', PLANNED_SELL_IN: 'qty', STATUS: 'text', CREATED_BY: 'text',
      CREATED_AT: 'datetime', UPDATED_AT: 'datetime', CURRENT_STOCK: 'qty', RISK_LEVEL: 'text',
      OVERRIDE_REASON: 'text', APPROVED_BY: 'text', APPROVED_AT: 'datetime', PERIOD_FROM: 'date', PERIOD_TO: 'date'
    },
    widths: { ALLOCATION_ID: 130, PLAN_DATE: 110, ACCOUNT_ID: 110, SKU_ID: 110, AVG_SELL_OUT: 130, AVG_RETURN: 120, MR_PERCENT: 110, STOCK_MOVEMENT: 140, POTENTIAL_LEVEL: 140, RECOMMENDED_ALLOCATION: 200, PLANNED_SELL_IN: 140, STATUS: 120, OVERRIDE_REASON: 260 },
    validations: { POTENTIAL_LEVEL: ENUMS.POTENTIAL_LEVEL, STATUS: ENUMS.ALLOCATION_STATUS, RISK_LEVEL: ENUMS.RISK_LEVEL }
  },

  MR_ADMIN: {
    name: 'MR_ADMIN',
    idField: 'MR_ID',
    idPrefix: 'MR',
    description: 'Administrasi Market Return end-to-end (input → SO → completed).',
    // 18 kolom pertama = spesifikasi PRD. Sisanya = extension yang dibutuhkan workflow.
    headers: ['MR_ID', 'MR_DATE', 'ACCOUNT_ID', 'SKU_ID', 'RETURN_QTY', 'RETURN_VALUE', 'PICKUP_DATE', 'CUTOFF_DATE', 'BAP_REQUIRED', 'BAP_STATUS', 'SALES_APPROVAL', 'SO_NUMBER', 'SO_STATUS', 'MR_STATUS', 'REMARK', 'CREATED_BY', 'CREATED_AT', 'UPDATED_AT', 'RETURN_REASON', 'EXPIRY_DATE', 'VALIDATION_STATUS', 'VALIDATION_NOTES', 'PIC', 'APPROVED_BY', 'APPROVED_AT', 'REJECT_REASON', 'SO_DATE', 'COMPLETED_AT'],
    types: {
      MR_ID: 'text', MR_DATE: 'date', ACCOUNT_ID: 'text', SKU_ID: 'text', RETURN_QTY: 'qty',
      RETURN_VALUE: 'money', PICKUP_DATE: 'date', CUTOFF_DATE: 'date', BAP_REQUIRED: 'bool',
      BAP_STATUS: 'text', SALES_APPROVAL: 'text', SO_NUMBER: 'text', SO_STATUS: 'text', MR_STATUS: 'text',
      REMARK: 'text', CREATED_BY: 'text', CREATED_AT: 'datetime', UPDATED_AT: 'datetime',
      RETURN_REASON: 'text', EXPIRY_DATE: 'date', VALIDATION_STATUS: 'text', VALIDATION_NOTES: 'text',
      PIC: 'text', APPROVED_BY: 'text', APPROVED_AT: 'datetime', REJECT_REASON: 'text',
      SO_DATE: 'date', COMPLETED_AT: 'datetime'
    },
    widths: { MR_ID: 150, MR_DATE: 110, ACCOUNT_ID: 110, SKU_ID: 110, RETURN_QTY: 110, RETURN_VALUE: 140, PICKUP_DATE: 120, CUTOFF_DATE: 120, BAP_REQUIRED: 130, BAP_STATUS: 130, SALES_APPROVAL: 140, SO_NUMBER: 190, SO_STATUS: 120, MR_STATUS: 160, REMARK: 240, VALIDATION_NOTES: 300 },
    validations: {
      BAP_STATUS: ENUMS.BAP_STATUS, SALES_APPROVAL: ENUMS.SALES_APPROVAL, SO_STATUS: ENUMS.SO_STATUS,
      MR_STATUS: ENUMS.MR_STATUS, VALIDATION_STATUS: ENUMS.VALIDATION_STATUS, RETURN_REASON: ENUMS.RETURN_REASON
    }
  },

  SOP_MASTER: {
    name: 'SOP_MASTER',
    idField: 'SOP_ID',
    idPrefix: 'SOP',
    description: 'Definisi SOP MR (jadwal penarikan, cutoff tagihan, ketentuan BAP).',
    headers: ['SOP_ID', 'STEP_NO', 'CODE', 'TITLE', 'DESCRIPTION', 'RULE', 'PIC', 'SLA_DAYS', 'STATUS', 'UPDATED_BY', 'UPDATED_AT'],
    types: {
      SOP_ID: 'text', STEP_NO: 'int', CODE: 'text', TITLE: 'text', DESCRIPTION: 'text', RULE: 'text',
      PIC: 'text', SLA_DAYS: 'int', STATUS: 'text', UPDATED_BY: 'text', UPDATED_AT: 'datetime'
    },
    widths: { SOP_ID: 110, STEP_NO: 90, CODE: 180, TITLE: 260, DESCRIPTION: 380, RULE: 380, PIC: 150, SLA_DAYS: 100, STATUS: 100 },
    validations: { STATUS: ENUMS.SOP_STATUS }
  },

  SETTINGS: {
    name: 'SETTINGS',
    idField: 'KEY',
    idPrefix: 'SET',
    description: 'Seluruh business rule yang configurable tanpa mengubah source code.',
    headers: ['KEY', 'VALUE', 'DESCRIPTION'],
    types: { KEY: 'text', VALUE: 'text', DESCRIPTION: 'text' },
    widths: { KEY: 240, VALUE: 160, DESCRIPTION: 560 }
  },

  AUDIT_LOG: {
    name: 'AUDIT_LOG',
    idField: 'LOG_ID',
    idPrefix: 'LOG',
    description: 'Jejak audit seluruh aktivitas penting.',
    headers: ['LOG_ID', 'TIMESTAMP', 'USER', 'ACTION', 'MODULE', 'RECORD_ID', 'DESCRIPTION', 'OLD_VALUE', 'NEW_VALUE'],
    types: {
      LOG_ID: 'text', TIMESTAMP: 'datetime', USER: 'text', ACTION: 'text', MODULE: 'text',
      RECORD_ID: 'text', DESCRIPTION: 'text', OLD_VALUE: 'text', NEW_VALUE: 'text'
    },
    widths: { LOG_ID: 130, TIMESTAMP: 160, USER: 130, ACTION: 150, MODULE: 150, RECORD_ID: 150, DESCRIPTION: 380, OLD_VALUE: 200, NEW_VALUE: 200 }
  }
};

/** Urutan pembuatan sheet saat setup. */
var SHEET_ORDER = [
  SHEETS.USERS, SHEETS.ACCOUNT_MASTER, SHEETS.SKU_MASTER, SHEETS.SALES_DATA, SHEETS.RETURN_DATA,
  SHEETS.STOCK_MOVEMENT, SHEETS.ALLOCATION_PLAN, SHEETS.MR_ADMIN, SHEETS.SOP_MASTER,
  SHEETS.SETTINGS, SHEETS.AUDIT_LOG
];

/**
 * Default business rules → ditulis ke sheet SETTINGS saat setupDatabase().
 * Format: [KEY, VALUE, DESCRIPTION]
 */
var DEFAULT_SETTINGS = [
  // -- Aplikasi ------------------------------------------------------------
  ['APP_NAME', APP.NAME, 'Nama aplikasi yang tampil pada UI.'],
  ['APP_VERSION', APP.VERSION, 'Versi aplikasi.'],
  ['CURRENCY', 'IDR', 'Kode mata uang untuk format nilai.'],
  ['CURRENCY_SYMBOL', 'Rp', 'Simbol mata uang pada UI.'],
  ['DATE_FORMAT', 'dd MMM yyyy', 'Format tanggal tampilan (pola Apps Script / Intl).'],
  ['DEFAULT_PAGE_SIZE', '25', 'Jumlah baris per halaman pada tabel server-side pagination.'],
  ['MAX_PAGE_SIZE', '200', 'Batas maksimum page size yang boleh diminta frontend.'],
  ['SESSION_TIMEOUT_MINUTES', '240', 'Durasi sesi login sebelum otomatis expired (menit).'],
  ['LOGIN_MAX_ATTEMPTS', '5', 'Jumlah percobaan login gagal sebelum akun dikunci sementara.'],
  ['LOGIN_LOCKOUT_MINUTES', '15', 'Durasi kunci sementara setelah percobaan login gagal berlebihan (menit).'],
  ['CACHE_TTL_SECONDS', '300', 'TTL cache dataset transaksional (detik).'],
  ['MASTER_CACHE_TTL_SECONDS', '1500', 'TTL cache master data (detik).'],

  // -- Periode analitik ----------------------------------------------------
  ['ANALYSIS_PERIOD_MONTHS', '6', 'Jumlah bulan default yang dianalisis untuk AVG Sell Out / AVG Return.'],
  ['PERIOD_GRANULARITY', 'MONTH', 'Granularitas periode perhitungan rata-rata: MONTH atau WEEK.'],

  // -- Formula allocation --------------------------------------------------
  ['ALLOCATION_FACTOR', '1.1', 'Faktor pengali AVG Sell Out pada formula Recommended Allocation.'],
  ['RISK_FACTOR', '1', 'Bobot pengurang AVG Return pada formula Recommended Allocation.'],
  ['POTENTIAL_FACTOR_HIGH', '1.15', 'Pengali tambahan untuk account berpotensi HIGH.'],
  ['POTENTIAL_FACTOR_MEDIUM', '1', 'Pengali tambahan untuk account berpotensi MEDIUM.'],
  ['POTENTIAL_FACTOR_LOW', '0.85', 'Pengali tambahan untuk account berpotensi LOW.'],
  ['ALLOCATION_ROUNDING', '1', 'Kelipatan pembulatan hasil Recommended Allocation (mis. 1, 6, 12).'],
  ['ALLOCATION_MIN', '0', 'Nilai minimum Recommended Allocation.'],
  ['ALLOCATION_STOCK_DEDUCTION', 'TRUE', 'TRUE = current stock dikurangkan dari rekomendasi allocation.'],
  ['ALLOCATION_OVERRIDE_REASON_REQUIRED', 'TRUE', 'TRUE = manual override wajib mengisi alasan.'],
  ['ALLOCATION_OVERRIDE_TOLERANCE_PERCENT', '0', 'Deviasi (%) terhadap rekomendasi yang dianggap bukan override.'],

  // -- Threshold MR % ------------------------------------------------------
  ['TARGET_MR_PERCENT', '5', 'Target maksimum MR% perusahaan.'],
  ['MR_THRESHOLD_MEDIUM', '5', 'MR% di atas nilai ini dianggap MEDIUM.'],
  ['MR_THRESHOLD_HIGH', '10', 'MR% di atas nilai ini dianggap HIGH.'],

  // -- Risk scoring (multi indikator) -------------------------------------
  ['RISK_WEIGHT_MR', '0.4', 'Bobot indikator MR% pada skor risiko (total bobot idealnya 1).'],
  ['RISK_WEIGHT_STOCK_COVER', '0.3', 'Bobot indikator stock cover pada skor risiko.'],
  ['RISK_WEIGHT_SHELF_LIFE', '0.2', 'Bobot indikator shelf life pada skor risiko.'],
  ['RISK_WEIGHT_SELL_OUT_TREND', '0.1', 'Bobot indikator tren sell out pada skor risiko.'],
  ['RISK_STOCK_COVER_MEDIUM', '1.5', 'Stock cover (bulan) di atas nilai ini mulai berisiko.'],
  ['RISK_STOCK_COVER_HIGH', '2.5', 'Stock cover (bulan) di atas nilai ini berisiko tinggi.'],
  ['RISK_SHELF_LIFE_SHORT_DAYS', '45', 'Shelf life (hari) di bawah nilai ini dianggap fast-perishable.'],
  ['RISK_SCORE_MEDIUM', '40', 'Skor risiko (0-100) minimum untuk kategori MEDIUM RISK.'],
  ['RISK_SCORE_HIGH', '65', 'Skor risiko (0-100) minimum untuk kategori HIGH RISK.'],

  // -- Clustering ----------------------------------------------------------
  ['CLUSTER_WEIGHT_SELL_OUT', '0.45', 'Bobot rata-rata sell out pada skor potensi account.'],
  ['CLUSTER_WEIGHT_SALES_VALUE', '0.25', 'Bobot historical sales value pada skor potensi account.'],
  ['CLUSTER_WEIGHT_MR', '0.2', 'Bobot MR% (inverse) pada skor potensi account.'],
  ['CLUSTER_WEIGHT_STOCK_MOVEMENT', '0.1', 'Bobot stock movement pada skor potensi account.'],
  ['CLUSTER_SCORE_HIGH', '65', 'Skor potensi (0-100) minimum untuk cluster HIGH.'],
  ['CLUSTER_SCORE_MEDIUM', '35', 'Skor potensi (0-100) minimum untuk cluster MEDIUM.'],

  // -- SOP MR --------------------------------------------------------------
  ['MR_CUTOFF_DAYS', '7', 'Jumlah hari dari tanggal MR sampai cutoff potong tagihan (alias: CUT_OFF_DAYS).'],
  ['MR_PICKUP_SLA_DAYS', '3', 'SLA maksimum dari MR date ke pickup date (hari).'],
  ['MR_VALIDATION_SLA_HOURS', '24', 'SLA validasi data MR setelah input admin (jam).'],
  ['MR_APPROVAL_SLA_HOURS', '48', 'SLA approval Sales setelah data tervalidasi (jam).'],
  ['MR_SO_SLA_HOURS', '24', 'SLA pembuatan SO setelah approval (jam).'],
  ['BAP_RULE', 'FRESH_EXEMPT', 'Aturan BAP: FRESH_EXEMPT (fresh & sesuai SOP tidak wajib BAP), ALWAYS, NEVER.'],
  ['BAP_FRESH_MIN_REMAINING_DAYS', '30', 'Sisa umur produk (hari) minimum agar item dikategorikan fresh.'],
  ['BAP_VALUE_THRESHOLD', '5000000', 'Nilai return di atas nominal ini tetap wajib BAP walaupun fresh.'],
  ['MR_QTY_ANOMALY_MULTIPLIER', '3', 'Qty return > multiplier x rata-rata return historis ditandai anomali.'],
  ['MR_DUPLICATE_WINDOW_DAYS', '7', 'Rentang hari untuk deteksi duplicate MR (account+SKU sama).'],
  ['SO_NUMBER_PREFIX', 'SO-MR', 'Prefix nomor SO otomatis. Format: <PREFIX>-YYYYMMDD-XXXX.'],
  ['MR_POST_RETURN_ON_COMPLETE', 'TRUE', 'TRUE = MR yang COMPLETED otomatis dicatat ke RETURN_DATA sebagai realisasi return.'],
  ['MR_REQUIRE_PICKUP_BEFORE_SO', 'TRUE', 'TRUE = jadwal penarikan wajib terisi sebelum SO dibuat.'],

  // -- Dashboard & report --------------------------------------------------
  ['DASHBOARD_TREND_MONTHS', '6', 'Jumlah bulan pada chart trend dashboard.'],
  ['TOP_N_DEFAULT', '10', 'Jumlah item pada chart Top Account / Top SKU.'],
  ['MISSED_PO_GRACE_DAYS', '2', 'Toleransi hari sebelum PO MR yang belum diproses dihitung sebagai missed PO.']
];

/** Alias key SETTINGS (kompatibilitas penamaan). */
var SETTING_ALIASES = {
  CUT_OFF_DAYS: 'MR_CUTOFF_DAYS',
  ALLOCATION_RISK_FACTOR: 'RISK_FACTOR'
};

/**
 * Permission matrix — sumber kebenaran RBAC.
 * Backend WAJIB memanggil requirePermission(); frontend hanya memakai daftar
 * ini untuk menyembunyikan aksi yang tidak relevan.
 */
var PERMISSIONS = {
  'dashboard.view':      ['ADMIN', 'MANAGER', 'SALES', 'MR', 'VIEWER'],
  'distribution.view':   ['ADMIN', 'MANAGER', 'SALES', 'VIEWER'],
  'distribution.review': ['ADMIN', 'MANAGER', 'SALES', 'VIEWER'],
  'distribution.plan':   ['ADMIN', 'MANAGER'],
  'distribution.override': ['ADMIN', 'MANAGER'],
  'distribution.approve': ['ADMIN', 'MANAGER'],
  'mr.view':             ['ADMIN', 'MANAGER', 'SALES', 'MR', 'VIEWER'],
  'mr.create':           ['ADMIN', 'MR'],
  'mr.update':           ['ADMIN', 'MR'],
  'mr.validate':         ['ADMIN', 'MANAGER', 'MR'],
  'mr.approve':          ['ADMIN', 'MANAGER', 'SALES'],
  'mr.createSO':         ['ADMIN', 'MANAGER', 'MR'],
  'mr.schedule':         ['ADMIN', 'MR'],
  'mr.complete':         ['ADMIN', 'MANAGER', 'MR'],
  'sop.view':            ['ADMIN', 'MANAGER', 'SALES', 'MR', 'VIEWER'],
  'sop.edit':            ['ADMIN', 'MANAGER'],
  'monitoring.view':     ['ADMIN', 'MANAGER', 'SALES', 'MR', 'VIEWER'],
  'analytics.view':      ['ADMIN', 'MANAGER', 'SALES', 'MR', 'VIEWER'],
  'master.view':         ['ADMIN', 'MANAGER'],
  'master.edit':         ['ADMIN'],
  'audit.view':          ['ADMIN', 'MANAGER'],
  'settings.view':       ['ADMIN'],
  'settings.edit':       ['ADMIN'],
  'report.export':       ['ADMIN', 'MANAGER', 'SALES', 'MR'],
  'setup.run':           ['ADMIN'],
  'user.manage':         ['ADMIN']
};

/** Navigasi sidebar — dipakai server untuk membangun menu sesuai role. */
var NAVIGATION = [
  { id: 'dashboard',    label: 'Overview',              icon: 'grid',      permission: 'dashboard.view' },
  { id: 'distribution', label: 'Distribution Planning', icon: 'target',    permission: 'distribution.view' },
  { id: 'mr',           label: 'MR Administration',     icon: 'clipboard', permission: 'mr.view' },
  { id: 'sop',          label: 'SOP',                   icon: 'book',      permission: 'sop.view' },
  { id: 'monitoring',   label: 'Monitoring',            icon: 'kanban',    permission: 'monitoring.view' },
  { id: 'analytics',    label: 'Analytics',             icon: 'chart',     permission: 'analytics.view' },
  { id: 'master',       label: 'Master Data',           icon: 'database',  permission: 'master.view' },
  { id: 'audit',        label: 'Audit Log',             icon: 'history',   permission: 'audit.view' },
  { id: 'settings',     label: 'Settings',              icon: 'settings',  permission: 'settings.view' }
];

/** Aksi yang dicatat AUDIT_LOG. */
var AUDIT_ACTIONS = {
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  VALIDATE: 'VALIDATE',
  CREATE_SO: 'CREATE_SO',
  CHANGE_ALLOCATION: 'CHANGE_ALLOCATION',
  MANUAL_OVERRIDE: 'MANUAL_OVERRIDE',
  SETUP: 'SETUP',
  EXPORT: 'EXPORT',
  LOGIN_FAILED: 'LOGIN_FAILED'
};

/** Property key pada PropertiesService. */
var PROP_KEYS = {
  SPREADSHEET_ID: 'MRD_SPREADSHEET_ID',
  SETUP_DONE: 'MRD_SETUP_DONE',
  SETUP_AT: 'MRD_SETUP_AT',
  DEMO_DONE: 'MRD_DEMO_DONE',
  SEQ_PREFIX: 'MRD_SEQ_',
  SESSION_PREFIX: 'MRD_SESS_'
};

/** Ambil definisi schema sebuah sheet. */
function getSchema(sheetName) {
  var s = SCHEMA[sheetName];
  if (!s) throw new Error('Schema tidak ditemukan untuk sheet: ' + sheetName);
  return s;
}

/** Cek apakah role memiliki permission tertentu. */
function roleHasPermission(role, permission) {
  if (!permission) return true;
  var allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return allowed.indexOf(role) !== -1;
}

/** Daftar seluruh permission milik sebuah role (dipakai frontend untuk gating UI). */
function permissionsForRole(role) {
  var out = {};
  Object.keys(PERMISSIONS).forEach(function (key) {
    if (PERMISSIONS[key].indexOf(role) !== -1) out[key] = true;
  });
  return out;
}

/** Navigasi yang boleh diakses sebuah role. */
function navigationForRole(role) {
  return NAVIGATION.filter(function (item) {
    return roleHasPermission(role, item.permission);
  }).map(function (item) {
    return { id: item.id, label: item.label, icon: item.icon };
  });
}
