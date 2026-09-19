/**
 * PROJECT MR DAIRY
 * ============================================================================
 * MRService.gs — Automation Market Return Administration.
 *
 * WORKFLOW (PRD bagian K):
 *   INPUT ADMIN → VALIDASI DATA → APPROVAL SALES → CREATE SO
 *               → PICKUP SCHEDULED → COMPLETED
 *
 * Setiap transisi status: dicek otorisasinya, divalidasi, dan dicatat ke
 * AUDIT_LOG. Tidak ada transisi yang boleh dilakukan langsung dari frontend.
 * ============================================================================
 */

var MRService = (function () {

  /** Transisi status yang diizinkan. */
  var TRANSITIONS = {
    INPUT: ['VALIDATED', 'REJECTED'],
    VALIDATED: ['WAITING_APPROVAL', 'INPUT', 'REJECTED'],
    WAITING_APPROVAL: ['APPROVED', 'REJECTED'],
    APPROVED: ['SO_CREATED', 'REJECTED'],
    SO_CREATED: ['PICKUP_SCHEDULED'],
    PICKUP_SCHEDULED: ['COMPLETED'],
    COMPLETED: [],
    REJECTED: []
  };

  function assertTransition(current, next) {
    var from = Utils.upper(current) || 'INPUT';
    var allowed = TRANSITIONS[from] || [];
    if (allowed.indexOf(Utils.upper(next)) === -1) {
      throwError('INVALID_STATE',
        'Status MR saat ini ' + from + ' sehingga tidak dapat diubah menjadi ' + next + '.');
    }
  }

  function getMrOrFail(mrId) {
    var mr = MrRepo.byId(mrId);
    if (!mr) throwError('NOT_FOUND', 'Dokumen MR ' + mrId + ' tidak ditemukan.');
    return mr;
  }

  // -------------------------------------------------------------------------
  // STEP 1 — INPUT ADMIN
  // -------------------------------------------------------------------------

  /** Validasi field wajib form input MR. */
  function validateInput(payload) {
    var errors = [];
    if (!Utils.str(payload.accountId)) errors.push('Account wajib dipilih.');
    if (!Utils.str(payload.skuId)) errors.push('SKU wajib dipilih.');
    var qty = Utils.num(payload.returnQty, 0);
    if (!(qty > 0)) errors.push('Return Qty harus lebih besar dari 0.');
    if (!Utils.parseDate(payload.mrDate)) errors.push('Tanggal MR wajib diisi dengan format yang benar.');
    if (payload.pickupDate && !Utils.parseDate(payload.pickupDate)) errors.push('Format Pickup Date tidak valid.');
    if (payload.expiryDate && !Utils.parseDate(payload.expiryDate)) errors.push('Format Expiry Date tidak valid.');
    if (Utils.str(payload.returnReason) && ENUMS.RETURN_REASON.indexOf(Utils.upper(payload.returnReason)) === -1) {
      errors.push('Alasan return tidak dikenali.');
    }
    if (errors.length) {
      throwError('VALIDATION_ERROR', errors.join(' '), { fields: errors });
    }
  }

  /** Estimasi nilai return dari histori harga jual SKU pada account tersebut. */
  function estimateReturnValue(accountId, skuId, qty) {
    var returns = ReturnRepo.all().filter(function (r) {
      return r.SKU_ID === skuId && Utils.num(r.RETURN_QTY) > 0;
    });
    var sales = SalesRepo.all().filter(function (r) {
      return r.SKU_ID === skuId && Utils.num(r.SELL_OUT_QTY) > 0;
    });
    var unitPrice = 0;
    if (returns.length) {
      unitPrice = Utils.safeDiv(Utils.sumBy(returns, 'RETURN_VALUE'), Utils.sumBy(returns, 'RETURN_QTY'));
    }
    if (!unitPrice && sales.length) {
      unitPrice = Utils.safeDiv(Utils.sumBy(sales, 'SALES_VALUE'), Utils.sumBy(sales, 'SELL_OUT_QTY'));
    }
    return Math.round(Utils.num(qty) * unitPrice);
  }

  /** Buat dokumen MR baru (STEP 1). */
  function createMR(session, payload) {
    validateInput(payload);
    var account = AccountRepo.byId(payload.accountId);
    if (!account) throwError('VALIDATION_ERROR', 'Account tidak ditemukan pada master data.');
    var sku = SkuRepo.byId(payload.skuId);
    if (!sku) throwError('VALIDATION_ERROR', 'SKU tidak ditemukan pada master data.');

    var mrDate = Utils.parseDate(payload.mrDate);
    var qty = Utils.num(payload.returnQty);
    var returnValue = Utils.num(payload.returnValue, 0) || estimateReturnValue(payload.accountId, payload.skuId, qty);
    var expiryDate = Utils.parseDate(payload.expiryDate) || '';
    var cutoffDate = Utils.addDays(mrDate, Settings.getNumber('MR_CUTOFF_DAYS', 7));
    var bapRequired = evaluateBapRequirement_(mrDate, expiryDate, returnValue);

    var row = {
      MR_DATE: mrDate,
      ACCOUNT_ID: payload.accountId,
      SKU_ID: payload.skuId,
      RETURN_QTY: qty,
      RETURN_VALUE: returnValue,
      PICKUP_DATE: Utils.parseDate(payload.pickupDate) || '',
      CUTOFF_DATE: cutoffDate,
      BAP_REQUIRED: bapRequired,
      BAP_STATUS: bapRequired ? 'PENDING' : 'NOT_REQUIRED',
      SALES_APPROVAL: 'PENDING',
      SO_NUMBER: '',
      SO_STATUS: 'NOT_CREATED',
      MR_STATUS: 'INPUT',
      REMARK: Utils.str(payload.remark),
      CREATED_BY: session.username,
      CREATED_AT: new Date(),
      UPDATED_AT: new Date(),
      RETURN_REASON: Utils.upper(payload.returnReason) || 'OTHER',
      EXPIRY_DATE: expiryDate,
      VALIDATION_STATUS: 'NOT_VALIDATED',
      VALIDATION_NOTES: '',
      PIC: Utils.str(payload.pic) || session.name,
      APPROVED_BY: '', APPROVED_AT: '', REJECT_REASON: '', SO_DATE: '', COMPLETED_AT: ''
    };

    var created = MrRepo.insert(row);
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.CREATE, module: AuditService.MODULES.MR,
      recordId: created.MR_ID,
      description: 'Input MR untuk ' + account.ACCOUNT_NAME + ' - ' + sku.SKU_NAME
        + ' sebanyak ' + qty + ' ' + (sku.UNIT || 'unit'),
      newValue: 'QTY=' + qty + '; VALUE=' + returnValue + '; CUTOFF=' + Utils.toIsoDate(cutoffDate)
    });

    // Validasi otomatis langsung setelah input agar admin cepat mendapat feedback
    var validation = runValidation(created.MR_ID, { autoPersist: true, session: session });
    return { mr: presentMr(MrRepo.byId(created.MR_ID)), validation: validation };
  }

  /** Update dokumen MR (hanya sebelum approval). */
  function updateMR(session, payload) {
    var mr = getMrOrFail(payload.mrId);
    if (['INPUT', 'VALIDATED'].indexOf(Utils.upper(mr.MR_STATUS)) === -1) {
      throwError('INVALID_STATE', 'MR yang sudah masuk tahap approval tidak dapat diubah.');
    }
    validateInput({
      accountId: payload.accountId || mr.ACCOUNT_ID,
      skuId: payload.skuId || mr.SKU_ID,
      returnQty: payload.returnQty === undefined ? mr.RETURN_QTY : payload.returnQty,
      mrDate: payload.mrDate || mr.MR_DATE,
      pickupDate: payload.pickupDate,
      expiryDate: payload.expiryDate,
      returnReason: payload.returnReason
    });

    var patch = {};
    if (payload.accountId) patch.ACCOUNT_ID = payload.accountId;
    if (payload.skuId) patch.SKU_ID = payload.skuId;
    if (payload.returnQty !== undefined) patch.RETURN_QTY = Utils.num(payload.returnQty);
    if (payload.mrDate) {
      patch.MR_DATE = Utils.parseDate(payload.mrDate);
      patch.CUTOFF_DATE = Utils.addDays(patch.MR_DATE, Settings.getNumber('MR_CUTOFF_DAYS', 7));
    }
    if (payload.pickupDate !== undefined) patch.PICKUP_DATE = Utils.parseDate(payload.pickupDate) || '';
    if (payload.expiryDate !== undefined) patch.EXPIRY_DATE = Utils.parseDate(payload.expiryDate) || '';
    if (payload.returnReason) patch.RETURN_REASON = Utils.upper(payload.returnReason);
    if (payload.remark !== undefined) patch.REMARK = Utils.str(payload.remark);
    if (payload.pic !== undefined) patch.PIC = Utils.str(payload.pic);
    if (payload.returnValue !== undefined) patch.RETURN_VALUE = Utils.num(payload.returnValue);

    var mrDate = patch.MR_DATE || mr.MR_DATE;
    var expiry = patch.EXPIRY_DATE !== undefined ? patch.EXPIRY_DATE : mr.EXPIRY_DATE;
    var value = patch.RETURN_VALUE !== undefined ? patch.RETURN_VALUE : mr.RETURN_VALUE;
    var bapRequired = evaluateBapRequirement_(mrDate, expiry, value);
    patch.BAP_REQUIRED = bapRequired;
    if (!bapRequired) patch.BAP_STATUS = 'NOT_REQUIRED';
    else if (Utils.upper(mr.BAP_STATUS) === 'NOT_REQUIRED') patch.BAP_STATUS = 'PENDING';

    var changes = AuditService.diff(mr, patch, Object.keys(patch));
    MrRepo.update(mr.MR_ID, patch);
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.MR,
      recordId: mr.MR_ID, description: 'Perubahan data MR: ' + AuditService.describeChanges(changes),
      oldValue: changes.map(function (c) { return c.field + '=' + c.from; }).join('; '),
      newValue: changes.map(function (c) { return c.field + '=' + c.to; }).join('; ')
    });

    var validation = runValidation(mr.MR_ID, { autoPersist: true, session: session });
    return { mr: presentMr(MrRepo.byId(mr.MR_ID)), validation: validation };
  }

  // -------------------------------------------------------------------------
  // STEP 2 — VALIDASI DATA
  // -------------------------------------------------------------------------

  function check(code, label, status, message) {
    return { code: code, label: label, status: status, message: message || '' };
  }

  /**
   * Jalankan seluruh pemeriksaan otomatis terhadap satu dokumen MR.
   * @return {{status:string, checks:Array, notes:string}}
   */
  function evaluateChecks(mr) {
    var checks = [];
    var account = AccountRepo.byId(mr.ACCOUNT_ID);
    var sku = SkuRepo.byId(mr.SKU_ID);
    var today = Utils.today();

    // Account
    if (!account) checks.push(check('ACCOUNT', 'Account valid', 'ERROR', 'Account tidak ditemukan pada master data.'));
    else if (Utils.upper(account.STATUS) !== 'ACTIVE') checks.push(check('ACCOUNT', 'Account valid', 'ERROR', 'Account berstatus tidak aktif.'));
    else checks.push(check('ACCOUNT', 'Account valid', 'PASS', account.ACCOUNT_NAME));

    // SKU
    if (!sku) checks.push(check('SKU', 'SKU valid', 'ERROR', 'SKU tidak ditemukan pada master data.'));
    else if (Utils.upper(sku.STATUS) !== 'ACTIVE') checks.push(check('SKU', 'SKU valid', 'ERROR', 'SKU berstatus tidak aktif.'));
    else checks.push(check('SKU', 'SKU valid', 'PASS', sku.SKU_NAME));

    // Qty
    var qty = Utils.num(mr.RETURN_QTY);
    if (!(qty > 0)) checks.push(check('QTY', 'Return Qty', 'ERROR', 'Qty harus lebih besar dari 0.'));
    else checks.push(check('QTY', 'Return Qty', 'PASS', qty + ' ' + (sku ? sku.UNIT : '')));

    // Anomali qty terhadap histori
    var multiplier = Settings.getNumber('MR_QTY_ANOMALY_MULTIPLIER', 3);
    var history = ReturnRepo.all().filter(function (r) {
      return r.ACCOUNT_ID === mr.ACCOUNT_ID && r.SKU_ID === mr.SKU_ID;
    });
    if (history.length >= 2) {
      var avgReturn = Utils.safeDiv(Utils.sumBy(history, 'RETURN_QTY'), history.length);
      if (avgReturn > 0 && qty > avgReturn * multiplier) {
        checks.push(check('QTY_ANOMALY', 'Anomali qty', 'WARNING',
          'Qty ' + qty + ' melebihi ' + multiplier + 'x rata-rata return historis ('
          + Utils.round(avgReturn, 1) + ').'));
      } else {
        checks.push(check('QTY_ANOMALY', 'Anomali qty', 'PASS', 'Qty wajar dibanding histori.'));
      }
    } else {
      checks.push(check('QTY_ANOMALY', 'Anomali qty', 'PASS', 'Belum ada histori pembanding.'));
    }

    // Duplicate MR
    var windowDays = Settings.getNumber('MR_DUPLICATE_WINDOW_DAYS', 7);
    var duplicates = MrRepo.findDuplicates(mr.ACCOUNT_ID, mr.SKU_ID, mr.MR_DATE, windowDays, mr.MR_ID);
    if (duplicates.length) {
      checks.push(check('DUPLICATE', 'Duplicate MR', 'WARNING',
        'Ditemukan ' + duplicates.length + ' MR lain untuk account & SKU yang sama dalam '
        + windowDays + ' hari (' + duplicates.map(function (d) { return d.MR_ID; }).join(', ') + ').'));
    } else {
      checks.push(check('DUPLICATE', 'Duplicate MR', 'PASS', 'Tidak ada duplikasi.'));
    }

    // Tanggal MR
    if (!Utils.parseDate(mr.MR_DATE)) {
      checks.push(check('MR_DATE', 'Tanggal MR', 'ERROR', 'Tanggal MR belum diisi.'));
    } else if (Utils.parseDate(mr.MR_DATE) > today) {
      checks.push(check('MR_DATE', 'Tanggal MR', 'WARNING', 'Tanggal MR berada di masa depan.'));
    } else {
      checks.push(check('MR_DATE', 'Tanggal MR', 'PASS', Utils.toIsoDate(mr.MR_DATE)));
    }

    // Pickup date & SLA
    var pickupSla = Settings.getNumber('MR_PICKUP_SLA_DAYS', 3);
    if (!Utils.parseDate(mr.PICKUP_DATE)) {
      checks.push(check('PICKUP', 'Jadwal penarikan', 'WARNING',
        'Pickup date belum dijadwalkan. Wajib diisi sebelum SO dibuat.'));
    } else {
      var gap = Utils.diffDays(mr.MR_DATE, mr.PICKUP_DATE);
      if (gap === null || gap < 0) {
        checks.push(check('PICKUP', 'Jadwal penarikan', 'ERROR', 'Pickup date lebih awal dari tanggal MR.'));
      } else if (gap > pickupSla) {
        checks.push(check('PICKUP', 'Jadwal penarikan', 'WARNING',
          'Jarak penarikan ' + gap + ' hari melebihi SLA ' + pickupSla + ' hari.'));
      } else {
        checks.push(check('PICKUP', 'Jadwal penarikan', 'PASS', Utils.toIsoDate(mr.PICKUP_DATE)));
      }
    }

    // Cutoff potong tagihan
    var cutoff = Utils.parseDate(mr.CUTOFF_DATE);
    if (!cutoff) {
      checks.push(check('CUTOFF', 'Cutoff tagihan', 'WARNING', 'Cutoff date belum terbentuk.'));
    } else if (cutoff < today) {
      checks.push(check('CUTOFF', 'Cutoff tagihan', 'WARNING',
        'Cutoff ' + Utils.toIsoDate(cutoff) + ' sudah terlewat. Pemotongan tagihan masuk periode berikutnya.'));
    } else {
      checks.push(check('CUTOFF', 'Cutoff tagihan', 'PASS',
        'Sisa ' + Utils.diffDays(today, cutoff) + ' hari menuju cutoff.'));
    }

    // Expiry & BAP
    var expiry = Utils.parseDate(mr.EXPIRY_DATE);
    if (!expiry) {
      checks.push(check('EXPIRY', 'Expiry date', 'WARNING', 'Expiry date belum diisi.'));
    } else {
      var remaining = Utils.diffDays(mr.MR_DATE, expiry);
      checks.push(check('EXPIRY', 'Expiry date',
        remaining < 0 ? 'WARNING' : 'PASS',
        remaining < 0 ? 'Produk sudah melewati expiry ' + Math.abs(remaining) + ' hari.'
          : 'Sisa umur produk ' + remaining + ' hari.'));
    }
    var bapRequired = Utils.bool(mr.BAP_REQUIRED);
    checks.push(check('BAP', 'Ketentuan BAP', 'PASS',
      bapRequired ? 'BAP wajib sesuai aturan ' + Settings.get('BAP_RULE', 'FRESH_EXEMPT') + '.'
        : 'BAP tidak wajib (item fresh & sesuai SOP).'));

    // Nilai return
    if (!(Utils.num(mr.RETURN_VALUE) > 0)) {
      checks.push(check('VALUE', 'Nilai return', 'WARNING', 'Nilai return belum terisi.'));
    } else {
      checks.push(check('VALUE', 'Nilai return', 'PASS', String(Utils.num(mr.RETURN_VALUE))));
    }

    var hasError = checks.some(function (c) { return c.status === 'ERROR'; });
    var hasWarning = checks.some(function (c) { return c.status === 'WARNING'; });
    return {
      status: hasError ? 'ERROR' : (hasWarning ? 'WARNING' : 'PASS'),
      checks: checks,
      notes: checks.filter(function (c) { return c.status !== 'PASS'; })
        .map(function (c) { return '[' + c.status + '] ' + c.label + ': ' + c.message; }).join(' | ')
    };
  }

  /** Jalankan validasi dan (opsional) simpan hasilnya ke database. */
  function runValidation(mrId, options) {
    var opts = options || {};
    var mr = getMrOrFail(mrId);
    var result = evaluateChecks(mr);
    if (opts.autoPersist) {
      var patch = {
        VALIDATION_STATUS: result.status,
        VALIDATION_NOTES: result.notes || 'Seluruh pemeriksaan otomatis lolos.'
      };
      // Naik ke VALIDATED hanya bila tidak ada ERROR dan masih di tahap INPUT
      if (result.status !== 'ERROR' && Utils.upper(mr.MR_STATUS) === 'INPUT') {
        patch.MR_STATUS = 'VALIDATED';
      }
      if (result.status === 'ERROR' && Utils.upper(mr.MR_STATUS) === 'VALIDATED') {
        patch.MR_STATUS = 'INPUT';
      }
      MrRepo.update(mrId, patch);
      if (opts.session) {
        AuditService.log({
          user: opts.session.username, action: AUDIT_ACTIONS.VALIDATE, module: AuditService.MODULES.MR,
          recordId: mrId, description: 'Validasi data MR: ' + result.status + '. ' + (result.notes || ''),
          newValue: 'VALIDATION_STATUS=' + result.status + (patch.MR_STATUS ? '; MR_STATUS=' + patch.MR_STATUS : '')
        });
      }
    }
    return result;
  }

  /** Validasi manual dari UI (STEP 2). */
  function validateMR(session, payload) {
    var result = runValidation(payload.mrId, { autoPersist: true, session: session });
    return { validation: result, mr: presentMr(MrRepo.byId(payload.mrId)) };
  }

  /** Kirim ke Sales untuk approval. */
  function submitForApproval(session, payload) {
    var mr = getMrOrFail(payload.mrId);
    assertTransition(mr.MR_STATUS, 'WAITING_APPROVAL');
    var result = evaluateChecks(mr);
    if (result.status === 'ERROR') {
      throwError('VALIDATION_ERROR',
        'Data MR masih memiliki error dan belum dapat dikirim untuk approval. ' + result.notes);
    }
    MrRepo.update(mr.MR_ID, {
      MR_STATUS: 'WAITING_APPROVAL',
      SALES_APPROVAL: 'PENDING',
      VALIDATION_STATUS: result.status,
      VALIDATION_NOTES: result.notes || 'Seluruh pemeriksaan otomatis lolos.'
    });
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.MR,
      recordId: mr.MR_ID, description: 'MR dikirim untuk approval Sales.',
      oldValue: 'MR_STATUS=' + mr.MR_STATUS, newValue: 'MR_STATUS=WAITING_APPROVAL'
    });
    return { mr: presentMr(MrRepo.byId(mr.MR_ID)) };
  }

  // -------------------------------------------------------------------------
  // STEP 3 — APPROVAL SALES
  // -------------------------------------------------------------------------

  function approveMR(session, payload) {
    var mr = getMrOrFail(payload.mrId);
    assertTransition(mr.MR_STATUS, 'APPROVED');
    var now = new Date();
    MrRepo.update(mr.MR_ID, {
      MR_STATUS: 'APPROVED',
      SALES_APPROVAL: 'APPROVED',
      APPROVED_BY: session.username,
      APPROVED_AT: now,
      REMARK: Utils.str(payload.note) || mr.REMARK,
      BAP_STATUS: Utils.bool(mr.BAP_REQUIRED) ? 'RECEIVED' : 'NOT_REQUIRED'
    });
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.APPROVE, module: AuditService.MODULES.MR,
      recordId: mr.MR_ID,
      description: 'Approval Sales diberikan untuk MR ' + mr.MR_ID
        + (payload.note ? '. Catatan: ' + payload.note : ''),
      oldValue: 'MR_STATUS=' + mr.MR_STATUS, newValue: 'MR_STATUS=APPROVED'
    });
    var result = { mr: presentMr(MrRepo.byId(mr.MR_ID)) };

    // Auto create SO bila diminta dan jadwal penarikan sudah siap
    if (payload.autoCreateSO && roleHasPermission(session.role, 'mr.createSO')) {
      try {
        result.so = createSO(session, { mrId: mr.MR_ID });
      } catch (e) {
        result.soError = e.message;
      }
    }
    return result;
  }

  function rejectMR(session, payload) {
    var mr = getMrOrFail(payload.mrId);
    if (Utils.isBlank(payload.reason)) {
      throwError('VALIDATION_ERROR', 'Alasan penolakan wajib diisi.');
    }
    assertTransition(mr.MR_STATUS, 'REJECTED');
    MrRepo.update(mr.MR_ID, {
      MR_STATUS: 'REJECTED',
      SALES_APPROVAL: 'REJECTED',
      REJECT_REASON: Utils.str(payload.reason),
      APPROVED_BY: session.username,
      APPROVED_AT: new Date()
    });
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.REJECT, module: AuditService.MODULES.MR,
      recordId: mr.MR_ID, description: 'MR ditolak. Alasan: ' + payload.reason,
      oldValue: 'MR_STATUS=' + mr.MR_STATUS, newValue: 'MR_STATUS=REJECTED'
    });
    return { mr: presentMr(MrRepo.byId(mr.MR_ID)) };
  }

  // -------------------------------------------------------------------------
  // STEP 4 — CREATE SO
  // -------------------------------------------------------------------------

  /** Nomor SO otomatis: <PREFIX>-YYYYMMDD-XXXX dengan urutan harian. */
  function generateSoNumber(date) {
    var prefix = Settings.get('SO_NUMBER_PREFIX', 'SO-MR');
    var stamp = Utils.formatDate(date || new Date(), 'yyyyMMdd');
    var props = PropertiesService.getScriptProperties();
    var key = 'MRD_SEQ_SO_' + stamp;
    var next = Number(props.getProperty(key) || 0) + 1;
    // Sinkronkan dengan data yang sudah ada (mis. demo data)
    var existingToday = MrRepo.all().filter(function (r) {
      return Utils.str(r.SO_NUMBER).indexOf(prefix + '-' + stamp + '-') === 0;
    }).length;
    if (existingToday >= next) next = existingToday + 1;
    props.setProperty(key, String(next));
    return prefix + '-' + stamp + '-' + Utils.pad(next, 4);
  }

  function createSO(session, payload) {
    var mr = getMrOrFail(payload.mrId);
    assertTransition(mr.MR_STATUS, 'SO_CREATED');
    if (Utils.upper(mr.SALES_APPROVAL) !== 'APPROVED') {
      throwError('INVALID_STATE', 'SO hanya dapat dibuat setelah mendapat approval Sales.');
    }
    if (Settings.getBool('MR_REQUIRE_PICKUP_BEFORE_SO', true) && !Utils.parseDate(mr.PICKUP_DATE)) {
      throwError('VALIDATION_ERROR',
        'Jadwal penarikan (pickup date) wajib diisi sebelum SO dibuat. Lengkapi melalui menu SOP / detail MR.');
    }
    if (Utils.bool(mr.BAP_REQUIRED) && Utils.upper(mr.BAP_STATUS) !== 'RECEIVED') {
      throwError('VALIDATION_ERROR', 'BAP wajib diterima terlebih dahulu sebelum SO dibuat.');
    }

    var soNumber = DB.withLock(function () { return generateSoNumber(new Date()); });
    MrRepo.update(mr.MR_ID, {
      SO_NUMBER: soNumber,
      SO_STATUS: 'CREATED',
      SO_DATE: new Date(),
      MR_STATUS: 'SO_CREATED'
    });
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.CREATE_SO, module: AuditService.MODULES.MR,
      recordId: mr.MR_ID, description: 'SO otomatis dibuat untuk MR ' + mr.MR_ID + ' dengan nomor ' + soNumber,
      oldValue: 'SO_STATUS=' + mr.SO_STATUS, newValue: 'SO_NUMBER=' + soNumber + '; SO_STATUS=CREATED'
    });
    return { soNumber: soNumber, mr: presentMr(MrRepo.byId(mr.MR_ID)) };
  }

  // -------------------------------------------------------------------------
  // STEP 5 — PICKUP & COMPLETION
  // -------------------------------------------------------------------------

  function schedulePickup(session, payload) {
    var mr = getMrOrFail(payload.mrId);
    var pickupDate = Utils.parseDate(payload.pickupDate);
    if (!pickupDate) throwError('VALIDATION_ERROR', 'Tanggal penarikan wajib diisi.');
    if (Utils.diffDays(mr.MR_DATE, pickupDate) < 0) {
      throwError('VALIDATION_ERROR', 'Tanggal penarikan tidak boleh lebih awal dari tanggal MR.');
    }
    var patch = { PICKUP_DATE: pickupDate, PIC: Utils.str(payload.pic) || mr.PIC };
    // Naikkan status hanya bila SO sudah dibuat
    if (Utils.upper(mr.MR_STATUS) === 'SO_CREATED') {
      assertTransition(mr.MR_STATUS, 'PICKUP_SCHEDULED');
      patch.MR_STATUS = 'PICKUP_SCHEDULED';
    }
    MrRepo.update(mr.MR_ID, patch);
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.MR,
      recordId: mr.MR_ID, description: 'Jadwal penarikan ditetapkan ' + Utils.toIsoDate(pickupDate),
      oldValue: 'PICKUP_DATE=' + Utils.toIsoDate(mr.PICKUP_DATE),
      newValue: 'PICKUP_DATE=' + Utils.toIsoDate(pickupDate)
    });
    return { mr: presentMr(MrRepo.byId(mr.MR_ID)) };
  }

  function completeMR(session, payload) {
    var mr = getMrOrFail(payload.mrId);
    assertTransition(mr.MR_STATUS, 'COMPLETED');
    var now = new Date();
    MrRepo.update(mr.MR_ID, { MR_STATUS: 'COMPLETED', COMPLETED_AT: now });

    // Realisasi MR dicatat ke ledger RETURN_DATA (configurable)
    var posted = false;
    if (Settings.getBool('MR_POST_RETURN_ON_COMPLETE', true)) {
      ReturnRepo.insert({
        RETURN_DATE: Utils.parseDate(mr.PICKUP_DATE) || Utils.parseDate(mr.MR_DATE) || now,
        ACCOUNT_ID: mr.ACCOUNT_ID,
        SKU_ID: mr.SKU_ID,
        RETURN_QTY: Utils.num(mr.RETURN_QTY),
        RETURN_VALUE: Utils.num(mr.RETURN_VALUE),
        RETURN_REASON: mr.RETURN_REASON || 'OTHER',
        EXPIRY_DATE: Utils.parseDate(mr.EXPIRY_DATE) || '',
        STATUS: 'PROCESSED',
        CREATED_AT: now
      });
      posted = true;
    }

    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.MR,
      recordId: mr.MR_ID,
      description: 'MR diselesaikan' + (posted ? ' dan dicatat sebagai realisasi return.' : '.'),
      oldValue: 'MR_STATUS=' + mr.MR_STATUS, newValue: 'MR_STATUS=COMPLETED'
    });
    return { mr: presentMr(MrRepo.byId(mr.MR_ID)), returnPosted: posted };
  }

  // -------------------------------------------------------------------------
  // Presentasi & monitoring
  // -------------------------------------------------------------------------

  /** Hitung status SLA sesuai tahap berjalan. */
  function slaFor(mr) {
    var status = Utils.upper(mr.MR_STATUS);
    var now = new Date();
    var slaHours = null;
    var reference = Utils.parseDate(mr.UPDATED_AT) || Utils.parseDate(mr.CREATED_AT) || Utils.parseDate(mr.MR_DATE);
    if (status === 'INPUT') slaHours = Settings.getNumber('MR_VALIDATION_SLA_HOURS', 24);
    else if (status === 'VALIDATED' || status === 'WAITING_APPROVAL') slaHours = Settings.getNumber('MR_APPROVAL_SLA_HOURS', 48);
    else if (status === 'APPROVED') slaHours = Settings.getNumber('MR_SO_SLA_HOURS', 24);
    else if (status === 'SO_CREATED' || status === 'PICKUP_SCHEDULED') {
      var pickup = Utils.parseDate(mr.PICKUP_DATE);
      if (pickup) {
        var days = Utils.diffDays(now, pickup);
        return {
          label: days < 0 ? 'OVERDUE' : (days <= 1 ? 'DUE_SOON' : 'ON_TIME'),
          hoursElapsed: null,
          slaHours: null,
          daysToPickup: days
        };
      }
      return { label: 'ON_TIME', hoursElapsed: null, slaHours: null, daysToPickup: null };
    }
    if (!slaHours || !reference) return { label: 'ON_TIME', hoursElapsed: null, slaHours: slaHours, daysToPickup: null };
    var elapsed = Utils.diffHours(reference, now);
    return {
      label: elapsed > slaHours ? 'OVERDUE' : (elapsed > slaHours * 0.75 ? 'DUE_SOON' : 'ON_TIME'),
      hoursElapsed: Utils.round(elapsed, 1),
      slaHours: slaHours,
      daysToPickup: null
    };
  }

  /** Apakah MR terhitung "missed PO" (melewati cutoff tapi belum diproses). */
  function isMissedPo(mr) {
    var status = Utils.upper(mr.MR_STATUS);
    if (['SO_CREATED', 'PICKUP_SCHEDULED', 'COMPLETED', 'REJECTED'].indexOf(status) !== -1) return false;
    var cutoff = Utils.parseDate(mr.CUTOFF_DATE);
    if (!cutoff) return false;
    var grace = Settings.getNumber('MISSED_PO_GRACE_DAYS', 2);
    return Utils.diffDays(Utils.addDays(cutoff, grace), Utils.today()) > 0;
  }

  /** Bentuk DTO MR lengkap dengan join master + SLA. */
  function presentMr(mr, accountMap, skuMap) {
    if (!mr) return null;
    var accounts = accountMap || AccountRepo.map();
    var skus = skuMap || SkuRepo.map();
    var account = accounts[mr.ACCOUNT_ID] || {};
    var sku = skus[mr.SKU_ID] || {};
    var sla = slaFor(mr);
    return {
      MR_ID: mr.MR_ID,
      MR_DATE: Utils.toIsoDate(mr.MR_DATE),
      ACCOUNT_ID: mr.ACCOUNT_ID,
      accountCode: account.ACCOUNT_CODE || '',
      accountName: account.ACCOUNT_NAME || mr.ACCOUNT_ID,
      region: account.REGION || '',
      area: account.AREA || '',
      channel: account.CHANNEL || '',
      SKU_ID: mr.SKU_ID,
      skuCode: sku.SKU_CODE || '',
      skuName: sku.SKU_NAME || mr.SKU_ID,
      category: sku.CATEGORY || '',
      unit: sku.UNIT || '',
      RETURN_QTY: Utils.num(mr.RETURN_QTY),
      RETURN_VALUE: Utils.num(mr.RETURN_VALUE),
      RETURN_REASON: mr.RETURN_REASON,
      EXPIRY_DATE: Utils.toIsoDate(mr.EXPIRY_DATE),
      PICKUP_DATE: Utils.toIsoDate(mr.PICKUP_DATE),
      CUTOFF_DATE: Utils.toIsoDate(mr.CUTOFF_DATE),
      BAP_REQUIRED: Utils.bool(mr.BAP_REQUIRED),
      BAP_STATUS: mr.BAP_STATUS,
      SALES_APPROVAL: mr.SALES_APPROVAL,
      SO_NUMBER: mr.SO_NUMBER,
      SO_STATUS: mr.SO_STATUS,
      SO_DATE: Utils.toIsoDate(mr.SO_DATE),
      MR_STATUS: Utils.upper(mr.MR_STATUS),
      VALIDATION_STATUS: mr.VALIDATION_STATUS,
      VALIDATION_NOTES: mr.VALIDATION_NOTES,
      REMARK: mr.REMARK,
      REJECT_REASON: mr.REJECT_REASON,
      PIC: mr.PIC,
      CREATED_BY: mr.CREATED_BY,
      CREATED_AT: Utils.toIsoDateTime(mr.CREATED_AT),
      UPDATED_AT: Utils.toIsoDateTime(mr.UPDATED_AT),
      APPROVED_BY: mr.APPROVED_BY,
      APPROVED_AT: Utils.toIsoDateTime(mr.APPROVED_AT),
      COMPLETED_AT: Utils.toIsoDateTime(mr.COMPLETED_AT),
      sla: sla,
      missedPo: isMissedPo(mr),
      stepIndex: Math.max(0, MR_FLOW.indexOf(Utils.upper(mr.MR_STATUS))),
      daysToCutoff: Utils.diffDays(Utils.today(), Utils.parseDate(mr.CUTOFF_DATE))
    };
  }

  function matchMrFilters(row, filters) {
    var f = filters || {};
    if (f.status && Utils.upper(row.MR_STATUS) !== Utils.upper(f.status)) return false;
    if (f.statuses && f.statuses.length && f.statuses.indexOf(row.MR_STATUS) === -1) return false;
    if (f.accountIds && f.accountIds.length && f.accountIds.indexOf(row.ACCOUNT_ID) === -1) return false;
    if (f.skuIds && f.skuIds.length && f.skuIds.indexOf(row.SKU_ID) === -1) return false;
    if (f.region && Utils.upper(row.region) !== Utils.upper(f.region)) return false;
    if (f.area && Utils.upper(row.area) !== Utils.upper(f.area)) return false;
    if (f.reason && Utils.upper(row.RETURN_REASON) !== Utils.upper(f.reason)) return false;
    if (f.soStatus && Utils.upper(row.SO_STATUS) !== Utils.upper(f.soStatus)) return false;
    if (f.missedPo && !row.missedPo) return false;
    if (f.dateFrom || f.dateTo) {
      if (!Utils.inRange(row.MR_DATE, f.dateFrom, f.dateTo)) return false;
    }
    if (f.q) {
      var hay = Utils.normalize([row.MR_ID, row.accountName, row.accountCode, row.skuName,
        row.skuCode, row.SO_NUMBER, row.PIC].join(' '));
      if (hay.indexOf(Utils.normalize(f.q)) === -1) return false;
    }
    return true;
  }

  /** Daftar MR untuk tabel administrasi. */
  function listMR(params) {
    var p = params || {};
    var accounts = AccountRepo.map();
    var skus = SkuRepo.map();
    var rows = MrRepo.all().map(function (mr) { return presentMr(mr, accounts, skus); })
      .filter(function (row) { return matchMrFilters(row, p.filters); });
    var sorted = Utils.sortBy(rows, [{ key: 'MR_DATE', dir: 'desc' }, { key: 'MR_ID', dir: 'desc', type: 'text' }]);
    var paged = Utils.paginate(sorted, p.page, p.pageSize || Settings.getNumber('DEFAULT_PAGE_SIZE', 25));
    return { rows: paged.rows, meta: paged.meta, summary: summarize(rows) };
  }

  /** Ringkasan status MR (dipakai dashboard & monitoring). */
  function summarize(rows) {
    var list = rows || MrRepo.all().map(function (mr) { return presentMr(mr); });
    var byStatus = {};
    MR_FLOW.concat(['REJECTED']).forEach(function (status) {
      byStatus[status] = list.filter(function (r) { return r.MR_STATUS === status; }).length;
    });
    var pending = list.filter(function (r) {
      return ['COMPLETED', 'REJECTED'].indexOf(r.MR_STATUS) === -1;
    });
    return {
      total: list.length,
      byStatus: byStatus,
      pending: pending.length,
      waitingApproval: byStatus.WAITING_APPROVAL || 0,
      soCreated: (byStatus.SO_CREATED || 0) + (byStatus.PICKUP_SCHEDULED || 0) + (byStatus.COMPLETED || 0),
      completed: byStatus.COMPLETED || 0,
      rejected: byStatus.REJECTED || 0,
      missedPo: list.filter(function (r) { return r.missedPo; }).length,
      overdue: list.filter(function (r) { return r.sla && r.sla.label === 'OVERDUE'; }).length,
      totalQty: Utils.sumBy(list, 'RETURN_QTY'),
      totalValue: Utils.sumBy(list, 'RETURN_VALUE'),
      onTimeRate: list.length
        ? Utils.round((list.filter(function (r) { return !r.sla || r.sla.label !== 'OVERDUE'; }).length / list.length) * 100, 1)
        : 100
    };
  }

  /** Papan Kanban monitoring (PRD bagian N). */
  function getMonitoringBoard(params) {
    var p = params || {};
    var accounts = AccountRepo.map();
    var skus = SkuRepo.map();
    var rows = MrRepo.all().map(function (mr) { return presentMr(mr, accounts, skus); })
      .filter(function (row) { return matchMrFilters(row, p.filters); });
    var limit = Utils.num(p.limitPerColumn, 0) || 25;

    var columns = MR_FLOW.map(function (status) {
      var cards = Utils.sortBy(rows.filter(function (r) { return r.MR_STATUS === status; }),
        [{ key: 'MR_DATE', dir: 'desc' }]);
      return {
        status: status,
        label: status.replace(/_/g, ' '),
        count: cards.length,
        qty: Utils.sumBy(cards, 'RETURN_QTY'),
        value: Utils.sumBy(cards, 'RETURN_VALUE'),
        overdue: cards.filter(function (c) { return c.sla && c.sla.label === 'OVERDUE'; }).length,
        cards: cards.slice(0, limit)
      };
    });
    var rejected = rows.filter(function (r) { return r.MR_STATUS === 'REJECTED'; });

    return {
      columns: columns,
      rejected: { count: rejected.length, cards: Utils.sortBy(rejected, [{ key: 'MR_DATE', dir: 'desc' }]).slice(0, limit) },
      summary: summarize(rows),
      limitPerColumn: limit
    };
  }

  /** Detail satu MR + timeline + konteks SOP. */
  function getDetail(params) {
    var mr = getMrOrFail((params || {}).mrId);
    var dto = presentMr(mr);
    var validation = evaluateChecks(mr);
    var timeline = [
      { status: 'INPUT', label: 'Input Admin', at: Utils.toIsoDateTime(mr.CREATED_AT), by: mr.CREATED_BY, done: true },
      { status: 'VALIDATED', label: 'Validasi Data', at: '', by: '', done: dto.stepIndex >= 1 || Utils.upper(mr.VALIDATION_STATUS) === 'PASS' },
      { status: 'WAITING_APPROVAL', label: 'Approval Sales', at: '', by: '', done: dto.stepIndex >= 2 },
      { status: 'APPROVED', label: 'Approved', at: Utils.toIsoDateTime(mr.APPROVED_AT), by: mr.APPROVED_BY, done: dto.stepIndex >= 3 },
      { status: 'SO_CREATED', label: 'Create SO', at: Utils.toIsoDate(mr.SO_DATE), by: '', done: dto.stepIndex >= 4 },
      { status: 'PICKUP_SCHEDULED', label: 'Pickup Scheduled', at: Utils.toIsoDate(mr.PICKUP_DATE), by: mr.PIC, done: dto.stepIndex >= 5 },
      { status: 'COMPLETED', label: 'Completed', at: Utils.toIsoDateTime(mr.COMPLETED_AT), by: '', done: dto.stepIndex >= 6 }
    ];
    if (Utils.upper(mr.MR_STATUS) === 'REJECTED') {
      timeline = timeline.slice(0, 3).concat([{
        status: 'REJECTED', label: 'Rejected', at: Utils.toIsoDateTime(mr.APPROVED_AT),
        by: mr.APPROVED_BY, done: true, reason: mr.REJECT_REASON
      }]);
    }
    var history = AuditRepo.all().filter(function (log) { return log.RECORD_ID === mr.MR_ID; });
    return {
      mr: dto,
      validation: validation,
      timeline: timeline,
      history: Utils.sortBy(history, [{ key: 'TIMESTAMP', dir: 'desc' }]).slice(0, 20).map(function (log) {
        return {
          timestamp: Utils.toIsoDateTime(log.TIMESTAMP), user: log.USER,
          action: log.ACTION, description: log.DESCRIPTION
        };
      }),
      rules: {
        cutoffDays: Settings.getNumber('MR_CUTOFF_DAYS', 7),
        pickupSlaDays: Settings.getNumber('MR_PICKUP_SLA_DAYS', 3),
        bapRule: Settings.get('BAP_RULE', 'FRESH_EXEMPT')
      }
    };
  }

  /** Opsi untuk form input MR. */
  function getFormOptions() {
    var master = Lookup.masterOptions();
    return {
      accounts: master.accounts,
      skus: master.skus,
      reasons: ENUMS.RETURN_REASON,
      defaults: {
        mrDate: Utils.toIsoDate(Utils.today()),
        cutoffDays: Settings.getNumber('MR_CUTOFF_DAYS', 7),
        pickupSlaDays: Settings.getNumber('MR_PICKUP_SLA_DAYS', 3),
        suggestedPickupDate: Utils.toIsoDate(Utils.addDays(Utils.today(), Settings.getNumber('MR_PICKUP_SLA_DAYS', 3))),
        bapRule: Settings.get('BAP_RULE', 'FRESH_EXEMPT'),
        bapFreshDays: Settings.getNumber('BAP_FRESH_MIN_REMAINING_DAYS', 30)
      }
    };
  }

  /** Data export CSV untuk MR Report / SO Monitoring Report. */
  function exportRows(params) {
    var p = params || {};
    var accounts = AccountRepo.map();
    var skus = SkuRepo.map();
    var rows = MrRepo.all().map(function (mr) { return presentMr(mr, accounts, skus); })
      .filter(function (row) { return matchMrFilters(row, p.filters); });
    var headers = ['MR_ID', 'MR_DATE', 'ACCOUNT_CODE', 'ACCOUNT_NAME', 'REGION', 'SKU_CODE', 'SKU_NAME',
      'RETURN_QTY', 'RETURN_VALUE', 'RETURN_REASON', 'PICKUP_DATE', 'CUTOFF_DATE', 'BAP_REQUIRED',
      'BAP_STATUS', 'SALES_APPROVAL', 'SO_NUMBER', 'SO_STATUS', 'MR_STATUS', 'VALIDATION_STATUS',
      'PIC', 'CREATED_BY', 'MISSED_PO', 'SLA_STATUS'];
    var data = Utils.sortBy(rows, [{ key: 'MR_DATE', dir: 'desc' }]).map(function (r) {
      return {
        MR_ID: r.MR_ID, MR_DATE: r.MR_DATE, ACCOUNT_CODE: r.accountCode, ACCOUNT_NAME: r.accountName,
        REGION: r.region, SKU_CODE: r.skuCode, SKU_NAME: r.skuName, RETURN_QTY: r.RETURN_QTY,
        RETURN_VALUE: r.RETURN_VALUE, RETURN_REASON: r.RETURN_REASON, PICKUP_DATE: r.PICKUP_DATE,
        CUTOFF_DATE: r.CUTOFF_DATE, BAP_REQUIRED: r.BAP_REQUIRED ? 'YES' : 'NO', BAP_STATUS: r.BAP_STATUS,
        SALES_APPROVAL: r.SALES_APPROVAL, SO_NUMBER: r.SO_NUMBER, SO_STATUS: r.SO_STATUS,
        MR_STATUS: r.MR_STATUS, VALIDATION_STATUS: r.VALIDATION_STATUS, PIC: r.PIC,
        CREATED_BY: r.CREATED_BY, MISSED_PO: r.missedPo ? 'YES' : 'NO',
        SLA_STATUS: r.sla ? r.sla.label : ''
      };
    });
    return { headers: headers, rows: data, filename: 'mr-report' };
  }

  return {
    createMR: createMR,
    updateMR: updateMR,
    validateMR: validateMR,
    evaluateChecks: evaluateChecks,
    submitForApproval: submitForApproval,
    approveMR: approveMR,
    rejectMR: rejectMR,
    createSO: createSO,
    schedulePickup: schedulePickup,
    completeMR: completeMR,
    listMR: listMR,
    getMonitoringBoard: getMonitoringBoard,
    getDetail: getDetail,
    getFormOptions: getFormOptions,
    summarize: summarize,
    presentMr: presentMr,
    exportRows: exportRows,
    isMissedPo: isMissedPo
  };
})();
