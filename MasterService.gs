/**
 * PROJECT MR DAIRY
 * ============================================================================
 * MasterService.gs — Master Data (Account, SKU, User) dan Settings.
 *
 * Seluruh fungsi di sini bersifat sensitif: pemanggilnya (Code.gs) wajib
 * melewati requirePermission() terlebih dahulu.
 * ============================================================================
 */

var MasterService = (function () {

  // -------------------------------------------------------------------------
  // ACCOUNT
  // -------------------------------------------------------------------------

  function listAccounts(params) {
    var p = params || {};
    var f = p.filters || {};
    var rows = AccountRepo.all().filter(function (row) {
      if (f.status && Utils.upper(row.STATUS) !== Utils.upper(f.status)) return false;
      if (f.region && Utils.upper(row.REGION) !== Utils.upper(f.region)) return false;
      if (f.channel && Utils.upper(row.CHANNEL) !== Utils.upper(f.channel)) return false;
      if (f.cluster && Utils.upper(row.CLUSTER) !== Utils.upper(f.cluster)) return false;
      if (f.q) {
        var hay = Utils.normalize([row.ACCOUNT_CODE, row.ACCOUNT_NAME, row.CITY, row.AREA, row.REGION].join(' '));
        if (hay.indexOf(Utils.normalize(f.q)) === -1) return false;
      }
      return true;
    }).map(function (row) { return toDto(SHEETS.ACCOUNT_MASTER, row); });

    var sorted = Utils.sortBy(rows, [{ key: 'ACCOUNT_CODE', dir: 'asc', type: 'text' }]);
    var paged = Utils.paginate(sorted, p.page, p.pageSize || Settings.getNumber('DEFAULT_PAGE_SIZE', 25));
    return { rows: paged.rows, meta: paged.meta, options: AccountRepo.filterOptions() };
  }

  function saveAccount(session, payload) {
    var code = Utils.str(payload.ACCOUNT_CODE);
    var name = Utils.str(payload.ACCOUNT_NAME);
    if (!code) throwError('VALIDATION_ERROR', 'Account Code wajib diisi.');
    if (!name) throwError('VALIDATION_ERROR', 'Account Name wajib diisi.');
    var potential = Utils.upper(payload.POTENTIAL_LEVEL) || 'MEDIUM';
    if (ENUMS.POTENTIAL_LEVEL.indexOf(potential) === -1) {
      throwError('VALIDATION_ERROR', 'Potential Level harus HIGH, MEDIUM atau LOW.');
    }

    var existingByCode = AccountRepo.byCode(code);
    if (payload.ACCOUNT_ID) {
      var current = AccountRepo.byId(payload.ACCOUNT_ID);
      if (!current) throwError('NOT_FOUND', 'Account tidak ditemukan.');
      if (existingByCode && existingByCode.ACCOUNT_ID !== current.ACCOUNT_ID) {
        throwError('DUPLICATE', 'Account Code ' + code + ' sudah dipakai account lain.');
      }
      var patch = {
        ACCOUNT_CODE: code, ACCOUNT_NAME: name, CHANNEL: Utils.str(payload.CHANNEL),
        REGION: Utils.str(payload.REGION), AREA: Utils.str(payload.AREA), CITY: Utils.str(payload.CITY),
        CLUSTER: Utils.upper(payload.CLUSTER) || potential, POTENTIAL_LEVEL: potential,
        STATUS: Utils.upper(payload.STATUS) || 'ACTIVE'
      };
      var changes = AuditService.diff(current, patch, Object.keys(patch));
      AccountRepo.update(current.ACCOUNT_ID, patch);
      AuditService.log({
        user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.MASTER,
        recordId: current.ACCOUNT_ID, description: 'Update account ' + name + ': ' + AuditService.describeChanges(changes),
        oldValue: changes.map(function (c) { return c.field + '=' + c.from; }).join('; '),
        newValue: changes.map(function (c) { return c.field + '=' + c.to; }).join('; ')
      });
      return { account: toDto(SHEETS.ACCOUNT_MASTER, AccountRepo.byId(current.ACCOUNT_ID)), created: false };
    }

    if (existingByCode) throwError('DUPLICATE', 'Account Code ' + code + ' sudah terdaftar.');
    var created = AccountRepo.create(payload);
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.CREATE, module: AuditService.MODULES.MASTER,
      recordId: created.ACCOUNT_ID, description: 'Account baru dibuat: ' + name + ' (' + code + ')',
      newValue: 'POTENTIAL=' + potential
    });
    return { account: toDto(SHEETS.ACCOUNT_MASTER, AccountRepo.byId(created.ACCOUNT_ID)), created: true };
  }

  /** Nonaktifkan account (soft delete agar histori transaksi tetap utuh). */
  function deactivateAccount(session, payload) {
    var account = AccountRepo.byId(payload.accountId);
    if (!account) throwError('NOT_FOUND', 'Account tidak ditemukan.');
    var status = Utils.upper(account.STATUS) === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    AccountRepo.update(account.ACCOUNT_ID, { STATUS: status });
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.MASTER,
      recordId: account.ACCOUNT_ID, description: 'Status account ' + account.ACCOUNT_NAME + ' diubah menjadi ' + status,
      oldValue: 'STATUS=' + account.STATUS, newValue: 'STATUS=' + status
    });
    return { accountId: account.ACCOUNT_ID, status: status };
  }

  // -------------------------------------------------------------------------
  // SKU
  // -------------------------------------------------------------------------

  function listSkus(params) {
    var p = params || {};
    var f = p.filters || {};
    var rows = SkuRepo.all().filter(function (row) {
      if (f.status && Utils.upper(row.STATUS) !== Utils.upper(f.status)) return false;
      if (f.category && Utils.upper(row.CATEGORY) !== Utils.upper(f.category)) return false;
      if (f.brand && Utils.upper(row.BRAND) !== Utils.upper(f.brand)) return false;
      if (f.q) {
        var hay = Utils.normalize([row.SKU_CODE, row.SKU_NAME, row.CATEGORY, row.BRAND].join(' '));
        if (hay.indexOf(Utils.normalize(f.q)) === -1) return false;
      }
      return true;
    }).map(function (row) { return toDto(SHEETS.SKU_MASTER, row); });
    var sorted = Utils.sortBy(rows, [{ key: 'SKU_CODE', dir: 'asc', type: 'text' }]);
    var paged = Utils.paginate(sorted, p.page, p.pageSize || Settings.getNumber('DEFAULT_PAGE_SIZE', 25));
    return { rows: paged.rows, meta: paged.meta, options: SkuRepo.filterOptions() };
  }

  function saveSku(session, payload) {
    var code = Utils.str(payload.SKU_CODE);
    var name = Utils.str(payload.SKU_NAME);
    if (!code) throwError('VALIDATION_ERROR', 'SKU Code wajib diisi.');
    if (!name) throwError('VALIDATION_ERROR', 'SKU Name wajib diisi.');
    var shelfLife = Utils.num(payload.SHELF_LIFE_DAYS, 0);
    if (shelfLife < 0) throwError('VALIDATION_ERROR', 'Shelf life tidak boleh negatif.');

    var duplicate = DB.findOne(SHEETS.SKU_MASTER, function (r) { return Utils.upper(r.SKU_CODE) === Utils.upper(code); });
    if (payload.SKU_ID) {
      var current = SkuRepo.byId(payload.SKU_ID);
      if (!current) throwError('NOT_FOUND', 'SKU tidak ditemukan.');
      if (duplicate && duplicate.SKU_ID !== current.SKU_ID) {
        throwError('DUPLICATE', 'SKU Code ' + code + ' sudah dipakai SKU lain.');
      }
      var patch = {
        SKU_CODE: code, SKU_NAME: name, CATEGORY: Utils.str(payload.CATEGORY),
        BRAND: Utils.str(payload.BRAND), UNIT: Utils.str(payload.UNIT) || 'CTN',
        SHELF_LIFE_DAYS: shelfLife, STATUS: Utils.upper(payload.STATUS) || 'ACTIVE'
      };
      var changes = AuditService.diff(current, patch, Object.keys(patch));
      SkuRepo.update(current.SKU_ID, patch);
      AuditService.log({
        user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.MASTER,
        recordId: current.SKU_ID, description: 'Update SKU ' + name + ': ' + AuditService.describeChanges(changes),
        oldValue: changes.map(function (c) { return c.field + '=' + c.from; }).join('; '),
        newValue: changes.map(function (c) { return c.field + '=' + c.to; }).join('; ')
      });
      return { sku: toDto(SHEETS.SKU_MASTER, SkuRepo.byId(current.SKU_ID)), created: false };
    }

    if (duplicate) throwError('DUPLICATE', 'SKU Code ' + code + ' sudah terdaftar.');
    var created = SkuRepo.create(payload);
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.CREATE, module: AuditService.MODULES.MASTER,
      recordId: created.SKU_ID, description: 'SKU baru dibuat: ' + name + ' (' + code + ')'
    });
    return { sku: toDto(SHEETS.SKU_MASTER, SkuRepo.byId(created.SKU_ID)), created: true };
  }

  function deactivateSku(session, payload) {
    var sku = SkuRepo.byId(payload.skuId);
    if (!sku) throwError('NOT_FOUND', 'SKU tidak ditemukan.');
    var status = Utils.upper(sku.STATUS) === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    SkuRepo.update(sku.SKU_ID, { STATUS: status });
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.MASTER,
      recordId: sku.SKU_ID, description: 'Status SKU ' + sku.SKU_NAME + ' diubah menjadi ' + status,
      oldValue: 'STATUS=' + sku.STATUS, newValue: 'STATUS=' + status
    });
    return { skuId: sku.SKU_ID, status: status };
  }

  // -------------------------------------------------------------------------
  // USER
  // -------------------------------------------------------------------------

  function listUsers(params) {
    var p = params || {};
    var rows = UserRepo.all().map(function (row) {
      var profile = UserRepo.publicProfile(row);
      profile.CREATED_AT = Utils.toIsoDateTime(row.CREATED_AT);
      profile.UPDATED_AT = Utils.toIsoDateTime(row.UPDATED_AT);
      return profile;                                   // PASSWORD_HASH tidak pernah dikirim
    }).filter(function (row) {
      var f = p.filters || {};
      if (f.role && row.ROLE !== Utils.upper(f.role)) return false;
      if (f.q) {
        var hay = Utils.normalize([row.USERNAME, row.NAME, row.EMAIL].join(' '));
        if (hay.indexOf(Utils.normalize(f.q)) === -1) return false;
      }
      return true;
    });
    return { rows: Utils.sortBy(rows, [{ key: 'USERNAME', dir: 'asc', type: 'text' }]), roles: ENUMS.ROLE };
  }

  function saveUser(session, payload) {
    var username = Utils.str(payload.USERNAME);
    var role = Utils.upper(payload.ROLE);
    if (!username) throwError('VALIDATION_ERROR', 'Username wajib diisi.');
    if (ENUMS.ROLE.indexOf(role) === -1) throwError('VALIDATION_ERROR', 'Role tidak dikenali.');
    if (!Utils.str(payload.NAME)) throwError('VALIDATION_ERROR', 'Nama wajib diisi.');

    var byUsername = UserRepo.findByUsername(username);
    if (payload.USER_ID) {
      var current = UserRepo.findById(payload.USER_ID);
      if (!current) throwError('NOT_FOUND', 'User tidak ditemukan.');
      if (byUsername && byUsername.USER_ID !== current.USER_ID) {
        throwError('DUPLICATE', 'Username ' + username + ' sudah dipakai.');
      }
      if (Utils.upper(current.ROLE) === ROLES.ADMIN && role !== ROLES.ADMIN) {
        var admins = UserRepo.all().filter(function (u) {
          return Utils.upper(u.ROLE) === ROLES.ADMIN && Utils.upper(u.STATUS) === 'ACTIVE';
        });
        if (admins.length <= 1) throwError('VALIDATION_ERROR', 'Minimal harus ada satu ADMIN aktif.');
      }
      var patch = {
        USERNAME: username, NAME: Utils.str(payload.NAME), ROLE: role,
        EMAIL: Utils.str(payload.EMAIL), STATUS: Utils.upper(payload.STATUS) || 'ACTIVE'
      };
      if (Utils.str(payload.PASSWORD)) {
        if (Utils.str(payload.PASSWORD).length < 6) {
          throwError('VALIDATION_ERROR', 'Password minimal 6 karakter.');
        }
        patch.PASSWORD_HASH = Auth.hashPassword(payload.PASSWORD);
      }
      var changes = AuditService.diff(current, patch, ['USERNAME', 'NAME', 'ROLE', 'EMAIL', 'STATUS']);
      UserRepo.update(current.USER_ID, patch);
      AuditService.log({
        user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.MASTER,
        recordId: current.USER_ID,
        description: 'Update user ' + username + ': ' + AuditService.describeChanges(changes)
          + (patch.PASSWORD_HASH ? ' (password direset)' : ''),
        oldValue: changes.map(function (c) { return c.field + '=' + c.from; }).join('; '),
        newValue: changes.map(function (c) { return c.field + '=' + c.to; }).join('; ')
      });
      return { user: UserRepo.publicProfile(UserRepo.findById(current.USER_ID)), created: false };
    }

    if (byUsername) throwError('DUPLICATE', 'Username ' + username + ' sudah terdaftar.');
    if (Utils.str(payload.PASSWORD).length < 6) {
      throwError('VALIDATION_ERROR', 'Password minimal 6 karakter.');
    }
    var created = UserRepo.create({
      USERNAME: username, PASSWORD_HASH: Auth.hashPassword(payload.PASSWORD), NAME: payload.NAME,
      ROLE: role, EMAIL: payload.EMAIL, STATUS: Utils.upper(payload.STATUS) || 'ACTIVE'
    });
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.CREATE, module: AuditService.MODULES.MASTER,
      recordId: created.USER_ID, description: 'User baru dibuat: ' + username + ' dengan role ' + role
    });
    return { user: UserRepo.publicProfile(UserRepo.findById(created.USER_ID)), created: true };
  }

  // -------------------------------------------------------------------------
  // SETTINGS
  // -------------------------------------------------------------------------

  function listSettings() {
    var stored = DB.read(SHEETS.SETTINGS);
    var descriptions = {};
    DEFAULT_SETTINGS.forEach(function (item) { descriptions[item[0]] = item[2]; });
    var defaults = {};
    DEFAULT_SETTINGS.forEach(function (item) { defaults[item[0]] = item[1]; });

    var rows = stored.map(function (row) {
      var key = Utils.upper(row.KEY);
      return {
        KEY: key,
        VALUE: Utils.str(row.VALUE),
        DESCRIPTION: Utils.str(row.DESCRIPTION) || descriptions[key] || '',
        DEFAULT_VALUE: defaults[key] === undefined ? '' : defaults[key],
        group: key.split('_')[0],
        isDefault: defaults[key] !== undefined && Utils.str(row.VALUE) === String(defaults[key])
      };
    });
    return { rows: Utils.sortBy(rows, [{ key: 'KEY', dir: 'asc', type: 'text' }]) };
  }

  /** Validasi tipe nilai setting berdasarkan bentuk nilai default-nya. */
  function validateSettingValue(key, value) {
    var def = null;
    for (var i = 0; i < DEFAULT_SETTINGS.length; i++) {
      if (DEFAULT_SETTINGS[i][0] === key) { def = DEFAULT_SETTINGS[i][1]; break; }
    }
    if (def === null) return Utils.str(value);
    var isBool = ['TRUE', 'FALSE'].indexOf(Utils.upper(def)) !== -1;
    var isNumeric = !isBool && def !== '' && !isNaN(Number(def));
    if (isBool) {
      var upper = Utils.upper(value);
      if (['TRUE', 'FALSE'].indexOf(upper) === -1) {
        throwError('VALIDATION_ERROR', key + ' harus bernilai TRUE atau FALSE.');
      }
      return upper;
    }
    if (isNumeric) {
      if (Utils.str(value) === '' || isNaN(Number(value))) {
        throwError('VALIDATION_ERROR', key + ' harus berupa angka.');
      }
      return Utils.str(value);
    }
    return Utils.str(value);
  }

  function updateSettings(session, payload) {
    var items = [].concat((payload && payload.items) || []);
    if (!items.length) throwError('VALIDATION_ERROR', 'Tidak ada konfigurasi yang diubah.');
    var audits = [];
    items.forEach(function (item) {
      var key = Utils.upper(item.key);
      if (!key) return;
      var value = validateSettingValue(key, item.value);
      var oldValue = Settings.get(key, '');
      if (String(oldValue) === String(value)) return;
      Settings.set(key, value);
      audits.push({
        user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.SETTINGS,
        recordId: key, description: 'Konfigurasi ' + key + ' diubah',
        oldValue: String(oldValue), newValue: String(value)
      });
    });
    if (audits.length) AuditService.logBatch(audits);
    DB.invalidateAll();
    Settings.reload();
    return { updated: audits.length };
  }

  /** Kembalikan satu setting ke nilai default pabrik. */
  function resetSetting(session, payload) {
    var key = Utils.upper(payload.key);
    var def = null;
    DEFAULT_SETTINGS.forEach(function (item) { if (item[0] === key) def = item[1]; });
    if (def === null) throwError('NOT_FOUND', 'Konfigurasi ' + key + ' tidak memiliki nilai default.');
    var oldValue = Settings.get(key, '');
    Settings.set(key, def);
    Settings.reload();
    DB.invalidateAll();
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.SETTINGS,
      recordId: key, description: 'Konfigurasi ' + key + ' dikembalikan ke default',
      oldValue: String(oldValue), newValue: String(def)
    });
    return { key: key, value: def };
  }

  return {
    listAccounts: listAccounts,
    saveAccount: saveAccount,
    deactivateAccount: deactivateAccount,
    listSkus: listSkus,
    saveSku: saveSku,
    deactivateSku: deactivateSku,
    listUsers: listUsers,
    saveUser: saveUser,
    listSettings: listSettings,
    updateSettings: updateSettings,
    resetSetting: resetSetting
  };
})();
