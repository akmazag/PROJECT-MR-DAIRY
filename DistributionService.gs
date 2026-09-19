/**
 * PROJECT MR DAIRY
 * ============================================================================
 * DistributionService.gs — Distribution Planning.
 *
 * Berisi:
 *   AllocationEngine     → mesin perhitungan (review data, risk, clustering,
 *                          recommended allocation). Murni, dapat diuji.
 *   DistributionService  → orkestrasi untuk UI (workspace, review, plan sell in).
 *
 * SELURUH ANGKA BISNIS DIBACA DARI SETTINGS. Tidak ada konstanta bisnis
 * yang ditulis langsung di dalam kode.
 *
 * FORMULA (PRD bagian F)
 *   MR%             = Total Return Qty / Total Sell Out Qty x 100   (0 bila pembagi 0)
 *   AVG SELL OUT    = Total Sell Out / jumlah periode
 *   AVG RETURN      = Total Return  / jumlah periode
 *   STOCK MOVEMENT  = Closing Stock - Opening Stock
 *   RECOMMENDED     = (AVG SELL OUT x ALLOCATION_FACTOR x POTENTIAL_FACTOR)
 *                     - CURRENT STOCK
 *                     - (AVG RETURN x RISK_FACTOR)
 * ============================================================================
 */

var AllocationEngine = (function () {

  // -------------------------------------------------------------------------
  // Periode analisis
  // -------------------------------------------------------------------------

  /** Tentukan rentang periode analisis dari filter (default: N bulan terakhir). */
  function resolvePeriod(filters) {
    var f = filters || {};
    var monthsBack = Utils.num(f.months, 0) || Settings.getNumber('ANALYSIS_PERIOD_MONTHS', 6);
    var to = Utils.parseDate(f.dateTo) || Utils.today();
    var from = Utils.parseDate(f.dateFrom) || Utils.startOfMonth(Utils.addMonths(to, -(monthsBack - 1)));
    var months = Utils.monthRange(from, to);
    return {
      from: from,
      to: to,
      months: months,
      periods: Math.max(1, months.length)
    };
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  /** Skor risiko dari MR% (0-100), memakai threshold pada SETTINGS. */
  function mrRiskScore(mrPercent) {
    var medium = Settings.getNumber('MR_THRESHOLD_MEDIUM', 5);
    var high = Settings.getNumber('MR_THRESHOLD_HIGH', 10);
    var mr = Utils.num(mrPercent);
    if (medium <= 0 || high <= medium) return Utils.clamp(mr * 5, 0, 100);
    if (mr <= medium) return (mr / medium) * 50;
    if (mr <= high) return 50 + ((mr - medium) / (high - medium)) * 30;
    return Utils.clamp(80 + ((mr - high) / high) * 20, 0, 100);
  }

  /** Skor risiko dari stock cover (berapa bulan stock menutupi sell out). */
  function stockCoverRiskScore(stockCover, hasSellOut) {
    var medium = Settings.getNumber('RISK_STOCK_COVER_MEDIUM', 1.5);
    var high = Settings.getNumber('RISK_STOCK_COVER_HIGH', 2.5);
    var cover = Utils.num(stockCover);
    if (!hasSellOut) return cover > 0 ? 100 : 0;       // ada stock tanpa sell out = risiko maksimum
    if (medium <= 0 || high <= medium) return Utils.clamp(cover * 30, 0, 100);
    if (cover <= medium) return (cover / medium) * 50;
    if (cover <= high) return 50 + ((cover - medium) / (high - medium)) * 30;
    return Utils.clamp(80 + ((cover - high) / high) * 20, 0, 100);
  }

  /** Skor risiko dari shelf life: makin pendek umur produk makin berisiko. */
  function shelfLifeRiskScore(shelfLifeDays) {
    var shortDays = Settings.getNumber('RISK_SHELF_LIFE_SHORT_DAYS', 45);
    var days = Utils.num(shelfLifeDays);
    if (!days) return 50;
    if (shortDays <= 0) return 50;
    if (days <= shortDays) return Utils.clamp(100 - (days / shortDays) * 50, 50, 100);
    return Utils.clamp(50 - ((days - shortDays) / shortDays) * 50, 0, 50);
  }

  /** Skor risiko dari tren sell out: tren menurun menaikkan risiko. */
  function trendRiskScore(trendPercent) {
    return Utils.clamp(50 - Utils.num(trendPercent), 0, 100);
  }

  /**
   * Skor risiko gabungan (multi indikator, bukan satu indikator saja).
   * @return {{score:number, level:string, components:Object}}
   */
  function computeRisk(input) {
    var weights = {
      mr: Settings.getNumber('RISK_WEIGHT_MR', 0.4),
      cover: Settings.getNumber('RISK_WEIGHT_STOCK_COVER', 0.3),
      shelf: Settings.getNumber('RISK_WEIGHT_SHELF_LIFE', 0.2),
      trend: Settings.getNumber('RISK_WEIGHT_SELL_OUT_TREND', 0.1)
    };
    var components = {
      mr: mrRiskScore(input.mrPercent),
      cover: stockCoverRiskScore(input.stockCover, input.avgSellOut > 0),
      shelf: shelfLifeRiskScore(input.shelfLifeDays),
      trend: trendRiskScore(input.trendPercent)
    };
    var totalWeight = weights.mr + weights.cover + weights.shelf + weights.trend;
    if (totalWeight <= 0) totalWeight = 1;
    var score = (components.mr * weights.mr + components.cover * weights.cover
      + components.shelf * weights.shelf + components.trend * weights.trend) / totalWeight;
    score = Utils.round(Utils.clamp(score, 0, 100), 1);

    var highAt = Settings.getNumber('RISK_SCORE_HIGH', 65);
    var mediumAt = Settings.getNumber('RISK_SCORE_MEDIUM', 40);
    var level = score >= highAt ? 'HIGH' : (score >= mediumAt ? 'MEDIUM' : 'LOW');
    return { score: score, level: level, components: components, weights: weights };
  }

  /** Faktor potensi account dari SETTINGS. */
  function potentialFactor(potential) {
    var key = 'POTENTIAL_FACTOR_' + (Utils.upper(potential) || 'MEDIUM');
    return Settings.getNumber(key, 1);
  }

  /**
   * Recommended Allocation.
   * Seluruh komponen formula configurable melalui SETTINGS.
   */
  function computeRecommendation(input) {
    var allocationFactor = Settings.getNumber('ALLOCATION_FACTOR', 1.1);
    var riskFactor = Settings.getNumber('RISK_FACTOR', 1);
    var deductStock = Settings.getBool('ALLOCATION_STOCK_DEDUCTION', true);
    var rounding = Settings.getNumber('ALLOCATION_ROUNDING', 1);
    var minimum = Settings.getNumber('ALLOCATION_MIN', 0);

    var potFactor = potentialFactor(input.potential);
    var demand = Utils.num(input.avgSellOut) * allocationFactor * potFactor;
    var stockDeduction = deductStock ? Utils.num(input.currentStock) : 0;
    var riskAdjustment = Utils.num(input.avgReturn) * riskFactor;
    var raw = demand - stockDeduction - riskAdjustment;
    var value = Math.max(minimum, Utils.roundToStep(raw, rounding));

    return {
      value: value,
      breakdown: {
        avgSellOut: Utils.round(Utils.num(input.avgSellOut), 2),
        allocationFactor: allocationFactor,
        potentialFactor: potFactor,
        demand: Utils.round(demand, 2),
        currentStock: Utils.num(input.currentStock),
        stockDeducted: deductStock,
        avgReturn: Utils.round(Utils.num(input.avgReturn), 2),
        riskFactor: riskFactor,
        riskAdjustment: Utils.round(riskAdjustment, 2),
        raw: Utils.round(raw, 2),
        rounding: rounding,
        minimum: minimum
      },
      formula: '(' + Utils.round(input.avgSellOut, 2) + ' x ' + allocationFactor + ' x ' + potFactor + ')'
        + (deductStock ? ' - ' + Utils.num(input.currentStock) : '')
        + ' - (' + Utils.round(input.avgReturn, 2) + ' x ' + riskFactor + ') = ' + Utils.round(raw, 2)
    };
  }

  // -------------------------------------------------------------------------
  // Matrix Account x SKU
  // -------------------------------------------------------------------------

  function emptyBucket() {
    return {
      sellIn: 0, sellOut: 0, salesValue: 0, returnQty: 0, returnValue: 0,
      opening: null, closing: null, openingDate: null, closingDate: null,
      lastStockQty: null, lastStockDate: null, months: {}
    };
  }

  function monthBucket(bucket, key) {
    if (!bucket.months[key]) {
      bucket.months[key] = { sellIn: 0, sellOut: 0, salesValue: 0, returnQty: 0, returnValue: 0, closing: null, opening: null };
    }
    return bucket.months[key];
  }

  /** Hitung seluruh metrik per kombinasi Account x SKU pada satu periode. */
  function computeMatrix(period) {
    var accounts = AccountRepo.map();
    var skus = SkuRepo.map();
    var sales = SalesRepo.inRange(period.from, period.to);
    var returns = ReturnRepo.inRange(period.from, period.to);
    var stock = StockRepo.inRange(period.from, period.to);

    var buckets = {};
    function bucketFor(accountId, skuId) {
      var key = accountId + '|' + skuId;
      if (!buckets[key]) buckets[key] = emptyBucket();
      return buckets[key];
    }

    sales.forEach(function (row) {
      var b = bucketFor(row.ACCOUNT_ID, row.SKU_ID);
      var mk = Utils.monthKey(row.DATE);
      var m = monthBucket(b, mk);
      b.sellIn += Utils.num(row.SELL_IN_QTY);
      b.sellOut += Utils.num(row.SELL_OUT_QTY);
      b.salesValue += Utils.num(row.SALES_VALUE);
      m.sellIn += Utils.num(row.SELL_IN_QTY);
      m.sellOut += Utils.num(row.SELL_OUT_QTY);
      m.salesValue += Utils.num(row.SALES_VALUE);
      var d = Utils.parseDate(row.DATE);
      if (d && (!b.lastStockDate || d >= b.lastStockDate)) {
        b.lastStockDate = d;
        b.lastStockQty = Utils.num(row.STOCK_QTY);
      }
    });

    returns.forEach(function (row) {
      var b = bucketFor(row.ACCOUNT_ID, row.SKU_ID);
      var mk = Utils.monthKey(row.RETURN_DATE);
      var m = monthBucket(b, mk);
      b.returnQty += Utils.num(row.RETURN_QTY);
      b.returnValue += Utils.num(row.RETURN_VALUE);
      m.returnQty += Utils.num(row.RETURN_QTY);
      m.returnValue += Utils.num(row.RETURN_VALUE);
    });

    stock.forEach(function (row) {
      var b = bucketFor(row.ACCOUNT_ID, row.SKU_ID);
      var mk = Utils.monthKey(row.DATE);
      var m = monthBucket(b, mk);
      var d = Utils.parseDate(row.DATE);
      m.opening = Utils.num(row.OPENING_STOCK);
      m.closing = Utils.num(row.CLOSING_STOCK);
      if (d && (!b.openingDate || d < b.openingDate)) {
        b.openingDate = d;
        b.opening = Utils.num(row.OPENING_STOCK);
      }
      if (d && (!b.closingDate || d >= b.closingDate)) {
        b.closingDate = d;
        b.closing = Utils.num(row.CLOSING_STOCK);
      }
    });

    var rows = [];
    Object.keys(buckets).forEach(function (key) {
      var parts = key.split('|');
      var account = accounts[parts[0]];
      var sku = skus[parts[1]];
      if (!account || !sku) return;                    // data yatim diabaikan
      var b = buckets[key];

      var periods = period.periods;
      var avgSellOut = Utils.safeDiv(b.sellOut, periods);
      var avgReturn = Utils.safeDiv(b.returnQty, periods);
      var mrPercent = Utils.safeDiv(b.returnQty, b.sellOut, 0) * 100;   // pembagi 0 → 0
      var currentStock = b.closing !== null ? b.closing
        : (b.lastStockQty !== null ? b.lastStockQty : 0);
      var stockMovement = (b.closing !== null && b.opening !== null) ? (b.closing - b.opening) : 0;
      var stockCover = Utils.safeDiv(currentStock, avgSellOut, currentStock > 0 ? 99 : 0);

      // Tren sell out: periode terakhir vs rata-rata periode sebelumnya
      var series = period.months.map(function (mk) {
        var m = b.months[mk];
        return m ? m : { sellIn: 0, sellOut: 0, salesValue: 0, returnQty: 0, returnValue: 0, closing: null, opening: null };
      });
      var lastSellOut = series.length ? series[series.length - 1].sellOut : 0;
      var priorMonths = series.slice(0, Math.max(0, series.length - 1));
      var priorAvg = priorMonths.length ? Utils.sumBy(priorMonths, 'sellOut') / priorMonths.length : 0;
      var trendPercent = priorAvg > 0 ? ((lastSellOut - priorAvg) / priorAvg) * 100 : 0;

      var potential = Utils.upper(account.POTENTIAL_LEVEL) || 'MEDIUM';
      var risk = computeRisk({
        mrPercent: mrPercent,
        stockCover: stockCover,
        avgSellOut: avgSellOut,
        shelfLifeDays: Utils.num(sku.SHELF_LIFE_DAYS),
        trendPercent: trendPercent
      });
      var recommendation = computeRecommendation({
        avgSellOut: avgSellOut,
        avgReturn: avgReturn,
        currentStock: currentStock,
        potential: potential
      });

      rows.push({
        key: key,
        accountId: account.ACCOUNT_ID,
        accountCode: account.ACCOUNT_CODE,
        accountName: account.ACCOUNT_NAME,
        channel: account.CHANNEL,
        region: account.REGION,
        area: account.AREA,
        city: account.CITY,
        cluster: Utils.upper(account.CLUSTER) || potential,
        potential: potential,
        skuId: sku.SKU_ID,
        skuCode: sku.SKU_CODE,
        skuName: sku.SKU_NAME,
        category: sku.CATEGORY,
        brand: sku.BRAND,
        unit: sku.UNIT,
        shelfLifeDays: Utils.num(sku.SHELF_LIFE_DAYS),
        totalSellIn: Utils.round(b.sellIn, 0),
        totalSellOut: Utils.round(b.sellOut, 0),
        totalSalesValue: Utils.round(b.salesValue, 0),
        totalReturn: Utils.round(b.returnQty, 0),
        totalReturnValue: Utils.round(b.returnValue, 0),
        avgSellOut: Utils.round(avgSellOut, 1),
        avgReturn: Utils.round(avgReturn, 1),
        mrPercent: Utils.round(mrPercent, 2),
        currentStock: Utils.round(currentStock, 0),
        stockMovement: Utils.round(stockMovement, 0),
        stockCover: Utils.round(stockCover, 2),
        trendPercent: Utils.round(trendPercent, 1),
        riskScore: risk.score,
        riskLevel: risk.level,
        riskComponents: {
          mr: Utils.round(risk.components.mr, 1),
          cover: Utils.round(risk.components.cover, 1),
          shelf: Utils.round(risk.components.shelf, 1),
          trend: Utils.round(risk.components.trend, 1)
        },
        recommendedAllocation: recommendation.value,
        recommendationFormula: recommendation.formula,
        periods: periods,
        series: series.map(function (m) {
          return [
            Utils.round(m.sellIn, 0), Utils.round(m.sellOut, 0), Utils.round(m.returnQty, 0),
            Utils.round(m.salesValue, 0), m.closing === null ? 0 : Utils.round(m.closing, 0)
          ];
        })
      });
    });

    return {
      rows: rows,
      meta: {
        from: Utils.toIsoDate(period.from),
        to: Utils.toIsoDate(period.to),
        periods: period.periods,
        months: period.months,
        monthLabels: period.months.map(Utils.monthLabel),
        generatedAt: Utils.toIsoDateTime(new Date())
      }
    };
  }

  /** Matrix dengan cache (invalidate otomatis saat ada write ke database). */
  function buildMatrix(filters) {
    var period = resolvePeriod(filters || {});
    var key = 'MATRIX_' + DB.hashKey({ f: Utils.toIsoDate(period.from), t: Utils.toIsoDate(period.to) });
    return DB.remember(key, Settings.getNumber('CACHE_TTL_SECONDS', 300), function () {
      return computeMatrix(period);
    });
  }

  // -------------------------------------------------------------------------
  // Filter dimensi
  // -------------------------------------------------------------------------

  function matchFilters(row, filters) {
    var f = filters || {};
    function listHas(list, value) {
      if (!list || !list.length) return true;
      return [].concat(list).indexOf(value) !== -1;
    }
    if (!listHas(f.accountIds, row.accountId)) return false;
    if (!listHas(f.skuIds, row.skuId)) return false;
    if (f.region && Utils.upper(row.region) !== Utils.upper(f.region)) return false;
    if (f.area && Utils.upper(row.area) !== Utils.upper(f.area)) return false;
    if (f.channel && Utils.upper(row.channel) !== Utils.upper(f.channel)) return false;
    if (f.cluster && Utils.upper(row.cluster) !== Utils.upper(f.cluster)) return false;
    if (f.potential && Utils.upper(row.potential) !== Utils.upper(f.potential)) return false;
    if (f.category && Utils.upper(row.category) !== Utils.upper(f.category)) return false;
    if (f.brand && Utils.upper(row.brand) !== Utils.upper(f.brand)) return false;
    if (f.risk && Utils.upper(row.riskLevel) !== Utils.upper(f.risk)) return false;
    if (f.q) {
      var hay = Utils.normalize([row.accountCode, row.accountName, row.skuCode, row.skuName,
        row.region, row.area, row.city].join(' '));
      if (hay.indexOf(Utils.normalize(f.q)) === -1) return false;
    }
    return true;
  }

  function filterRows(rows, filters) {
    if (!filters) return rows;
    return rows.filter(function (row) { return matchFilters(row, filters); });
  }

  // -------------------------------------------------------------------------
  // Agregasi
  // -------------------------------------------------------------------------

  /** Ringkasan KPI dari sekumpulan baris matrix. */
  function summarize(rows, meta) {
    var totalSellOut = Utils.sumBy(rows, 'totalSellOut');
    var totalReturn = Utils.sumBy(rows, 'totalReturn');
    var totalSellIn = Utils.sumBy(rows, 'totalSellIn');
    var periods = (meta && meta.periods) ? meta.periods : 1;
    var accountIds = Utils.uniq(rows.map(function (r) { return r.accountId; }));
    var skuIds = Utils.uniq(rows.map(function (r) { return r.skuId; }));
    return {
      totalAccount: accountIds.length,
      totalSku: skuIds.length,
      totalPairs: rows.length,
      totalSellIn: totalSellIn,
      totalSellOut: totalSellOut,
      totalReturn: totalReturn,
      totalReturnValue: Utils.sumBy(rows, 'totalReturnValue'),
      totalSalesValue: Utils.sumBy(rows, 'totalSalesValue'),
      avgSellOut: Utils.round(Utils.safeDiv(totalSellOut, periods), 1),
      avgReturn: Utils.round(Utils.safeDiv(totalReturn, periods), 1),
      mrPercent: Utils.round(Utils.safeDiv(totalReturn, totalSellOut, 0) * 100, 2),
      recommendedAllocation: Utils.sumBy(rows, 'recommendedAllocation'),
      currentStock: Utils.sumBy(rows, 'currentStock'),
      riskDistribution: {
        HIGH: rows.filter(function (r) { return r.riskLevel === 'HIGH'; }).length,
        MEDIUM: rows.filter(function (r) { return r.riskLevel === 'MEDIUM'; }).length,
        LOW: rows.filter(function (r) { return r.riskLevel === 'LOW'; }).length
      }
    };
  }

  /** Tren bulanan agregat dari baris matrix (memakai series per pair). */
  function monthlyTrend(rows, meta) {
    var months = (meta && meta.months) ? meta.months : [];
    var series = months.map(function (key, idx) {
      var sellIn = 0, sellOut = 0, returnQty = 0, salesValue = 0, stock = 0;
      rows.forEach(function (row) {
        var point = row.series && row.series[idx];
        if (!point) return;
        sellIn += point[0]; sellOut += point[1]; returnQty += point[2];
        salesValue += point[3]; stock += point[4];
      });
      return {
        key: key,
        label: Utils.monthLabel(key),
        sellIn: sellIn,
        sellOut: sellOut,
        returnQty: returnQty,
        salesValue: salesValue,
        stock: stock,
        mrPercent: Utils.round(Utils.safeDiv(returnQty, sellOut, 0) * 100, 2)
      };
    });
    return series;
  }

  // -------------------------------------------------------------------------
  // Clustering account
  // -------------------------------------------------------------------------

  /**
   * Clustering account berdasarkan beberapa indikator sekaligus:
   * average sell out, historical sales value, MR% (inverse) dan stock movement.
   */
  function buildClusters(filters) {
    var matrix = buildMatrix(filters);
    var rows = filterRows(matrix.rows, filters);
    var byAccount = Utils.groupBy(rows, 'accountId');
    var accounts = AccountRepo.map();

    var aggregates = Object.keys(byAccount).map(function (accountId) {
      var list = byAccount[accountId];
      var account = accounts[accountId] || {};
      var totalSellOut = Utils.sumBy(list, 'totalSellOut');
      var totalReturn = Utils.sumBy(list, 'totalReturn');
      var salesValue = Utils.sumBy(list, 'totalSalesValue');
      var periods = matrix.meta.periods;
      return {
        accountId: accountId,
        accountCode: account.ACCOUNT_CODE || '',
        accountName: account.ACCOUNT_NAME || accountId,
        channel: account.CHANNEL || '',
        region: account.REGION || '',
        area: account.AREA || '',
        city: account.CITY || '',
        currentCluster: Utils.upper(account.CLUSTER) || 'MEDIUM',
        currentPotential: Utils.upper(account.POTENTIAL_LEVEL) || 'MEDIUM',
        skuCount: list.length,
        totalSellOut: totalSellOut,
        totalReturn: totalReturn,
        totalSalesValue: salesValue,
        avgSellOut: Utils.round(Utils.safeDiv(totalSellOut, periods), 1),
        avgReturn: Utils.round(Utils.safeDiv(totalReturn, periods), 1),
        mrPercent: Utils.round(Utils.safeDiv(totalReturn, totalSellOut, 0) * 100, 2),
        stockMovement: Utils.sumBy(list, 'stockMovement'),
        currentStock: Utils.sumBy(list, 'currentStock'),
        recommendedAllocation: Utils.sumBy(list, 'recommendedAllocation'),
        highRiskSku: list.filter(function (r) { return r.riskLevel === 'HIGH'; }).length
      };
    });

    var sellOutStats = Utils.minMax(aggregates.map(function (a) { return a.avgSellOut; }));
    var valueStats = Utils.minMax(aggregates.map(function (a) { return a.totalSalesValue; }));
    var movementStats = Utils.minMax(aggregates.map(function (a) { return a.stockMovement; }));

    var weights = {
      sellOut: Settings.getNumber('CLUSTER_WEIGHT_SELL_OUT', 0.45),
      value: Settings.getNumber('CLUSTER_WEIGHT_SALES_VALUE', 0.25),
      mr: Settings.getNumber('CLUSTER_WEIGHT_MR', 0.2),
      movement: Settings.getNumber('CLUSTER_WEIGHT_STOCK_MOVEMENT', 0.1)
    };
    var totalWeight = weights.sellOut + weights.value + weights.mr + weights.movement;
    if (totalWeight <= 0) totalWeight = 1;
    var highAt = Settings.getNumber('CLUSTER_SCORE_HIGH', 65);
    var mediumAt = Settings.getNumber('CLUSTER_SCORE_MEDIUM', 35);

    aggregates.forEach(function (a) {
      var sellOutScore = Utils.normalizeScore(a.avgSellOut, sellOutStats.min, sellOutStats.max);
      var valueScore = Utils.normalizeScore(a.totalSalesValue, valueStats.min, valueStats.max);
      var mrScore = 100 - mrRiskScore(a.mrPercent);                       // MR rendah = potensi baik
      var movementScore = 100 - Utils.normalizeScore(a.stockMovement, movementStats.min, movementStats.max);
      var score = (sellOutScore * weights.sellOut + valueScore * weights.value
        + mrScore * weights.mr + movementScore * weights.movement) / totalWeight;
      a.scoreComponents = {
        sellOut: Utils.round(sellOutScore, 1),
        salesValue: Utils.round(valueScore, 1),
        mr: Utils.round(mrScore, 1),
        stockMovement: Utils.round(movementScore, 1)
      };
      a.score = Utils.round(Utils.clamp(score, 0, 100), 1);
      a.suggestedCluster = a.score >= highAt ? 'HIGH' : (a.score >= mediumAt ? 'MEDIUM' : 'LOW');
      a.changed = a.suggestedCluster !== a.currentCluster;
    });

    return {
      rows: Utils.sortBy(aggregates, [{ key: 'score', dir: 'desc' }]),
      meta: matrix.meta,
      thresholds: { high: highAt, medium: mediumAt },
      weights: weights,
      distribution: {
        HIGH: aggregates.filter(function (a) { return a.suggestedCluster === 'HIGH'; }).length,
        MEDIUM: aggregates.filter(function (a) { return a.suggestedCluster === 'MEDIUM'; }).length,
        LOW: aggregates.filter(function (a) { return a.suggestedCluster === 'LOW'; }).length
      }
    };
  }

  return {
    resolvePeriod: resolvePeriod,
    computeRisk: computeRisk,
    computeRecommendation: computeRecommendation,
    computeMatrix: computeMatrix,
    buildMatrix: buildMatrix,
    filterRows: filterRows,
    matchFilters: matchFilters,
    summarize: summarize,
    monthlyTrend: monthlyTrend,
    buildClusters: buildClusters,
    mrRiskScore: mrRiskScore,
    potentialFactor: potentialFactor
  };
})();


// ===========================================================================
// DistributionService — orkestrasi untuk UI
// ===========================================================================
var DistributionService = (function () {

  /** Index plan terakhir per Account x SKU untuk join ke tabel allocation. */
  function latestPlanIndex() {
    var plans = Utils.sortBy(AllocationRepo.all(), [{ key: 'PLAN_DATE', dir: 'asc' }]);
    var index = {};
    plans.forEach(function (plan) {
      index[plan.ACCOUNT_ID + '|' + plan.SKU_ID] = plan;   // terakhir menang
    });
    return index;
  }

  var SORT_PRESETS = {
    risk: [{ key: 'riskScore', dir: 'desc' }, { key: 'mrPercent', dir: 'desc' }],
    mr: [{ key: 'mrPercent', dir: 'desc' }, { key: 'totalReturn', dir: 'desc' }],
    allocation: [{ key: 'recommendedAllocation', dir: 'desc' }],
    sellout: [{ key: 'totalSellOut', dir: 'desc' }],
    account: [{ key: 'accountName', dir: 'asc', type: 'text' }, { key: 'skuName', dir: 'asc', type: 'text' }]
  };

  function resolveSort(sort) {
    if (!sort) return SORT_PRESETS.risk;
    if (typeof sort === 'string') return SORT_PRESETS[sort] || SORT_PRESETS.risk;
    if (sort.key) return [{ key: sort.key, dir: sort.dir || 'desc', type: sort.type }];
    return SORT_PRESETS.risk;
  }

  /**
   * Workspace Distribution Planning: KPI + trend + tabel allocation.
   * Seluruh pemrosesan dilakukan server-side (filter, sort, pagination).
   */
  function getWorkspace(params) {
    var p = params || {};
    var filters = p.filters || {};
    var matrix = AllocationEngine.buildMatrix(filters);
    var rows = AllocationEngine.filterRows(matrix.rows, filters);
    var planIndex = latestPlanIndex();

    var enriched = rows.map(function (row) {
      var plan = planIndex[row.accountId + '|' + row.skuId];
      return {
        key: row.key,
        accountId: row.accountId,
        accountCode: row.accountCode,
        accountName: row.accountName,
        region: row.region,
        area: row.area,
        channel: row.channel,
        cluster: row.cluster,
        skuId: row.skuId,
        skuCode: row.skuCode,
        skuName: row.skuName,
        category: row.category,
        avgSellOut: row.avgSellOut,
        avgReturn: row.avgReturn,
        mrPercent: row.mrPercent,
        currentStock: row.currentStock,
        stockMovement: row.stockMovement,
        stockCover: row.stockCover,
        potential: row.potential,
        recommendedAllocation: row.recommendedAllocation,
        plannedSellIn: plan ? Utils.num(plan.PLANNED_SELL_IN) : null,
        planId: plan ? plan.ALLOCATION_ID : null,
        planStatus: plan ? Utils.upper(plan.STATUS) : 'NOT_PLANNED',
        planDate: plan ? Utils.toIsoDate(plan.PLAN_DATE) : '',
        overrideReason: plan ? plan.OVERRIDE_REASON : '',
        riskLevel: row.riskLevel,
        riskScore: row.riskScore,
        trendPercent: row.trendPercent
      };
    });

    var sorted = Utils.sortBy(enriched, resolveSort(p.sort));
    var paged = Utils.paginate(sorted, p.page, p.pageSize || Settings.getNumber('DEFAULT_PAGE_SIZE', 25));
    var summary = AllocationEngine.summarize(rows, matrix.meta);

    return {
      kpi: {
        totalAccount: summary.totalAccount,
        totalSku: summary.totalSku,
        avgSellOut: summary.avgSellOut,
        avgReturn: summary.avgReturn,
        mrPercent: summary.mrPercent,
        recommendedAllocation: summary.recommendedAllocation,
        targetMrPercent: Settings.getNumber('TARGET_MR_PERCENT', 5),
        plannedSellIn: Utils.sumBy(enriched, function (r) { return r.plannedSellIn; })
      },
      trend: AllocationEngine.monthlyTrend(rows, matrix.meta),
      riskDistribution: summary.riskDistribution,
      rows: paged.rows,
      meta: paged.meta,
      period: matrix.meta,
      sort: p.sort || 'risk'
    };
  }

  /**
   * Review Data (PRD bagian H): profil account + histori + rekomendasi.
   * skuId opsional → bila kosong, review dilakukan pada level account.
   */
  function getReview(params) {
    var p = params || {};
    if (!p.accountId) throwError('VALIDATION_ERROR', 'Account wajib dipilih untuk melakukan review.');
    var filters = p.filters || {};
    var matrix = AllocationEngine.buildMatrix(filters);
    var account = AccountRepo.byId(p.accountId);
    if (!account) throwError('NOT_FOUND', 'Account tidak ditemukan.');

    var rows = matrix.rows.filter(function (r) {
      return r.accountId === p.accountId && (!p.skuId || r.skuId === p.skuId);
    });
    if (!rows.length) {
      return {
        account: toDto(SHEETS.ACCOUNT_MASTER, account),
        sku: p.skuId ? toDto(SHEETS.SKU_MASTER, SkuRepo.byId(p.skuId)) : null,
        empty: true,
        period: matrix.meta,
        message: 'Belum ada transaksi pada periode ini untuk account tersebut.'
      };
    }

    var summary = AllocationEngine.summarize(rows, matrix.meta);
    var trend = AllocationEngine.monthlyTrend(rows, matrix.meta);
    var focus = rows.length === 1 ? rows[0] : null;

    // Riwayat plan untuk pasangan yang sedang direview
    var planHistory = AllocationRepo.all().filter(function (plan) {
      return plan.ACCOUNT_ID === p.accountId && (!p.skuId || plan.SKU_ID === p.skuId);
    });
    planHistory = Utils.sortBy(planHistory, [{ key: 'PLAN_DATE', dir: 'desc' }]).slice(0, 10);

    return {
      account: toDto(SHEETS.ACCOUNT_MASTER, account),
      sku: p.skuId ? toDto(SHEETS.SKU_MASTER, SkuRepo.byId(p.skuId)) : null,
      empty: false,
      kpi: {
        totalSellOut: summary.totalSellOut,
        totalReturn: summary.totalReturn,
        totalSellIn: summary.totalSellIn,
        avgSellOut: summary.avgSellOut,
        avgReturn: summary.avgReturn,
        mrPercent: summary.mrPercent,
        currentStock: summary.currentStock,
        stockMovement: Utils.sumBy(rows, 'stockMovement'),
        recommendedAllocation: summary.recommendedAllocation,
        riskLevel: focus ? focus.riskLevel : null,
        riskScore: focus ? focus.riskScore : null,
        riskComponents: focus ? focus.riskComponents : null,
        recommendationFormula: focus ? focus.recommendationFormula : null,
        targetMrPercent: Settings.getNumber('TARGET_MR_PERCENT', 5)
      },
      trend: trend,
      skuBreakdown: Utils.sortBy(rows, [{ key: 'mrPercent', dir: 'desc' }]).map(function (r) {
        return {
          skuId: r.skuId, skuCode: r.skuCode, skuName: r.skuName, category: r.category,
          totalSellOut: r.totalSellOut, totalReturn: r.totalReturn, mrPercent: r.mrPercent,
          currentStock: r.currentStock, stockMovement: r.stockMovement,
          riskLevel: r.riskLevel, riskScore: r.riskScore,
          recommendedAllocation: r.recommendedAllocation
        };
      }),
      planHistory: planHistory.map(function (plan) {
        return {
          ALLOCATION_ID: plan.ALLOCATION_ID,
          PLAN_DATE: Utils.toIsoDate(plan.PLAN_DATE),
          SKU_ID: plan.SKU_ID,
          RECOMMENDED_ALLOCATION: Utils.num(plan.RECOMMENDED_ALLOCATION),
          PLANNED_SELL_IN: Utils.num(plan.PLANNED_SELL_IN),
          OVERRIDE_REASON: plan.OVERRIDE_REASON,
          STATUS: plan.STATUS,
          CREATED_BY: plan.CREATED_BY
        };
      }),
      period: matrix.meta
    };
  }

  /** Determine Plan Sell In (PRD bagian I): detail rekomendasi 1 pasangan. */
  function getPlanPreview(params) {
    var p = params || {};
    if (!p.accountId || !p.skuId) {
      throwError('VALIDATION_ERROR', 'Account dan SKU wajib dipilih.');
    }
    var matrix = AllocationEngine.buildMatrix(p.filters || {});
    var row = null;
    for (var i = 0; i < matrix.rows.length; i++) {
      if (matrix.rows[i].accountId === p.accountId && matrix.rows[i].skuId === p.skuId) {
        row = matrix.rows[i];
        break;
      }
    }
    if (!row) {
      var account = AccountRepo.byId(p.accountId);
      var sku = SkuRepo.byId(p.skuId);
      if (!account || !sku) throwError('NOT_FOUND', 'Account atau SKU tidak ditemukan.');
      var recommendation = AllocationEngine.computeRecommendation({
        avgSellOut: 0, avgReturn: 0, currentStock: 0, potential: account.POTENTIAL_LEVEL
      });
      return {
        empty: true,
        accountId: p.accountId, skuId: p.skuId,
        accountName: account.ACCOUNT_NAME, skuName: sku.SKU_NAME,
        avgSellOut: 0, avgReturn: 0, mrPercent: 0, currentStock: 0, stockMovement: 0,
        potential: Utils.upper(account.POTENTIAL_LEVEL), riskLevel: 'LOW', riskScore: 0,
        recommendedAllocation: recommendation.value,
        breakdown: recommendation.breakdown,
        formula: recommendation.formula,
        period: matrix.meta,
        message: 'Belum ada histori transaksi. Rekomendasi dihitung dari nilai nol.'
      };
    }

    var detail = AllocationEngine.computeRecommendation({
      avgSellOut: row.avgSellOut, avgReturn: row.avgReturn,
      currentStock: row.currentStock, potential: row.potential
    });
    var existing = AllocationRepo.latestFor(p.accountId, p.skuId);

    return {
      empty: false,
      accountId: row.accountId, accountCode: row.accountCode, accountName: row.accountName,
      skuId: row.skuId, skuCode: row.skuCode, skuName: row.skuName, unit: row.unit,
      totalSellOut: row.totalSellOut, totalReturn: row.totalReturn,
      avgSellOut: row.avgSellOut, avgReturn: row.avgReturn, mrPercent: row.mrPercent,
      currentStock: row.currentStock, stockMovement: row.stockMovement, stockCover: row.stockCover,
      potential: row.potential, cluster: row.cluster,
      riskLevel: row.riskLevel, riskScore: row.riskScore, riskComponents: row.riskComponents,
      trendPercent: row.trendPercent,
      recommendedAllocation: row.recommendedAllocation,
      breakdown: detail.breakdown,
      formula: detail.formula,
      series: row.series,
      months: matrix.meta.monthLabels,
      existingPlan: existing ? {
        ALLOCATION_ID: existing.ALLOCATION_ID,
        PLAN_DATE: Utils.toIsoDate(existing.PLAN_DATE),
        PLANNED_SELL_IN: Utils.num(existing.PLANNED_SELL_IN),
        RECOMMENDED_ALLOCATION: Utils.num(existing.RECOMMENDED_ALLOCATION),
        STATUS: existing.STATUS,
        OVERRIDE_REASON: existing.OVERRIDE_REASON
      } : null,
      overrideRequiresReason: Settings.getBool('ALLOCATION_OVERRIDE_REASON_REQUIRED', true),
      overrideTolerancePercent: Settings.getNumber('ALLOCATION_OVERRIDE_TOLERANCE_PERCENT', 0),
      period: matrix.meta
    };
  }

  /** Apakah nilai final dianggap manual override terhadap rekomendasi. */
  function isOverride(recommended, planned) {
    var tolerance = Settings.getNumber('ALLOCATION_OVERRIDE_TOLERANCE_PERCENT', 0);
    var rec = Utils.num(recommended);
    var plan = Utils.num(planned);
    if (rec === plan) return false;
    if (rec === 0) return plan !== 0;
    var deviation = Math.abs((plan - rec) / rec) * 100;
    return deviation > tolerance;
  }

  /**
   * Simpan plan sell in (satu atau banyak baris sekaligus).
   * Wajib menyimpan: rekomendasi awal, nilai final, alasan override, user, waktu.
   */
  function savePlan(session, payload) {
    var items = [].concat((payload && payload.items) || []);
    if (!items.length) throwError('VALIDATION_ERROR', 'Tidak ada baris rencana yang dikirim.');

    var planDate = Utils.parseDate(payload.planDate) || Utils.today();
    var matrix = AllocationEngine.buildMatrix(payload.filters || {});
    var matrixIndex = {};
    matrix.rows.forEach(function (r) { matrixIndex[r.accountId + '|' + r.skuId] = r; });

    var existingPlans = AllocationRepo.all();
    var existingIndex = {};
    existingPlans.forEach(function (plan) {
      existingIndex[plan.ACCOUNT_ID + '|' + plan.SKU_ID + '|' + Utils.toIsoDate(plan.PLAN_DATE)] = plan;
    });

    var requireReason = Settings.getBool('ALLOCATION_OVERRIDE_REASON_REQUIRED', true);
    var inserts = [];
    var updates = [];
    var auditEntries = [];
    var now = new Date();
    var status = Utils.upper(payload.status) || 'DRAFT';
    if (ENUMS.ALLOCATION_STATUS.indexOf(status) === -1) status = 'DRAFT';

    items.forEach(function (item) {
      var key = item.accountId + '|' + item.skuId;
      var metric = matrixIndex[key];
      if (!metric) {
        throwError('VALIDATION_ERROR',
          'Kombinasi account dan SKU tidak memiliki data pada periode ini sehingga tidak dapat direncanakan.');
      }
      var planned = Utils.num(item.plannedSellIn, null);
      if (planned === null || planned < 0 || !isFinite(planned)) {
        throwError('VALIDATION_ERROR', 'Planned Sell In harus berupa angka >= 0.');
      }
      var override = isOverride(metric.recommendedAllocation, planned);
      var reason = Utils.str(item.overrideReason);
      if (override && requireReason && !reason) {
        throwError('OVERRIDE_REASON_REQUIRED',
          'Perubahan manual terhadap rekomendasi wajib disertai alasan (' + metric.accountName
          + ' - ' + metric.skuName + ').');
      }

      var existing = existingIndex[key + '|' + Utils.toIsoDate(planDate)];
      var base = {
        PLAN_DATE: planDate,
        ACCOUNT_ID: metric.accountId,
        SKU_ID: metric.skuId,
        AVG_SELL_OUT: metric.avgSellOut,
        AVG_RETURN: metric.avgReturn,
        MR_PERCENT: metric.mrPercent,
        STOCK_MOVEMENT: metric.stockMovement,
        POTENTIAL_LEVEL: metric.potential,
        RECOMMENDED_ALLOCATION: metric.recommendedAllocation,
        PLANNED_SELL_IN: planned,
        STATUS: status,
        CURRENT_STOCK: metric.currentStock,
        RISK_LEVEL: metric.riskLevel,
        OVERRIDE_REASON: override ? reason : '',
        PERIOD_FROM: matrix.meta.from,
        PERIOD_TO: matrix.meta.to,
        UPDATED_AT: now
      };

      var locked = existing && ['APPROVED', 'COMPLETED'].indexOf(Utils.upper(existing.STATUS)) !== -1;

      if (existing && !locked) {
        updates.push({ id: existing.ALLOCATION_ID, patch: base });
        auditEntries.push({
          user: session.username,
          action: override ? AUDIT_ACTIONS.MANUAL_OVERRIDE : AUDIT_ACTIONS.CHANGE_ALLOCATION,
          module: AuditService.MODULES.ALLOCATION,
          recordId: existing.ALLOCATION_ID,
          description: (override ? 'Manual override allocation' : 'Perubahan allocation') + ' untuk '
            + metric.accountName + ' - ' + metric.skuName
            + (override ? '. Alasan: ' + reason : ''),
          oldValue: 'PLANNED_SELL_IN=' + Utils.num(existing.PLANNED_SELL_IN),
          newValue: 'PLANNED_SELL_IN=' + planned + '; RECOMMENDED=' + metric.recommendedAllocation
        });
      } else {
        // Plan yang sudah APPROVED/COMPLETED bersifat final → simpan sebagai
        // revisi baru agar riwayat keputusan tetap utuh (audit trail tidak hilang).
        base.CREATED_BY = session.username;
        base.CREATED_AT = now;
        inserts.push(base);
        auditEntries.push({
          user: session.username,
          action: override ? AUDIT_ACTIONS.MANUAL_OVERRIDE : AUDIT_ACTIONS.CREATE,
          module: AuditService.MODULES.ALLOCATION,
          recordId: metric.accountCode + '/' + metric.skuCode,
          description: (locked ? 'Revisi plan sell in (menggantikan ' + existing.ALLOCATION_ID
            + ' berstatus ' + existing.STATUS + ') untuk ' : 'Plan sell in dibuat untuk ')
            + metric.accountName + ' - ' + metric.skuName
            + (override ? '. Manual override. Alasan: ' + reason : ''),
          oldValue: locked ? 'PLANNED_SELL_IN=' + Utils.num(existing.PLANNED_SELL_IN)
            : 'RECOMMENDED=' + metric.recommendedAllocation,
          newValue: 'PLANNED_SELL_IN=' + planned + '; STATUS=' + status
        });
      }
    });

    if (inserts.length) AllocationRepo.insertMany(inserts);
    if (updates.length) AllocationRepo.updateMany(updates);
    AuditService.logBatch(auditEntries);

    return {
      created: inserts.length,
      updated: updates.length,
      status: status,
      planDate: Utils.toIsoDate(planDate)
    };
  }

  /** Ubah status plan (submit / approve / reject / complete). */
  function changePlanStatus(session, payload) {
    var ids = [].concat((payload && payload.ids) || []);
    var target = Utils.upper(payload.status);
    if (!ids.length) throwError('VALIDATION_ERROR', 'Pilih minimal satu baris rencana.');
    if (ENUMS.ALLOCATION_STATUS.indexOf(target) === -1) {
      throwError('VALIDATION_ERROR', 'Status rencana tidak dikenali.');
    }
    if (target === 'REJECTED' && Utils.isBlank(payload.reason)) {
      throwError('VALIDATION_ERROR', 'Penolakan rencana wajib disertai alasan.');
    }

    var now = new Date();
    var patches = [];
    var audits = [];
    var plans = Utils.indexBy(AllocationRepo.all(), 'ALLOCATION_ID');

    ids.forEach(function (id) {
      var plan = plans[id];
      if (!plan) return;
      var patch = { STATUS: target, UPDATED_AT: now };
      if (target === 'APPROVED') {
        patch.APPROVED_BY = session.username;
        patch.APPROVED_AT = now;
      }
      if (target === 'REJECTED') {
        patch.OVERRIDE_REASON = Utils.str(payload.reason);
      }
      patches.push({ id: id, patch: patch });
      audits.push({
        user: session.username,
        action: target === 'APPROVED' ? AUDIT_ACTIONS.APPROVE
          : (target === 'REJECTED' ? AUDIT_ACTIONS.REJECT : AUDIT_ACTIONS.UPDATE),
        module: AuditService.MODULES.ALLOCATION,
        recordId: id,
        description: 'Status allocation plan diubah menjadi ' + target
          + (payload.reason ? '. Alasan: ' + payload.reason : ''),
        oldValue: 'STATUS=' + plan.STATUS,
        newValue: 'STATUS=' + target
      });
    });

    if (!patches.length) throwError('NOT_FOUND', 'Rencana yang dipilih tidak ditemukan.');
    AllocationRepo.updateMany(patches);
    AuditService.logBatch(audits);
    return { updated: patches.length, status: target };
  }

  /** Daftar allocation plan tersimpan (tabel + filter + pagination). */
  function listPlans(params) {
    var p = params || {};
    var f = p.filters || {};
    var accounts = AccountRepo.map();
    var skus = SkuRepo.map();
    var rows = AllocationRepo.all().filter(function (plan) {
      var account = accounts[plan.ACCOUNT_ID] || {};
      var sku = skus[plan.SKU_ID] || {};
      if (f.status && Utils.upper(plan.STATUS) !== Utils.upper(f.status)) return false;
      if (f.accountIds && f.accountIds.length && f.accountIds.indexOf(plan.ACCOUNT_ID) === -1) return false;
      if (f.skuIds && f.skuIds.length && f.skuIds.indexOf(plan.SKU_ID) === -1) return false;
      if (f.region && Utils.upper(account.REGION) !== Utils.upper(f.region)) return false;
      if (f.area && Utils.upper(account.AREA) !== Utils.upper(f.area)) return false;
      if (f.dateFrom || f.dateTo) {
        if (!Utils.inRange(plan.PLAN_DATE, f.dateFrom, f.dateTo)) return false;
      }
      if (f.q) {
        var hay = Utils.normalize([account.ACCOUNT_NAME, account.ACCOUNT_CODE, sku.SKU_NAME,
          sku.SKU_CODE, plan.ALLOCATION_ID].join(' '));
        if (hay.indexOf(Utils.normalize(f.q)) === -1) return false;
      }
      return true;
    }).map(function (plan) {
      var account = accounts[plan.ACCOUNT_ID] || {};
      var sku = skus[plan.SKU_ID] || {};
      return {
        ALLOCATION_ID: plan.ALLOCATION_ID,
        PLAN_DATE: Utils.toIsoDate(plan.PLAN_DATE),
        accountName: account.ACCOUNT_NAME || plan.ACCOUNT_ID,
        accountCode: account.ACCOUNT_CODE || '',
        skuName: sku.SKU_NAME || plan.SKU_ID,
        skuCode: sku.SKU_CODE || '',
        AVG_SELL_OUT: Utils.num(plan.AVG_SELL_OUT),
        AVG_RETURN: Utils.num(plan.AVG_RETURN),
        MR_PERCENT: Utils.num(plan.MR_PERCENT),
        CURRENT_STOCK: Utils.num(plan.CURRENT_STOCK),
        STOCK_MOVEMENT: Utils.num(plan.STOCK_MOVEMENT),
        POTENTIAL_LEVEL: plan.POTENTIAL_LEVEL,
        RISK_LEVEL: plan.RISK_LEVEL,
        RECOMMENDED_ALLOCATION: Utils.num(plan.RECOMMENDED_ALLOCATION),
        PLANNED_SELL_IN: Utils.num(plan.PLANNED_SELL_IN),
        OVERRIDE_REASON: plan.OVERRIDE_REASON,
        STATUS: Utils.upper(plan.STATUS),
        CREATED_BY: plan.CREATED_BY,
        CREATED_AT: Utils.toIsoDateTime(plan.CREATED_AT),
        APPROVED_BY: plan.APPROVED_BY
      };
    });

    var sorted = Utils.sortBy(rows, [{ key: 'PLAN_DATE', dir: 'desc' }, { key: 'RECOMMENDED_ALLOCATION', dir: 'desc' }]);
    var paged = Utils.paginate(sorted, p.page, p.pageSize || Settings.getNumber('DEFAULT_PAGE_SIZE', 25));
    return {
      rows: paged.rows,
      meta: paged.meta,
      summary: {
        total: rows.length,
        byStatus: ENUMS.ALLOCATION_STATUS.reduce(function (acc, status) {
          acc[status] = rows.filter(function (r) { return r.STATUS === status; }).length;
          return acc;
        }, {}),
        totalPlanned: Utils.sumBy(rows, 'PLANNED_SELL_IN'),
        totalRecommended: Utils.sumBy(rows, 'RECOMMENDED_ALLOCATION')
      }
    };
  }

  /** Hasil clustering untuk UI. */
  function getClusters(params) {
    var p = params || {};
    var result = AllocationEngine.buildClusters(p.filters || {});
    var paged = Utils.paginate(result.rows, p.page, p.pageSize || 50);
    return {
      rows: paged.rows,
      meta: paged.meta,
      distribution: result.distribution,
      thresholds: result.thresholds,
      weights: result.weights,
      period: result.meta
    };
  }

  /** Terapkan hasil clustering ke ACCOUNT_MASTER. */
  function applyCluster(session, payload) {
    var items = [].concat((payload && payload.items) || []);
    if (!items.length) throwError('VALIDATION_ERROR', 'Tidak ada account yang dipilih.');
    var accounts = AccountRepo.map();
    var patches = [];
    var audits = [];
    var now = new Date();

    items.forEach(function (item) {
      var account = accounts[item.accountId];
      if (!account) return;
      var cluster = Utils.upper(item.cluster);
      if (ENUMS.POTENTIAL_LEVEL.indexOf(cluster) === -1) return;
      var patch = { CLUSTER: cluster, UPDATED_AT: now };
      if (item.applyToPotential) patch.POTENTIAL_LEVEL = cluster;
      patches.push({ id: account.ACCOUNT_ID, patch: patch });
      audits.push({
        user: session.username,
        action: AUDIT_ACTIONS.UPDATE,
        module: AuditService.MODULES.DISTRIBUTION,
        recordId: account.ACCOUNT_ID,
        description: 'Clustering account ' + account.ACCOUNT_NAME + ' diperbarui menjadi ' + cluster,
        oldValue: 'CLUSTER=' + account.CLUSTER + '; POTENTIAL=' + account.POTENTIAL_LEVEL,
        newValue: 'CLUSTER=' + cluster + (item.applyToPotential ? '; POTENTIAL=' + cluster : '')
      });
    });

    if (!patches.length) throwError('VALIDATION_ERROR', 'Tidak ada perubahan cluster yang valid.');
    AccountRepo.updateMany(patches);
    AuditService.logBatch(audits);
    return { updated: patches.length };
  }

  /** Data export CSV untuk Distribution Planning Report. */
  function exportRows(params) {
    var p = params || {};
    var matrix = AllocationEngine.buildMatrix(p.filters || {});
    var rows = AllocationEngine.filterRows(matrix.rows, p.filters || {});
    var planIndex = latestPlanIndex();
    var headers = ['ACCOUNT_CODE', 'ACCOUNT_NAME', 'REGION', 'AREA', 'CHANNEL', 'CLUSTER', 'POTENTIAL',
      'SKU_CODE', 'SKU_NAME', 'CATEGORY', 'AVG_SELL_OUT', 'AVG_RETURN', 'MR_PERCENT', 'CURRENT_STOCK',
      'STOCK_MOVEMENT', 'RISK_LEVEL', 'RISK_SCORE', 'RECOMMENDED_ALLOCATION', 'PLANNED_SELL_IN', 'PLAN_STATUS'];
    var data = Utils.sortBy(rows, [{ key: 'riskScore', dir: 'desc' }]).map(function (r) {
      var plan = planIndex[r.accountId + '|' + r.skuId];
      return {
        ACCOUNT_CODE: r.accountCode, ACCOUNT_NAME: r.accountName, REGION: r.region, AREA: r.area,
        CHANNEL: r.channel, CLUSTER: r.cluster, POTENTIAL: r.potential, SKU_CODE: r.skuCode,
        SKU_NAME: r.skuName, CATEGORY: r.category, AVG_SELL_OUT: r.avgSellOut, AVG_RETURN: r.avgReturn,
        MR_PERCENT: r.mrPercent, CURRENT_STOCK: r.currentStock, STOCK_MOVEMENT: r.stockMovement,
        RISK_LEVEL: r.riskLevel, RISK_SCORE: r.riskScore, RECOMMENDED_ALLOCATION: r.recommendedAllocation,
        PLANNED_SELL_IN: plan ? Utils.num(plan.PLANNED_SELL_IN) : '',
        PLAN_STATUS: plan ? plan.STATUS : 'NOT_PLANNED'
      };
    });
    return { headers: headers, rows: data, filename: 'distribution-planning-report' };
  }

  return {
    getWorkspace: getWorkspace,
    getReview: getReview,
    getPlanPreview: getPlanPreview,
    savePlan: savePlan,
    changePlanStatus: changePlanStatus,
    listPlans: listPlans,
    getClusters: getClusters,
    applyCluster: applyCluster,
    exportRows: exportRows,
    isOverride: isOverride
  };
})();
