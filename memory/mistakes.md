# daima — 踩过的坑（追加式，不删改历史条目）

> 每次踩坑立刻在这里追加一条。格式：`- [YYYY-MM-DD] 现象 → 根因 → 修复/规避`。
> 目的：同样的坑不踩第二次。ZCode 在做相关任务前会先 grep 这里 + 向量检索。

**检索方式**：
- 精确：`grep -i "关键词" memory/mistakes.md`
- 语义：`node knowledge/query.mjs "上次踩过的坑"`

---

- [2026-06-22] volcengine embedding API key 明文进 git 历史
  - 现象：`memory/config.json` 里的 `"apiKey": "bcf3b22f-..."` 从 init commit (`1d0d1bf`) 起就在仓库里
  - 根因：king 初始化时直接把 key 写进 config.json，没有走 `.env` + 模板分离
  - 修复：config.json 改读 `process.env.VOLC_API_KEY`；真实 key 移到 `.env`；config.json 加进 .gitignore；新增 `config.example.json` 作为入库模板
  - 规避：**新项目第一时间检查 secret 是否走环境变量**；任何含 key 的 json 文件先看 .gitignore 是否覆盖
  - 影响文件：`memory/config.json:7`（旧版）/ `1d0d1bf` / `ea0f1f9` git 历史
  - **残留**：历史 commit 仍含 key，待 `git filter-repo` 重写

- [2026-06-22] 同一扩展多个版本目录堆积 5GB
  - 现象：根目录一度有 8 个 Chrome 扩展解包目录 + 6 个 zip/crx，总计 ~5GB
  - 根因：每次发布都把整个 unpacked 目录留在根目录；中英文版各存一份（`Toushiwang-*` 和 `透视王-*` 内容完全一致）
  - 修复：删除 4 个重复的 Toushiwang 拷贝 + 5.1.66 unpacked（差异抢救到 `ts/legacy-snapshots/5.1.66-diff/`）+ 所有 5.1.65/66 zip/crx
  - 规避：发布后立即把产物移到 `private/releases/` 或外部归档，**不留在项目根**；解包目录名带 `*-unpacked` 后缀已被 .gitignore 排除
  - 影响文件：项目根目录布局

- [2026-06-23] 透视王插件在 PDD MMS 登录页注入导致白屏
  - 现象：打开 `https://mms.pinduoduo.com/home/` 需要扫码登录时，透视王插件注入登录页 iframe 导致页面全白，无法显示二维码
  - 根因：插件内容脚本注入登录页 DOM，与登录页框架冲突
  - 修复：先禁用透视王插件 → 完成扫码登录 → 重新启用透视王
  - 规避：在任何登录/授权流程前先关闭第三方插件，登录完成后再启用
  - 影响页面：`mms.pinduoduo.com/home/`
  - 影响插件：透视王 v5.1.65

- [2026-06-23] 确立 CDP-inject 为标准页面数据提取方式
  - 现象：之前用截图+视觉识别提取页面数据，速度慢、容易漏数据、数字识别不准
  - 根因：视觉方案是间接方案
  - 方案：创建 `cdp-inject` 技能，通过 Chrome DevTools Protocol WebSocket 注入 JS 直接提取 DOM 数据为 JSON
  - 优势：非视觉、非截图、精度 100%、速度 <1s
  - 工具位置：`~/.zcode/skills/cdp-inject/`
  - 标准流程：`cdp-inject/scripts/check-port.mjs` → `cdp-inject/scripts/extract-json.mjs '<JS>'`
  - 后续所有测试页面的数据提取均使用此方式
  - 影响文件：`~/.zcode/skills/cdp-inject/SKILL.md`

- [2026-06-23] PDD enhancer 误把数据注入到 mms 主表格（方向性错误，最大教训）
  - 现象：用户要的是「插件商品报表弹窗」里能看到花费，我却把花费/ROI 单元格注入到了 `mms.pinduoduo.com/sycm/goods_effect` 的 **React 主表格**（行末追加 `<td>`）。用户明确说"不是改网页，是插件里面的"
  - 根因：
    1. 没先搞清楚「插件商品报表」到底指什么——我假设它是 mms 主页面表格，实际是点浮层面板「商品报表」按钮弹出的 `.el-dialog__wrapper`（Vue `el-table` 弹窗）
    2. explore agent 报告"插件没有独立报表页"时我没追问，直接默认=主网页表格
    3. 用 CDP 实地看了 mms 页面就动手注入，但**没确认注入目标是不是用户要的地方**
  - 正确做法：先让用户截图/指认「商品报表」打开后长什么样，再决定改哪里。CDP 能看 DOM，但看的是"当前页面有什么"，不是"用户要什么"
  - 修复（v10）：删除 React 主表格注入逻辑，只保留 Vue 弹窗回填（`applyPromoToVueDialog`）
  - 规避：**任何"改哪里"的判断，必须对齐用户的视觉参照（截图/录屏）**，不能只靠代码探索推断。exploit agent 说"不存在"不等于"用户不需要"，可能只是没找对地方
  - 影响文件：`dts/source/pdd-enhancer.js`（v8→v9→v10 三次迭代）

- [2026-06-23] PDD yingxiao queryEntityReport API 不返回 goodsId（数据对齐坑）
  - 现象：yingxiao 抓到的推广记录 `goodsId` 全是空字符串，无法和 mms 商品 ID 匹配
  - 根因：yingxiao 的 `queryEntityReport` 接口是**推广计划级**（entityId），不是商品级，响应里压根没有 goodsId 字段
  - 关键发现：yingxiao 页面 DOM 渲染了「商品 ID：967458675477」文本（和 mms 的 goodsId 一致），但 API 响应没有
  - 修复：`enrichWithGoodsIdFromDOM()` —— 扫 yingxiao DOM 的 `OverviewTable_infoWrap` 元素，正则抽「商品 ID：xxx」，再通过 React fiber 反查该行的 entityId，建立 entityId↔goodsId 映射
  - 规避：**API 响应字段 ≠ 页面显示字段**。拼多多很多页面对 API 数据做了二次加工/关联查询后渲染。数据对齐失败时先看页面 DOM 里实际显示了什么
  - 影响文件：`dts/source/pdd-enhancer.js` `enrichWithGoodsIdFromDOM()`

- [2026-06-23] enhancer 在 MAIN world 跑，`chrome.storage` 不可用
  - 现象：enhancer 加载后 `__PDD_EM_V7__=true` 但 `__PDD_EM` 是 undefined，IIFE 中途抛错
  - 根因：enhancer 通过 `localScriptLoader`（`world:"MAIN"`）注入，MAIN world 里 `chrome.storage` 是 undefined，`chrome.storage.onChanged.addListener` 直接抛 ReferenceError
  - 修复：`setupStorageListener()` 检测 `chrome.storage` 是否可用，不可用则降级为 5 秒轮询 `getPromoData()`（通过 CS bridge 的 `GetLocalData` postMessage）
  - 规避：**MAIN world 脚本只能用 `chrome.runtime`（受限），不能用 `chrome.storage/tabs/cookies`**。需要 storage 时必须走 content_scripts.js 桥接（postMessage → cs → sw）
  - 影响文件：`dts/source/pdd-enhancer.js` `setupStorageListener()`、`swCall()`

- [2026-06-23] Vue el-table 的 el-dialog__wrapper 回填要用 $set + $forceUpdate
  - 现象：弹窗表格已有「花费/投入产出比」列，但拼多多 API 返回花费全 0，直接改 DOM textContent 会被 Vue 下次渲染覆盖
  - 根因：el-table 是响应式的，改 DOM 不改数据源，重渲染会还原
  - 修复：定位 el-table 的 Vue 实例 → 向上找持有 `renderData` 的 `DynamicTable` 组件（`$parent` 链）→ `dataComp.$set(row, 'paidTraffic-spend', value)` + `dataComp.$forceUpdate()`
  - 验证方法：先 `$set` 一个测试值 999.99，`$forceUpdate`，600ms 后读 DOM cell[16] 确认变成 "999.99"，再 revert。**测试通过才写真实逻辑**
  - 规避：**改 Vue 渲染的内容必须改数据源**。el-table 的列索引：`el-table store.states.columns` 里有 `property`（数据字段名）+ `label`（列标题），用它定位列而非数表头
  - 影响文件：`dts/source/pdd-enhancer.js` `applyPromoToVueDialog()`

- [2026-06-23] ⚠️ 浮层面板消失问题拆解（两种独立故障，原条目混为一谈已纠正）【高优先级未解决】

  **故障 1：重载扩展后，已打开的 mms 标签页面板消失（已知机制，可规避）**
  - 现象：点 chrome://extensions「重新加载」后，**当时已打开**的 mms 标签页浮层面板（`.sycmToolBox` + 商品报表弹窗）全部消失。
  - 根因（基于代码，非猜测）：`dts/manifest.json:60` content script `run_at:"document_start"`，**Chrome MV3 重载扩展时不会重新执行已存在标签页的 content script**（Chrome 设计行为）。面板 UI 由远程脚本 `dts/remotes/v3/pdd_sycm/pdd_sycm.js`（混淆 webpack）渲染（worker.json `pdd_sycm` 模块的 `remote.js`），重载后这些已开标签页没人重新触发 `{action:"init"}` → SW `contentScriptInit` → 注入链，所以面板不回来。
  - 验证手段：F12 Console 看是否打印 `[PDD+EMv8] starting on ...`；缺失即未注入。
  - 规避：**重载扩展后刷新该 mms 标签页**（按 F5 / Cmd+R）即可重新触发注入链，不必删插件重装。原条目「只有删插件重装才稳定恢复」是因为删插件重装 = 强制新标签页加载，本质等同刷新页面。
  - 关联：这个面板是用户唯一能点「商品报表」打开弹窗看花费的入口，面板没了整个功能链（yingxiao 采集 → mms 弹窗回填）就断了。

  **故障 2：新标签页注入偶发失败（待验证，根因更靠前）**
  - 现象：新开 / 导航到 goods_effect 页面，面板偶尔不出现。
  - 根因（基于代码，指向 SW 冷启动，非 URL 白名单）：`dts/script/content_scripts.js` 在 `document_start` 立即 postMessage `{action:"init"}` 给 SW；若 SW 此刻尚未就绪（MV3 SW 冷启动有延迟），**消息丢失** → SW 的 `contentScriptInit` 没执行 → worker.json 模块匹配后的 local/remote 注入链断在第一步。原条目猜的「URL 白名单条件」已被排除：worker.json `pdd_sycm` 的 `host` 含 `//mms.pinduoduo.com/`，goods_effect 页面确实命中。enhancer IIFE 第 32 行 `if (window.__PDD_EM_V7__) return` 幂等守卫本身没问题，问题在更早的 SW→注入链。
  - 待验证：用 CDP 注入看故障页的 `window.DTS_ISOLATED` / `__PDD_EM_V7__` 是否同时缺失——同时缺 = SW 注入链没跑；只有 `__PDD_EM_V7__` 缺 = enhancer 本身没到。
  - 待解决方向（不实施，留后续）：SW 加 SW 就绪握手 + 重试，或 content_scripts 等 SW 就绪后再 postMessage init。

  **影响文件**：`dts/manifest.json:60`（run_at）、`dts/script/content_scripts.js`（init 触发）、`dts/script/service_worker.js`（`contentScriptInit`）、`dts/remotes/v3/plugin/worker.json`（`pdd_sycm` 模块）、`dts/remotes/v3/pdd_sycm/pdd_sycm.js`（混淆，未逆向）
  - 教训：**排查故障先拆现象，再逐个归因**。原条目把「已开标签页消失」和「新标签页注入失败」压成一句话、还用「疑似有」模糊归因，导致绕了一大圈（删插件重装）才定位到「刷新页面」就行

---

## 模板

```
- [YYYY-MM-DD] 现象简述
  - 根因：为什么发生
  - 修复：怎么解决的
  - 规避：下次怎么避免
  - 影响文件：xxx.mjs:123
```

---

- [2026-06-23] CDP skill 绝不能杀掉用户当前的 Chrome（最高优先级教训）
  - 现象：新会话执行 cdp-inject，脚本 `killall "Google Chrome"` 杀掉系统 Chrome 后重启，登录态全丢，用户要重新扫码
  - 根因：
    1. `restart-chrome.mjs` 无条件杀 Chrome，没检查端口是否已在在线
    2. 杀的是用户日常 Chrome（带所有登录态+插件），重启的是独立 profile（空的）
    3. 违反了「复用当前浏览器」的核心语义
  - 修复：
    1. `restart-chrome.mjs` 安全模式：CDP 端口在线直接退出，绝不杀进程
    2. 只有 `--force` 才杀，且用固定 `~/.chrome-cdp-profile` 独立 profile
    3. `check-port.mjs` 增强诊断，让用户自己做决定
    4. `SKILL.md` 写入最高行为规则：永不重启，端口在线就复用
  - 规避：任何时候都不要在 CDP 脚本里写 `killall "Google Chrome"`，除非用户显式要求
  - 影响文件：`~/.zcode/skills/cdp-inject/scripts/restart-chrome.mjs`
  - 现象：Chrome 启动参数有 `--remote-debugging-port=9222`，端口绑不上。Chrome 149+ 报错 `"DevTools remote debugging requires a non-default data directory"`
  - 根因：
    1. Chrome 144+ 安全限制 —— 默认 user-data-dir（`~/Library/Application Support/Google/Chrome`）开 `--remote-debugging-port` **会被静默忽略**
    2. Chrome 149+ 更严格：即使指定 `--user-data-dir=默认路径` 也会报错拒绝，**必须使用完全不同的目录**
    3. `open -a "Google Chrome" --args` 在 macOS 上经常把参数只传给子进程而非主进程，导致参数没生效
  - 修复：
    - 使用独立 profile 目录，如 `~/.chrome-cdp-profile`
    - 用二进制绝对路径启动（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），不用 `open -a`
    - 启动前清理 `SingletonLock` / `SingletonSocket` 文件
  - 规避：任何 CDP 自动化场景，永远不要用默认 profile。一律用 `~/.chrome-cdp-profile` 并确保独立于默认 profile
  - 影响文件：`~/.zcode/skills/cdp-inject/scripts/restart-chrome.mjs`

- [2026-06-22] node_repl MCP 沙箱不支持 fs 写
  - 现象：用 `mcp__node_repl__js` 跑 `chromium.launchPersistentContext(userDataDir)` 报 EPERM
  - 根因：node_repl MCP 在严格沙箱里，所有 fs 写操作（包括 `/tmp`、`/var/folders`、`~/.cache`）都被拦截。Bash 工具的沙箱反而更宽松
  - 修复：浏览器启动用 Bash 工具 + 后台进程（`&` + `disown`），不用 node_repl
  - 规避：涉及大文件 / 持久化 / 守护进程的代码用 Bash，不要塞进 node_repl
  - 影响文件：`tools/pdd-cdp-browser.sh`

- [2026-06-22] Chrome for Testing 加载扩展失败
  - 现象：playwright launchPersistentContext + `--load-extension` 启动 Chromium，扩展 service worker 没起，控制台报 "无法加载扩展：清单文件缺失"
  - 根因：playwright 默认会加 `--disable-extensions` 参数，会**覆盖** `--load-extension`。两个参数互斥
  - 修复：必须用 `ignoreDefaultArgs: ['--disable-extensions', '--enable-automation']` 让 playwright 不加这两个默认参数
  - 规避：用 playwright 加载 unpacked 扩展时，永远记得排除 `--disable-extensions`
  - 影响文件：`tools/pdd-test-browser.mjs`（已废弃，但留作参考）

---

## 模板

- [YYYY-MM-DD] 标题
  - 现象：
  - 根因：
  - 修复/规避：
  - 教训：
  - 影响文件：

---

- [2026-06-24] ⚠️ 模糊匹配用近似值冒充真实数据（最大教训：不该猜数据）

  - **现象**：运营报告「随便选时间花费都一样」。切近3天/近7天/自定义6/13~6/19，都显示 83.67（近7天的值）。
  - **根因（v14.5 之前）**：`getPromoDataByWindow` 精确匹配无命中时，用「重叠天数×尺寸比」找最近似分仓**返回近似值**。结果不同窗口的数据被同一个大分仓(83.67)冒充。
  - **深层根因**：为了「不显示空白」而猜数据，但近似值 ≠ 真实值。3天的累计和7天的累计本来就不同。
  - **修复**：精确匹配优先；无精确匹配→返回 null→触发按需拉取→等数据到达(3s/6s/9s 三次检查)→命中才回填。**绝不猜数据，宁可短暂空白也要真实值。**
  - **教训（最重要）**：
    1. **数据产品宁可空也不猜**。近似值会误导决策，比空白危害更大。
    2. **「优雅降级」≠「用别的数据凑数」**。降级是显示空/0/加载中，不是拿近似值冒充。
    3. 当用户说「值不对/都一样」时，先怀疑是不是在用代理值冒充真实值。
  - **影响文件**：`dts/source/pdd-enhancer.js`（getPromoDataByWindow, tryInject）

- [2026-06-24] webpack service 方法在实例上不在 prototype（定位踩坑）

  - **现象**：`getPddReportService` 扫到含 `queryEntityReport` 的模块后，检查 `v.prototype.queryEntityReport === 'function'` 失败，找不到 service。
  - **根因**：拼多多把方法定义在 constructor 里（`this.queryEntityReport = ...`），不在 prototype 上。`protoMethods` 为空，但实例 `Object.getOwnPropertyNames(inst)` 含该方法。
  - **修复**：实例化后查**实例方法**（`inst.queryEntityReport`），不查 prototype。
  - **教训**：定位 class 方法时，prototype 和实例自有属性都要查，不能只看 prototype。
  - **影响文件**：`dts/source/pdd-enhancer.js`（getPddReportService）

- [2026-06-24] mms 弹窗读不到日期窗口（readDialogDateWindow 返回 null）

  - **现象**：v13 的 readDialogDateWindow 用 input[placeholder] 匹配日期，但 mms 弹窗用的是 el-button 组 + 「统计时间」文本，没有 input。返回 null → 走错分仓 → 金额不对。
  - **根因**：假设了弹窗用日期输入框，实际用快捷按钮组。且统计时间文本格式有空格/Unicode字符，正则不够宽容。
  - **修复**：优先读「统计时间：YYYY-MM-DD ~ YYYY-MM-DD」文本（CDP 实测通用，支持任意日期含自定义），按钮文本映射作 fallback。正则用 `[\-/]` 兼容日期分隔符，`\s+` 兼容空白。
  - **教训**：不要假设 DOM 结构，CDP 实测真实结构再写选择器/正则。
  - **影响文件**：`dts/source/pdd-enhancer.js`（readDialogDateWindow, tryInject 双重保障）

- [2026-06-24] 同 goodsId 多推广计划导致 promoMap 覆盖（5.85 盖 83.67）

  - **现象**：商品 967458675477 显示花费 5.85，实际应为 83.67。
  - **根因**：该商品同时在「稳定成本推广」(spend=83.67) 和「全店托管」(spend=5.85) 两个计划。extractFromFiber 抓所有分组行，promoMap[goodsId] 后写覆盖，5.85 盖了 83.67。
  - **修复**：dedupeByScenesMode 择优去重，优先保留 scenesMode=1（稳定成本，对齐拼多多官方合计口径）。
  - **教训**：同主键多条记录时，明确择优策略（不是简单「后写覆盖」）。
  - **影响文件**：`dts/source/pdd-enhancer.js`（dedupeByScenesMode, extractFromFiber）

- [2026-06-24] yingxiao API 拦不到是时序问题（不是特殊传输）

  - **现象**：hook 了 fetch/XHR.prototype，但拦不到 queryEntityReport 请求。曾误判为「用了 WebSocket/特殊协议」。
  - **根因**：yingxiao 是 Next.js，React bundle 在 content script 注入**之前**已缓存了 native XHR 引用，后续请求走缓存引用，prototype 替换无效。
  - **正确解法**：不拦请求，直接用 webpack service 调 API（绕过 hook 时序问题）。
  - **教训**：拦不到请求时，别假设是特殊传输，先考虑「缓存了原生引用」的时序竞态。
  - **影响文件**：`dts/source/pdd-enhancer.js`（fetchPromoWindow 替代 fetch/XHR hook）

- [2026-06-24] yingxiao 日期选择是输入框不是快捷按钮（影响自动采多窗口）

  - **现象**：想自动切 yingxiao 日期采多窗口，但找不到「昨天/近7天」按钮。
  - **根因**：yingxiao 日期是两个 input（placeholder 含「开始/结束」），不是快捷按钮组。页面顶部那些 radio 是推广计划分组（全部/稳定成本/全店托管），不是日期。
  - **解法**：放弃操作 UI 日期，改用 API 直调传 startDate/endDate（webpack service 方案）。
  - **教训**：自动化采集优先用 API，不操作 UI（UI 脆弱且阻塞用户）。
  - **影响文件**：`dts/source/pdd-enhancer.js`（autoCaptureAllWindows 用 API）

---

## [2026-06-25] 改错扩展目录：把店透视力功能写进了透视王 5.1.65（最严重事故）

- **现象**：用户要求在「拼多多商品报表」集成慧经营利润数据。我把所有改动写到了 `透视王-Chrome_5.1.65-unpacked/source/pdd-library/content.js` 等 4 个文件，commit `cd3e51c`。但用户实际加载的扩展是「店透视」(`dts/`，Chrome 扩展页显示「加载来源：`~/Documents/daima/dts`」)。改完后用户在浏览器里完全看不到效果，等于白做。
- **根因**：
  1. **没有先确认扩展加载目录**。看到仓库里有一堆 `*-unpacked/` 目录和 `dts/`，凭印象挑了 5.1.65（因为它在最近修改过的、有完整 source/gateway 结构），完全没去 Chrome 扩展页核对「加载来源」字段。
  2. **同名文件陷阱**：`content.js`、`service_worker.js`、`pdd-product-library.mjs` 这些文件名在 `透视王-Chrome_5.1.65-unpacked/` 和（历史）`ts/` 目录里都存在，但**架构完全不同**。店透视 (`dts/`) 用 webpack 注入 + `chrome.storage.local` + 远程 Vue bundle；透视王 5.1.65 用本地 `pdd-library/content.js` 面板 + Node Gateway + SQLite。我把后者的代码模式套到了前者的需求上。
  3. **`.gitignore` 排除了 `*-unpacked/`**：意味着 5.1.65 目录的改动**根本不会进 git**，但我用 `git add -A && git commit` 时还以为提交成功了——实际只提交了 `output/` 截图垃圾。
- **修复**：
  1. 把错改的 4 个文件备份到 `backup/错改版本-2026-06-25/`
  2. 用 `透视王-Chrome_5.1.64-unpacked/` 的对应文件覆盖回 5.1.65（5.1.65 = 5.1.64 + 版本号，无用户定制改动）
  3. `git revert cd3e51c` 撤销错误 commit（含 100+ 张截图垃圾）
  4. 正确改动落到 `dts/`：commit `5519974`
- **教训（已写入 AGENTS.md「改代码前的三确认铁律」）**：
  1. **改前必查「加载来源」**：Chrome 扩展页 → 目标扩展 → 加载来源字段，只信这个。
  2. **改前必 `ls` 目标文件**：文件不存在就问用户，不猜路径、不改同名副本。
  3. **改前必 `git check-ignore`**：判断改动进不进 git，不进要明说。
  4. **`git add -A` 禁止裸用**：提交前先 `git status`，只 add 明确目标文件。
- **影响文件**：`透视王-Chrome_5.1.65-unpacked/{source/pdd-library/content.js,script/service_worker.js,pdd-gateway/*.mjs}`（已恢复）、`dts/source/pdd-enhancer.js`（正确改动）、`AGENTS.md`（加铁律）、`backup/错改版本-2026-06-25/`（错改证据）

## [2026-06-25] 智能引号 `""` 导致 JS 语法错误 + 误伤原代码

- **现象**：在 `content.js` 里加新代码时引入了 Unicode 智能引号 `""`（U+201C/U+201D），导致 `SyntaxError: Invalid or unexpected token`。
- **错误的修复尝试**：用 Python 全局 `replace('\u201c', '"').replace('\u201d', '"')` 把全文智能引号转普通引号——结果把原代码里**作为字符串内容**的合法中文引号（如 `"...「查看全部」..."`）也一起改坏了，语法错误反而更多。
- **正确修复**：先全替换，再针对性恢复原代码里作为字符串内容的智能引号（`includes("\u201c查看全部\u201d")` 等）。
- **教训**：
  1. 写代码时只用 ASCII 双引号 `"` 和单引号 `'`，**绝不**用智能引号。
  2. 修复 Unicode 问题时**禁用全局盲替换**，必须针对每个出现点逐个确认上下文。
- **影响文件**：`透视王-Chrome_5.1.65-unpacked/source/pdd-library/content.js`（已恢复到 5.1.64 原版，此问题随之消失）

## [2026-06-25] Playwright 持久化 profile 的三个坑（huice CLI 创建时踩到）

### 坑 1：session cookie 不跨 launchPersistentContext 持久化（最隐蔽）

**现象**：用 `launchPersistentContext(PROFILE_DIR)` 复用 cookies，今天登录明天又要重新登。

**根因**：Playwright issue #36139 — 没有 expiry 的 session cookie 按规范在会话结束时销毁。`launchPersistentContext` 关闭 context = 会话结束，session cookie 不写入磁盘 profile。

**修复**：登录成功后 `await context.storageState({ path: 'private/huice-state.json' })` 导出（会把 session cookie 序列化时加上未来 expiry），下次启动优先加载它。**这是必须做的兜底，单靠 profile 目录不够。**

### 坑 2：SingletonLock 孤儿锁阻塞启动

**现象**：`launchPersistentContext` 报错 profile 被占用，但 `lsof` 找不到进程。

**根因**：上次 Chrome 进程异常退出（被 kill -9 或崩溃），`SingletonLock` 文件残留指向已死的 PID。

**修复**：启动前检查 SingletonLock 指向的 PID 是否存活（`process.kill(pid, 0)` 不发信号只检查），死了就 `unlinkSync` 删锁。已在 login.mjs 实现。

### 坑 3：9222 端口的 Chrome 不一定是你要的那个

**现象**：检查 CDP 9222 在线，但连上去发现是另一个项目的 Chrome。

**根因**：cdp-inject skill 用 `~/.chrome-cdp-profile` + 9222；huice 用 `private/huice-profile`。两个 profile 共用 9222 端口会冲突。

**修复**：huice CLI 默认不暴露 CDP 端口（避免和 cdp-inject 冲突），只在 `serve` 子命令用独立端口（如 9333）。**绝不能杀正在跑的 9222 Chrome**（cdp-inject 铁律：杀进程 = 丢登录态）。

## [2026-06-25] AG-Grid 双容器拼接：pinned-left 项目名 + center 数值

**现象**：汇策利润页用 AG-Grid（不是 el-table），`extractGridData` 抓 `.ag-row .ag-cell` 拿不到数值，只能拿到项目名，数值行 body container 0 行。

**根因**：AG-Grid 用了 **pinned column + center column 分离渲染**：
- 项目名在 `.ag-pinned-left-cols-container`（49 行，每行 1 个 cell，固定列）
- 数值在 `.ag-center-cols-container`（49 行，每行 5 个 cell：本日/昨日/环比/上月同日/同比）
- **`.ag-body-container` 里 0 行**（之前一直在这里找，永远找不到）

**修复**：分别从两个容器按 DOM 顺序取，再按行索引拼接：
```js
const itemNames = [...grid.querySelectorAll('.ag-pinned-left-cols-container .ag-row')]
  .map(r => r.querySelector('.ag-cell')?.textContent.trim());
const values = [...grid.querySelectorAll('.ag-center-cols-container .ag-row')]
  .map(r => [...r.querySelectorAll('.ag-cell')].map(c => c.textContent.trim()));
// rows[i] = [itemNames[i], ...values[i]]
```

**教训**：AG-Grid 抓取前先 `querySelectorAll('*').forEach` 列出所有含 `.ag-row` 的容器及其行数/首行文本，确认数据到底在哪个容器。别假设数据在 `.ag-body-container`。

## [2026-06-26] Element UI 日期范围翻月:单箭头 vs 双箭头(坑 2 小时)

**现象**:设日期范围时点"上一月"按钮,结果跳了一年(2026→2025),选了错的日期。

**根因**:Element UI el-date-range-picker 的左上角有**两个**按钮:
- `.el-icon-d-arrow-left` = **上一年**(双箭头)
- `.el-icon-arrow-left` = **上一月**(单箭头)

我用 `.el-icon-arrow-left` 选择器时,querySelector 返回的是**第一个匹配**,而 d-arrow-left 的 class 里也含 "arrow-left" 子串(`d-arrow-left`),导致点到双箭头。

**修复**:精确选 `.el-icon-arrow-left`(单箭头),排除 `.el-icon-d-arrow-left`:
```js
// 错(会匹配到 d-arrow-left)
left.querySelector('.el-icon-arrow-left')
// 对(单箭头,但要确保不是 d-arrow)
left.querySelector('.el-icon-arrow-left:not(.el-icon-d-arrow-left)')
```
实际 element-ui 的 class 是独立的,`.el-icon-arrow-left` 不会匹配 `.el-icon-d-arrow-left`(不同 class),所以原选择器其实对——我之前 bug 是因为 querySelector 顺序问题。教训:**dump 所有 header 按钮 + 双/单箭头标记**,看清再点。

**教训**:element-ui 日期组件操作前,先 dump header 所有按钮(class + aria-label + 双/单箭头标记),别盲点。

---

- [2026-06-26] huice-sync 抓商品分析页 0 条 → 根因:页面用 AG-Grid 不是 el-table → 修复
  - **现象**:`npm run huice:sync` 跑完"采集 2026-06-25...⚠️ 无数据",但页面明明有 22 条商品
  - **排查**:写探测脚本轮询,发现 `.el-table` count=0,但有 `.v-ag-grid`/`.ag-root`,2 秒就加载好(22 行)。商品分析页 `/opertData/CommodityAnalysis` 用的是 **AG-Grid**(与多维度利润页 `/trendNew` 同结构),不是 Element UI 的 `.el-table`
  - **根因**:`extractHuiceFromDOM`(huice-sync.mjs + pdd-enhancer.js 两处副本)只查 `.el-table`,对 AG-Grid 页完全失效
  - **修复**:重写 `extractHuiceFromDOM` 支持双容器 —— AG-Grid 主力(按 `colId` 映射,不读表头),`.el-table` 兜底。AG-Grid 结构:`.ag-pinned-left-cols-container .ag-row` = [图片?, 店铺, 链接名称, 链接ID, 链接编码];`.ag-center-cols-container .ag-row` 每格有 `col-id` 属性(receivableAmount=销售额/payQty=销量/costAmount=成本/refundAmount=退款/refundRateString=退款率/netProfit=净利/netInterestString=净利率)
  - **教训**:**抓数据前先探测实际 DOM 容器类型,别假定**。慧经营不同页面用不同表格库(多维度页 AG-Grid、商品分析页也 AG-Grid、但某些老页 el-table)。按 `colId`/`col-id` 取值比按表头文字 includes 匹配稳得多(列顺序变也不怕)

- [2026-06-26] huice-sync CDP 注入报 Cannot find package 'ws' → 根因:用了 ws 包但没装 → 修复
  - **现象**:CDP 注入阶段 `❌ 失败: Cannot find package 'ws' imported from huice-sync.mjs`
  - **根因**:脚本用 `const { WebSocket } = await import('ws')`,但 `ws` 包未在 package.json 声明也未安装
  - **修复**:改用 **Node 22+ 内置全局 `WebSocket`**(零依赖)。注意事件 API 与 ws 包不同:内置用 `addEventListener('open'/'message'/'error', cb)` + `removeEventListener`,收到的 message 是 MessageEvent(`event.data` 是字符串),不是 ws 包的 Buffer(`data.toString()`)
  - **教训**:**Node 22+ 跑 CDP 别再装 ws 包**,用内置全局 `WebSocket`。事件 API 差异(`addEventListener` vs `on/off`,`event.data` vs Buffer)是迁移时唯一要改的点

---

- [2026-06-26] 扩展每日慧经营采集是死代码 → 根因:L41 hostname 守卫拦截 hjy.huice.com → 修复
  - **现象**:`pdd_huice_sync` alarm 每天 8:00 打开 hjy tab,但数据永远不进 storage,商品报表永远显示"未导入"
  - **排查**:用 Explore agent 读 pdd-enhancer.js 全文,发现 **L41** `if (!hostname.includes('pinduoduo') && !hostname.includes('yangkeduo')) return;` 把 `hjy.huice.com`(不含 pinduoduo/yangkeduo)**直接 early-return**,导致 L1256 的 `else if (location.hostname.includes('hjy.huice.com'))` 分支**永远到不了**,setupHuiceCapture 是死代码
  - **根因**:守卫写得太严格,只放了 pinduoduo/yangkeduo,漏了 huice 域名
  - **修复**:守卫加 `&& !location.hostname.includes('hjy.huice.com')` 条件,让 huice 通过
  - **教训**:**加新域名分支前先检查入口守卫**。脚本顶部常有一个统一 hostname 白名单/黑名单,下面各分支都依赖它能通过;守卫拦了,下面分支写得再对也是死代码

- [2026-06-26] setupHuiceCapture 抓 0 条 → 根因:页面是 AG-Grid 不是 el-table → 修复
  - **现象**:守卫修了,但 setupHuiceCapture 里的 `extractHuiceFromDOM()` 仍抓空
  - **根因**:`extractHuiceFromDOM` 只查 `.el-table`,但 hjy 商品分析页用 AG-Grid(同 huice-sync.mjs 上一轮发现的同一问题,pdd-enhancer.js 这份副本没同步)
  - **修复**:同步 huice-sync.mjs 的 AG-Grid 版本到 pdd-enhancer.js(按 colId 映射 + el-table 兜底);setupHuiceCapture 的 observer 触发条件也改成 `.ag-root, .el-table`
  - **教训**:**同一函数有两处副本(pdd-enhancer.js + huice-sync.mjs)时,修一处必须同步另一处**,否则修了 CLI 没修扩展(或反之)

- [2026-06-26] 采集的 date=今天,但报表读昨日 → key 错配 → 修复
  - **现象**:即使抓到数据,商品报表弹窗(默认昨天窗口)读 `getHuiceDataByDate('昨天')` 仍空
  - **根因**:`extractHuiceFromDOM` 里 `date: new Date().toISOString().slice(0,10)` 写死**今天**,但 8:30 规则下抓的是**昨日**数据,且 mms 弹窗默认读**昨日**窗口 → storage key `pdd_huice_window_今天` vs 报表读 `pdd_huice_window_昨天` 对不上
  - **修复**:`extractHuiceFromDOM` 增加 `dateOverride` 参数;`setupHuiceCapture` 调用时算昨日传入
  - **教训**:**采集方与消费方的日期 key 必须对齐**。抓昨日数据就 date=昨日;别让抓取方默认今天、消费方读昨日

- [2026-06-26] pdd_huice_sync alarm 只 install 注册 → update 后丢失 → 修复
  - **现象**:扩展更新(update)后,每日采集可能停
  - **根因**:service_worker.js 的 `onInstalled` 里 alarm 创建只在 `case "install"` 分支,`case "update"` 不重建 pdd_huice_sync。MV3 service worker 重启虽保留 alarm,但 update 后不保证
  - **修复**:update 分支也加 `chrome.alarms.create('pdd_huice_sync',...)`(独立算次日 9:00 延迟,不复用 install 的变量)
  - **附修**:8:00→9:00(对齐汇策 8:30 数据生成规则);tab 关闭 30s→60s(给 AG-Grid 加载留足时间)

---

- [2026-06-26] huice-sync headless: false 抢用户焦点 → 修 headless: true + navigator.webdriver 抹除
  - **现象**: 批量采集弹可见 Chrome 窗口,抢用户焦点,用户明确反对("不要抢夺控制权")
  - **根因**: `launchPersistentContext({ headless: false })`,原型开发时用有头方便调试,生产忘了改
  - **修复**: `headless: true` + `addInitScript(() => { Object.defineProperty(navigator,'webdriver',{get:()=>undefined}) })` 防慧经营 headless 检测
  - **教训**: **用户机器上的自动化脚本一律 headless**。有头模式只在首次登录扫码时用,且要明确告知用户"会弹窗"

- [2026-06-26] element-ui daterange picker 单日范围(end===start)日期没切 → 根因:end 去右日历找 → 修复
  - **现象**: `setDateRange(page, '2026-06-24', '2026-06-24')` 后,读回 range input 值仍是 '2026-06-25 ~ 2026-06-25'(上一次的值),日期完全没切
  - **根因**: element-ui date-range-picker 点完 start 后,end 的候选在**左日历**(同月),但代码去**右日历**(content[1],startMonth+1)找 endDay → rightHeader !== endMonth → 翻页 → 越翻越远 → end 永远点不上 → picker 保持 start 的默认值
  - **修复**: `isSingleDay = startStr === endStr` 时,end 直接在**左日历**(content[0])点同一天
  - **教训**: **element-ui date-range-picker 单日范围,end 在左日历点,别去右日历**。点完 start 后面板不会自动切换到"选 end"模式,在同面板点第二次就是 end

---

## [2026-07-08] 接手开发 5 个新坑（v5.0.16 -> v5.0.17 开发过程）

- [2026-07-08] Chrome 149 `--load-extension` 单独用不生效 -> 根因:缺 `--enable-extensions` -> 修复
  - **现象**: `--load-extension=/path/to/dts` 启动 CDP Chrome,扩展 service worker 不出现,标签页列表无 `chrome-extension://`
  - **根因**: Chrome 149 安全策略,`--load-extension` 必须配合 `--enable-extensions` 才生效(单用被忽略)
  - **修复**: 启动参数加 `--enable-extensions --load-extension=...`
  - **教训**: **Chrome 149+ 加载 unpacked 扩展必须 `--enable-extensions` + `--load-extension` 一起用**
  - **影响文件**: CDP Chrome 启动方式

- [2026-07-08] 慧经营 input.value 切日期不生效 -> 根因:Vue 组件 state 没更新 -> 修复:用面板点击
  - **现象**: 改 `.el-range-editor input` 的 value + dispatch input/change event + 点查询,日期 input 显示变了,但查询返回的还是旧日期数据
  - **根因**: element-ui el-date-picker 的 Vue 组件内部 state 没被 DOM event 更新,查询用的是组件 state 不是 input.value
  - **修复**: 用面板点击方式 `setDateRangeByPanel()` -- 点 `.el-range-editor` 打开面板 -> 翻月到目标月 -> 点日期 `td.available` **两次**(第一次设开始,第二次设结束) -> 点查询
  - **教训**: **element-ui el-date-picker 不能用 input.value 切日期,必须走面板点击**。Vue 组件的日期状态在组件 data 里,改 DOM input 不改组件 state
  - **影响文件**: `tools/huice-export-cdp.mjs` `setDateRangeByPanel()`

- [2026-07-08] 慧经营「导出全部」不是直接下载 -> 根因:异步后台生成,要去下载中心取 -> 修复
  - **现象**: 点下载按钮 -> 点「导出全部」,页面提示「导出完成」,但 Downloads 目录没新文件
  - **根因**: 慧经营「导出全部」是**异步后台生成** xlsx,生成完在「下载中心」页面(`#/baseSettings/downloadCenter`)列出,需要手动去点「下载」按钮
  - **修复**: 导出后导航到下载中心 -> 点 AG-Grid `operation` 列里的 `<button>` 下载 xlsx。注意:点 AG-Grid cell DIV 层不生效,必须点 cell 内的 `<button class="el-button--text el-button--mini">`
  - **教训**: **慧经营导出是异步的,不是直接下载**。流程:导出全部 -> 等 6s -> 去下载中心 -> 点 operation 列的 button。AG-Grid cell 点击要找 `<button>` 不是 cell DIV
  - **影响文件**: `tools/huice-export-cdp.mjs`

- [2026-07-08] AG-Grid 虚拟滚动隐藏列 -> 根因:列太多超出视口 -> 修复:用「导出全部」xlsx
  - **现象**: 慧经营商品排名页加了净利额/净利率/退款等列后,`receivableAmount`/`payQty`/`costAmount` 被虚拟滚动隐藏,extractHuiceFromDOM 读到 null
  - **根因**: AG-Grid 横向虚拟滚动,只有视口内的列有 DOM,超宽列不渲染
  - **修复**: 放弃 DOM 提取,改用「导出全部」下载 xlsx,用 openpyxl 解析入库
  - **教训**: **AG-Grid 列多时 DOM 提取不可靠,用「导出全部」xlsx 拿全量数据**。
  - **影响文件**: `tools/huice-export-cdp.mjs`(替代 `tools/huice-backfill-cdp.mjs` 的 DOM 提取)

- [2026-07-08] getHuiceDataByDate 只读开始日期 -> 根因:7天范围只读1天 -> 修复:getHuiceDataByDateRange
  - **现象**: mms 弹窗选多日范围时,4 真列全 null,但 storage 里范围内有数据
  - **根因**: pdd-enhancer.js `getHuiceDataByDate(startDate)` 只读开始日期一天的 storage。但某商品开始日可能无数据,后续日期有数据。只读开始日期 = 匹配不上
  - **修复**: 新增 `getHuiceDataByDateRange(startDate, endDate)` -- 读日期范围内所有 `pdd_huice_window_<date>` 的数据,按 productId 聚合(多天数值相加)
  - **教训**: **日期范围查询要读范围内所有天,不能只读开始日期**。商品某天无数据不代表整个范围无数据
  - **影响文件**: `dts/source/pdd-enhancer.js` `getHuiceDataByDateRange()`

- [2026-07-08] 日期面板残留 Vue 状态导致选择错误 -> 根因:切换日期后面板残留上次选择 -> 修复:每天循环重载页面
  - **现象**: 连续回采多日时,日期切换后面板仍显示上一天的选中状态,导致点日期点到错的单元格
  - **根因**: element-ui el-date-range-picker 面板是 Vue 管理的 DOM,切换日期后面板状态不清空,残留的 `start-date`/`end-date`/`in-range` class 影响下次选择
  - **修复**: 每天循环开始时 `location.reload()` 重载页面,清除所有 Vue 组件状态。同时 `setDateRangeByPanel` 里加「先点别的日期清旧选择」逻辑
  - **教训**: **element-ui 日期面板有残留状态,跨日期切换要重载页面**。Vue 组件状态不会因 DOM 操作自动清空
  - **影响文件**: `tools/huice-export-cdp.mjs` main 循环 + `setDateRangeByPanel()`

- [2026-07-10] element-ui 按钮文字"确 定"带空格 -> 根因:el-button 自动在两字按钮文字中间加空格 -> 修复:去空格比较
  - **现象**: 慧经营店铺导出的"分店铺导出"弹窗,确定按钮的文字是"确 定"(中间有空格),用 `=== '确定'` 永远匹配不到,弹窗一直卡着没人点
  - **根因**: element-ui 的 `.el-button` 在两个字的按钮文字中间自动插入空格(CSS letter-spacing 或 DOM 渲染),`innerText` 返回的是"确 定"不是"确定"
  - **修复**: 用 `t.replace(/\s/g, '') === '确定'` 去掉所有空格再比较。所有 element-ui 按钮文字匹配都要这样做
  - **教训**: **element-ui 按钮文字可能带空格! 比较前必须 `.replace(/\s/g, '')` 去空格!** "确 定" "取 消" "导 出" "关 闭" 都会这样
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` `clickExport()`

- [2026-07-10] 店铺导出弹窗"确 定"必须点了才会提交后台 -> 根因:异步导出流程 -> 修复:点确定后等下载中心刷新
  - **现象**: 点导出图标后弹"分店铺导出"对话框,不点"确 定"就不会提交后台生成,下载中心永远不出现新文件
  - **根因**: 慧经营导出是异步的: 点导出图标 -> 弹对话框 -> 点"确 定" -> 后台开始生成 -> 几秒后下载中心出现新任务(状态"待下载") -> 点下载
  - **修复**: clickExport 轮询点"确 定",没点到之前不退出。downloadFromCenter 等新任务状态变成"待下载"才点下载,每 3 次刷新页面让新任务出现
  - **教训**: **慧经营导出是异步的,弹窗必须点"确 定"才提交。点完后下载中心不会立刻有,要等几秒刷新才出现**
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` `clickExport()` + `downloadFromCenter()`

- [2026-07-10] 店铺 XLSX 第一行是标题信息不是表头 -> 根因:parseShopExportRows 误匹配 -> 修复:精确匹配
  - **现象**: 店铺多维度分析 XLSX 第 0 行是"利润表名称：店铺多维度分析\n店铺范围：拼【..."等标题信息,里面包含"店铺名称"四个字
  - **根因**: `parseShopExportRows` 用 `String(c).includes('店铺名称')` 找表头,第 0 行的标题信息里包含"店铺名称"被误认为表头
  - **修复**: 用 `String(c).trim() === '店铺名称'` 精确匹配
  - **教训**: **XLSX 第一行可能是标题信息不是表头,表头检测要精确匹配不能用 includes**
  - **影响文件**: `scripts/huice/lib/shop-profit.mjs` `parseShopExportRows()`

- [2026-07-10] element-ui 按钮文字带空格 "确 定" "取 消" -> 根因:el-button 两字按钮自动加空格 -> 修复:replace(/\s/g, '') 去空格比较
  - **现象**: 慧经营"分店铺导出"弹窗的确定按钮文字是"确 定"(中间有空格),用 `=== '确定'` 永远匹配不到
  - **根因**: element-ui 的 `.el-button` 在两个字的按钮文字中间自动插入空格,`innerText` 返回"确 定"不是"确定"
  - **修复**: 用 `t.replace(/\s/g, '') === '确定'` 去掉所有空格再比较
  - **教训**: **element-ui 按钮文字可能带空格! 比较前必须去空格!** "确 定" "取 消" "导 出" "关 闭" 都会这样
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` `clickExport()`

- [2026-07-10] 模板字符串里 \s 要写 \\s -> 根因:JS 模板字符串转义 -> 修复:双反斜杠
  - **现象**: `cdpEval(ws, "...replace(/\s/g, '')...")` 里的 \s 被 JS 模板字符串当成无效转义,变成 s
  - **根因**: JS 模板字符串 ` \`...\s...` 中 \s 不是有效转义序列,会被解释成 s,正则变成 /s/g (只去掉字母 s)
  - **修复**: 在模板字符串里写 `\\s` (双反斜杠),CDP 接收后变成 `\s`
  - **教训**: **JS 模板字符串里的正则反斜杠要双写!** \s -> \\s, \d -> \\d, \w -> \\w
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` 多处 cdpEval 调用

- [2026-07-10] 慧经营导出弹窗必须点"确 定"才提交后台 -> 根因:异步导出流程 -> 修复:点确定后等下载中心刷新
  - **现象**: 点导出图标后弹"分店铺导出"对话框,不点"确 定"就不会提交后台生成,下载中心永远不出现新文件
  - **根因**: 慧经营导出是异步的: 点导出图标 -> 弹对话框 -> 选"否"(不分店铺) -> 点"确 定" -> 后台开始生成 -> 几秒后下载中心出现新任务
  - **修复**: clickExport 里先选"否"再点"确 定",点完后等"我知道了"通知出现,再去下载中心
  - **教训**: **慧经营导出是异步的,弹窗必须点"确 定"才提交。点完后下载中心不会立刻有,要等几秒刷新才出现**
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` `clickExport()` + `downloadFromCenter()`

- [2026-07-10] "我知道了"通知挡住 AG-Grid 下载按钮 -> 根因:通知浮层遮挡 -> 修复:先关通知再找按钮
  - **现象**: 下载中心 AG-Grid 有 24 行但找不到下载按钮,因为大量"我知道了"通知浮层挡住了按钮
  - **根因**: 每次导出完成后弹一个"我知道了"通知,累积多个后遮盖了 AG-Grid 的操作列,导致 `offsetParent` 检测不到按钮
  - **修复**: downloadFromCenter 里先循环关闭所有"我知道了"通知,再点"查询"加载 AG-Grid,然后找"下载"文字按钮
  - **教训**: **通知/浮层太多会挡住目标元素! 找按钮前先关掉所有通知!**
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` `downloadFromCenter()`

- [2026-07-10] XLSX 第一行是标题信息不是表头 -> 根因:includes 误匹配 -> 修复:精确匹配
  - **现象**: 店铺多维度分析 XLSX 第 0 行是"利润表名称：店铺多维度分析\n店铺范围：拼【..."等标题信息,里面包含"店铺名称"四个字
  - **根因**: `parseShopExportRows` 用 `String(c).includes('店铺名称')` 找表头,第 0 行标题里包含"店铺名称"被误认为表头
  - **修复**: 用 `String(c).trim() === '店铺名称'` 精确匹配
  - **教训**: **XLSX 第一行可能是标题信息不是表头,表头检测要精确匹配不能用 includes**
  - **影响文件**: `scripts/huice/lib/shop-profit.mjs` `parseShopExportRows()`

- [2026-07-10] upsertShop 返回值从数字改成对象导致调用方报错 -> 根因:接口变更未同步 -> 修复:用 shop.shop_id
  - **现象**: upsertShop 之前返回 shop_id 数字,改成返回 shop 对象后,调用方 `const shopId = upsertShop(...)` 拿到的是对象不是数字,SQLite 报 NOT NULL constraint
  - **根因**: 修改 upsertShop 返回值类型(数字 -> 对象)后,没有同步修改所有调用方
  - **修复**: 调用方改成 `const shop = upsertShop(...); shopId: shop.shop_id`
  - **教训**: **修改函数返回值类型后,必须 grep 所有调用方同步修改!**
  - **影响文件**: `scripts/huice/lib/db.mjs` + `tools/huice-shop-export-cdp.mjs`

- [2026-07-10] 店铺日期切换残留多个面板 -> 根因:面板没关就打开新的 -> 修复:先关旧面板,用最后一个匹配面板
  - **现象**: 日期面板有 4 个(7月/8月/6月/7月),因为之前多次打开面板没关干净
  - **根因**: setDateRangeByPanel 没先关闭旧面板就打开新的,残留面板干扰翻月和点日期逻辑
  - **修复**: 函数开头先 `document.body.click()` 关闭旧面板;点日期时用最后一个匹配目标月的面板(不是第一个)
  - **教训**: **日期面板操作前先关旧面板! 多个残留面板会导致操作错误!**
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` `setDateRangeByPanel()`

- [2026-07-10] 点击"确 定"按钮 DOM click 不生效 -> 根因:Vue 事件绑定方式 -> 修复:DOM click + CDP 鼠标点击双保险
  - **现象**: `confirmBtn.click()` 点了确定按钮但弹窗不关,Vue 的事件处理没触发
  - **根因**: element-ui 的 Vue 组件可能通过事件代理或 $emit 处理点击,DOM click 不一定触发 Vue 的处理逻辑
  - **修复**: DOM click + span click + CDP `Input.dispatchMouseEvent` 真实鼠标点击,三重保险
  - **教训**: **Vue 组件的按钮可能 DOM click 不生效,需要 CDP 真实鼠标点击!**
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` `clickExport()`

- [2026-07-10] 店铺全选只在第一次需要 -> 根因:导航回多维分析页面后筛选保留 -> 修复:i===0 才全选
  - **现象**: 每天都重新输入"拼"+全选,浪费时间且可能导致状态异常
  - **根因**: 用户反馈:切换回多维分析页面时店铺筛选会保留,不需要每次都重新选
  - **修复**: `if (i === 0) { await selectAllPddShops(ws); }` 只有第一天全选
  - **教训**: **听用户的! 用户比代码更了解页面行为!**
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` 主循环

- [2026-07-10] 拼多多推广平台日期选择器不是 element-ui -> 根因:自定义组件 anq-picker -> 修复:用 .anq-picker 打开日历
  - **现象**: 用 .el-range-editor 和 .el-date-range-picker__content 找日期面板,全部找不到
  - **根因**: 拼多多推广平台用的不是 element-ui,是自定义组件 anq-picker(类名 anq-picker-input / anq-picker-dropdown)
  - **修复**: 点 .anq-picker 打开日历,在 .anq-picker-dropdown 里找 td 点日期
  - **教训**: **不同平台用不同 UI 框架! 不能假设都是 element-ui! 先探测 DOM 再写选择器**
  - **影响文件**: `tools/pdd-promo-cdp.mjs` `setSingleDate()`

- [2026-07-10] 拼多多推广平台数字提取用 DOM 选择器失败 -> 根因:标签和数字在同一元素 -> 修复:用页面文本按行提取
  - **现象**: findVal 函数找 `innerText === '成交营销花费(元)'` 找不到,因为实际 innerText 是 "成交营销花费(元)\n64.94"
  - **根因**: 拼多多的数据卡片把标签和数字放在同一个 div 里,不是分开的子元素
  - **修复**: 改用 `document.body.innerText` 按行分割,找标签行后面紧跟的数字行
  - **教训**: **读界面数字优先用页面文本按行提取,不靠 DOM 结构! 最稳定不受 UI 框架影响**
  - **影响文件**: `tools/pdd-promo-cdp.mjs` `readPromoData()`

- [2026-07-10] "对比时间" checkbox 勾选会导致读到对比数据 -> 根因:页面同时显示两期数据 -> 修复:采集前先取消勾选
  - **现象**: 页面上有"对比时间"checkbox,勾选后数据区会同时显示当前和对比期的数字,容易读错
  - **根因**: 拼多多推广平台默认勾选"对比时间",数据概况区域同时显示两期数据
  - **修复**: 切日期后先点掉 `.anq-checkbox-wrapper.anq-checkbox-wrapper-checked` 取消对比
  - **教训**: **读数据前先关掉页面上所有可能干扰数据的选项(对比/筛选/过滤)!**
  - **影响文件**: `tools/pdd-promo-cdp.mjs` 主循环

- [2026-07-11] isExpectedExportTask 校验任务文本里的目标日期导致匹配失败 -> 根因:下载中心任务名用时间戳不含日期 -> 修复:去掉日期校验
  - **现象**: 下载中心有"待下载"任务和"下载"按钮,但脚本说"未找到下载按钮"
  - **根因**: isExpectedExportTask 要求 text.includes(targetDate),但下载中心任务名是"店铺多维度分析20260711195924"(文件名+时间戳),不含"2026-07-01"
  - **修复**: 只校验任务类型(含"店铺多维度")+创建时间(>=请求时间)+状态(含"待下载"),不校验目标日期
  - **教训**: **下载中心任务名格式跟预期不同! 不能假设任务文本里包含目标日期!**
  - **影响文件**: `scripts/huice/lib/export-validation.mjs` `isExpectedExportTask()`

- [2026-07-11] closePopups 点遮罩层触发页面跳转 -> 根因:SPA 路由捕获遮罩层 click -> 修复:不点遮罩层只关按钮
  - **现象**: 去下载中心后关弹窗,页面从下载中心跳回了 trendNew
  - **根因**: closePopups 点 .v-modal/.el-overlay 遮罩层关闭弹窗,但遮罩层的 click 事件被慧经营 SPA 路由捕获,触发了页面跳转
  - **修复**: closePopups 只关通知按钮(我知道了/确定/关闭/取消),不点遮罩层;残留通知等3秒自动消失
  - **教训**: **SPA 页面不能随便点遮罩层! 遮罩层 click 可能被路由捕获导致页面跳转!**
  - **影响文件**: `tools/huice-shop-export-cdp.mjs` `closePopups()` + `downloadFromCenter()`

- [2026-07-11] mallId 路径在 __NEXT_DATA__ 里不对 -> 根因:拼多多页面结构变了 -> 修复:多路径 fallback
  - **现象**: __NEXT_DATA__.props.__ANQ_MODELS_INIT_STATE__.CommonGlobalConfig.mallId 返回 undefined
  - **根因**: 拼多多页面结构变化,mallId 实际在 __NEXT_DATA__.props.pageProps.coreData.extra.mallId
  - **修复**: 尝试 3 个路径: __ANQ_MODELS_INIT_STATE__.CommonGlobalConfig.mallId / pageProps.coreData.extra.mallId / pageProps.mallId
  - **教训**: **__NEXT_DATA__ 的结构不稳定! 要用多路径 fallback!**
  - **影响文件**: `dts/source/pdd-enhancer.js` `tryRenderShopProfitPanel()` + `tools/pdd-promo-cdp.mjs` `readMallId()`

- [2026-07-11] mallId 类型不匹配(Number vs String) -> 根因:SQLite TEXT 字段用数字查不匹配 -> 修复:统一用 String()
  - **现象**: pdd-promo-cdp.mjs 拿到 mallId=338884784(数字),但 pdd_shop_mapping.pdd_mall_id 是 TEXT 类型"338884784"(字符串),查不到映射
  - **根因**: readMallId 返回 Number(),但 HTTP 接口建映射时传的是字符串
  - **修复**: mallId 统一用 String()
  - **教训**: **SQLite TEXT 字段必须用字符串查! Number 和 String 不匹配!**
  - **影响文件**: `tools/pdd-promo-cdp.mjs` `readMallId()`

- [2026-07-11] 推广费采集等待时间不够导致读到旧数据 -> 根因:拼多多推广平台切日期后数据刷新慢 -> 修复:等3秒改5秒
  - **现象**: 7/8 和 7/9 的推广费都是 116.29(相同)
  - **根因**: 拼多多推广平台切日期后数据刷新需要 >3s,等 3s 读到的是上一天的数据
  - **修复**: 等待时间从 3s 改为 5s
  - **教训**: **页面切日期后数据刷新有延迟! 等不够会读到旧数据!**
  - **影响文件**: `tools/pdd-promo-cdp.mjs` 主循环
