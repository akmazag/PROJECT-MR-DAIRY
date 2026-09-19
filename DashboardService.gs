/**
 * PROJECT MR DAIRY
 * ============================================================================
 * DashboardService.gs — Agregasi dashboard utama.
 *
 * Dashboard memakai dataset agregat (bukan raw) dan dihitung server-side agar
 * initial load tetap ringan. Setiap KPI disertai pembanding periode
 * sebelumnya sehingga angka menjadi actionable, bukan sekadar hiasan.
 * ============================================================================
 */

var DashboardService = (function () {

  /** Periode sebelumnya dengan panjang yang sama. */
  function previousPeriod(period) {
    var months = period.months.length || 1;
    var prevTo = Utils.addDays(Utils.startOfMonth(period.from), -1);
    var prevFrom = Utils.startOfMonth(Utils.addMonths(prevTo, -(months - 1)));
    return { dateFrom: prevFrom, dateTo: prevTo };
  }

  function kpi(value, previous, options) {
    var opts = options || {};
    var delta = Utils.deltaPercent(value, previous);
    return {
      value: Utils.round(value, opts.decimals === undefined ? 0 : opts.decimals),
      previous: Utils.round(previous, opts.decimals === undefined ? 0 : opts.decimals),
      delta: delta === null ? null : Utils.round(delta, 1),
      // lowerIsBetter: penurunan angka = kabar baik (mis. MR%, return)
      direction: delta === null ? 'flat' : (delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')),
      good: delta === null ? null : (opts.lowerIsBetter ? delta <= 0 : delta >= 0),
      unit: opts.unit || '',
      format: opts.format || 'number'
    };
  }

  /**
   * Ringkasan dashboard.
   * @param {Object} params { filters }
   */
  function getSummary(params) {
    var p = params || {};
    var filters = p.filters || {};
    var matrix = AllocationEngine.buildMatrix(filters);
    var rows = AllocationEngine.filterRows(matrix.rows, filters);
    var period = AllocationEngine.resolvePeriod(filters);

    var prevRange = previousPeriod(period);
    var prevMatrix = AllocationEngine.buildMatrix({ dateFrom: prevRange.dateFrom, dateTo: prevRange.dateTo });
    var prevRows = AllocationEngine.filterRows(prevMatrix.rows, filters);

    var current = AllocationEngine.summarize(rows, matrix.meta);
    var previous = AllocationEngine.summarize(prevRows, prevMatrix.meta);

    // MR administration (dibatasi rentang tanggal filter bila ada)
    var accounts = AccountRepo.map();
    var skus = SkuRepo.map();
    var mrRows = MrRepo.all().map(function (mr) { return MRService.presentMr(mr, accounts, skus); });
    var mrFiltered = mrRows.filter(function (row) {
      if (filters.region && Utils.upper(row.region) !== Utils.upper(filters.region)) return false;
      if (filters.area && Utils.upper(row.area) !== Utils.upper(filters.area)) return false;
      if (filters.accountIds && filters.accountIds.length
        && filters.accountIds.indexOf(row.ACCOUNT_ID) === -1) return false;
      return true;
    });
    var mrSummary = MRService.summarize(mrFiltered);

    var targetMr = Settings.getNumber('TARGET_MR_PERCENT', 5);
    var plans = AllocationRepo.all();
    var approvedPlanQty = Utils.sumBy(plans.filter(function (plan) {
      return ['APPROVED', 'COMPLETED'].indexOf(Utils.upper(plan.STATUS)) !== -1;
    }), 'PLANNED_SELL_IN');

    return {
      period: matrix.meta,
      comparison: {
        from: Utils.toIsoDate(prevRange.dateFrom),
        to: Utils.toIsoDate(prevRange.dateTo)
      },
      kpi: {
        marketReturn: kpi(current.totalReturn, previous.totalReturn, { lowerIsBetter: true, unit: 'qty' }),
        marketReturnValue: kpi(current.totalReturnValue, previous.totalReturnValue, { lowerIsBetter: true, format: 'currency' }),
        mrPercent: kpi(current.mrPercent, previous.mrPercent, { lowerIsBetter: true, decimals: 2, format: 'percent' }),
        sellOut: kpi(current.totalSellOut, previous.totalSellOut, { unit: 'qty' }),
        allocation: kpi(current.recommendedAllocation, previous.recommendedAllocation, { unit: 'qty' }),
        pendingMr: kpi(mrSummary.pending, null, { lowerIsBetter: true, unit: 'dok' }),
        pendingApproval: kpi(mrSummary.waitingApproval, null, { lowerIsBetter: true, unit: 'dok' }),
        missedPo: kpi(mrSummary.missedPo, null, { lowerIsBetter: true, unit: 'dok' }),
        soCreated: kpi(mrSummary.soCreated, null, { unit: 'dok' })
      },
      target: {
        mrPercent: targetMr,
        achieved: current.mrPercent <= targetMr,
        gap: Utils.round(current.mrPercent - targetMr, 2)
      },
      objective: {
        headline: APP.OBJECTIVE,
        lessReturn: {
          label: 'Less Return',
          value: Utils.round(current.mrPercent, 2),
          target: targetMr,
          delta: Utils.deltaPercent(current.mrPercent, previous.mrPercent) === null ? null
            : Utils.round(current.mrPercent - previous.mrPercent, 2),
          achieved: current.mrPercent <= targetMr
        },
        moreFreshness: {
          label: 'More Freshness',
          // proporsi pasangan account x SKU dengan risiko rendah
          value: rows.length ? Utils.round((current.riskDistribution.LOW / rows.length) * 100, 1) : 0,
          highRisk: current.riskDistribution.HIGH,
          totalPairs: rows.length
        },
        onTimeAdministration: {
          label: 'On Time MR Administration',
          value: mrSummary.onTimeRate,
          overdue: mrSummary.overdue
        }
      },
      trend: AllocationEngine.monthlyTrend(rows, matrix.meta),
      riskDistribution: current.riskDistribution,
      mrStatus: mrSummary.byStatus,
      topRisk: Utils.sortBy(rows, [{ key: 'riskScore', dir: 'desc' }]).slice(0, 6).map(function (r) {
        return {
          accountId: r.accountId, accountName: r.accountName, skuId: r.skuId, skuName: r.skuName,
          mrPercent: r.mrPercent, currentStock: r.currentStock, riskLevel: r.riskLevel,
          riskScore: r.riskScore, recommendedAllocation: r.recommendedAllocation
        };
      }),
      attention: buildAttentionList(mrFiltered, rows),
      recentActivity: AuditService.recent(6),
      counts: {
        account: current.totalAccount,
        sku: current.totalSku,
        pairs: current.totalPairs,
        plans: plans.length,
        approvedPlanQty: approvedPlanQty
      }
    };
  }

  /** Daftar hal yang perlu ditindaklanjuti hari ini (actionable, bukan dekoratif). */
  function buildAttentionList(mrRows, matrixRows) {
    var items = [];
    var waiting = mrRows.filter(function (r) { return r.MR_STATUS === 'WAITING_APPROVAL'; });
    if (waiting.length) {
      items.push({
        code: 'WAITING_APPROVAL', severity: 'warning',
        title: waiting.length + ' MR menunggu approval Sales',
        description: 'Total ' + Utils.sumBy(waiting, 'RETURN_QTY') + ' qty tertahan di tahap approval.',
        action: { page: 'mr', filter: { status: 'WAITING_APPROVAL' }, label: 'Proses approval' }
      });
    }
    var missed = mrRows.filter(function (r) { return r.missedPo; });
    if (missed.length) {
      items.push({
        code: 'MISSED_PO', severity: 'danger',
        title: missed.length + ' MR melewati cutoff potong tagihan',
        description: 'Pemotongan tagihan berisiko mundur ke periode berikutnya.',
        action: { page: 'sop', tab: 'cutoff', label: 'Lihat komitmen cutoff' }
      });
    }
    var noPickup = mrRows.filter(function (r) {
      return !r.PICKUP_DATE && ['COMPLETED', 'REJECTED'].indexOf(r.MR_STATUS) === -1;
    });
    if (noPickup.length) {
      items.push({
        code: 'NO_PICKUP', severity: 'warning',
        title: noPickup.length + ' MR belum memiliki jadwal penarikan',
        description: 'SO tidak dapat dibuat sebelum jadwal penarikan ditetapkan.',
        action: { page: 'sop', tab: 'pickup', label: 'Plot jadwal' }
      });
    }
    var highRisk = matrixRows.filter(function (r) { return r.riskLevel === 'HIGH'; });
    if (highRisk.length) {
      items.push({
        code: 'HIGH_RISK', severity: 'danger',
        title: highRisk.length + ' kombinasi account x SKU berisiko tinggi menjadi Market Return',
        description: 'Tinjau allocation sebelum periode sell in berikutnya.',
        action: { page: 'distribution', filter: { risk: 'HIGH' }, label: 'Review allocation' }
      });
    }
    var overStock = matrixRows.filter(function (r) { return r.recommendedAllocation === 0 && r.currentStock > 0; });
    if (overStock.length) {
      items.push({
        code: 'OVER_STOCK', severity: 'info',
        title: overStock.length + ' account x SKU direkomendasikan tanpa sell in',
        description: 'Stock di account masih menutupi kebutuhan periode berjalan.',
        action: { page: 'distribution', filter: {}, label: 'Lihat rekomendasi' }
      });
    }
    return items.slice(0, 5);
  }

  return { getSummary: getSummary };
})();
