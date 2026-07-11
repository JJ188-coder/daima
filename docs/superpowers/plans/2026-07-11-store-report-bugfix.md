# 店铺报表可靠性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复店铺报表的数据读取、商品 ID 映射、采集失败处理和每日同步，使真实店铺利润指标可以可靠展示。

**Architecture:** 本地服务继续只监听 `127.0.0.1`，但按请求来源回显允许的拼多多/扩展来源。商品报表弹窗只提交已命中慧经营数据的商品 ID；服务端只在候选店铺唯一时写入 `mallId -> huiceShopId` 映射。采集器以结构化结果返回失败日期，入口统一依据结果设置退出码，并在下载前后校验任务和文件。

**Tech Stack:** Chrome MV3 content script、Node.js ESM、SQLite (`better-sqlite3`)、CDP、Node test runner、PowerShell/Bash。

## Global Constraints

- 只修改店铺报表及其数据采集链路；商品列表和其余浮窗选项不改变展示与利润口径。
- 店铺日报使用慧经营真实费用与净利润；推广费、ROI 只从 `pdd_promo_daily` 读取，不覆盖 `shop_daily_profit`。
- 不按店名模糊匹配，不使用“第一家店铺”兜底。
- 自动映射只使用当前商品报表中已命中慧经营记录的商品 ID；多候选不写入映射。
- 下载失败、日期不符、任务不符、入库失败均必须返回非零退出码。
- 不提交 `private/`、SQLite、下载文件或 `output/`。

---

### Task 1: 允许受控来源访问本地服务

**Files:**
- Modify: `tools/huice-server.mjs`
- Create: `test/huice-server.test.mjs`

**Interfaces:**
- Produces: `resolveAllowedOrigin(origin)`，返回允许回显的来源或 `null`。
- Produces: `buildCorsHeaders(origin)`，对允许来源返回精确 `Access-Control-Allow-Origin`。

- [ ] **Step 1: 写失败测试**
  - 测试 `https://mms.pinduoduo.com` 和 `chrome-extension://<id>` 被允许。
  - 测试任意 `https://example.com` 与 `http://127.0.0.1:*` 不会成为响应来源。
- [ ] **Step 2: 运行测试确认失败**
  - `node --test test/huice-server.test.mjs`
- [ ] **Step 3: 最小实现**
  - 从请求 `Origin` 读取来源；只允许拼多多 MMS/营销域名和 `chrome-extension://` 来源。
  - `OPTIONS` 与 JSON 响应复用同一套响应头。
- [ ] **Step 4: 回归验证**
  - `node --test test/huice-server.test.mjs`
  - 使用随机端口发送含 `Origin: https://mms.pinduoduo.com` 的 `/health` 请求，确认响应头精确回显。

### Task 2: 接通商品 ID 自动映射

**Files:**
- Modify: `dts/source/pdd-enhancer.js`
- Modify: `tools/huice-server.mjs`
- Modify: `scripts/huice/lib/db.mjs`
- Create: `test/shop-mapping.test.mjs`

**Interfaces:**
- `POST /shop-mapping/candidates` 请求体：`{ mallId, pddShopName, productIds }`。
- 响应状态：`unique`（已写映射）、`ambiguous`（只返回候选）、`none`（没有候选）。
- 前端只传 `matchedRecords.keys()`，绝不传页面全部商品 ID。

- [ ] **Step 1: 写失败测试**
  - 唯一候选时写入映射；多候选和零候选时不写入。
  - 已匹配商品 ID 集合为空时前端不发送请求。
- [ ] **Step 2: 运行测试确认失败**
  - `node --test test/shop-mapping.test.mjs`
- [ ] **Step 3: 最小实现**
  - 抽出可测试的候选决策函数，服务端只由它决定是否 upsert。
  - 店铺报表面板遇到 `no_mapping` 时，从当前商品报表收集已命中 ID，调用候选接口；仅 `unique` 后重试 `/shop-profit`。
  - `ambiguous` 显示候选数量和需要人工确认的状态，不写入错误映射。
- [ ] **Step 4: 回归验证**
  - `node --test test/shop-mapping.test.mjs`
  - 静态检查确认页面没有把 `scannedProductIds` 直接提交给映射接口。

### Task 3: 让采集失败可被自动任务识别

**Files:**
- Modify: `tools/huice-export-cdp.mjs`
- Modify: `tools/huice-shop-export-cdp.mjs`
- Modify: `tools/pdd-promo-cdp.mjs`
- Create: `scripts/huice/lib/collector-result.mjs`
- Create: `test/collector-result.test.mjs`

**Interfaces:**
- `collectorExitCode(failedDates, fatalError)`：存在任一失败日期或致命错误时返回 `1`，否则返回 `0`。
- 每个下载超时、日期切换失败、下载中心无匹配任务、Excel 校验失败、SQLite 写入失败均加入 `failedDates`。

- [ ] **Step 1: 写失败测试**
  - 空失败列表返回 `0`；任一失败日期返回 `1`；致命错误返回 `1`。
- [ ] **Step 2: 运行测试确认失败**
  - `node --test test/collector-result.test.mjs`
- [ ] **Step 3: 最小实现**
  - 三个采集器在 `main` 返回结构化结果，不在业务函数中直接 `process.exit`。
  - 顶层只在 `finally` 后调用一次退出码计算。
  - 商品导出下载超时必须记录目标日期。
- [ ] **Step 4: 回归验证**
  - `node --test test/collector-result.test.mjs`
  - 模拟结果对象，确认部分成功不会伪装为成功退出。

### Task 4: 只下载并导入目标导出任务

**Files:**
- Modify: `tools/huice-export-cdp.mjs`
- Modify: `tools/huice-shop-export-cdp.mjs`
- Create: `scripts/huice/lib/export-validation.mjs`
- Create: `test/export-validation.test.mjs`

**Interfaces:**
- `isExpectedExportTask(task, { kind, targetDate, after })`：只接受正确报表类型、创建时间晚于本轮点击且日期匹配的任务。
- `validateExportRows(rows, { kind, targetDate })`：验证表头、目标日期和至少一条有效数据行。

- [ ] **Step 1: 写失败测试**
  - 旧任务、非目标报表、日期不符任务被拒绝。
  - 商品 Excel 缺商品 ID 表头、店铺 Excel 缺店铺名称或日期不符时被拒绝。
- [ ] **Step 2: 运行测试确认失败**
  - `node --test test/export-validation.test.mjs`
- [ ] **Step 3: 最小实现**
  - 下载中心轮询每行元数据，选择符合 `kind + targetDate + after` 的下载按钮，禁止“第一行/第一个按钮”策略。
  - 下载后在解析前验证文件；验证失败保留失败日志，不归档、不入库。
- [ ] **Step 4: 回归验证**
  - `node --test test/export-validation.test.mjs`
  - 现有解析测试仍通过。

### Task 5: 补齐每日同步与平台说明

**Files:**
- Modify: `scripts/huice-daily.sh`
- Modify: `scripts/huice-daily.ps1`
- Modify: `README.md`

**Interfaces:**
- macOS 和 Windows 每日顺序：商品利润 -> 扩展 storage -> 慧经营店铺日报 -> 拼多多推广费。
- 店铺日报或推广费失败必须使该次日任务失败，不得显示“同步完成”。

- [ ] **Step 1: 写可执行文本校验**
  - 新增测试读取两个脚本，断言都调用店铺日报和推广费采集器，且在失败时退出非零。
- [ ] **Step 2: 运行测试确认失败**
  - `node --test test/daily-sync.test.mjs`
- [ ] **Step 3: 最小实现**
  - macOS 移除“失败不影响商品同步”的吞错分支。
  - Windows 加入店铺日报与推广费命令，并检查 `$LASTEXITCODE`。
  - README 写明推广费采集依赖当前登录的拼多多店铺和已确认的 mallId 映射。
- [ ] **Step 4: 回归验证**
  - `node --test test/daily-sync.test.mjs`

### Task 6: 完整验证与提交

**Files:**
- Modify: 上述实现文件与测试文件。

- [ ] **Step 1: 全量自动验证**
  - `npm test`
  - `npm run check:js`
  - `git diff --check`
- [ ] **Step 2: 浏览器验证**
  - 在已登录的拼多多商品报表中打开店铺报表，确认本地请求未被跨域拦截。
  - 验证唯一候选可建立映射，多候选不会自动映射。
- [ ] **Step 3: 提交与推送**
  - 仅暂存明确代码、测试、README 和计划文件。
  - 提交信息：`fix(store-report): close mapping and collector reliability gaps`。
  - 推送新分支并创建 PR，等待合并审核。
