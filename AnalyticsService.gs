/**
 * PROJECT MR DAIRY
 * ============================================================================
 * AnalyticsService.gs — Sumber data seluruh chart & report.
 *
 * Chart yang disediakan (PRD bagian M):
 *   1. MR Trend             6. Allocation vs Sell Out
 *   2. Sell Out Trend       7. Risk Distribution
 *   3. Return Trend         8. Pending MR
 *   4. MR by Account        9. SO Status
 *   5. MR by SKU           10. Cluster Distribution
 *
 * Setiap chart mengembalikan struktur seragam {type, title, series, ...} agar
 * renderer di frontend tetap sederhana, dan menyertakan "drill" untuk
 * mendukung klik drill-down.
 * ============================================================================
 */

var AnalyticsService = (function () {

  function topN(rows, valueKey, limit) {
    return Utils.sortBy(rows, [{ key: valueKey, dir: 'desc' }]).slice(0, limit || 10);
  }

  /**
   * Seluruh dataset analytics dalam satu panggilan (menghindari banyak
   * round-trip google.script.run dari frontend).
   */
  function getAnalytics(params) {
    var p = params || {};
    var filters = p.filters || {};
    var limit = Utils.num(p.topN, 0) || Settings.getNumber('TOP_N_DEFAULT', 10);

    var matrix = AllocationEngine.buildMatrix(filters);
    var rows = AllocationEngine.filterRows(matrix.rows, filters);
    var trend = AllocationEngine.monthlyTrend(rows, matrix.meta);
    var summary = AllocationEngine.summarize(rows, matrix.meta);

    var accounts = AccountRepo.map();
    var skus = SkuRepo.map();
    var mrRows = MrRepo.all().map(function (mr) { return MRService.presentMr(mr, accounts, skus); })
      .filter(function (row) {
        if (filters.region && Utils.upper(row.region) !== Utils.upper(filters.region)) return false;
        if (filters.area && Utils.upper(row.area) !== Utils.upper(filters.area)) return false;
        if (filters.accountIds && filters.accountIds.length
          && filters.accountIds.indexOf(row.ACCOUNT_ID) === -1) return false;
        return true;
      });

    // --- Agregasi per account & per SKU ------------------------------------
    var byAccount = Utils.groupBy(rows, 'accountId');
    var accountAgg = Object.keys(byAccount).map(function (id) {
      var list = byAccount[id];
      var sellOut = Utils.sumBy(list, 'totalSellOut');
      var ret = Utils.sumBy(list, 'totalReturn');
      return {
        id: id,
        label: list[0].accountName,
        code: list[0].accountCode,
        region: list[0].region,
        cluster: list[0].cluster,
        sellOut: sellOut,
        returnQty: ret,
        returnValue: Utils.sumBy(list, 'totalReturnValue'),
        mrPercent: Utils.round(Utils.safeDiv(ret, sellOut, 0) * 100, 2),
        allocation: Utils.sumBy(list, 'recommendedAllocation')
      };
    });

    var bySku = Utils.groupBy(rows, 'skuId');
    var skuAgg = Object.keys(bySku).map(function (id) {
      var list = bySku[id];
      var sellOut = Utils.sumBy(list, 'totalSellOut');
      var ret = Utils.sumBy(list, 'totalReturn');
      return {
        id: id,
        label: list[0].skuName,
        code: list[0].skuCode,
        category: list[0].category,
        sellOut: sellOut,
        returnQty: ret,
        returnValue: Utils.sumBy(list, 'totalReturnValue'),
        mrPercent: Utils.round(Utils.safeDiv(ret, sellOut, 0) * 100, 2),
        allocation: Utils.sumBy(list, 'recommendedAllocation')
      };
    });

    var clusters = AllocationEngine.buildClusters(filters);
    var mrSummary = MRService.summarize(mrRows);
    var labels = matrix.meta.monthLabels;

    var charts = {
      mrTrend: {
        id: 'mrTrend', type: 'line', title: 'MR Trend',
        subtitle: 'Persentase Market Return terhadap Sell Out',
        labels: labels,
        target: Settings.getNumber('TARGET_MR_PERCENT', 5),
        series: [{ name: 'MR %', values: trend.map(function (t) { return t.mrPercent; }), format: 'percent' }],
        drill: { dimension: 'month' }
      },
      sellOutTrend: {
        id: 'sellOutTrend', type: 'line', title: 'Sell Out Trend',
        subtitle: 'Pergerakan sell out dan sell in',
        labels: labels,
        series: [
          { name: 'Sell Out', values: trend.map(function (t) { return t.sellOut; }) },
          { name: 'Sell In', values: trend.map(function (t) { return t.sellIn; }) }
        ],
        drill: { dimension: 'month' }
      },
      returnTrend: {
        id: 'returnTrend', type: 'bar', title: 'Return Trend',
        subtitle: 'Volume Market Return per bulan',
        labels: labels,
        series: [{ name: 'Return Qty', values: trend.map(function (t) { return t.returnQty; }) }],
        drill: { dimension: 'month' }
      },
      mrByAccount: {
        id: 'mrByAccount', type: 'hbar', title: 'MR by Account',
        subtitle: 'Top ' + limit + ' account dengan MR% tertinggi',
        items: topN(accountAgg.filter(function (a) { return a.sellOut > 0; }), 'mrPercent', limit)
          .map(function (a) {
            return { id: a.id, label: a.label, value: a.mrPercent, secondary: a.returnQty, format: 'percent' };
          }),
        drill: { dimension: 'account' }
      },
      mrBySku: {
        id: 'mrBySku', type: 'hbar', title: 'MR by SKU',
        subtitle: 'Top ' + limit + ' SKU dengan MR% tertinggi',
        items: topN(skuAgg.filter(function (s) { return s.sellOut > 0; }), 'mrPercent', limit)
          .map(function (s) {
            return { id: s.id, label: s.label, value: s.mrPercent, secondary: s.returnQty, format: 'percent' };
          }),
        drill: { dimension: 'sku' }
      },
      allocationVsSellOut: {
        id: 'allocationVsSellOut', type: 'group', title: 'Allocation vs Sell Out',
        subtitle: 'Rekomendasi allocation dibanding realisasi sell out (top ' + limit + ' account)',
        labels: topN(accountAgg, 'sellOut', limit).map(function (a) { return a.label; }),
        keys: topN(accountAgg, 'sellOut', limit).map(function (a) { return a.id; }),
        series: [
          { name: 'Sell Out', values: topN(accountAgg, 'sellOut', limit).map(function (a) { return a.sellOut; }) },
          { name: 'Recommended Allocation', values: topN(accountAgg, 'sellOut', limit).map(function (a) { return a.allocation; }) }
        ],
        drill: { dimension: 'account' }
      },
      riskDistribution: {
        id: 'riskDistribution', type: 'donut', title: 'Risk Distribution',
        subtitle: 'Sebaran risiko Market Return pada kombinasi account x SKU',
        items: [
          { id: 'HIGH', label: 'High Risk', value: summary.riskDistribution.HIGH, tone: 'danger' },
          { id: 'MEDIUM', label: 'Medium Risk', value: summary.riskDistribution.MEDIUM, tone: 'warning' },
          { id: 'LOW', label: 'Low Risk', value: summary.riskDistribution.LOW, tone: 'success' }
        ],
        drill: { dimension: 'risk' }
      },
      pendingMr: {
        id: 'pendingMr', type: 'bar', title: 'Pending MR',
        subtitle: 'Dokumen MR yang masih berjalan per tahap',
        labels: MR_FLOW.slice(0, MR_FLOW.length - 1).map(function (s) { return s.replace(/_/g, ' '); }),
        keys: MR_FLOW.slice(0, MR_FLOW.length - 1),
        series: [{
          name: 'Dokumen',
          values: MR_FLOW.slice(0, MR_FLOW.length - 1).map(function (status) {
            return mrSummary.byStatus[status] || 0;
          })
        }],
        drill: { dimension: 'mrStatus' }
      },
      soStatus: {
        id: 'soStatus', type: 'donut', title: 'SO Status',
        subtitle: 'Status pembuatan Sales Order dari dokumen MR',
        items: [
          { id: 'CREATED', label: 'SO Created', tone: 'primary',
            value: mrRows.filter(function (r) { return Utils.upper(r.SO_STATUS) === 'CREATED'; }).length },
          { id: 'NOT_CREATED', label: 'Belum SO', tone: 'warning',
            value: mrRows.filter(function (r) {
              return Utils.upper(r.SO_STATUS) !== 'CREATED' && r.MR_STATUS !== 'REJECTED';
            }).length },
          { id: 'REJECTED', label: 'Rejected', tone: 'muted',
            value: mrRows.filter(function (r) { return r.MR_STATUS === 'REJECTED'; }).length }
        ],
        drill: { dimension: 'soStatus' }
      },
      clusterDistribution: {
        id: 'clusterDistribution', type: 'donut', title: 'Cluster Distribution',
        subtitle: 'Hasil clustering potensi account',
        items: [
          { id: 'HIGH', label: 'High Potential', value: clusters.distribution.HIGH, tone: 'success' },
          { id: 'MEDIUM', label: 'Medium Potential', value: clusters.distribution.MEDIUM, tone: 'primary' },
          { id: 'LOW', label: 'Low Potential', value: clusters.distribution.LOW, tone: 'muted' }
        ],
        drill: { dimension: 'cluster' }
      }
    };

    return {
      period: matrix.meta,
      summary: {
        mrPercent: summary.mrPercent,
        totalSellOut: summary.totalSellOut,
        totalReturn: summary.totalReturn,
        totalReturnValue: summary.totalReturnValue,
        recommendedAllocation: summary.recommendedAllocation,
        targetMrPercent: Settings.getNumber('TARGET_MR_PERCENT', 5),
        pendingMr: mrSummary.pending,
        missedPo: mrSummary.missedPo
      },
      charts: charts,
      tables: {
        accountPerformance: Utils.sortBy(accountAgg, [{ key: 'mrPercent', dir: 'desc' }]),
        skuPerformance: Utils.sortBy(skuAgg, [{ key: 'mrPercent', dir: 'desc' }])
      }
    };
  }

  /**
   * Drill-down: mengembalikan baris detail untuk satu titik chart.
   * @param {Object} params {dimension, key, filters}
   */
  function drill(params) {
    var p = params || {};
    var filters = p.filters || {};
    var matrix = AllocationEngine.buildMatrix(filters);
    var rows = AllocationEngine.filterRows(matrix.rows, filters);
    var dimension = Utils.str(p.dimension);
    var key = Utils.str(p.key);
    var title = '';
    var detail = [];

    if (dimension === 'account') {
      title = 'Detail account';
      detail = rows.filter(function (r) { return r.accountId === key; });
    } else if (dimension === 'sku') {
      title = 'Detail SKU';
      detail = rows.filter(function (r) { return r.skuId === key; });
    } else if (dimension === 'risk') {
      title = 'Risk ' + key;
      detail = rows.filter(function (r) { return r.riskLevel === Utils.upper(key); });
    } else if (dimension === 'cluster') {
      title = 'Cluster ' + key;
      detail = rows.filter(function (r) { return r.cluster === Utils.upper(key); });
    } else if (dimension === 'month') {
      title = 'Periode ' + Utils.monthLabel(key);
      var idx = matrix.meta.months.indexOf(key);
      detail = rows.filter(function (r) {
        return idx >= 0 && r.series[idx] && (r.series[idx][1] > 0 || r.series[idx][2] > 0);
      }).map(function (r) {
        // Membentuk object ringan, bukan deep clone, agar tetap hemat saat
        // dataset besar (drill-down bisa menyentuh ribuan pasangan).
        var point = r.series[idx];
        return {
          accountId: r.accountId, accountName: r.accountName, accountCode: r.accountCode,
          skuId: r.skuId, skuName: r.skuName, skuCode: r.skuCode,
          totalSellOut: point[1], totalReturn: point[2],
          mrPercent: Utils.round(Utils.safeDiv(point[2], point[1], 0) * 100, 2),
          currentStock: point[4], riskLevel: r.riskLevel, riskScore: r.riskScore,
          recommendedAllocation: r.recommendedAllocation
        };
      });
    } else if (dimension === 'mrStatus' || dimension === 'soStatus') {
      var accounts = AccountRepo.map();
      var skus = SkuRepo.map();
      var mrRows = MrRepo.all().map(function (mr) { return MRService.presentMr(mr, accounts, skus); });
      var filtered = dimension === 'mrStatus'
        ? mrRows.filter(function (r) { return r.MR_STATUS === Utils.upper(key); })
        : mrRows.filter(function (r) {
          if (Utils.upper(key) === 'CREATED') return Utils.upper(r.SO_STATUS) === 'CREATED';
          if (Utils.upper(key) === 'REJECTED') return r.MR_STATUS === 'REJECTED';
          return Utils.upper(r.SO_STATUS) !== 'CREATED' && r.MR_STATUS !== 'REJECTED';
        });
      return {
        type: 'mr',
        title: 'Dokumen MR - ' + key.replace(/_/g, ' '),
        rows: Utils.sortBy(filtered, [{ key: 'MR_DATE', dir: 'desc' }]).slice(0, 100),
        total: filtered.length
      };
    } else {
      throwError('VALIDATION_ERROR', 'Dimensi drill-down tidak dikenali.');
    }

    return {
      type: 'matrix',
      title: title,
      total: detail.length,
      rows: Utils.sortBy(detail, [{ key: 'mrPercent', dir: 'desc' }]).slice(0, 100).map(function (r) {
        return {
          accountId: r.accountId, accountName: r.accountName, accountCode: r.accountCode,
          skuId: r.skuId, skuName: r.skuName, skuCode: r.skuCode,
          totalSellOut: r.totalSellOut, totalReturn: r.totalReturn, mrPercent: r.mrPercent,
          currentStock: r.currentStock, riskLevel: r.riskLevel, riskScore: r.riskScore,
          recommendedAllocation: r.recommendedAllocation
        };
      })
    };
  }

  // -------------------------------------------------------------------------
  // Report & export
  // -------------------------------------------------------------------------

  var REPORTS = {
    DISTRIBUTION_PLANNING: 'DISTRIBUTION_PLANNING',
    MR: 'MR',
    ACCOUNT_PERFORMANCE: 'ACCOUNT_PERFORMANCE',
    SKU_PERFORMANCE: 'SKU_PERFORMANCE',
    SO_MONITORING: 'SO_MONITORING'
  };

  /** Katalog report yang tersedia di halaman Analytics. */
  function getReportCatalog() {
    return [
      { id: REPORTS.DISTRIBUTION_PLANNING, name: 'Distribution Planning Report', description: 'Rekomendasi allocation, MR%, risiko dan rencana sell in per account x SKU.' },
      { id: REPORTS.MR, name: 'MR Report', description: 'Seluruh dokumen Market Return beserta status workflow dan SLA.' },
      { id: REPORTS.ACCOUNT_PERFORMANCE, name: 'Account Performance Report', description: 'Performa sell out, return, MR% dan cluster per account.' },
      { id: REPORTS.SKU_PERFORMANCE, name: 'SKU Performance Report', description: 'Performa sell out, return dan MR% per SKU.' },
      { id: REPORTS.SO_MONITORING, name: 'SO Monitoring Report', description: 'Status pembuatan SO, jadwal penarikan dan missed PO.' }
    ];
  }

  /** Bangun data report (dipakai preview tabel maupun export CSV). */
  function buildReport(params) {
    var p = params || {};
    var type = Utils.upper(p.type) || REPORTS.DISTRIBUTION_PLANNING;
    var filters = p.filters || {};

    if (type === REPORTS.DISTRIBUTION_PLANNING) {
      return DistributionService.exportRows({ filters: filters });
    }
    if (type === REPORTS.MR) {
      return MRService.exportRows({ filters: filters });
    }
    if (type === REPORTS.SO_MONITORING) {
      var mr = MRService.exportRows({ filters: filters });
      var headers = ['MR_ID', 'MR_DATE', 'ACCOUNT_NAME', 'SKU_NAME', 'RETURN_QTY', 'SO_NUMBER',
        'SO_STATUS', 'PICKUP_DATE', 'CUTOFF_DATE', 'MR_STATUS', 'MISSED_PO', 'SLA_STATUS'];
      return {
        headers: headers,
        rows: mr.rows.map(function (r) { return Utils.pick(r, headers); }),
        filename: 'so-monitoring-report'
      };
    }

    var analytics = getAnalytics({ filters: filters });
    if (type === REPORTS.ACCOUNT_PERFORMANCE) {
      var accHeaders = ['ACCOUNT_CODE', 'ACCOUNT_NAME', 'REGION', 'CLUSTER', 'SELL_OUT', 'RETURN_QTY',
        'RETURN_VALUE', 'MR_PERCENT', 'RECOMMENDED_ALLOCATION'];
      return {
        headers: accHeaders,
        rows: analytics.tables.accountPerformance.map(function (a) {
          return {
            ACCOUNT_CODE: a.code, ACCOUNT_NAME: a.label, REGION: a.region, CLUSTER: a.cluster,
            SELL_OUT: a.sellOut, RETURN_QTY: a.returnQty, RETURN_VALUE: a.returnValue,
            MR_PERCENT: a.mrPercent, RECOMMENDED_ALLOCATION: a.allocation
          };
        }),
        filename: 'account-performance-report'
      };
    }
    if (type === REPORTS.SKU_PERFORMANCE) {
      var skuHeaders = ['SKU_CODE', 'SKU_NAME', 'CATEGORY', 'SELL_OUT', 'RETURN_QTY', 'RETURN_VALUE',
        'MR_PERCENT', 'RECOMMENDED_ALLOCATION'];
      return {
        headers: skuHeaders,
        rows: analytics.tables.skuPerformance.map(function (s) {
          return {
            SKU_CODE: s.code, SKU_NAME: s.label, CATEGORY: s.category, SELL_OUT: s.sellOut,
            RETURN_QTY: s.returnQty, RETURN_VALUE: s.returnValue, MR_PERCENT: s.mrPercent,
            RECOMMENDED_ALLOCATION: s.allocation
          };
        }),
        filename: 'sku-performance-report'
      };
    }
    throwError('VALIDATION_ERROR', 'Jenis report tidak dikenali.');
  }

  /** Export CSV (Excel compatible: BOM + CRLF ditangani di frontend). */
  function exportCsv(session, params) {
    var report = buildReport(params);
    AuditService.log({
      user: session.username, action: AUDIT_ACTIONS.EXPORT, module: AuditService.MODULES.REPORT,
      recordId: (params || {}).type || 'REPORT',
      description: 'Export report ' + ((params || {}).type || '') + ' sebanyak ' + report.rows.length + ' baris.'
    });
    return {
      filename: report.filename + '-' + Utils.formatDate(new Date(), 'yyyyMMdd-HHmm') + '.csv',
      csv: Utils.toCsv(report.headers, report.rows),
      rowCount: report.rows.length
    };
  }

  return {
    getAnalytics: getAnalytics,
    drill: drill,
    getReportCatalog: getReportCatalog,
    buildReport: buildReport,
    exportCsv: exportCsv,
    REPORTS: REPORTS
  };
})();
