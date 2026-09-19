/**
 * PROJECT MR DAIRY
 * ============================================================================
 * SOPService.gs — SOP Market Return.
 *
 * Tiga pilar SOP (PRD bagian J):
 *   1. Plotting Jadwal Penarikan
 *   2. Komitmen Cutoff Potong Tagihan
 *   3. Ketentuan BAP
 *
 * Isi aturan diambil dari sheet SOP_MASTER + SETTINGS sehingga dapat diubah
 * tanpa mengubah source code.
 * ============================================================================
 */

var SOPService = (function () {

  /** Setting yang boleh diubah dari halaman SOP (whitelist keamanan). */
  var EDITABLE_RULE_KEYS = [
    'MR_CUTOFF_DAYS', 'MR_PICKUP_SLA_DAYS', 'MR_VALIDATION_SLA_HOURS', 'MR_APPROVAL_SLA_HOURS',
    'MR_SO_SLA_HOURS', 'BAP_RULE', 'BAP_FRESH_MIN_REMAINING_DAYS', 'BAP_VALUE_THRESHOLD',
    'MR_DUPLICATE_WINDOW_DAYS', 'MR_QTY_ANOMALY_MULTIPLIER', 'MR_REQUIRE_PICKUP_BEFORE_SO'
  ];

  function activeMrRows(filters) {
    var accounts = AccountRepo.map();
    var skus = SkuRepo.map();
    return MrRepo.all().map(function (mr) { return MRService.presentMr(mr, accounts, skus); })
      .filter(function (row) {
        var f = filters || {};
        if (f.region && Utils.upper(row.region) !== Utils.upper(f.region)) return false;
        if (f.area && Utils.upper(row.area) !== Utils.upper(f.area)) return false;
        if (f.accountIds && f.accountIds.length && f.accountIds.indexOf(row.ACCOUNT_ID) === -1) return false;
        if (f.q) {
          var hay = Utils.normalize([row.MR_ID, row.accountName, row.skuName, row.PIC].join(' '));
          if (hay.indexOf(Utils.normalize(f.q)) === -1) return false;
        }
        return true;
      });
  }

  /** Ringkasan 3 langkah SOP + aturan aktual dari SETTINGS. */
  function getWorkflow() {
    var sopRows = SopRepo.all();
    var rows = activeMrRows({});
    var openRows = rows.filter(function (r) { return ['COMPLETED', 'REJECTED'].indexOf(r.MR_STATUS) === -1; });

    var metrics = {
      PLOTTING_JADWAL_PENARIKAN: {
        total: openRows.length,
        done: openRows.filter(function (r) { return !!r.PICKUP_DATE; }).length,
        issue: openRows.filter(function (r) { return !r.PICKUP_DATE; }).length,
        issueLabel: 'MR tanpa jadwal penarikan'
      },
      KOMITMEN_CUTOFF_TAGIHAN: {
        total: openRows.length,
        done: openRows.filter(function (r) { return r.daysToCutoff !== null && r.daysToCutoff >= 0; }).length,
        issue: openRows.filter(function (r) { return r.daysToCutoff !== null && r.daysToCutoff < 0; }).length,
        issueLabel: 'MR melewati cutoff'
      },
      KETENTUAN_BAP: {
        total: rows.filter(function (r) { return r.BAP_REQUIRED; }).length,
        done: rows.filter(function (r) { return r.BAP_REQUIRED && Utils.upper(r.BAP_STATUS) === 'RECEIVED'; }).length,
        issue: rows.filter(function (r) { return r.BAP_REQUIRED && Utils.upper(r.BAP_STATUS) === 'PENDING'; }).length,
        issueLabel: 'BAP belum diterima'
      }
    };

    return {
      steps: sopRows.map(function (sop) {
        var m = metrics[Utils.upper(sop.CODE)] || { total: 0, done: 0, issue: 0, issueLabel: '' };
        return {
          SOP_ID: sop.SOP_ID,
          STEP_NO: Utils.num(sop.STEP_NO),
          CODE: sop.CODE,
          TITLE: sop.TITLE,
          DESCRIPTION: sop.DESCRIPTION,
          RULE: sop.RULE,
          PIC: sop.PIC,
          SLA_DAYS: Utils.num(sop.SLA_DAYS),
          STATUS: Utils.upper(sop.STATUS),
          UPDATED_BY: sop.UPDATED_BY,
          UPDATED_AT: Utils.toIsoDateTime(sop.UPDATED_AT),
          metrics: m,
          compliance: m.total ? Utils.round((m.done / m.total) * 100, 1) : 100
        };
      }),
      rules: EDITABLE_RULE_KEYS.reduce(function (acc, key) {
        acc[key] = Settings.get(key, '');
        return acc;
      }, {}),
      ruleDescriptions: DEFAULT_SETTINGS.filter(function (item) {
        return EDITABLE_RULE_KEYS.indexOf(item[0]) !== -1;
      }).reduce(function (acc, item) { acc[item[0]] = item[2]; return acc; }, {})
    };
  }

  /**
   * Plotting Jadwal Penarikan — daftar + timeline per tanggal.
   */
  function getPickupSchedule(params) {
    var p = params || {};
    var rows = activeMrRows(p.filters).filter(function (r) {
      return ['REJECTED'].indexOf(r.MR_STATUS) === -1;
    });
    var scheduled = rows.filter(function (r) { return !!r.PICKUP_DATE; });
    var unscheduled = rows.filter(function (r) {
      return !r.PICKUP_DATE && ['COMPLETED'].indexOf(r.MR_STATUS) === -1;
    });

    var byDate = Utils.groupBy(scheduled, 'PICKUP_DATE');
    var today = Utils.toIsoDate(Utils.today());
    var timeline = Object.keys(byDate).sort().map(function (date) {
      var items = byDate[date];
      return {
        date: date,
        label: Utils.monthLabel(date.substring(0, 7)),
        dayLabel: Utils.formatDate(date, 'dd MMM yyyy'),
        isToday: date === today,
        isPast: date < today,
        count: items.length,
        qty: Utils.sumBy(items, 'RETURN_QTY'),
        value: Utils.sumBy(items, 'RETURN_VALUE'),
        items: Utils.sortBy(items, [{ key: 'accountName', dir: 'asc', type: 'text' }]).map(function (r) {
          return {
            MR_ID: r.MR_ID, accountName: r.accountName, accountCode: r.accountCode,
            skuName: r.skuName, RETURN_QTY: r.RETURN_QTY, PIC: r.PIC,
            MR_STATUS: r.MR_STATUS, MR_DATE: r.MR_DATE, sla: r.sla
          };
        })
      };
    });

    return {
      timeline: timeline,
      unscheduled: Utils.sortBy(unscheduled, [{ key: 'MR_DATE', dir: 'asc' }]).map(function (r) {
        return {
          MR_ID: r.MR_ID, MR_DATE: r.MR_DATE, accountName: r.accountName, skuName: r.skuName,
          RETURN_QTY: r.RETURN_QTY, MR_STATUS: r.MR_STATUS, PIC: r.PIC,
          suggestedDate: Utils.toIsoDate(Utils.addDays(r.MR_DATE, Settings.getNumber('MR_PICKUP_SLA_DAYS', 3)))
        };
      }),
      summary: {
        scheduled: scheduled.length,
        unscheduled: unscheduled.length,
        overdue: scheduled.filter(function (r) {
          return r.PICKUP_DATE < today && ['COMPLETED'].indexOf(r.MR_STATUS) === -1;
        }).length,
        slaDays: Settings.getNumber('MR_PICKUP_SLA_DAYS', 3)
      }
    };
  }

  /** Komitmen Cutoff Potong Tagihan. */
  function getCutoffCommitments(params) {
    var p = params || {};
    var rows = activeMrRows(p.filters).filter(function (r) {
      return ['REJECTED'].indexOf(r.MR_STATUS) === -1;
    });
    var cutoffDays = Settings.getNumber('MR_CUTOFF_DAYS', 7);

    var list = rows.map(function (r) {
      var days = r.daysToCutoff;
      var status;
      if (r.MR_STATUS === 'COMPLETED') status = 'FULFILLED';
      else if (days === null) status = 'NO_CUTOFF';
      else if (days < 0) status = 'OVERDUE';
      else if (days <= 2) status = 'DUE_SOON';
      else status = 'ON_TRACK';
      return {
        MR_ID: r.MR_ID,
        accountName: r.accountName,
        accountCode: r.accountCode,
        region: r.region,
        skuName: r.skuName,
        RETURN_QTY: r.RETURN_QTY,
        RETURN_VALUE: r.RETURN_VALUE,
        MR_DATE: r.MR_DATE,
        CUTOFF_DATE: r.CUTOFF_DATE,
        daysRemaining: days,
        MR_STATUS: r.MR_STATUS,
        commitmentStatus: status
      };
    });

    var sorted = Utils.sortBy(list, [{ key: 'daysRemaining', dir: 'asc' }]);
    var paged = Utils.paginate(sorted, p.page, p.pageSize || 25);
    return {
      rows: paged.rows,
      meta: paged.meta,
      summary: {
        cutoffDays: cutoffDays,
        onTrack: list.filter(function (r) { return r.commitmentStatus === 'ON_TRACK'; }).length,
        dueSoon: list.filter(function (r) { return r.commitmentStatus === 'DUE_SOON'; }).length,
        overdue: list.filter(function (r) { return r.commitmentStatus === 'OVERDUE'; }).length,
        fulfilled: list.filter(function (r) { return r.commitmentStatus === 'FULFILLED'; }).length,
        valueAtRisk: Utils.sumBy(list.filter(function (r) { return r.commitmentStatus === 'OVERDUE'; }), 'RETURN_VALUE')
      }
    };
  }

  /** Ketentuan BAP + dampaknya terhadap dokumen MR berjalan. */
  function getBapOverview(params) {
    var rows = activeMrRows((params || {}).filters);
    var required = rows.filter(function (r) { return r.BAP_REQUIRED; });
    var exempt = rows.filter(function (r) { return !r.BAP_REQUIRED; });
    return {
      rule: Settings.get('BAP_RULE', 'FRESH_EXEMPT'),
      ruleOptions: [
        { value: 'FRESH_EXEMPT', label: 'Fresh Exempt', description: 'Item fresh & sesuai SOP tidak wajib BAP.' },
        { value: 'ALWAYS', label: 'Selalu Wajib', description: 'Seluruh MR wajib disertai BAP.' },
        { value: 'NEVER', label: 'Tidak Wajib', description: 'BAP tidak dipakai pada proses MR.' }
      ],
      freshMinRemainingDays: Settings.getNumber('BAP_FRESH_MIN_REMAINING_DAYS', 30),
      valueThreshold: Settings.getNumber('BAP_VALUE_THRESHOLD', 5000000),
      summary: {
        required: required.length,
        exempt: exempt.length,
        pending: required.filter(function (r) { return Utils.upper(r.BAP_STATUS) === 'PENDING'; }).length,
        received: required.filter(function (r) { return Utils.upper(r.BAP_STATUS) === 'RECEIVED'; }).length
      },
      rows: Utils.sortBy(required, [{ key: 'MR_DATE', dir: 'desc' }]).slice(0, 50).map(function (r) {
        return {
          MR_ID: r.MR_ID, MR_DATE: r.MR_DATE, accountName: r.accountName, skuName: r.skuName,
          RETURN_QTY: r.RETURN_QTY, RETURN_VALUE: r.RETURN_VALUE, EXPIRY_DATE: r.EXPIRY_DATE,
          BAP_STATUS: r.BAP_STATUS, MR_STATUS: r.MR_STATUS
        };
      })
    };
  }

  /** Update definisi SOP (judul, deskripsi, aturan, PIC, SLA, status). */
  function updateSop(session, payload) {
    var sop = SopRepo.byId(payload.sopId);
    if (!sop) throwError('NOT_FOUND', 'Langkah SOP tidak ditemukan.');
    var patch = {};
    ['TITLE', 'DESCRIPTION', 'RULE', 'PIC'].forEach(function (field) {
      if (payload[field] !== undefined) patch[field] = Utils.str(payload[field]);
    });
    if (payload.SLA_DAYS !== undefined) patch.SLA_DAYS = Utils.num(payload.SLA_DAYS);
    if (payload.STATUS !== undefined) {
      var status = Utils.upper(payload.STATUS);
      if (ENUMS.SOP_STATUS.indexOf(status) === -1) throwError('VALIDATION_ERROR', 'Status SOP tidak dikenali.');
      patch.STATUS = status;
    }
    if (!Object.keys(patch).length) throwError('VALIDATION_ERROR', 'Tidak ada perubahan yang dikirim.');
    if (Utils.isBlank(patch.TITLE !== undefined ? patch.TITLE : sop.TITLE)) {
      throwError('VALIDATION_ERROR', 'Judul SOP wajib diisi.');
    }

    var changes = AuditService.diff(sop, patch, Object.keys(patch));
    patch.UPDATED_BY = session.username;
    SopRepo.update(sop.SOP_ID, patch);
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.SOP,
      recordId: sop.SOP_ID, description: 'SOP "' + sop.TITLE + '" diperbarui: ' + AuditService.describeChanges(changes),
      oldValue: changes.map(function (c) { return c.field + '=' + c.from; }).join('; '),
      newValue: changes.map(function (c) { return c.field + '=' + c.to; }).join('; ')
    });
    return { sop: toDto(SHEETS.SOP_MASTER, SopRepo.byId(sop.SOP_ID)) };
  }

  /** Update aturan SOP yang tersimpan di SETTINGS (whitelist). */
  function updateRule(session, payload) {
    var key = Utils.upper(payload.key);
    if (EDITABLE_RULE_KEYS.indexOf(key) === -1) {
      throwError('FORBIDDEN', 'Konfigurasi ' + key + ' tidak dapat diubah dari halaman SOP.');
    }
    var value = Utils.str(payload.value);
    if (key === 'BAP_RULE' && ['FRESH_EXEMPT', 'ALWAYS', 'NEVER'].indexOf(Utils.upper(value)) === -1) {
      throwError('VALIDATION_ERROR', 'Nilai BAP_RULE harus FRESH_EXEMPT, ALWAYS, atau NEVER.');
    }
    var numericKeys = ['MR_CUTOFF_DAYS', 'MR_PICKUP_SLA_DAYS', 'MR_VALIDATION_SLA_HOURS',
      'MR_APPROVAL_SLA_HOURS', 'MR_SO_SLA_HOURS', 'BAP_FRESH_MIN_REMAINING_DAYS',
      'BAP_VALUE_THRESHOLD', 'MR_DUPLICATE_WINDOW_DAYS', 'MR_QTY_ANOMALY_MULTIPLIER'];
    if (numericKeys.indexOf(key) !== -1 && !(Utils.num(value, -1) >= 0)) {
      throwError('VALIDATION_ERROR', 'Nilai ' + key + ' harus berupa angka >= 0.');
    }
    var oldValue = Settings.get(key, '');
    Settings.set(key, key === 'BAP_RULE' ? Utils.upper(value) : value);
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.UPDATE, module: AuditService.MODULES.SOP,
      recordId: key, description: 'Aturan SOP ' + key + ' diubah dari ' + oldValue + ' menjadi ' + value,
      oldValue: oldValue, newValue: value
    });
    return { key: key, value: Settings.get(key, '') };
  }

  return {
    getWorkflow: getWorkflow,
    getPickupSchedule: getPickupSchedule,
    getCutoffCommitments: getCutoffCommitments,
    getBapOverview: getBapOverview,
    updateSop: updateSop,
    updateRule: updateRule,
    EDITABLE_RULE_KEYS: EDITABLE_RULE_KEYS
  };
})();
