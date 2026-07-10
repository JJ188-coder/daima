/**
 * pdd-enhancer.js — 拼多多推广数据增强 v16
 *
 * 设计原则（v10 起）：推广数据只回填到**插件「商品报表」弹窗**（.el-dialog__wrapper 的
 * Vue el-table），**不注入** mms 主页面（goods_effect 等）的原生表格。
 *
 * v8→v9→v10→v11→v12→v13→v14 演进：
 *   v8: 注入 mms React 主表格 — 已废弃
 *   v9: Vue 弹窗回填（$set + $forceUpdate）— 保留
 *   v10: 删除 React 主表格注入，只保留 Vue 弹窗回填
 *   v11: 修复「切日期不刷新」bug，去掉 __pddPromoFilled
 *   v12: extractFromFiber 读全 55 字段；窗口重叠回填；按弹窗列动态回填
 *   v13: scenesMode 择优去重 + 按日期窗口分仓存储 + 监听弹窗切日期
 *   v14: 全自动采集 —— 不再依赖 fiber 抓 DOM，改用 webpack 注入复用页面 service 类
 *        直接调 queryEntityReport API（绕过反爬 crawlerInfo/Anti-Content），可拉任意日期窗口
 *        的全量数据。页面加载后自动采昨日/近7天/近30天三个分仓，运营在 mms 弹窗切任意日期
 *        都有对应数据，无需手动操作 yingxiao。
 *
 * 采集范式（v14 起）：
 *   主路径：getPddReportService() → fetchPromoWindow(startDate, endDate) 直接 API 调用
 *   fallback：extractFromFiber() 读 DOM（API 不可用时）
 *
 * 关键发现（CDP 探查）：
 *   1. queryEntityReport 是普通 XHR POST，拦不到是因 Next.js 缓存了 native XHR 引用（时序）
 *   2. 可通过 webpackChunk_N_E 注入拿 __webpack_require__，复用页面 service 类
 *   3. service 自动注入反爬，直接 fetch 会 54001，复用 service 不会
 *   4. goodsId 在 externalFieldValues.goodsId（嵌套，非顶层）
 *   5. 日期参数是 startDate/endDate（POST body）
 *
 * 工作流程：
 *   yingxiao 页面加载后:
 *     A. autoCaptureAllWindows() 自动拉昨日/近7天/近30天 → 写各自分仓
 *     B. 用户手动切日期 → 自动重采当前窗口 → 写分仓
 *   mms 弹窗:
 *     C. 切日期(昨天/近7天/近30天) → readDialogDateWindow → getPromoDataByWindow 取对应分仓
 *     D. applyPromoToVueDialog 回填所有付费流量列
 */

(function() {
  'use strict';
  if (!location.hostname.includes('pinduoduo')
      && !location.hostname.includes('yangkeduo')
      && !location.hostname.includes('hjy.huice.com')) return;
  if (window.__PDD_EM_V7__) return;
  window.__PDD_EM_V7__ = true;
  const NS = '[PDD+EMv9]';
  console.log(NS, 'starting on', location.hostname);

  const EXT_ID = window.DTS_ISOLATED?.dts_runtime_id || '';
  const STORE_KEY = 'pdd_promo_full_latest';
  const INJECT_FLAG_ATTR = 'data-pdd-promo';

  function swCall(action, data) {
    return new Promise(resolve => {
      if (!EXT_ID) { resolve(null); return; }
      const timer = setTimeout(() => resolve(null), 10000);
      try { chrome.runtime.sendMessage(EXT_ID, {action, data}, r => { clearTimeout(timer); resolve(r); }); }
      catch(e) { clearTimeout(timer); resolve(null); }
    });
  }

  function val(obj) {
    if (obj == null) return 0;
    if (typeof obj === 'number') return obj;
    if (typeof obj === 'string') { const n = parseFloat(obj); return isNaN(n) ? 0 : n; }
    if (typeof obj === 'object') return val(obj.value);
    return 0;
  }

  // ============ 数据捕获（在 yingxiao 页面） ============
  function extractPromoRecords(apiData) {
    const list = apiData?.result?.entityReportList;
    if (!Array.isArray(list)) return [];
    return list.map(item => ({
      entityId: String(item.entityId || ''),
      goodsId: String(item.goodsId || ''),
      goodsName: item.goodsName || item.adName || '',
      thumbUrl: item.thumbUrl || '',
      spend: val(item.spend),
      orderSpend: val(item.orderSpend),
      roi: val(item.orderSpendNetRoi),
      roiUnified: val(item.orderSpendRoiUnified),
      settlementRoi: val(item.settlementRoi),
      gmv: val(item.gmv),
      netGmv: val(item.netGmv),
      directPayGmv: val(item.directPayGmv),
      indirectGmv: val(item.indirectGmv),
      impression: val(item.impression),
      click: val(item.click),
      billingImpression: val(item.billingImpression),
      orderNum: val(item.orderNum),
      netOrderNum: val(item.netOrderNum),
      directOrderNum: val(item.directOrderNum),
      indirectOrderNum: val(item.indirectOrderNum),
      cvr: val(item.cvr),
      ctr: val(item.ctr),
      avgPayAmount: val(item.avgPayAmount),
      costPerOrder: val(item.costPerOrder),
    })).filter(r => r.goodsId || r.entityId);
  }

  /**
   * v12 新增：直接从 yingxiao 表格的 React fiber 读取全量字段（83 个）。
   * 比 API 拦截更可靠（API 用了非标准传输，fetch/XHR hook 拦不到）。
   * 已 CDP 验证：fiber.memoizedProps.data 含完整业务数据。
   *
   * 字段值是嵌套结构 {unit, value, unitCode}，val() 能自动解包。
   */
  const FIBER_FIELDS = [
    // 金额
    'spend', 'orderSpend', 'gmv', 'payGmv', 'netGmv', 'settlementGmv',
    'directPayGmv', 'directGmv', 'indirectGmv',
    'avgPayAmount', 'netAvgPayAmount', 'costPerOrder',
    'orderSpendNetCostPerOrder', 'costPerSettlementOrderForDeal',
    'gmvPerSettlementOrderForDeal',
    // ROI
    'orderSpendNetRoi', 'orderSpendRoiUnified', 'settlementRoi',
    // 订单
    'orderNum', 'netOrderNum', 'directOrderNum', 'indirectOrderNum',
    'settlementOrder', 'refundOrder30d',
    // 流量
    'impression', 'billingImpression', 'click', 'ctr', 'cvr',
    // 询单/收藏/关注（多目标）
    'inquirySpend', 'multiGoalInquiryNum', 'multiGoalCostPerInquiry',
    'goodsFavSpend', 'multiGoalGoodsFavNum', 'multiGoalCostPerGoodsFav',
    'mallFavSpend', 'multiGoalMallFavNum', 'multiGoalCostPerMallFav',
    // 退款/结算
    'exemptRefundGmvRate30d', 'exemptRefundOrderRate30d',
    'refundGmv30dForAd', 'billingExemptRefundGmv', 'billingExemptRefundOrder',
    'netGmvRate', 'netOrderNumRate', 'settlementGmvRate', 'settlementOrderRate',
    // 标识
    'entityId', 'goodsId', 'goodsName', 'adName', 'adId', 'planId', 'thumbUrl',
    // 推广计划类型（v13）：1=稳定成本推广，3=全店托管。同 goodsId 多计划时择优用
    'scenesMode',
  ];

  function extractFromFiber() {
    // 数据行 class 是 anq-table-row（ant-design），排除测量行 anq-table-measure-row
    let rows = document.querySelectorAll('tr.anq-table-row:not(.anq-table-measure-row)');
    if (!rows.length) {
      // fallback：其他可能的 class（CSS modules 可能变化）
      rows = document.querySelectorAll('[class*="OverviewTable_row"], tr[class*="row"]:not([class*="measure"])');
    }
    if (!rows.length) return [];
    const records = [];
    for (const rowEl of rows) {
      const fk = Object.keys(rowEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fk) continue;
      let fiber = rowEl[fk];
      let walked = 0;
      let data = null;
      while (fiber && walked < 20) {
        const p = fiber.memoizedProps || fiber.pendingProps || {};
        // 数据在 props.record（ant-design Table 行渲染），也可能叫 data/record/item
        if (p && typeof p === 'object') {
          for (const k of ['record', 'data', 'item', 'row']) {
            const v = p[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && (v.spend !== undefined || v.goodsId !== undefined || v.entityId !== undefined)) {
              data = v; break;
            }
          }
          if (data) break;
        }
        fiber = fiber.return;
        walked++;
      }
      if (!data) continue;
      const rec = {};
      for (const f of FIBER_FIELDS) {
        if (data[f] !== undefined) rec[f] = val(data[f]);
      }
      // 标识字段保留原始类型
      if (data.entityId !== undefined) rec.entityId = String(data.entityId || '');
      if (data.goodsId !== undefined) rec.goodsId = String(data.goodsId || '');
      if (data.goodsName) rec.goodsName = data.goodsName;
      else if (data.adName) rec.goodsName = data.adName;
      if (data.thumbUrl) rec.thumbUrl = data.thumbUrl;
      if (rec.goodsId || rec.entityId) records.push(rec);
    }
    // v13: 同 goodsId 择优去重（抽成公共函数，API/fiber 路径复用）
    return dedupeByScenesMode(records);
  }

  /**
   * 同 goodsId 择优去重：优先保留 scenesMode=1（稳定成本推广）。
   * 全店托管(scenesMode=3)的单商品花费官方标注「不提供」，拼多多合计行也不计入。
   */
  function dedupeByScenesMode(records) {
    const byGoods = {};
    for (const r of records) {
      if (!r.goodsId) continue;
      const key = String(r.goodsId);
      const existing = byGoods[key];
      if (!existing) { byGoods[key] = r; continue; }
      const sm = v => { const x = v?.value ?? v; return x == null ? null : String(x); };
      const rSm = sm(r.scenesMode), eSm = sm(existing.scenesMode);
      if (rSm === '1' && eSm !== '1') byGoods[key] = r;        // 来的是稳定成本，替换
      else if (eSm === '1' && rSm !== '1') continue;            // 已有稳定成本，丢弃来的
      // 两者都不是稳定成本：保留已有（首次出现的）
    }
    const deduped = Object.values(byGoods);
    console.log(NS, '🔍 dedup ' + records.length + ' → ' + deduped.length + ' records (prefer scenesMode=1)');
    return deduped;
  }

  /**
   * 读取 yingxiao 页面当前选的日期窗口（开始/结束）。
   * yingxiao 用 anq- 自定义组件，输入框 placeholder 含「开始日期/结束日期」，value 形如 "2026/06/17"。
   * 返回 "YYYY-MM-DD~YYYY-MM-DD" 格式，读不到返回 null。
   */
  function readYingxiaoDateWindow() {
    const inputs = document.querySelectorAll('input[placeholder*="开始"], input[placeholder*="结束"], input[placeholder*="日期"]');
    const starts = [], ends = [];
    inputs.forEach(i => {
      const v = (i.value || '').trim();
      const m = v.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
      if (!m) return;
      const iso = m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
      if ((i.placeholder || '').includes('开始')) starts.push(iso);
      else if ((i.placeholder || '').includes('结束')) ends.push(iso);
    });
    if (starts.length && ends.length) return starts[0] + '~' + ends[0];
    return null;
  }

  async function savePromoData(records) {
    if (!records?.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const dateWindow = readYingxiaoDateWindow();
    // 把采集时的日期窗口写进每条 record（回填侧用来判断是否与弹窗所选窗口一致）
    if (dateWindow) {
      records.forEach(r => { r.dateWindow = dateWindow; });
    }
    // v13: 按日期窗口分仓存储。主键 STORE_KEY 仍存"最近一次"，
    // 同时写入分仓 pdd_promo_window_<开始>_<结束>，并维护一个窗口索引。
    const windowKey = dateWindow
      ? 'pdd_promo_window_' + dateWindow.replace(/~/g, '_')
      : 'pdd_promo_window_unknown';
    const payload = { records, capturedAt: Date.now(), date: today, dateWindow };
    const writes = {
      [STORE_KEY]: payload,           // 最近一次（兼容旧逻辑/fallback）
      [windowKey]: payload,           // 该日期窗口分仓
    };
    await swCall('SetLocalData', writes);
    // 维护窗口索引（追加，去重）
    try {
      const idx = await swCall('GetLocalData', { key: ['pdd_promo_windows'] });
      const list = idx?.['pdd_promo_windows'] || [];
      const set = new Set(list);
      if (dateWindow) set.add(dateWindow);
      const newList = [...set];
      if (newList.length !== list.length) {
        await swCall('SetLocalData', { pdd_promo_windows: newList });
      }
    } catch(e) { /* 索引维护失败不影响主流程 */ }
    console.log(NS, '✓ Saved ' + records.length + ' records (window=' + (dateWindow || '?') + ' → ' + windowKey + ')');
  }

  /**
   * v13: 按日期窗口读分仓数据。
   * @param {string} window  形如 "2026-06-17~2026-06-23"，找不到时退回 STORE_KEY（最近一次）
   * @returns {Promise<Array|null>}
   */
async function getPromoDataByWindow(window) {
	    // 精确匹配：只返回与目标窗口完全匹配的数据
	    if (window) {
	      const key = 'pdd_promo_window_' + window.replace(/~/g, '_');
	      const d = await swCall('GetLocalData', { key: [key] });
	      const v = d?.[key];
	      if (v?.records?.length) {
	        console.log(NS, '📦 exact match: ' + window);
	        return v.records;
	      }
	    }
	    // 无精确匹配 → 返回 null（不猜数据，由调用方触发按需拉取）
	    return null;
	  }

  /** 列出所有已采集的日期窗口 */
  async function listWindows() {
    const idx = await swCall('GetLocalData', { key: ['pdd_promo_windows'] });
    return idx?.['pdd_promo_windows'] || [];
  }

  /**
   * 从 yingxiao DOM 把「商品 ID：xxx」解析出来，补到 records 上。
   * yingxiao API 响应里没有 goodsId，但表格 DOM 渲染了「商品 ID：967458675477」。
   * 通过 React fiber 拿到每行的 entityId，建立 entityId↔goodsId 映射。
   */
  function enrichWithGoodsIdFromDOM(records) {
    if (!records?.length) return records;
    const infoWraps = document.querySelectorAll('[class*="OverviewTable_infoWrap"], [class*="OverviewTable_goodsName"]');
    if (!infoWraps.length) {
      console.log(NS, '⚠️ no infoWrap on yingxiao DOM, skip enrich');
      return records;
    }
    const byEntityId = {};
    for (const r of records) byEntityId[r.entityId] = r;

    let enriched = 0;
    for (const info of infoWraps) {
      const text = info.textContent || '';
      const m = text.match(/商品\s*ID[：:]\s*(\d{6,20})/);
      if (!m) continue;
      const goodsId = m[1];
      const nm = text.match(/商品名[：:]\s*([^\n]+)/);
      const goodsName = nm ? nm[1].trim().substring(0, 120) : '';

      let rowEl = info.closest('[class*="OverviewTable_row"]') || info.parentElement;
      let depth = 0;
      while (rowEl && depth < 6 && (rowEl.parentElement?.children.length || 0) < 2) {
        rowEl = rowEl.parentElement;
        depth++;
      }
      const entityId = findEntityIdFromFiber(rowEl);
      if (entityId && byEntityId[entityId]) {
        byEntityId[entityId].goodsId = goodsId;
        if (goodsName) byEntityId[entityId].goodsName = goodsName;
        enriched++;
      }
    }
    console.log(NS, '✓ DOM enrich: ' + enriched + '/' + records.length + ' records got goodsId');
    return records;
  }

  /** 从一个 DOM 元素向上找 React fiber，提取 record.entityId */
  function findEntityIdFromFiber(el) {
    if (!el) return null;
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!fk) return null;
    let fiber = el[fk];
    let walked = 0;
    while (fiber && walked < 12) {
      const props = fiber.memoizedProps || {};
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && v.entityId !== undefined) {
          return String(v.entityId);
        }
      }
      fiber = fiber.return;
      walked++;
    }
    return null;
  }

  /**
   * v14：通过 webpack 注入复用页面封装的 service 类，直接调 queryEntityReport API。
   * 页面 service 自动注入 crawlerInfo + Anti-Content，绕过反爬（直接 fetch 会 54001）。
   * 模块 ID 动态定位（扫源码含 queryEntityReport 的模块），拼多多发版后自动适配。
   */
  function getPddReportService() {
    if (window.__PDD_REPORT_SVC) return window.__PDD_REPORT_SVC;
    const chunks = window.webpackChunk_N_E;
    if (!chunks) throw new Error('webpackChunk_N_E 不存在（非 Next.js 页或未加载完）');
    let __webpack_require__ = null;
    chunks.push([[Symbol('__pdd_cap__')], {}, (req) => { __webpack_require__ = req; }]);
    if (!__webpack_require__) throw new Error('webpack require 未捕获');
    // 动态定位：扫模块源码找含 queryEntityReport 的（避免硬编码模块 ID）
    const modules = __webpack_require__.m || {};
    let svcInstance = null;
    for (const id of Object.keys(modules)) {
      const fn = modules[id];
      let src = '';
      try { src = fn.toString(); } catch(e) { continue; }
      if (!src.includes('queryEntityReport')) continue;
      // require 该模块，找导出里能实例化出 queryEntityReport 方法的
      try {
        const mod = __webpack_require__(id);
        for (const k of Object.keys(mod)) {
          const Exported = mod[k];
          // class → 实例化后查实例方法（拼多多把方法定义在 constructor 里 this.xxx=）
          if (typeof Exported === 'function') {
            try {
              const inst = new Exported();
              if (typeof inst.queryEntityReport === 'function') {
                svcInstance = inst;
                console.log(NS, '🔧 found report service: module ' + id + ' export ' + k);
                break;
              }
            } catch(e) { /* 实例化失败试下一个 */ }
          }
          // object → 直接查
          if (Exported && typeof Exported === 'object' && typeof Exported.queryEntityReport === 'function') {
            svcInstance = Exported;
            console.log(NS, '🔧 found report service: module ' + id + ' export ' + k + ' (object)');
            break;
          }
        }
        if (svcInstance) break;
      } catch(e) { continue; }
    }
    if (!svcInstance) throw new Error('未找到含 queryEntityReport 的 service（实例化失败或方法缺失）');
    window.__PDD_REPORT_SVC = svcInstance;
    return svcInstance;
  }

  /**
   * 解析 queryEntityReport 响应的 entityReportList → 标准 record 格式。
   * 关键：goodsId 在 externalFieldValues.goodsId（嵌套，非顶层）。值是 {unit,value} 嵌套。
   */
  function parseEntityReportList(entityReportList) {
    if (!Array.isArray(entityReportList)) return [];
    return entityReportList.map(item => {
      const rec = {};
      for (const f of FIBER_FIELDS) {
        if (item[f] !== undefined) rec[f] = val(item[f]);
      }
      // externalFieldValues 嵌套字段（goodsId/goodsName/scenesMode 等在这里）
      const ext = item.externalFieldValues || {};
      for (const f of ['goodsId', 'goodsName', 'adName', 'scenesMode', 'planId', 'adId', 'thumbUrl']) {
        if (ext[f] !== undefined) {
          rec[f] = (f === 'goodsId' || f === 'scenesMode') ? String(ext[f] ?? '') : ext[f];
        }
      }
      if (rec.goodsId || rec.entityId) return rec;
      return null;
    }).filter(Boolean);
  }

  /**
   * v14：拉一个日期窗口的全量数据（自动分页 pageSize 50）。
   * @param {string} startDate  YYYY-MM-DD
   * @param {string} endDate    YYYY-MM-DD
   * @param {number} entityId   账号主体 ID（mallId，首次可省略，自动从 __NEXT_DATA__ 读）
   * @returns {Promise<{records: Array, entityId: number}>}
   */
  function getEntityId() {
    if (window.__PDD_EM_ENTITY_ID) return window.__PDD_EM_ENTITY_ID;
    // 从 __NEXT_DATA__ 读账号主体 mallId（稳定来源）
    try {
      const mallId = window.__NEXT_DATA__?.props?.__ANQ_MODELS_INIT_STATE__?.CommonGlobalConfig?.mallId;
      if (mallId) {
        window.__PDD_EM_ENTITY_ID = Number(mallId);
        return window.__PDD_EM_ENTITY_ID;
      }
    } catch(e) {}
    return 0;
  }

  async function fetchPromoWindow(startDate, endDate, entityId) {
    const svc = getPddReportService();
    if (!entityId) entityId = getEntityId();
    const all = [];
    let pageNum = 1, total = 0, resolvedEntityId = entityId;
    do {
      const params = {
        entityId: resolvedEntityId,
        entityDimensionType: 0,
        queryDimensionType: 2,
        reportPromotionType: 9,
        blockTypes: [6],
        startDate, endDate,
        externalFields: ['planId','adId','adName','thumbUrl','goodsName','goodsId','scenesMode','scenesType'],
        queryRange: { pageNumber: pageNum, pageSize: 50 },
        orderBy: 9999, orderType: 9999,
        queryHasStableCostSmartAd: true,
        returnTotalSumReport: pageNum === 1,
      };
      const r = await svc.queryEntityReport(params);
      const list = r?.entityReportList || [];
      all.push(...list);
      total = r?.total ?? all.length;
      pageNum++;
    } while (all.length < total && pageNum < 50);
    if (resolvedEntityId) window.__PDD_EM_ENTITY_ID = resolvedEntityId;
    return { records: parseEntityReportList(all), entityId: resolvedEntityId };
  }

  /**
   * v12 统一采集入口：优先用 fiber 直接读（最可靠、字段最全），
   * 拿不到再 fallback 到 API 拦截数据 + DOM 补 goodsId。
   */
  async function captureFromPage() {
    // v14: 优先 API（全量、不受分页/UI 限制），fiber 降为 fallback
    const win = readYingxiaoDateWindow();
    if (win) {
      const m = win.match(/(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})/);
      if (m) {
        try {
          const { records } = await fetchPromoWindow(m[1], m[2]);
          if (records.length) {
            // API 路径：去重后存（parseEntityReportList 未去重，复用 extractFromFiber 的去重逻辑）
            const deduped = dedupeByScenesMode(records);
            await savePromoData(deduped);
            console.log(NS, '✓ API captured ' + deduped.length + ' records for window ' + win);
            return deduped.length;
          }
        } catch(e) {
          console.warn(NS, 'API capture failed, fallback to fiber:', e.message);
        }
      }
    }
    // fallback: fiber
    let records = extractFromFiber();
    if (records.length) {
      await savePromoData(records);
      return records.length;
    }
    return 0;
  }

  /** 处理 API 响应：抓取 + DOM 补 goodsId + 存储（fallback 路径，fiber 不可用时用） */
  async function handleEntityReport(apiData) {
    // v12: 先试 fiber（字段更全），失败再用 API 数据
    const fiberRecords = extractFromFiber();
    if (fiberRecords.length) {
      await savePromoData(fiberRecords);
      return;
    }
    let records = extractPromoRecords(apiData);
    if (!records.length) return;
    records = enrichWithGoodsIdFromDOM(records);
    const missing = records.filter(r => !r.goodsId).length;
    if (missing > 0) {
      console.log(NS, '⏳ ' + missing + ' records missing goodsId, will retry enrich in 2s');
      setTimeout(async () => {
        const fresh = await getPromoData();
        if (fresh?.length) {
          const merged = enrichWithGoodsIdFromDOM(fresh);
          await savePromoData(merged);
        }
      }, 2000);
    }
    await savePromoData(records);
  }

  // ============ 拦截 API（在 yingxiao/yangkeduo 页面） ============
  const ENTITY_REPORT_PATTERN = 'queryEntityReport';
  function matchEntityReport(url) { return url.includes(ENTITY_REPORT_PATTERN); }

  // fetch 拦截
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const response = await origFetch.apply(this, arguments);
    if (matchEntityReport(url) && response.ok) {
      try {
        const cloned = response.clone();
        const data = await cloned.json();
        console.log(NS, '📡 fetch hit queryEntityReport');
        handleEntityReport(data);
      } catch(e) {}
    }
    return response;
  };

  // XHR 拦截
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._em_url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (this._em_url && matchEntityReport(this._em_url)) {
      this.addEventListener('load', () => {
        if (this.status === 200 && this.responseText) {
          try {
            const data = JSON.parse(this.responseText);
            console.log(NS, '📡 XHR hit queryEntityReport');
            handleEntityReport(data);
          } catch(e) {}
        }
      });
    }
    return origSend.call(this, body);
  };

  // 触发 yingxiao 页面数据刷新：点击日期筛选按钮触发重新请求
  function triggerYingxiaoRefresh() {
    // 在 yingxiao 页面，查找日期选择器或筛选按钮，触发重新查询
    const refreshBtn = document.querySelector('.date-range-picker .el-date-editor, .filter-btn, [class*="refresh"], [class*="search"]');
    if (refreshBtn && typeof refreshBtn.click === 'function') {
      refreshBtn.click();
      console.log(NS, '🔄 triggered yingxiao refresh');
    }
  }

  // ============ storage 变化监测（mms 页面即时响应） ============
  // MAIN world 里 chrome.storage 不可用，只能用轮询读取（通过 CS bridge）
  let lastRecordCount = 0;
  let lastCapturedAt = 0;
  function setupStorageListener() {
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes[STORE_KEY]) {
          const records = changes[STORE_KEY].newValue?.records;
          if (records?.length) {
            console.log(NS, '📥 storage changed: ' + records.length + ' records');
            setTimeout(() => tryInject(), 500);
          }
        }
      });
      console.log(NS, '✓ storage.onChanged listener active');
    } else {
      // MAIN world 兜底：5 秒轮询 storage
      console.log(NS, 'ℹ️ chrome.storage 不可用，启用轮询模式');
      setInterval(async () => {
        try {
          const r = await getPromoData();
          if (r.length && (r.length !== lastRecordCount || r[0]?._capturedAt !== lastCapturedAt)) {
            lastRecordCount = r.length;
            console.log(NS, '📥 poll detected ' + r.length + ' records');
            tryInject();
          }
        } catch(e) {}
      }, 5000);
    }
  }

  // ============ mms 表格注入（React/Next.js） ============
  async function getPromoData() {
    const r = await swCall('GetLocalData', { key: STORE_KEY });
    return r?.[STORE_KEY]?.records || [];
  }

  /**
   * 回填「商品报表」弹窗（Vue el-table）的花费/ROI。
   * 注意：不注入 goods_effect 主页面表格（用户要求只在插件弹窗内显示推广数据）。
   */
  /**
   * v14: 按需拉取 —— 当 mms 弹窗切到某窗口但分仓无数据时，
   * 通过 SW 的 InjectCode 在 yingxiao 标签执行拉取+存储。
   * 拉取是异步的，mms 侧的轮询/MutationObserver 会在数据就绪后自动读到并回填。
   * 防抖：同一窗口 30 秒内只触发一次，避免重复请求。
   */
  const onDemandFetching = {};
  function triggerOnDemandFetch(window) {
    if (!window) return;
    const m = window.match(/(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})/);
    if (!m) return;
    // 防抖
    if (onDemandFetching[window] && Date.now() - onDemandFetching[window] < 30000) return;
    onDemandFetching[window] = Date.now();
    const [start, end] = [m[1], m[2]];
    // 在 yingxiao 标签注入拉取代码（调 enhancer 的 fetchPromoWindow + 存分仓）
    // v14.5: 不覆盖 STORE_KEY（latest），避免 fallback 拿到错误值
    //     + 存完分仓后更新 windows 索引
    const code = `
      (async () => {
        try {
          if (!window.__PDD_EM || !window.__PDD_EM.fetchPromoWindow) return;
          const { records } = await window.__PDD_EM.fetchPromoWindow('${start}', '${end}');
          if (records.length) {
            const deduped = window.__PDD_EM.__internal_dedupe ? window.__PDD_EM.__internal_dedupe(records) : records;
            const win = '${start}~${end}';
            const payload = { records: deduped, capturedAt: Date.now(), date: '${start}', dateWindow: win };
            const winKey = 'pdd_promo_window_' + win.replace(/~/g,'_');
            await new Promise(res => {
              const rid = sessionStorage.getItem('dts_runtime_id');
              const t = setTimeout(res, 8000);
              chrome.runtime.sendMessage(rid, { action: 'SetLocalData', data: { [winKey]: payload }}, () => { clearTimeout(t); res(); });
            });
            // 更新 windows 索引
            try {
              const idx = await new Promise(res => {
                chrome.runtime.sendMessage(sessionStorage.getItem('dts_runtime_id'), { action: 'GetLocalData', data: { key: ['pdd_promo_windows'] }}, d => res(d));
              });
              const list = idx?.pdd_promo_windows || [];
              if (!list.includes(win)) {
                list.push(win);
                chrome.runtime.sendMessage(sessionStorage.getItem('dts_runtime_id'), { action: 'SetLocalData', data: { pdd_promo_windows: list }});
              }
            } catch(e) {}
            console.log('[PDD+EMv14] on-demand fetched ' + deduped.length + ' for ' + win);
          }
        } catch(e) { console.warn('[PDD+EMv14] on-demand fetch failed:', e.message); }
      })();
    `;
    // 先找到 yingxiao 标签（GetTabs 传 {} 查全部，再过滤）
    swCall('GetTabs', {}).then(tabs => {
      const yxTab = Array.isArray(tabs) ? tabs.find(t => t.url && t.url.includes('yingxiao.pinduoduo.com')) : null;
      if (!yxTab) { console.log(NS, '⚠️ no yingxiao tab open, cannot on-demand fetch'); return; }
      swCall('InjectCode', { code, tabId: yxTab.id }).then(r => {
        console.log(NS, '→ on-demand fetch injected to yingxiao tab ' + yxTab.id);
      });
    });
  }

  async function tryInject() {
    // v13: 读弹窗当前所选日期窗口，取对应分仓数据（不再固定读 latest）
    let dialogWindow = readDialogDateWindow();
    // v14.5: dialogWindow=null 时再尝试直接搜"统计时间"文本(正则可能漏匹配)
    if (!dialogWindow) {
      const dialog = document.querySelector('.el-dialog__wrapper, .el-dialog.dts-modal');
      if (dialog) {
        const txt = (dialog.innerText || '').replace(/\s+/g, ' ');
        const m = txt.match(/统计时间[：:]\s*(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})\s*[~～\-—至到]\s*(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})/);
        if (m) {
          const s = m[1] + '-' + m[2].padStart(2,'0') + '-' + m[3].padStart(2,'0');
          const e = m[4] + '-' + m[5].padStart(2,'0') + '-' + m[6].padStart(2,'0');
          dialogWindow = s + '~' + e;
          console.log(NS, '📅 direct regex: ' + dialogWindow);
        }
      }
    }
    let promoRecords = await getPromoDataByWindow(dialogWindow);
    // 精确匹配返回 null 或无数据时，触发按需拉取并等待数据
    if (!promoRecords?.length && dialogWindow) {
      console.log(NS, '📭 no exact data for window ' + dialogWindow + ', triggering on-demand fetch');
      triggerOnDemandFetch(dialogWindow);
      // 等 8 秒让 yingxiao 拉取+存储，分 3 次检查  
      for (let wait = 0; wait < 3; wait++) {
        await new Promise(r => setTimeout(r, 3000));
        promoRecords = await getPromoDataByWindow(dialogWindow);
        if (promoRecords?.length) break;
      }
      if (!promoRecords?.length) {
        console.log(NS, '⚠️ on-demand fetch did not complete in 7s, will retry on next poll');
        return { vueFilled: 0, reason: 'on-demand fetch pending for ' + dialogWindow };
      }
    }
    if (!promoRecords?.length) return { vueFilled: 0, reason: 'no stored data for window=' + (dialogWindow || '?') };

    const promoMap = {};
    let usable = 0;
    for (const r of promoRecords) {
      if (r.goodsId) { promoMap[String(r.goodsId)] = r; usable++; }
    }
    if (!usable) {
      console.log(NS, '⚠️ stored records have no goodsId, cannot match');
      return { vueFilled: 0, reason: 'no goodsId in records', stored: promoRecords.length };
    }

        const vueResult = applyPromoToVueDialog(promoMap);

    // === 慧经营利润数据行内展示 ===
    // 无论有无数据都执行：有数据 -> 绿色信息条；无数据 -> 灰色「慧经营未导入」提示
    if (dialogWindow) {
      const dateParts = dialogWindow.split('~');
      const startDate = dateParts[0];
      const endDate = dateParts[1] || dateParts[0];  // 单日范围只有 startDate
      // 读日期范围内所有天的 huice 数据,按 productId 聚合(多天数据相加)
      const huiceRecords = await getHuiceDataByDateRange(startDate, endDate);
      const huiceMap = {};
      huiceRecords.forEach(r => { if (r.productId) huiceMap[r.productId] = r; });
      // 从 renderData 读取行数据（复用 applyPromoToVueDialog 已定位的逻辑）
      const dialog = document.querySelector('.el-dialog__wrapper, .el-dialog.dts-modal');
      if (dialog) {
        const elTable = dialog.querySelector('.el-table');
        if (elTable) {
          let tableComp = null;
          let el = elTable;
          while (el && !tableComp) { if (el.__vue__) tableComp = el.__vue__; el = el.parentElement; }
          if (tableComp) {
            let dataComp = tableComp.$parent;
            let renderData = null;
            let walkLevel = 0;
            while (dataComp && walkLevel < 8) {
              const d = dataComp.$data || {};
              if (Array.isArray(d.renderData) && d.renderData.length) { renderData = d.renderData; break; }
              dataComp = dataComp.$parent;
              walkLevel++;
            }
            if (renderData) {
              // 优先注入「真列」；失败降级到绿色信息条
              const realColsOk = injectHuiceColumns(tableComp, dataComp, renderData, huiceMap);
              if (realColsOk) {
                console.log(HUICE_NS, huiceRecords.length > 0
                  ? '✓ injected real columns with ' + huiceRecords.length + ' huice records'
                  : '⚠️ no huice data for ' + startDate + ', columns show -- placeholder');

                // === 店铺利润汇总 ===
                injectShopSummaryColumns(tableComp);
                if (Object.keys(huiceMap).length > 0) {
                  // 逐页收录已命中的慧经营记录
                  const collection = await collectMatchedReportRecords(dialog, huiceMap);
                  if (collection.ok) {
                    const summaryResult = summarizeMatchedHuiceRecords(Array.from(collection.matchedRecords.values()));
                    fillShopSummaryRows(dataComp, renderData, summaryResult, collection.scannedProductIds.size);
                    console.log(HUICE_NS, '✓ shop summary: ' + summaryResult.matchedProductCount + ' matched / ' + collection.scannedProductIds.size + ' scanned');
                  } else {
                    fillShopSummaryRows(dataComp, renderData, null, 0);
                    console.log(HUICE_NS, '⚠️ shop summary failed: ' + collection.reason);
                  }
                  // 恢复原页后重新拿当前页 renderData 标红
                  const currentPageData = getDialogPageData(dialog, huiceMap);
                  if (currentPageData) {
                    applyLossRowHighlight(dialog, currentPageData.renderData, huiceMap);
                  }
                } else {
                  fillShopSummaryRows(dataComp, renderData, null, 0);
                }
                try { tableComp.$forceUpdate(); dataComp.$forceUpdate(); } catch (e) {}
              } else {
                applyHuiceStrips(huiceMap, renderData);
                console.log(HUICE_NS, '↘️ fallback to strips (real columns failed)');
              }
            }
          }
        }
      }
    }

    return { vueFilled: vueResult.filled, vueMatched: vueResult.matched };
  }

  // ============ 慧经营利润数据：存储 & 读取 ============
  const HUICE_NS = '🏪[huice]';

  function huiceNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/,/g, '').replace(/%/g, '').trim());
    return Number.isFinite(n) ? n : null;
  }

  function huiceRatio(numerator, denominator) {
    const n = huiceNum(numerator);
    const d = huiceNum(denominator);
    return n != null && d != null && d > 0 ? n / d : null;
  }

  function normalizeHuiceRecord(record) {
    const salesAmount = huiceNum(record.salesAmount);
    const salesQuantity = huiceNum(record.salesQuantity);
    const orderCount = huiceNum(record.orderCount != null ? record.orderCount : record.salesQuantity);
    const rawNetProfit = huiceNum(record.rawNetProfit != null ? record.rawNetProfit : (record.huiceNetProfit != null ? record.huiceNetProfit : record.netProfit));
    const adjustedNetProfit = huiceNum(record.netProfit);
    const orderFixedCost = record.orderFixedCost != null ? huiceNum(record.orderFixedCost) : (orderCount != null ? orderCount * 1.15 : null);
    const platformFee = record.platformFee != null ? huiceNum(record.platformFee) : (salesAmount != null ? salesAmount * 0.02 : null);
    const netProfit = adjustedNetProfit != null ? adjustedNetProfit : (rawNetProfit != null ? rawNetProfit - (orderFixedCost || 0) - (platformFee || 0) : null);
    const grossProfit = huiceNum(record.grossProfit);
    const refundAmount = huiceNum(record.refundAmount);
    return {
      ...record,
      productId: String(record.productId || ''),
      productName: record.productName || '',
      shopName: record.shopName || '',
      salesAmount,
      salesQuantity,
      orderCount,
      costPrice: huiceNum(record.costPrice),
      grossProfit,
      grossProfitRate: huiceNum(record.grossProfitRate) != null ? huiceNum(record.grossProfitRate) : huiceRatio(grossProfit, salesAmount),
      refundAmount,
      refundRate: huiceNum(record.refundRate) != null ? huiceNum(record.refundRate) : huiceRatio(refundAmount, salesAmount),
      rawNetProfit,
      rawNetProfitRate: huiceNum(record.rawNetProfitRate) != null ? huiceNum(record.rawNetProfitRate) : huiceRatio(rawNetProfit, salesAmount),
      netProfit,
      netProfitRate: huiceNum(record.netProfitRate) != null ? huiceNum(record.netProfitRate) : huiceRatio(netProfit, salesAmount),
      orderFixedCost,
      platformFee,
      platformFeeRate: record.platformFeeRate != null ? huiceNum(record.platformFeeRate) : 0.02,
      orderFixedUnitCost: record.orderFixedUnitCost != null ? huiceNum(record.orderFixedUnitCost) : 1.15,
      profitFormulaVersion: record.profitFormulaVersion || 'order-fixed-v1',
    };
  }

  function aggregateHuiceRecords(records) {
    const byProduct = {};
    for (const input of records || []) {
      const r = normalizeHuiceRecord(input);
      if (!r.productId) continue;
      if (!byProduct[r.productId]) {
        byProduct[r.productId] = { ...r };
      } else {
        const existing = byProduct[r.productId];
        if (!existing.productName && r.productName) existing.productName = r.productName;
        if (!existing.shopName && r.shopName) existing.shopName = r.shopName;
        for (const field of ['salesAmount', 'salesQuantity', 'orderCount', 'costPrice', 'grossProfit', 'refundAmount', 'rawNetProfit', 'netProfit', 'orderFixedCost', 'platformFee']) {
          const a = huiceNum(existing[field]);
          const b = huiceNum(r[field]);
          existing[field] = (a != null || b != null) ? (a || 0) + (b || 0) : null;
        }
        if (!existing.date || r.date > existing.date) existing.date = r.date;
      }
    }
    for (const r of Object.values(byProduct)) {
      r.netProfitRate = huiceRatio(r.netProfit, r.salesAmount);
      r.rawNetProfitRate = huiceRatio(r.rawNetProfit, r.salesAmount);
      r.grossProfitRate = huiceRatio(r.grossProfit, r.salesAmount);
      r.refundRate = huiceRatio(r.refundAmount, r.salesAmount);
    }
    return Object.values(byProduct);
  }

  async function saveHuiceData(records) {
    if (!records?.length) return;
    const normalized = records.map(normalizeHuiceRecord);
    const date = normalized[0].date || new Date().toISOString().slice(0, 10);
    const windowKey = 'pdd_huice_window_' + date;
    const payload = { records: normalized, capturedAt: Date.now(), date };
    await swCall('SetLocalData', { [windowKey]: payload });
    // 维护索引
    try {
      const idx = await swCall('GetLocalData', { key: ['pdd_huice_windows'] });
      const list = idx?.['pdd_huice_windows'] || [];
      const set = new Set(list);
      set.add(date);
      const newList = [...set];
      if (newList.length !== list.length) {
        await swCall('SetLocalData', { pdd_huice_windows: newList });
      }
    } catch(e) {}
    console.log(HUICE_NS, '✓ Saved ' + normalized.length + ' records for ' + date);
  }

  async function getHuiceDataByDate(date) {
    if (!date) return [];
    const key = 'pdd_huice_window_' + date;
    const d = await swCall('GetLocalData', { key: [key] });
    const v = d?.[key];
    return v?.records || [];
  }

  /** 读日期范围内所有天的 huice 数据,按 productId 聚合(多天数值相加)
   *  双通道: 优先 HTTP 服务(127.0.0.1:9911),失败 fallback 回 storage
   */
  async function getHuiceDataByDateRange(startDate, endDate) {
    if (!startDate) return [];
    const end = endDate || startDate;

    // === 通道 1: 本地 HTTP 服务(日常 Chrome 也能用) ===
    try {
      const resp = await fetch(`http://127.0.0.1:9911/huice?start=${startDate}&end=${end}`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const data = await resp.json();
        if (data.records && Array.isArray(data.records) && data.records.length > 0) {
          console.log(HUICE_NS, `✅ HTTP 通道命中: ${data.count} 条 (${startDate} ~ ${end})`);
          return data.records;
        }
      }
    } catch (e) {
      // HTTP 服务不在线,静默 fallback
    }

    // === 通道 2: 扩展 storage(CDP Chrome 原有方式) ===
    const start = new Date(startDate);
    const endD = new Date(end);
    if (isNaN(start) || isNaN(endD)) return [];

    // 收集范围内所有日期 key
    const keys = [];
    const cur = new Date(start);
    while (cur <= endD) {
      const y = cur.getFullYear();
      const m = String(cur.getMonth() + 1).padStart(2, '0');
      const d = String(cur.getDate()).padStart(2, '0');
      keys.push('pdd_huice_window_' + y + '-' + m + '-' + d);
      cur.setDate(cur.getDate() + 1);
    }

    // 一次性读所有 key
    const d = await swCall('GetLocalData', { key: keys });
    if (!d) return [];

    const allRecords = [];
    for (const k of keys) {
      const v = d[k];
      if (!v) continue;
      const records = v.records || v;
      if (!Array.isArray(records)) continue;
      allRecords.push(...records);
    }
    const aggregated = aggregateHuiceRecords(allRecords);
    console.log(HUICE_NS, `📦 storage 通道: ${aggregated.length} 条 (${startDate} ~ ${end})`);
    return aggregated;
  }

  /** 慧经营页面：从表格提取商品级数据
   *  支持两种容器：
   *  - AG-Grid（商品分析页主力，按 colId 映射，列顺序无关）
   *  - el-table（兜底，按表头文字 includes 匹配）
   *  dateOverride：覆盖 record.date（不传则用今天）
   */
  function extractHuiceFromDOM(dateOverride) {
    const records = [];
    const useDate = dateOverride || new Date().toISOString().slice(0, 10);

    // === AG-Grid 分支（商品分析页 /opertData/CommodityAnalysis 用此结构）===
    // pinned-left 列顺序固定：[图片?, 店铺, 链接名称, 链接ID, 链接编码?]
    // center 列按 colId 标识字段，无需读表头
    const grids = document.querySelectorAll('.ag-root');
    grids.forEach(grid => {
      const pinnedRows = Array.from(grid.querySelectorAll('.ag-pinned-left-cols-container .ag-row'));
      const centerRows = Array.from(grid.querySelectorAll('.ag-center-cols-container .ag-row'));
      if (!pinnedRows.length && !centerRows.length) return;

      const maxLen = Math.max(pinnedRows.length, centerRows.length);
      for (let i = 0; i < maxLen; i++) {
        const pinned = pinnedRows[i] ? Array.from(pinnedRows[i].querySelectorAll('.ag-cell')).map(c => (c.textContent || '').trim()) : [];
        const center = centerRows[i] ? Array.from(centerRows[i].querySelectorAll('.ag-cell')) : [];

        // pinned 列：店铺(idx 1)、链接名称(idx 2)、链接ID(idx 3)
        const shopName = pinned[1] || '';
        const productName = pinned[2] || '';
        const rawId = pinned[3] || '';
        const productId = rawId.replace(/\D/g, '');
        if (!productId) continue;

        // center 列按 colId 取值（列顺序无关，最稳）
        const byColId = {};
        for (const cell of center) {
          const colId = cell.getAttribute('col-id') || cell.getAttribute('colId') || '';
          if (colId) byColId[colId] = (cell.textContent || '').trim();
        }

        const parseNum = (v) => { const n = parseFloat(String(v || '').replace(/,/g, '').replace(/%/g, '')); return isNaN(n) ? null : n; };
        const parsePct = (v) => { const n = parseNum(v); return n != null ? n / 100 : null; };

        records.push({
          productId,
          productName,
          shopName,
          salesAmount: parseNum(byColId.receivableAmount),
          salesQuantity: parseNum(byColId.payQty),
          orderCount: parseNum(byColId.payQty),
          costPrice: parseNum(byColId.costAmount),
          grossProfit: parseNum(byColId.grossProfit),
          grossProfitRate: parsePct(byColId.grossProfitRateString),
          refundAmount: parseNum(byColId.refundAmount),
          refundRate: parsePct(byColId.refundRateString),
          rawNetProfit: parseNum(byColId.netProfit),
          rawNetProfitRate: parsePct(byColId.netInterestString),
          date: useDate,
          source: 'huice'
        });
      }
    });
    if (records.length) return records; // AG-Grid 命中则直接返回

    // === el-table 兜底分支（其他页面可能用此结构）===
    const tables = document.querySelectorAll('.el-table');
    tables.forEach(table => {
      const headerEls = table.querySelectorAll('.el-table__header-wrapper th, .el-table__header th');
      const headers = Array.from(headerEls).map(th => (th.textContent || '').trim());
      if (!headers.length) return;

      const idx = (name) => {
        const i = headers.findIndex(h => h.includes(name));
        return i >= 0 ? i : -1;
      };
      const linkIdx = idx('链接ID') !== -1 ? idx('链接ID') : idx('商品ID');
      const nameIdx = idx('链接名称');
      const salesAmtIdx = idx('销售额');
      const salesQtyIdx = idx('销量');
      const refundAmtIdx = idx('退款金额');
      const refundRateIdx = idx('退款率');
      const netProfitIdx = idx('净利');
      const netProfitRateIdx = idx('净利率');
      const costIdx = idx('成本');
      const shopIdx = idx('店铺');

      if (linkIdx === -1 && nameIdx === -1) return;

      table.querySelectorAll('.el-table__body-wrapper tbody tr, .el-table__body tbody tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim());
        if (!cells.length || cells.length <= Math.max(linkIdx, nameIdx)) return;
        const rawId = linkIdx >= 0 ? cells[linkIdx] : '';
        const productId = rawId.replace(/\D/g, '');
        if (!productId) return;

        const parseNum = (v) => { const n = parseFloat(String(v || '').replace(/,/g, '')); return isNaN(n) ? null : n; };
        const parsePct = (v) => { const n = parseNum(v); return n != null ? n / 100 : null; };

        records.push({
          productId,
          productName: nameIdx >= 0 ? cells[nameIdx] : '',
          shopName: shopIdx >= 0 ? cells[shopIdx] : '',
          salesAmount: parseNum(cells[salesAmtIdx]),
          salesQuantity: salesQtyIdx >= 0 ? parseInt(String(cells[salesQtyIdx]).replace(/,/g, '')) || 0 : 0,
          orderCount: salesQtyIdx >= 0 ? parseInt(String(cells[salesQtyIdx]).replace(/,/g, '')) || 0 : 0,
          refundAmount: parseNum(cells[refundAmtIdx]),
          refundRate: parsePct(cells[refundRateIdx]),
          rawNetProfit: parseNum(cells[netProfitIdx]),
          rawNetProfitRate: parsePct(cells[netProfitRateIdx]),
          costPrice: parseNum(cells[costIdx]),
          date: useDate,
          source: 'huice'
        });
      });
    });
    return records;
  }

  /** 在商品报表弹窗的每行下方插入绿色信息条 */
  function applyHuiceStrips(huiceMap, renderData) {
    const table = document.querySelector('.el-table');
    if (!table) return;
    // 清除旧的 strips
    table.querySelectorAll('.dts-huice-strip').forEach(el => el.remove());

    const rows = table.querySelectorAll('.el-table__body-wrapper tbody tr.el-table__row');
    let shown = 0;
    for (let i = 0; i < rows.length && i < renderData.length; i++) {
      const tr = rows[i];
      const row = renderData[i];
      const itemId = String(row.itemId || row.goodsId || '');
      if (!itemId) continue;

      const huice = huiceMap[itemId];
      const hasData = huice && huice.netProfit != null;

      const strip = document.createElement('div');
      strip.className = 'dts-huice-strip';

      if (hasData) {
        const netProfit = huice.netProfit;
        const netProfitRate = huice.netProfitRate || (huice.salesAmount > 0 ? huice.netProfit / huice.salesAmount : null);
        const salesAmount = huice.salesAmount || 0;
        const refundAmount = huice.refundAmount || 0;
        // 从已回填的 row 读取推广数据
        const spend = Number(row['paidTraffic-spend'] || row.spend || 0);
        const gmv = Number(row['paidTraffic-gmv'] || row.gmv || 0);
        const promoFeeRatio = (gmv > 0 && spend > 0) ? (spend / gmv) : null;
        const breakevenROI = (salesAmount > 0 && netProfit > 0) ? (salesAmount / netProfit) : null;
        const realROI = (gmv > 0 && refundAmount >= 0 && spend > 0) ? ((gmv - refundAmount) / spend) : null;

        const parts = [`净利 ¥${netProfit.toFixed(2)}`];
        if (netProfitRate != null) parts.push(`净利率 ${(netProfitRate * 100).toFixed(2)}%`);
        if (promoFeeRatio != null) parts.push(`推广费比 ${(promoFeeRatio * 100).toFixed(2)}%`);
        if (breakevenROI != null) parts.push(`保本ROI ${breakevenROI.toFixed(2)}`);
        if (realROI != null) parts.push(`退款后ROI ${realROI.toFixed(2)}`);

        strip.textContent = parts.join(' | ');
        strip.style.cssText = 'padding:3px 10px;font-size:11px;color:#389e0d;background:#f6ffed;border-bottom:1px solid #b7eb8f;';
        shown++;
      } else {
        strip.textContent = '⚠️ 慧经营未导入 | 等待每日8:00自动同步';
        strip.style.cssText = 'padding:3px 10px;font-size:11px;color:#999;background:#fafafa;border-bottom:1px solid #eee;';
      }
      tr.parentNode.insertBefore(strip, tr.nextSibling);
    }
    if (shown > 0) console.log(HUICE_NS, '✓ applied strips for ' + shown + ' rows');
    return shown;
  }

  /**
   * 向商品报表弹窗注入 4 个「真列」：净利润 / 净利率 / 推广费比 / 保本ROI
   * 位置：「商品明细」列后、「推广数据」列前。
   * 技术：element-ui 2.15.14 store.commit('insertColumn', columnConfig, idx)
   *       与原生 <el-table-column> mount 走同一注册路径，表头/列宽/重排自动处理。
   * 幂等：每次调用先检查 property 是否已存在，已存在则只刷新值（mms 翻页/切日期会重建表格）。
   * 兜底：store.commit 不可用或抛错时返回 false，调用方降级到 applyHuiceStrips。
   */
  function injectHuiceColumns(tableComp, dataComp, renderData, huiceMap) {
    if (!tableComp || !tableComp.store || !dataComp || !renderData) return false;
    const store = tableComp.store;
    const cols = store.states.columns || [];
    // 6 列定义（原4列 + 毛利率 + 退款率）
    const HUICE_COLS = [
      { property: 'huice-netProfit',     label: '净利润',   fmt: v => v == null ? '--' : '¥' + Number(v).toFixed(2) },
      { property: 'huice-netProfitRate', label: '净利率',   fmt: v => v == null ? '--' : (Number(v) * 100).toFixed(2) + '%' },
      { property: 'huice-grossProfitRate', label: '毛利率', fmt: v => v == null ? '--' : (Number(v) * 100).toFixed(2) + '%' },
      { property: 'huice-refundAmount',  label: '退款额',   fmt: v => v == null ? '--' : '¥' + Number(v).toFixed(2) },
      { property: 'huice-promoFeeRatio', label: '推广费比', fmt: v => v == null ? '--' : (Number(v) * 100).toFixed(2) + '%' },
      { property: 'huice-breakevenROI',  label: '保本ROI',  fmt: v => v == null ? '--' : Number(v).toFixed(2) },
    ];

    // 幂等：若第一列已存在则跳过 insert，只刷新值
    const alreadyInjected = cols.some(c => c.property === HUICE_COLS[0].property);
    if (!alreadyInjected) {
      try {
        // === 锚点定位：插到表格最前面 ===
        let insertAt = 0;
        let anchorReason = 'front (idx 0)';

        // 用一个已存在的真实列做模板（深拷贝，避免引用串数据）
        const tplCol = cols[0] || {};
        const tplJson = {};
        // 抄基本布局字段
        ['type', 'className', 'labelClassName', 'columnKey', 'fixed', 'resizable', 'align', 'headerAlign', 'showOverflowTooltip', 'filterable', 'filteredValue', 'filterPlacement', 'sortable', 'index', 'order', 'isColumnGroup', 'filterOpened', 'selectable'].forEach(k => { if (k in tplCol) tplJson[k] = tplCol[k]; });
        tplJson.sortable = false;       // 新列不可排序（数据是算出来的）
        tplJson.fixed = undefined;      // 不固定
        tplJson.resizable = true;

        for (const def of HUICE_COLS) {
          const cfg = JSON.parse(JSON.stringify(tplJson));
          cfg.id = def.property + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
          cfg.property = def.property;
          cfg.label = def.label;
          cfg.realWidth = 100;
          cfg.minWidth = 80;
          cfg.width = 100;
          // renderHeader：让表头带颜色辨识（绿底）
          cfg.renderHeader = function(h, { column }) {
            return h('div', { style: 'color:#389e0d;font-weight:600;' }, column.label);
          };
          // renderCell：自定义格式化 + 亏损标红 + 无数据占位
          cfg.renderCell = function(h, { row, column }) {
            const val = row[column.property];
            // 净利润列亏损标红
            if (column.property === 'huice-netProfit' && val != null && Number(val) < 0) {
              return h('span', { style: 'color:#f5222d;font-weight:600;' }, def.fmt(val));
            }
            return h('span', { style: val == null ? 'color:#bbb;' : 'color:#389e0d;' }, def.fmt(val));
          };
          store.commit('insertColumn', cfg, insertAt);
          insertAt++;
        }
        console.log(HUICE_NS, '✓ injected 4 real columns at idx ' + (insertAt - HUICE_COLS.length) + ' (' + anchorReason + ')');
      } catch (e) {
        console.warn(HUICE_NS, '⚠️ insertColumn failed, fallback to strips:', e.message);
        return false;
      }
    }

    // 回填值到 renderData（property 用连字符键，不含点，getPropByPath 安全）
    let filled = 0;
    for (const row of renderData) {
      if (!row) continue;
      const itemId = String(row.itemId || row.goodsId || '');
      if (!itemId) continue;
      const huice = huiceMap[itemId];
      const set = (prop, val) => { try { dataComp.$set(row, prop, val); } catch (e) {} };

      if (huice && huice.netProfit != null) {
        const netProfit = huice.netProfit;
        const netProfitRate = huice.netProfitRate != null ? huice.netProfitRate : (huice.salesAmount > 0 ? huice.netProfit / huice.salesAmount : null);
        const grossProfitRate = huice.grossProfitRate != null ? huice.grossProfitRate : null;
        // 退款额
        const refundAmount = huice.refundAmount != null ? huice.refundAmount : null;
        // 从已回填的 row 读推广数据算推广费比
        const spend = Number(row['paidTraffic-spend'] || row.spend || 0);
        const gmv = Number(row['paidTraffic-gmv'] || row.gmv || 0);
        const promoFeeRatio = (gmv > 0 && spend > 0) ? (spend / gmv) : null;
        const breakevenROI = (huice.salesAmount > 0 && netProfit > 0) ? (huice.salesAmount / netProfit) : null;
        // 推广费比优化:如果 mms 有 spend 但无 gmv,用 salesAmount 估算
        const estGmv = gmv > 0 ? gmv : (huice.salesAmount || 0);
        const estPromoFeeRatio = (estGmv > 0 && spend > 0) ? (spend / estGmv) : null;

        set('huice-netProfit', netProfit);
        set('huice-netProfitRate', netProfitRate);
        set('huice-grossProfitRate', grossProfitRate);
        set('huice-refundAmount', refundAmount);
        set('huice-promoFeeRatio', estPromoFeeRatio || promoFeeRatio);
        set('huice-breakevenROI', breakevenROI);
        filled++;
      } else {
        // 无数据：显式置 null，让 renderCell 显示 '--'
        set('huice-netProfit', null);
        set('huice-netProfitRate', null);
        set('huice-grossProfitRate', null);
        set('huice-refundAmount', null);
        set('huice-promoFeeRatio', null);
        set('huice-breakevenROI', null);
      }
    }
    try { tableComp.$forceUpdate(); dataComp.$forceUpdate(); } catch (e) {}
    const hasHuiceData = Object.keys(huiceMap).length > 0;
    if (hasHuiceData && filled === 0) {
      // 有数据但没填进去：productId 类型不匹配？打印样本帮助定位
      const sampleRow = renderData.find(r => r);
      const sampleId = sampleRow ? String(sampleRow.itemId || sampleRow.goodsId || '') : '(none)';
      console.warn(HUICE_NS, '⚠️ huiceMap has ' + Object.keys(huiceMap).length + ' entries but filled=0; sample renderData itemId=' + sampleId + ', huiceMap keys sample=' + Object.keys(huiceMap).slice(0, 3).join(','));
    } else {
      console.log(HUICE_NS, '✓ filled ' + filled + '/' + renderData.length + ' rows with huice data (map size=' + Object.keys(huiceMap).length + ')');
    }
    return true;
  }

  // ============ 店铺利润汇总 ============

  /** 从当前弹窗页提取商品 ID 和已命中的慧经营记录 */
  function getDialogPageData(dialog, huiceMap) {
    const elTable = dialog.querySelector('.el-table');
    let tableComp = elTable?.__vue__ || null;
    for (let el = elTable; el && !tableComp; el = el.parentElement) tableComp = el.__vue__ || null;
    let dataComp = tableComp?.$parent || null;
    for (let depth = 0; dataComp && depth < 8; depth++, dataComp = dataComp.$parent) {
      const renderData = dataComp.$data?.renderData;
      if (!Array.isArray(renderData)) continue;
      const scannedProductIds = new Set();
      const matchedRecords = new Map();
      for (const row of renderData) {
        const productId = String(row?.itemId || row?.goodsId || '');
        if (!productId) continue;
        scannedProductIds.add(productId);
        const huice = huiceMap[productId];
        if (huice && Number.isFinite(huice.netProfit)) matchedRecords.set(productId, huice);
      }
      return {
        tableComp,
        dataComp,
        renderData,
        scannedProductIds,
        matchedRecords,
        signature: [...scannedProductIds].sort().join(','),
      };
    }
    return null;
  }

  async function waitForDialogPageChange(dialog, beforeSignature, huiceMap, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const page = getDialogPageData(dialog, huiceMap);
      if (page && page.signature !== beforeSignature) return page;
    }
    throw new Error('product report page did not change');
  }

  async function restoreDialogPage(dialog, originalPage, previous, huiceMap, timeoutMs) {
    try {
      while (true) {
        const activePage = Number(dialog.querySelector('.el-pager .number.active')?.textContent || 1);
        if (activePage <= originalPage || previous.disabled || previous.classList.contains('disabled')) return;
        const before = getDialogPageData(dialog, huiceMap)?.signature || '';
        previous.click();
        await waitForDialogPageChange(dialog, before, huiceMap, timeoutMs);
      }
    } catch (error) {
      console.warn(HUICE_NS, 'failed to restore original product-report page:', error.message);
    }
  }

  /** 逐页收录已命中慧经营记录,完成后恢复原页 */
  async function collectMatchedReportRecords(dialog, huiceMap) {
    const initial = getDialogPageData(dialog, huiceMap);
    const pager = dialog.querySelector('.el-pagination');
    const next = pager?.querySelector('.btn-next');
    const previous = pager?.querySelector('.btn-prev');
    if (!initial || !pager || !next || !previous) return { ok: false, reason: 'pager or renderData unavailable' };

    const originalPage = Number(pager.querySelector('.el-pager .number.active')?.textContent || 1);
    const scannedProductIds = new Set();
    const matchedRecords = new Map();
    let pageCount = 0;
    try {
      while (true) {
        const page = getDialogPageData(dialog, huiceMap);
        if (!page) throw new Error('renderData unavailable');
        page.scannedProductIds.forEach(id => scannedProductIds.add(id));
        page.matchedRecords.forEach((record, id) => matchedRecords.set(id, record));
        pageCount++;
        if (next.disabled || next.classList.contains('disabled')) break;
        if (pageCount >= 200) throw new Error('product report page limit exceeded');
        next.click();
        await waitForDialogPageChange(dialog, page.signature, huiceMap, 5000);
      }
      return { ok: true, scannedProductIds, matchedRecords, pageCount };
    } catch (error) {
      return { ok: false, reason: error.message };
    } finally {
      await restoreDialogPage(dialog, originalPage, previous, huiceMap, 5000);
    }
  }

  /** 在扩展内汇总已命中的慧经营记录 */
  function summarizeMatchedHuiceRecords(records) {
    const aggregated = aggregateHuiceRecords(records);
    const matched = aggregated.filter(record => Number.isFinite(record.netProfit));
    const sum = field => {
      const values = matched.map(record => Number(record[field])).filter(Number.isFinite);
      return values.length ? values.reduce((total, value) => total + value, 0) : null;
    };
    const salesAmount = sum('salesAmount');
    const netProfit = sum('netProfit');
    return {
      matchedProductCount: matched.length,
      summary: {
        salesAmount,
        rawNetProfit: sum('rawNetProfit'),
        orderFixedCost: sum('orderFixedCost'),
        platformFee: sum('platformFee'),
        netProfit,
        netProfitRate: salesAmount && salesAmount > 0 && netProfit !== null ? netProfit / salesAmount : null,
      },
    };
  }

  /** 店铺汇总列定义 */
  const SHOP_SUMMARY_COLS = [
    { property: 'huice-shop-salesAmount',   label: '店铺销售额',   fmt: v => v == null ? '--' : '¥' + Number(v).toFixed(2) },
    { property: 'huice-shop-rawNetProfit',  label: '店铺原始净利', fmt: v => v == null ? '--' : '¥' + Number(v).toFixed(2) },
    { property: 'huice-shop-orderFixedCost',label: '包装人工',     fmt: v => v == null ? '--' : '¥' + Number(v).toFixed(2) },
    { property: 'huice-shop-platformFee',   label: '平台费',       fmt: v => v == null ? '--' : '¥' + Number(v).toFixed(2) },
    { property: 'huice-shop-netProfit',     label: '店铺调整净利', fmt: v => v == null ? '--' : '¥' + Number(v).toFixed(2) },
    { property: 'huice-shop-netProfitRate', label: '店铺调整净利率',fmt: v => v == null ? '--' : (Number(v) * 100).toFixed(2) + '%' },
    { property: 'huice-shop-coverage',      label: '覆盖商品',     fmt: v => v == null ? '--' : String(v) },
  ];

  /** 注入店铺汇总列 */
  function injectShopSummaryColumns(tableComp) {
    if (!tableComp || !tableComp.store) return false;
    const store = tableComp.store;
    const cols = store.states.columns || [];
    const alreadyInjected = cols.some(c => c.property === SHOP_SUMMARY_COLS[0].property);
    if (alreadyInjected) return true;

    // 店铺汇总列插在绿色商品列后面(也就是表格最前面 6 列之后)
    let insertAt = cols.findIndex(c => c.property === 'huice-breakevenROI');
    if (insertAt < 0) insertAt = 0;
    else insertAt++;

    const tplCol = cols[0] || {};
    const tplJson = {};
    ['type', 'className', 'labelClassName', 'columnKey', 'fixed', 'resizable', 'align', 'headerAlign', 'showOverflowTooltip', 'filterable', 'filteredValue', 'filterPlacement', 'sortable', 'index', 'order', 'isColumnGroup', 'filterOpened', 'selectable'].forEach(k => { if (k in tplCol) tplJson[k] = tplCol[k]; });
    tplJson.sortable = false;
    tplJson.fixed = undefined;
    tplJson.resizable = true;

    for (const def of SHOP_SUMMARY_COLS) {
      const cfg = JSON.parse(JSON.stringify(tplJson));
      cfg.id = def.property + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      cfg.property = def.property;
      cfg.label = def.label;
      cfg.realWidth = 110;
      cfg.minWidth = 80;
      cfg.width = 110;
      cfg.renderHeader = function(h, { column }) {
        return h('div', { style: 'color:#722ed1;font-weight:600;' }, column.label);
      };
      cfg.renderCell = function(h, { row, column }) {
        const val = row[column.property];
        if (column.property === 'huice-shop-netProfit' && val != null && Number(val) < 0) {
          return h('span', { style: 'color:#f5222d;font-weight:600;' }, def.fmt(val));
        }
        return h('span', { style: val == null ? 'color:#bbb;' : 'color:#722ed1;' }, def.fmt(val));
      };
      store.commit('insertColumn', cfg, insertAt);
      insertAt++;
    }
    console.log(HUICE_NS, '✓ injected 7 shop summary columns at idx ' + (insertAt - SHOP_SUMMARY_COLS.length));
    return true;
  }

  /** 回填店铺汇总值到当前页所有行 */
  function fillShopSummaryRows(dataComp, renderData, result, scannedProductCount) {
    const summary = result?.summary;
    const coverage = result ? `${result.matchedProductCount} / ${scannedProductCount}` : null;
    // 店铺汇总只在第一行显示,其余行显示 -- 避免视觉重复
    for (let i = 0; i < renderData.length; i++) {
      const row = renderData[i];
      if (!row) continue;
      const set = (prop, val) => { try { dataComp.$set(row, prop, val); } catch (e) {} };
      if (i === 0) {
        set('huice-shop-salesAmount', summary?.salesAmount ?? null);
        set('huice-shop-rawNetProfit', summary?.rawNetProfit ?? null);
        set('huice-shop-orderFixedCost', summary?.orderFixedCost ?? null);
        set('huice-shop-platformFee', summary?.platformFee ?? null);
        set('huice-shop-netProfit', summary?.netProfit ?? null);
        set('huice-shop-netProfitRate', summary?.netProfitRate ?? null);
        set('huice-shop-coverage', coverage);
      } else {
        set('huice-shop-salesAmount', null);
        set('huice-shop-rawNetProfit', null);
        set('huice-shop-orderFixedCost', null);
        set('huice-shop-platformFee', null);
        set('huice-shop-netProfit', null);
        set('huice-shop-netProfitRate', null);
        set('huice-shop-coverage', null);
      }
    }
  }

  /** 亏损商品整行标红 */
  function ensureLossRowStyle() {
    if (document.getElementById('dts-huice-loss-row-style')) return;
    const style = document.createElement('style');
    style.id = 'dts-huice-loss-row-style';
    style.textContent = `
      .dts-huice-loss-row > td,
      .dts-huice-loss-row > td .cell,
      .dts-huice-loss-row > td .cell * {
        color: #f5222d !important;
      }
    `;
    document.head.appendChild(style);
  }

  function applyLossRowHighlight(dialog, renderData, huiceMap) {
    ensureLossRowStyle();
    const table = dialog.querySelector('.el-table');
    const bodies = [
      table?.querySelector('.el-table__body-wrapper'),
      table?.querySelector('.el-table__fixed .el-table__fixed-body-wrapper'),
      table?.querySelector('.el-table__fixed-right .el-table__fixed-body-wrapper'),
    ].filter(Boolean);
    for (const body of bodies) {
      const rows = body.querySelectorAll('tbody tr.el-table__row');
      rows.forEach((element, index) => {
        const productId = String(renderData[index]?.itemId || renderData[index]?.goodsId || '');
        const isLoss = Number(huiceMap[productId]?.netProfit) < 0;
        element.classList.toggle('dts-huice-loss-row', isLoss);
      });
    }
  }

  /**
   * 读 mms 商品报表弹窗当前所选日期窗口（支持任意日期，含自定义）。
   * CDP 实测：「统计时间：YYYY-MM-DD ~ YYYY-MM-DD」文本始终反映当前真实窗口，
   * 无论选快捷按钮还是自定义日期都会更新。
   * 策略：①优先在全文本搜日期范围（宽容正则，处理各种空白/Unicode字符）
   *       ②读选中按钮文本→映射到窗口
   */
  function readDialogDateWindow() {
    const dialog = document.querySelector('.el-dialog__wrapper, .el-dialog.dts-modal');
    if (!dialog) return null;
    // ①在全文本找日期范围（兼容各种空白和标点）
    const txt = (dialog.innerText || '').replace(/\s+/g, ' ');
    // 匹配 "统计时间: YYYY-MM-DD ~ YYYY-MM-DD" 或 "统计时间: YYYY-MM-DD 至 YYYY-MM-DD"
    const m = txt.match(/统计时间[：:]\s*(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})\s*[~～\-—至到]\s*(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})/);
    if (m) {
      const s = m[1] + '-' + m[2].padStart(2,'0') + '-' + m[3].padStart(2,'0');
      const e = m[4] + '-' + m[5].padStart(2,'0') + '-' + m[6].padStart(2,'0');
      return s + '~' + e;
    }
    // 单日
    const single = txt.match(/统计时间[：:]\s*(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})(?![~\-至到])/);
    if (single) {
      const s = single[1] + '-' + single[2].padStart(2,'0') + '-' + single[3].padStart(2,'0');
      return s + '~' + s;
    }
    // ②fallback：按钮文本映射
    const today = new Date();
    const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const ymd = off => { const d = new Date(today); d.setDate(d.getDate()+off); return fmt(d); };
    const BTN_MAP = {
      '实时': [ymd(0), ymd(0)], '今日': [ymd(0), ymd(0)],
      '昨天': [ymd(-1), ymd(-1)], '昨日': [ymd(-1), ymd(-1)],
      '近7天': [ymd(-7), ymd(-1)], '近7日': [ymd(-7), ymd(-1)],
      '近30天': [ymd(-30), ymd(-1)], '近30日': [ymd(-30), ymd(-1)],
    };
    const btns = Array.from(dialog.querySelectorAll('button.el-button'));
    for (const b of btns) {
      if (!b.className.includes('el-button--primary') || b.className.includes('is-plain')) continue;
      const norm = (b.innerText || '').replace(/\s/g, '');
      if (BTN_MAP[norm]) return BTN_MAP[norm][0] + '~' + BTN_MAP[norm][1];
    }
    return null;
  }

  /**
   * 回填 Vue 商品报表弹窗（.el-dialog__wrapper 里的 el-table）的花费/ROI。
   * 拼多多 mms 报表 API 把花费字段全部返回 0，需要从 yingxiao 抓到的数据补上。
   * 策略：定位 el-table 的 Vue renderData，按 itemId 匹配 promoMap，$set + $forceUpdate 触发重渲染。
   *
   * 日期窗口处理（v12 改进，解决「过0点近7天空白」）：
   *   - v11 用严格相等检查，过0点后弹窗窗口滚动（6/18~6/24）vs 采集窗口（6/17~6/23）→ 不回填 → 空白
   *   - v12 改为「重叠即回填」：两个窗口有任何重叠日期就回填
   *   - 回填后通过 promoWindowSource 记录实际数据口径，供 UI 标注（如有列可显示）
   *
   * 字段回填（v12 扩展）：
   *   - 不再硬编码只填 spend/roi/gmv 三个，而是按弹窗 el-table 实际存在的列 property 回填
   *   - 列名映射：弹窗 paidTraffic-xxx ↔ promo.xxx（如 paidTraffic-directGmv ↔ directGmv）
   */
  // 解析 "YYYY-MM-DD~YYYY-MM-DD" 为 [start, end] Date
  function parseWindow(win) {
    if (!win) return null;
    const m = win.match(/(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})/);
    if (!m) return null;
    return [new Date(m[1] + 'T00:00:00'), new Date(m[2] + 'T23:59:59')];
  }
  // 两个窗口是否有重叠
  function windowsOverlap(w1, w2) {
    const a = parseWindow(w1), b = parseWindow(w2);
    if (!a || !b) return true; // 任一读不到，默认允许回填（避免误空白）
    return a[0] <= b[1] && b[0] <= a[1];
  }

  function applyPromoToVueDialog(promoMap) {
    const dialog = document.querySelector('.el-dialog__wrapper');
    if (!dialog || dialog.style.display === 'none') return { filled: 0, reason: 'no dialog' };

    // v12 日期窗口检查：重叠即回填（解决过0点空白）
    const dialogWindow = readDialogDateWindow();
    const firstPromo = Object.values(promoMap)[0];
    const promoWindow = firstPromo?.dateWindow;
    if (dialogWindow && promoWindow && !windowsOverlap(dialogWindow, promoWindow)) {
      console.log(NS, '⏭️ skip fill: no overlap between dialog=' + dialogWindow + ' and promo=' + promoWindow);
      return { filled: 0, reason: 'no window overlap: ' + dialogWindow + ' vs ' + promoWindow };
    }
    if (promoWindow) {
      console.log(NS, '📅 window overlap OK: dialog=' + (dialogWindow || '?') + ' promo=' + promoWindow);
    }

    // 定位 el-table 及其数据拥有组件（DynamicTable，持有 renderData）
    const elTable = dialog.querySelector('.el-table');
    if (!elTable) return { filled: 0, reason: 'no el-table' };
    let tableComp = null;
    let el = elTable;
    while (el && !tableComp) { if (el.__vue__) tableComp = el.__vue__; el = el.parentElement; }
    if (!tableComp) return { filled: 0, reason: 'no el-table vue' };

    // 向上找持有 renderData 的父组件
    let dataComp = tableComp.$parent;
    let renderData = null;
    let walkLevel = 0;
    while (dataComp && walkLevel < 8) {
      const d = dataComp.$data || {};
      if (Array.isArray(d.renderData) && d.renderData.length) { renderData = d.renderData; break; }
      dataComp = dataComp.$parent;
      walkLevel++;
    }
    if (!renderData || !dataComp) return { filled: 0, reason: 'no renderData' };

    // v12: 读取 el-table 实际存在的列，按列 property 动态回填（不再硬编码 3 字段）
    // 列 property 形如 paidTraffic-spend / stableCostPromotion-ctr 等
    // v15: 扩展回填范围，不只 paidTraffic-，还包括 stableCostPromotion- / fullStoreManaged-
    //   （这两组列 mms 也返0，但有 CTR/CPM/收藏/关注/询单/点击等全套，yingxiao 已采集）
    const columns = tableComp.store?.states?.columns || [];
    const fillableProps = columns
      .map(c => c.property)
      .filter(p => p && /^(paidTraffic|stableCostPromotion|fullStoreManaged)-/.test(p));
    // 映射：列 property（去前缀）→ promo 字段名候选
    // CDP 实测弹窗列名 vs promo 字段名对应（见 memory/decisions.md）
    const PROP_ALIASES = {
      // === paidTraffic 组 ===
      'roi': ['orderSpendNetRoi', 'roi'],
      'gmv': ['gmv', 'payGmv'],
      'spend': ['spend', 'orderSpend'],
      'payOrdrCnt': ['orderNum', 'payOrdrCnt'],
      'directPayOrdrCnt': ['directOrderNum', 'directPayOrdrCnt'],
      'indirectPayOrdrCnt': ['indirectOrderNum', 'indirectPayOrdrCnt'],
      'goodsVcr': ['cvr', 'goodsVcr'],
      'orderRate': ['netOrderNumRate', 'orderRate'],
      'goodsUv': [],  // promo 无访客数
      // === stableCostPromotion / fullStoreManaged 组（共用字段名）===
      'impression': ['impression', 'billingImpression'],
      'clickCount': ['click'],
      'directGmv': ['directGmv', 'directPayGmv'],
      'indirectGmv': ['indirectGmv'],
      'transactionCost': ['costPerOrder'],
      'avgPayAmount': ['avgPayAmount'],
      'avgDirectPayAmount': [],  // promo 无单独字段
      'avgIndirectPayAmount': [],
      'orderNum': ['orderNum'],
      'directOrderNum': ['directOrderNum'],
      'indirectOrderNum': ['indirectOrderNum'],
      'ctr': ['ctr'],
      'cvr': ['cvr'],
      'clickSpendAvg': [],  // promo 无（=spend/click 可算但暂不）
      'cpm': [],  // promo 无（=spend/impression*1000 可算但暂不）
      'goodsFavNum': ['multiGoalGoodsFavNum'],
      'mallFavNum': ['multiGoalMallFavNum'],
      'inquiryNum': ['multiGoalInquiryNum'],
    };
    function resolvePromoField(propSuffix) {
      const candidates = PROP_ALIASES[propSuffix] || [propSuffix];
      for (const cand of candidates) {
        if (cand && cand in firstPromo) return cand;
      }
      return null; // 没匹配到，跳过此列
    }
    if (fillableProps.length === 0) {
      // fallback：没读到列定义，用默认 3 字段（兼容旧逻辑）
      console.log(NS, '⚠️ no paidTraffic-* columns detected, fallback to spend/roi/gmv');
    }

    let filled = 0;
    let matched = 0;
    for (let i = 0; i < renderData.length; i++) {
      const row = renderData[i];
      if (!row) continue;
      // v11: 去掉 __pddPromoFilled 跳过逻辑——它导致切日期后永不刷新（永远显示首次值）。
      //      改为每次都重填，配合上面的日期窗口一致性检查来避免错误覆盖。
      const itemId = String(row.itemId || '');
      if (!itemId) continue;
      const promo = promoMap[itemId];
      if (!promo) continue;
      matched++;

      // 只有有实际推广数据才回填（spend>0 或 gmv>0）
      const hasData = (promo.spend > 0) || (promo.gmv > 0) || (promo.roi > 0);
      if (!hasData) continue;

      try {
        const propsToFill = fillableProps.length ? fillableProps : ['paidTraffic-spend', 'paidTraffic-roi', 'paidTraffic-gmv'];
        for (const prop of propsToFill) {
          const suffix = prop.replace(/^paidTraffic-/, '');
          const promoField = resolvePromoField(suffix);
          if (!promoField) continue; // 该列在 promo 无对应字段（如 goodsUv 访客数），跳过
          if (promoField in promo && promo[promoField] !== undefined && promo[promoField] !== null) {
            const numVal = Number(promo[promoField]);
            if (!isNaN(numVal)) dataComp.$set(row, prop, numVal);
          }
        }
        filled++;
      } catch(e) {
        console.warn(NS, 'set row failed for', itemId, e.message);
      }
    }

    if (filled > 0) {
      // 强制 el-table 重渲染，让单元格立刻显示新值
      try { dataComp.$forceUpdate(); tableComp.$forceUpdate(); } catch(e) {}
      console.log(NS, '✓ Vue dialog: filled ' + filled + '/' + matched + ' rows');
    }
    return { filled, matched };
  }

  // ============ MutationObserver（mms 页面表格重渲染时重注入） ============
  let mmsObserver = null;
  let injectTimer = null;
  function setupMmsObserver() {
    if (mmsObserver) return;
    mmsObserver = new MutationObserver(() => {
      if (injectTimer) return;
      injectTimer = setTimeout(() => {
        injectTimer = null;
        tryInject();
      }, 800);
    });
    mmsObserver.observe(document.body, { childList: true, subtree: true });
    console.log(NS, '✓ mms MutationObserver active');
  }

  // ============ 启动（按页面类型） ============
  if (location.hostname.includes('mms.pinduoduo') || location.hostname.includes('yangkeduo')) {
    // === mms 商品报表页面（React） ===
    console.log(NS, 'mms mode: React table injection');
    setupStorageListener();
    if (document.body) setupMmsObserver();
    else document.addEventListener('DOMContentLoaded', setupMmsObserver);
    setTimeout(tryInject, 3000);
    setTimeout(tryInject, 8000);
    setTimeout(tryInject, 15000);
    setTimeout(tryInject, 30000);

    // v13: 监听弹窗日期按钮点击（实时/昨天/近7天/近30天），切换后重新回填对应窗口数据。
    // 用事件委托挂在 body 上，弹窗内任何点击都检查是否命中日期按钮。
    document.addEventListener('click', (e) => {
      const dialog = document.querySelector('.el-dialog.dts-modal, .el-dialog__wrapper');
      if (!dialog) return;
      // 判断点击的是否在弹窗内、且是日期相关按钮
      const btn = e.target.closest ? e.target.closest('button, .el-button') : null;
      if (!btn || !dialog.contains(btn)) return;
      const txt = (btn.innerText || '').replace(/\s/g, '');
      if (!/^(昨天|近7天|近30天|近90天|实时|今日|昨日|近\d+天)$/.test(txt)) return;
      console.log(NS, '🔄 dialog date clicked: ' + txt + ', will refetch in 4s');
      // 切日期后 mms 会重新加载 renderData，延迟让新数据加载完再回填
      setTimeout(tryInject, 4000);
      setTimeout(tryInject, 7000);
    }, true);

  } else if (location.hostname.includes('yingxiao') || location.hostname === 'yingxiao.pinduoduo.com') {
    // === yingxiao 推广平台 ===
    console.log(NS, 'yingxiao mode: fiber capture + API intercept active');

    // v12 采集触发：MutationObserver 监听表格数据行出现，比固定延时可靠
    // （document_start 注入时页面还没渲染，4s/7s 时表格可能还没出）
    let yxCaptured = false;
    let yxCaptureTimer = null;
    function tryYxCapture() {
      if (yxCaptureTimer) return;
      yxCaptureTimer = setTimeout(async () => {
        yxCaptureTimer = null;
        const rows = document.querySelectorAll('tr.anq-table-row:not(.anq-table-measure-row)');
        if (rows.length) {
          const n = await captureFromPage();
          if (n > 0) { yxCaptured = true; console.log(NS, '✓ auto-captured ' + n + ' rows via observer'); }
        }
      }, 1500);
    }
    // 监听 DOM：数据行出现或变化时触发采集
    const yxObserver = new MutationObserver(() => {
      if (!yxCaptured) tryYxCapture(); // 首次抓到就停
    });
    if (document.body) yxObserver.observe(document.body, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', () => yxObserver.observe(document.body, { childList: true, subtree: true }));
    // 兜底延时（observer 万一没触发）
    setTimeout(tryYxCapture, 5000);
    setTimeout(tryYxCapture, 10000);
    setTimeout(tryYxCapture, 20000);

    // 切换日期后重新采集：监听日期输入框变化
    let lastWindow = readYingxiaoDateWindow();
    setInterval(() => {
      const nowWindow = readYingxiaoDateWindow();
      if (nowWindow && nowWindow !== lastWindow) {
        console.log(NS, '🔄 yingxiao date changed: ' + lastWindow + ' → ' + nowWindow);
        lastWindow = nowWindow;
        yxCaptured = false; // 允许重新采集
        setTimeout(tryYxCapture, 3000);
      }
    }, 2000);
    // 保留 API 拦截作为补充触发（handleEntityReport 内部已优先用 fiber）
    setTimeout(triggerYingxiaoRefresh, 5000);

    // v14: 全自动采集多个常用日期窗口（昨日/近7天/近30天），写各自分仓。
    // 这样运营在 mms 弹窗切任意日期，对应分仓已有数据，无需手动操作 yingxiao。
    // 通过 API 直接拉（webpack service），不操作 DOM 日期选择器。
    async function autoCaptureAllWindows() {
      const today = new Date();
      const fmt = d => d.toISOString().slice(0, 10);
      const ymd = (offset) => { const d = new Date(today); d.setDate(d.getDate() + offset); return fmt(d); };
      // 昨天 = 单日；近7天/近30天 = 往前推
      const windows = [
        ['昨日', ymd(-1), ymd(-1)],
        ['近7天', ymd(-7), ymd(-1)],
        ['近30天', ymd(-30), ymd(-1)],
      ];
      // 先试一次 service 可用性（getPddReportService 会抛错说明页面没准备好）
      try { getPddReportService(); }
      catch(e) { console.warn(NS, 'service 未就绪, 多窗口采集稍后重试:', e.message); return false; }

      console.log(NS, '🚀 v14 auto-capture ' + windows.length + ' windows via API');
      for (const [label, start, end] of windows) {
        try {
          const { records } = await fetchPromoWindow(start, end);
          if (records.length) {
            const deduped = dedupeByScenesMode(records);
            // 直接写分仓（不走 savePromoData，因为要指定具体窗口而非当前页面窗口）
            const win = start + '~' + end;
            const payload = { records: deduped, capturedAt: Date.now(), date: start, dateWindow: win };
            await swCall('SetLocalData', {
              ['pdd_promo_window_' + win.replace(/~/g, '_')]: payload,
              [STORE_KEY]: payload, // 最近一次也更新
            });
            // 维护窗口索引
            try {
              const idx = await swCall('GetLocalData', { key: ['pdd_promo_windows'] });
              const list = idx?.['pdd_promo_windows'] || [];
              if (!list.includes(win)) {
                list.push(win);
                await swCall('SetLocalData', { pdd_promo_windows: list });
              }
            } catch(e) {}
            console.log(NS, '  ✓ ' + label + ' (' + win + '): ' + deduped.length + ' records');
          } else {
            console.log(NS, '  ⚠️ ' + label + ' (' + start + '~' + end + '): 无数据');
          }
        } catch(e) {
          console.warn(NS, '  ✗ ' + label + ' 采集失败:', e.message);
        }
        // 请求间隔，避免触发频控
        await new Promise(r => setTimeout(r, 1500));
      }
console.log(NS, '✅ v14 auto-capture 完成');
	      return true;
	    }
	    // 页面加载后延迟启动（等 webpack bundle 就绪）。多次重试覆盖冷启动。
	    let autoWinDone = false;
	    function tryAutoWindows() {
	      if (autoWinDone) return;
autoCaptureAllWindows().then(ok => { if (ok) autoWinDone = true; }).catch(()=>{});
	    }
	    setTimeout(tryAutoWindows, 8000);
	    setTimeout(tryAutoWindows, 15000);
	    setTimeout(tryAutoWindows, 25000);
	  } else if (location.hostname.includes('hjy.huice.com')) {
	    // === 慧经营页面：自动利润数据采集 ===
	    console.log(HUICE_NS, '启动自动利润采集...');

	    function isHuiceTargetPage() {
	      const hash = location.hash || '';
	      const path = location.pathname || '';
	      return hash.includes('CommodityAnalysis') || hash.includes('opertData') || path.includes('commodity') || path.includes('operate');
	    }

	    if (isHuiceTargetPage()) {
	      setupHuiceCapture();
	    } else {
	      let huicePageCheckTimer = setInterval(() => {
	        if (isHuiceTargetPage()) {
	          clearInterval(huicePageCheckTimer);
	          setupHuiceCapture();
	        }
	      }, 2000);
	    }

	    function setupHuiceCapture() {
	      console.log(HUICE_NS, '等待表格渲染...');
	      // 算昨日日期（汇策昨日数据 8:30 后生成，报表读昨日窗口）
	      const yest = new Date(); yest.setDate(yest.getDate() - 1);
	      const yestStr = yest.toISOString().slice(0, 10);
	      const hasTable = () => document.querySelector('.ag-root, .el-table');
	      const observer = new MutationObserver(() => {
	        if (hasTable()) {
	          const records = extractHuiceFromDOM(yestStr);
	          if (records.length > 0) {
	            saveHuiceData(records);
	            observer.disconnect();
	          }
	        }
	      });
	      observer.observe(document.body, { childList: true, subtree: true });
	      setTimeout(() => {
        const records = extractHuiceFromDOM(yestStr);
        if (records.length > 0) {
          saveHuiceData(records);
          observer.disconnect();
        }
      }, 4000);
	    }
	  }

	  // 暴露 API
  window.__PDD_EM = {
    version: 'v16',
    getPromoData,
    getPromoDataByWindow,
    listWindows,
    injectNow: tryInject,
    captureNow: captureFromPage,
    fetchPromoWindow,
    getPddReportService,
    __internal_dedupe: dedupeByScenesMode,
    __internal_onDemand: triggerOnDemandFetch, // 测试/调试用
    __internal_getByWindow: getPromoDataByWindow,
    autoCaptureAllWindows: null, // 占位，启动分支里赋值
    enrichWithGoodsIdFromDOM,
    extractPromoRecords,
    extractFromFiber,
    readYingxiaoDateWindow,
    readDialogDateWindow,
    // === 慧经营利润数据（v14+ 新增）===
    getHuiceDataByDate,
    applyHuiceStrips,
    saveHuiceData,
    extractHuiceFromDOM,
    // CLI 导入入口：供 huice-sync.mjs 通过 CDP 调用写入数据
    importHuiceData: async (records) => {
      if (!Array.isArray(records) || !records.length) return { ok: false, error: 'records empty' };
      await saveHuiceData(records);
      return { ok: true, count: records.length, date: records[0].date };
    },
  };

  console.log(NS, 'ready');
})();
