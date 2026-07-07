# 店透视插件 — AI 交接文档

> **给接手 AI 的说明**：本文档是「店透视」Chrome 扩展的完整交接包。读完本文 + `AGENTS.md` + `docs/OPERATIONS.md` 即可上手。项目根：`/Users/longxiaking/Documents/daima`。

---

## 1. 这是什么项目

**店透视**（dts/）是一个拼多多商家后台数据增强 Chrome 扩展（MV3，v5.0.16）。核心能力：

1. **推广数据补齐**：拼多多 mms 商品报表弹窗的花费/ROI/GMV 等字段官方返 0，扩展从 yingxiao（推广平台）抓真实数据回填到弹窗 Vue el-table
2. **慧经营利润注入**：从慧经营 ERP（hjy.huice.com）商品排名页抓净利润/退款/成本等利润数据，注入商品报表弹窗的 4 个真列（净利润/净利率/推广费比/保本ROI）
3. **每日自动采集**：service worker alarm 每天 9:00 自动打开慧经营页抓昨日数据入 storage

## 2. 项目结构（只列核心）

```
daima/                          ← 项目根
├── AGENTS.md                   ← 全局行为规则（缓存纪律/硬底线/三确认铁律）
├── docs/OPERATIONS.md          ← 操作铁律（commit/版本号/CDP验证/三确认）
├── HANDOFF.md                  ← 本文件
├── package.json                ← npm scripts（huice:sync / huice:backfill / memory:*）
│
├── dts/                        ← ★ 扩展源码（Chrome 加载此目录）
│   ├── manifest.json           ← MV3 清单 version=5.0.16
│   ├── script/
│   │   ├── service_worker.js   ← 后台 SW（压缩版，含 alarm/actionHandlers）
│   │   └── content_scripts.js  ← 桥接层（page ↔ SW 消息转发）
│   ├── source/
│   │   └── pdd-enhancer.js     ← ★★ 核心逻辑（1507行，注入到 MAIN world）
│   └── remotes/v3/plugin/
│       └── worker.json         ← 按域名注入模块配置（pdd_sycm/pdd_yingxiao/pdd_huice）
│
├── scripts/                    ← CLI 工具
│   ├── huice-sync.mjs          ← ★ 慧经营数据同步 CLI（headless Playwright）
│   └── huice/                  ← 慧经营利润采集套件
│       ├── lib/{config,db}.mjs ← 配置+SQLite 封装
│       └── bin/{daily,backfill,login,capture}.mjs
│
├── memory/                     ← 项目记忆（追加式，不删历史）
│   ├── decisions.md            ← 架构决策记录（ADR 风格）
│   └── mistakes.md             ← 踩坑记录
│
├── private/                    ← 凭证/profile（gitignored，不入库）
│   ├── huice-profile/          ← Playwright 持久化 Chrome profile（慧经营 cookies）
│   ├── huice.env               ← 慧经营登录凭证
│   └── huice-data.sqlite       ← SQLite 利润数据库（product_profit + daily_profit）
│
└── tools/
    └── pdd-cdp-browser.sh      ← CDP Chrome 启动脚本（端口 9222）
```

## 3. 扩展加载方式

1. 打开 Chrome → `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选 `~/Documents/daima/dts/`
4. 扩展 ID: `mknaonddfghebdmoecigfplbbgkagpla`
5. **改代码后**：在扩展页点「重新加载」按钮 → 刷新 mms 页面（content script 才会重新注入）

> ⚠️ **三确认铁律**（见 AGENTS.md 尾部）：改代码前必须确认 ① Chrome 扩展页的「加载来源」字段 ② 目标文件 `ls` 存在 ③ `git check-ignore` 是否被排除。**别改错目录**（曾因改到 `透视王-Chrome_5.1.65-unpacked/` 白做了整个任务）。

## 4. 核心数据流（两张图看懂）

### 4.1 推广数据流（yingxiao → mms 弹窗）

```
[yingxiao.pinduoduo.com 页面加载]
  pdd-enhancer.js 自动注入（worker.json pdd_yingxiao 模块）
    → autoCaptureAllWindows(): 自动拉昨日/近7天/近30天 3个窗口
    → fetchPromoWindow(start, end): webpack 注入复用页面 service 类
      → svc.queryEntityReport(params): 绕反爬调 API
      → parseEntityReportList → dedupeByScenesMode
    → savePromoData: 写 chrome.storage.local
      key: pdd_promo_window_<start>_<end>
      key: pdd_promo_full_latest（最近一次 fallback）
      key: pdd_promo_windows（索引数组）

[mms.pinduoduo.com 商品报表弹窗打开]
  pdd-enhancer.js 自动注入（worker.json pdd_sycm 模块）
    → MutationObserver + 定时器 → tryInject()
      → readDialogDateWindow(): 读弹窗「统计时间: YYYY-MM-DD ~ YYYY-MM-DD」
      → getPromoDataByWindow(window): 精确匹配分仓
      → 无数据 → triggerOnDemandFetch: 跨标签注入 yingxiao 拉取
      → applyPromoToVueDialog(promoMap): 按 goodsId 匹配
        → dataComp.$set(row, 'paidTraffic-spend', val): Vue el-table 回填
        → dataComp.$forceUpdate()
```

### 4.2 慧经营利润数据流（hjy.huice.com → mms 弹窗真列）

```
[采集端 - 两条路径]

路径A: 扩展自带 alarm（每天 9:00）
  service_worker.js: chrome.alarms 'pdd_huice_sync'
    → chrome.tabs.create hjy.huice.com/#/opertData/CommodityAnalysis（后台 tab, 60s 关）
    → pdd-enhancer.js 注入（worker.json pdd_huice 模块）
      → setupHuiceCapture(): MutationObserver 等 AG-Grid 渲染
      → extractHuiceFromDOM(yestStr): 按 AG-Grid colId 映射提取
        colId: receivableAmount→销售额 / payQty→销量 / netProfit→净利 / ...
      → saveHuiceData(records): 写 chrome.storage.local
        key: pdd_huice_window_<YYYY-MM-DD（昨日）>

路径B: CLI 手动/批量（headless）
  npm run huice:sync -- --days 7
  scripts/huice-sync.mjs:
    → chromium.launchPersistentContext('private/huice-profile', { headless: true })
    → 打开 CommodityAnalysis 页 → setDateRange 逐天切日期
    → extractHuiceFromDOM(dateOverride) → 159 条 records
    → 双写: SQLite product_profit 表 + CDP 9222 注入 dts storage

[消费端 - mms 商品报表弹窗]
  tryInject() → applyPromoToVueDialog 之后:
    → getHuiceDataByDate(startDate): 读 pdd_huice_window_<date>
    → huiceMap[productId] = record
    → injectHuiceColumns(tableComp, dataComp, renderData, huiceMap)
      → store.commit('insertColumn', cfg, insertAt): 插 4 个真列
        锚点: 推广数据列前 → 商品信息列后 → 兜底第2列（永不末尾）
      → dataComp.$set(row, 'huice-netProfit', val): 回填值
      → 失败降级 → applyHuiceStrips(): 绿色信息条
```

## 5. 关键文件详解

### `dts/source/pdd-enhancer.js`（核心，1507 行）
| 函数 | 作用 | 行号 |
|---|---|---|
| `getPddReportService()` | webpack 注入拿 service 类（绕反爬） | ~350 |
| `fetchPromoWindow(s,e)` | 调 queryEntityReport API 拉推广数据 | ~441 |
| `savePromoData(rs)` | 写 storage 分仓 | ~226 |
| `getPromoDataByWindow(w)` | 精确匹配读分仓 | ~262 |
| `tryInject()` | ★ 主注入入口（mms 弹窗） | ~682 |
| `applyPromoToVueDialog(map)` | 推广数据回填 Vue el-table | ~1148 |
| `injectHuiceColumns(...)` | ★ 慧经营 4 真列注入 | ~977 |
| `applyHuiceStrips(map,data)` | 降级：绿色信息条 | ~918 |
| `readDialogDateWindow()` | 读弹窗日期窗口 | ~1099 |
| `extractHuiceFromDOM(date)` | AG-Grid + el-table 提取慧经营数据 | ~811 |
| `saveHuiceData(rs)` / `getHuiceDataByDate(d)` | 慧经营数据存取 | ~777/797 |

### `dts/script/service_worker.js`（压缩版）
关键 handler：`GetLocalData` / `SetLocalData` / `InjectCode` / `GetTabs`
关键 alarm：`pdd_sync`（5min, 开 yingxiao）/ `pdd_huice_sync`（24h 9:00, 开 hjy）

### `scripts/huice-sync.mjs`（CLI）
`setDateRange(page, start, end)` — element-ui date-range-picker 操作（点日历单元格，单日左日历点 end）

## 6. 常用命令

```bash
# 慧经营数据同步
npm run huice:sync                    # 抓昨日（headless）
npm run huice:sync -- --days 7        # 批量近7天

# CDP 验证（需先启动 CDP Chrome: bash tools/pdd-cdp-browser.sh）
node ~/.zcode/skills/cdp-inject/scripts/check-port.mjs
node ~/.zcode/skills/cdp-inject/scripts/extract-json.mjs '<JS>'

# 记忆检索
npm run memory:search -- daima "关键词"

# Git
git add <明确文件> && git commit -m "..." && git push
# ⚠️ 禁止 git add -A（会提 output/ 截图垃圾）
```

## 7. 依赖的技能（Skills）

| 技能 | 路径 | 用途 |
|---|---|---|
| **cdp-inject** | `~/.zcode/skills/cdp-inject/` | Chrome DevTools Protocol 注入 JS 验证（端口 9222）|
| **huice** | `~/.zcode/skills/huice/SKILL.md` | 慧经营利润采集 SOP（daily/backfill/login）|
| **playwright** | `~/.zcode/skills/playwright/` | 无头浏览器自动化 |
| **reverse-engineering** | `~/.zcode/skills/reverse-engineering/` | 通用逆向 |

## 8. 踩过的坑（Top 5，详见 memory/mistakes.md）

1. **改错目录**：扩展加载 `dts/`，不是 `透视王-*-unpacked/`。改前必查 Chrome 扩展页「加载来源」
2. **慧经营页用 AG-Grid 不是 el-table**：extractHuiceFromDOM 必须支持 `.ag-root`（按 colId 映射），`.el-table` 只是兜底
3. **element-ui daterange 单日范围**：end 在**左日历**点同一天，别去右日历
4. **headless 抢焦点**：用户机器上的自动化一律 `headless: true`
5. **MAIN world 不能用 chrome.storage**：pdd-enhancer.js 跑在 MAIN world，必须走 `swCall('SetLocalData')` 桥接

## 9. 版本号规则

- **单一可信源**：`dts/manifest.json` 的 `version` 字段（当前 5.0.16）
- pdd-enhancer.js 内部 `__PDD_EM.version`（v16）是架构版本，独立追踪
- 每次响应末尾输出：`> 📦 v<manifest version> @ <commit hash 前7位>`

## 10. 下一步待做（已知缺口）

- [ ] **真列渲染实测**：injectHuiceColumns 的 `store.commit('insertColumn')` 需用户手动开 mms 商品报表弹窗验证（CDP 无法纯脚本触发弹窗）
- [ ] **huice:sync cron 化**：加 `crontab 0 9 * * *` 每日自动跑（需本机常开）
- [ ] **推广费比/保本ROI 计算**：依赖推广数据(spend/gmv)回填到 row 后才能算，时序依赖 applyPromoToVueDialog 先跑完
