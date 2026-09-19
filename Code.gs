/**
 * PROJECT MR DAIRY
 * ============================================================================
 * Code.gs — Entry point Web App + API Router.
 *
 * Seluruh komunikasi frontend memakai SATU pintu:
 *     google.script.run.api(action, token, payload)
 *
 * Keuntungan:
 *   - Autentikasi, otorisasi, error handling dan audit terpusat.
 *   - Frontend tidak pernah memanggil service/database secara langsung.
 *   - Menambah fitur = menambah satu baris pada tabel route.
 *
 * Bentuk response selalu:
 *   { success:true,  data: ... }
 *   { success:false, error: { code, message, details } }
 * ============================================================================
 */

// ===========================================================================
// WEB APP
// ===========================================================================

function doGet(e) {
  var template = HtmlService.createTemplateFromFile('Index');
  template.bootstrap = JSON.stringify(getBootstrap_());
  return template.evaluate()
    .setTitle(APP.NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=5')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Include HTML partial (pengganti struktur folder pada Apps Script). */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Data awal yang dibutuhkan halaman sebelum login (ringan & non-sensitif). */
function getBootstrap_() {
  var ready = false;
  var status = null;
  try {
    ready = isDatabaseReady();
    status = getSystemStatus();
  } catch (err) {
    console.error('getBootstrap_ gagal: ' + err);
  }
  return {
    ready: ready,
    status: status,
    app: {
      name: APP.NAME,
      subtitle: APP.SUBTITLE,
      version: APP.VERSION,
      objective: APP.OBJECTIVE
    }
  };
}

// ===========================================================================
// API ROUTER
// ===========================================================================

/**
 * Tabel route. Dibangun di dalam fungsi agar bebas dari urutan load file .gs.
 *   public    : true  → tidak butuh token
 *   bootstrap : true  → boleh dijalankan saat database belum ter-setup
 *   permission: string→ dicek melalui Auth.requirePermission()
 */
function getApiRoutes_() {
  return {
    // ---- Auth ------------------------------------------------------------
    'auth.login': {
      public: true,
      handler: function (session, payload) { return Auth.login(payload.username, payload.password); }
    },
    'auth.logout': {
      public: true,
      handler: function (session, payload) { return { loggedOut: Auth.logout(payload.token) }; }
    },
    'auth.session': {
      public: true,
      handler: function (session, payload) {
        var active = Auth.peek(payload.token);
        return active ? Auth.buildSessionPayload(active) : null;
      }
    },
    'auth.changePassword': {
      handler: function (session, payload) {
        return { changed: Auth.changePassword(payload.token, payload.currentPassword, payload.newPassword) };
      }
    },

    // ---- System ----------------------------------------------------------
    'system.status': { public: true, handler: function () { return getSystemStatus(); } },
    'system.setup': {
      bootstrap: true, permission: 'setup.run',
      handler: function (session) {
        var result = setupDatabase();
        AuditService.log({
          user: session.username, action: AUDIT_ACTIONS.SETUP, module: AuditService.MODULES.SETUP,
          recordId: 'DATABASE', description: 'Inisialisasi database dijalankan dari aplikasi.'
        });
        return { message: result.message, status: getSystemStatus() };
      }
    },
    'system.demo': {
      permission: 'setup.run',
      handler: function (session, payload) {
        var result = payload.reset ? resetDemoData() : createDemoData();
        return { message: result.message, skipped: !!result.skipped, status: getSystemStatus() };
      }
    },
    'system.master': {
      handler: function () {
        return {
          master: Lookup.masterOptions(),
          enums: {
            risk: ENUMS.RISK_LEVEL, potential: ENUMS.POTENTIAL_LEVEL, mrStatus: ENUMS.MR_STATUS,
            allocationStatus: ENUMS.ALLOCATION_STATUS, returnReason: ENUMS.RETURN_REASON,
            mrFlow: MR_FLOW
          },
          settings: {
            targetMrPercent: Settings.getNumber('TARGET_MR_PERCENT', 5),
            mrThresholdMedium: Settings.getNumber('MR_THRESHOLD_MEDIUM', 5),
            mrThresholdHigh: Settings.getNumber('MR_THRESHOLD_HIGH', 10),
            pageSize: Settings.getNumber('DEFAULT_PAGE_SIZE', 25),
            analysisMonths: Settings.getNumber('ANALYSIS_PERIOD_MONTHS', 6),
            currencySymbol: Settings.get('CURRENCY_SYMBOL', 'Rp')
          },
          period: (function () {
            var p = AllocationEngine.resolvePeriod({});
            return { from: Utils.toIsoDate(p.from), to: Utils.toIsoDate(p.to), months: p.months };
          })()
        };
      }
    },

    // ---- Dashboard -------------------------------------------------------
    'dashboard.summary': {
      permission: 'dashboard.view',
      handler: function (session, payload) { return DashboardService.getSummary(payload); }
    },

    // ---- Distribution Planning -------------------------------------------
    'distribution.workspace': {
      permission: 'distribution.view',
      handler: function (session, payload) { return DistributionService.getWorkspace(payload); }
    },
    'distribution.review': {
      permission: 'distribution.review',
      handler: function (session, payload) { return DistributionService.getReview(payload); }
    },
    'distribution.planPreview': {
      permission: 'distribution.view',
      handler: function (session, payload) { return DistributionService.getPlanPreview(payload); }
    },
    'distribution.savePlan': {
      permission: 'distribution.plan',
      handler: function (session, payload) { return DistributionService.savePlan(session, payload); }
    },
    'distribution.planStatus': {
      permission: 'distribution.approve',
      handler: function (session, payload) { return DistributionService.changePlanStatus(session, payload); }
    },
    'distribution.submitPlan': {
      permission: 'distribution.plan',
      handler: function (session, payload) {
        payload.status = 'SUBMITTED';
        return DistributionService.changePlanStatus(session, payload);
      }
    },
    'distribution.plans': {
      permission: 'distribution.view',
      handler: function (session, payload) { return DistributionService.listPlans(payload); }
    },
    'distribution.clusters': {
      permission: 'distribution.view',
      handler: function (session, payload) { return DistributionService.getClusters(payload); }
    },
    'distribution.applyCluster': {
      permission: 'distribution.plan',
      handler: function (session, payload) { return DistributionService.applyCluster(session, payload); }
    },

    // ---- MR Administration ------------------------------------------------
    'mr.list': { permission: 'mr.view', handler: function (s, p) { return MRService.listMR(p); } },
    'mr.detail': { permission: 'mr.view', handler: function (s, p) { return MRService.getDetail(p); } },
    'mr.formOptions': { permission: 'mr.view', handler: function () { return MRService.getFormOptions(); } },
    'mr.create': { permission: 'mr.create', handler: function (s, p) { return MRService.createMR(s, p); } },
    'mr.update': { permission: 'mr.update', handler: function (s, p) { return MRService.updateMR(s, p); } },
    'mr.validate': { permission: 'mr.validate', handler: function (s, p) { return MRService.validateMR(s, p); } },
    'mr.submit': { permission: 'mr.update', handler: function (s, p) { return MRService.submitForApproval(s, p); } },
    'mr.approve': { permission: 'mr.approve', handler: function (s, p) { return MRService.approveMR(s, p); } },
    'mr.reject': { permission: 'mr.approve', handler: function (s, p) { return MRService.rejectMR(s, p); } },
    'mr.createSO': { permission: 'mr.createSO', handler: function (s, p) { return MRService.createSO(s, p); } },
    'mr.schedule': { permission: 'mr.schedule', handler: function (s, p) { return MRService.schedulePickup(s, p); } },
    'mr.complete': { permission: 'mr.complete', handler: function (s, p) { return MRService.completeMR(s, p); } },

    // ---- Monitoring -------------------------------------------------------
    'monitoring.board': {
      permission: 'monitoring.view',
      handler: function (s, p) { return MRService.getMonitoringBoard(p); }
    },

    // ---- SOP --------------------------------------------------------------
    'sop.workflow': { permission: 'sop.view', handler: function () { return SOPService.getWorkflow(); } },
    'sop.pickup': { permission: 'sop.view', handler: function (s, p) { return SOPService.getPickupSchedule(p); } },
    'sop.cutoff': { permission: 'sop.view', handler: function (s, p) { return SOPService.getCutoffCommitments(p); } },
    'sop.bap': { permission: 'sop.view', handler: function (s, p) { return SOPService.getBapOverview(p); } },
    'sop.updateSop': { permission: 'sop.edit', handler: function (s, p) { return SOPService.updateSop(s, p); } },
    'sop.updateRule': { permission: 'sop.edit', handler: function (s, p) { return SOPService.updateRule(s, p); } },

    // ---- Analytics & Report ----------------------------------------------
    'analytics.overview': {
      permission: 'analytics.view',
      handler: function (s, p) { return AnalyticsService.getAnalytics(p); }
    },
    'analytics.drill': {
      permission: 'analytics.view',
      handler: function (s, p) { return AnalyticsService.drill(p); }
    },
    'analytics.reports': {
      permission: 'analytics.view',
      handler: function () { return { reports: AnalyticsService.getReportCatalog() }; }
    },
    'analytics.report': {
      permission: 'analytics.view',
      handler: function (s, p) {
        var report = AnalyticsService.buildReport(p);
        var paged = Utils.paginate(report.rows, p.page, p.pageSize || 25);
        return { headers: report.headers, rows: paged.rows, meta: paged.meta, filename: report.filename };
      }
    },
    'analytics.export': {
      permission: 'report.export',
      handler: function (s, p) { return AnalyticsService.exportCsv(s, p); }
    },

    // ---- Master Data & Settings -------------------------------------------
    'master.accounts': { permission: 'master.view', handler: function (s, p) { return MasterService.listAccounts(p); } },
    'master.saveAccount': { permission: 'master.edit', handler: function (s, p) { return MasterService.saveAccount(s, p); } },
    'master.toggleAccount': { permission: 'master.edit', handler: function (s, p) { return MasterService.deactivateAccount(s, p); } },
    'master.skus': { permission: 'master.view', handler: function (s, p) { return MasterService.listSkus(p); } },
    'master.saveSku': { permission: 'master.edit', handler: function (s, p) { return MasterService.saveSku(s, p); } },
    'master.toggleSku': { permission: 'master.edit', handler: function (s, p) { return MasterService.deactivateSku(s, p); } },
    'master.users': { permission: 'user.manage', handler: function (s, p) { return MasterService.listUsers(p); } },
    'master.saveUser': { permission: 'user.manage', handler: function (s, p) { return MasterService.saveUser(s, p); } },
    'settings.list': { permission: 'settings.view', handler: function () { return MasterService.listSettings(); } },
    'settings.update': { permission: 'settings.edit', handler: function (s, p) { return MasterService.updateSettings(s, p); } },
    'settings.reset': { permission: 'settings.edit', handler: function (s, p) { return MasterService.resetSetting(s, p); } },

    // ---- Audit ------------------------------------------------------------
    'audit.list': {
      permission: 'audit.view',
      handler: function (s, p) { return AuditService.search(p.filters, p); }
    }
  };
}

/**
 * Satu-satunya pintu masuk API dari frontend.
 * @param {string} action  nama route, mis. 'dashboard.summary'
 * @param {string} token   token sesi (null untuk route publik)
 * @param {Object} payload parameter
 */
function api(action, token, payload) {
  return Utils.guard(action, function () {
    var routes = getApiRoutes_();
    var route = routes[action];
    if (!route) {
      throwError('UNKNOWN_ACTION', 'Aksi "' + action + '" tidak dikenali oleh server.');
    }
    var data = payload || {};
    var session = null;

    if (route.public) {
      // Route publik: login, status sistem, cek sesi.
      if (action === 'auth.session' || action === 'auth.logout') data.token = data.token || token;
    } else if (route.bootstrap && !isDatabaseReady()) {
      // First run: database belum ada sehingga belum ada user untuk diautentikasi.
      // Aman karena setupDatabase() bersifat idempotent dan tidak menghapus data.
      session = { userId: 'BOOTSTRAP', username: 'BOOTSTRAP', name: 'System Bootstrap', role: ROLES.ADMIN };
    } else {
      session = Auth.requirePermission(token, route.permission);
    }

    return Utils.ok(route.handler(session, data));
  });
}

/**
 * Daftar action yang tersedia (membantu debugging dari Apps Script editor).
 */
function listApiActions() {
  var actions = Object.keys(getApiRoutes_()).sort();
  console.log(actions.join('\n'));
  return actions;
}

/**
 * Smoke test cepat dari Apps Script editor:
 * login demo → ambil dashboard → tampilkan ringkasan di Execution log.
 */
function smokeTest() {
  var login = api('auth.login', null, { username: 'admin', password: 'admin123' });
  if (!login.success) {
    console.error('Login gagal: ' + JSON.stringify(login.error));
    return login;
  }
  var token = login.data.token;
  var checks = ['dashboard.summary', 'distribution.workspace', 'mr.list', 'monitoring.board',
    'sop.workflow', 'analytics.overview'];
  var report = checks.map(function (action) {
    var res = api(action, token, {});
    return action + ' → ' + (res.success ? 'OK' : 'GAGAL: ' + res.error.message);
  });
  console.log(report.join('\n'));
  api('auth.logout', token, { token: token });
  return report;
}
