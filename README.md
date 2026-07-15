# 店透视 - 拼多多利润增强工具

> 拼多多商品报表增强 + 慧经营数据自动采集 + 店铺逐日利润看板

---

## 这东西能干嘛？

1. **商品报表弹窗加 13 列利润数据**：6 列绿色商品利润 + 7 列紫色店铺汇总
2. **每日自动采集慧经营数据**：商品利润 + 店铺日报 + 推广费
3. **店铺报表弹窗显示逐日利润**：推广费、ROI、保本ROI、费比、净利润率、净利润额

---

## 快速开始

### 第 1 步：克隆

```bash
git clone https://github.com/JJ188-coder/daima.git
cd daima
```

### 第 2 步：一键部署

**macOS：**
```bash
./install.sh
```

**Windows：**
```powershell
.\install.ps1
```

### 第 3 步：登录慧经营

CDP Chrome 自动打开，输入 `https://hjy.huice.com/` 登录，保持标签页打开。

### 第 4 步：手动采集一次

```bash
# 商品利润数据（30天）
node tools/huice-export-cdp.mjs --days 30
node tools/write-storage.mjs --days 30

# 店铺日报数据（30天）
node tools/huice-shop-export-cdp.mjs --days 30

# 推广费数据（30天）
node tools/pdd-promo-cdp.mjs --days 30
```

推广费采集读取当前登录的拼多多店铺。首次打开“店铺报表”时，扩展只会用已经显示慧经营利润的商品 ID 建立店铺映射；唯一候选会自动确认，多个候选不会猜测，需要人工确认后再采集推广费。

### 第 5 步：打开拼多多看效果

打开 `https://yingxiao.pinduoduo.com/goods/report/promotion/overView`

- **商品报表弹窗**：6 列绿色 + 7 列紫色利润数据
- **店铺报表弹窗**：紫色"🏪 店铺逐日利润"面板

---

## 数据说明

### 商品利润列（绿色表头）

| 列名 | 说明 |
|---|---|
| 净利润 | 扣 1.15元/单包装 + 2%平台费后的利润 |
| 净利率 | 净利润 ÷ 销售额 |
| 毛利率 | 慧经营原始毛利率 |
| 退款额 | 当期退款金额 |
| 推广费比 | 推广费 ÷ GMV |
| 保本ROI | 1 ÷ 净利率 |

### 店铺汇总列（紫色表头）

| 列名 | 说明 |
|---|---|
| 店铺销售额 | 有绿色利润数据的商品销售额之和 |
| 店铺原始净利 | 慧经营原始净利 |
| 包装人工 | 1.15元 × 订单数 |
| 平台费 | 销售额 × 2% |
| 店铺调整净利 | 原始净利 - 包装 - 平台费 |
| 店铺调整净利率 | 调整净利 ÷ 销售额 |
| 覆盖商品 | 有利润商品数 / 已扫描商品数 |

### 店铺逐日利润面板

| 列名 | 数据来源 |
|---|---|
| 日期 | 当前报表日期范围 |
| 推广费用 | 拼多多推广平台"成交营销花费" |
| ROI | 拼多多推广平台"实际投产比" |
| 保本ROI | 1 ÷ 净利率 |
| 费比 | 推广费 ÷ 销售额 |
| 净利润率 | 慧经营"净利润率" |
| 净利润额 | 慧经营"净利润" |

---

## 每日自动同步

| 任务 | 时间 | 说明 |
|---|---|---|
| CDP Chrome 启动 | 开机时 | 带 `--load-extension` 加载扩展 |
| HTTP 数据服务 | 开机时 | `127.0.0.1:9911` 本地数据中转 |
| 商品+店铺+推广采集 | 每天 09:00 | 采前一天数据 |

---

## 常用命令

| 命令 | 说明 |
|---|---|
| `./install.sh` | 一键部署 |
| `./export-data.sh` | 导出数据（换电脑用） |
| `node tools/huice-export-cdp.mjs --days 30` | 采集 30 天商品利润 |
| `node tools/huice-shop-export-cdp.mjs --days 30` | 采集 30 天店铺日报 |
| `node tools/pdd-promo-cdp.mjs --days 30` | 采集 30 天推广费 |
| `node tools/write-storage.mjs --days 30` | 写入扩展 storage |
| `node tools/huice-report.mjs --days 7` | 运营看板 |
| `curl http://127.0.0.1:9911/health` | 检查 HTTP 服务 |

---

## 项目结构

```
daima/
├── install.sh              # macOS 一键部署
├── install.ps1             # Windows 一键部署
├── export-data.sh          # 数据导出
├── dts/                    # Chrome MV3 扩展「店透视」v5.0.17
│   └── source/pdd-enhancer.js  # 核心注入逻辑
├── tools/
│   ├── huice-export-cdp.mjs     # 商品利润采集
│   ├── huice-shop-export-cdp.mjs # 店铺日报采集
│   ├── pdd-promo-cdp.mjs        # 推广费采集
│   ├── write-storage.mjs        # SQLite -> 扩展 storage
│   ├── huice-server.mjs         # 本地 HTTP 数据服务
│   └── huice-report.mjs         # 运营看板
├── scripts/
│   ├── huice-daily.sh(.ps1)     # 每日同步脚本
│   ├── start-cdp-chrome.sh(.ps1) # CDP Chrome 启动
│   └── huice/lib/
│       ├── db.mjs                # SQLite 数据库
│       ├── profit.mjs            # 商品利润计算
│       ├── shop-profit.mjs       # 店铺利润计算
│       ├── export-flow.mjs      # 下载业务层解析器
│       ├── pdd-promo-target.mjs  # 推广页目标锁定器
│       └── collector-result.mjs  # 采集结果状态
├── test/                    # 单元测试
└── private/                 # 凭证+数据库（gitignored）
```

---

## 踩过的坑

完整记录在 `memory/mistakes.md`，主要包括：

- element-ui 按钮文字带空格（"确 定"）
- JS 模板字符串里 `\s` 要写 `\\s`
- 慧经营导出弹窗必须点"确 定"才提交后台
- "我知道了"通知挡住 AG-Grid 下载按钮
- 拼多多推广平台用自定义组件不是 element-ui
- 读界面数字用页面文本按行提取不靠 DOM 选择器
- "对比时间" checkbox 会干扰数据
- 两个推广页同时打开会采错店铺，需按 mallId=338884784 锁定目标页
- CDP 连接超时会泄漏 WebSocket，必须在 reject 前关掉
- 商品快照要按日期原子替换，否则同日旧行删不掉
- 日期面板要选最后一个可见面板，不能选第一个

---

## 安全说明

- 慧经营凭证只存在 `private/huice.env`，已 gitignore
- 数据库在 `private/huice-data.sqlite`，已 gitignore
- HTTP 服务只监听 `127.0.0.1`，不对外
- 扩展不向第三方发送数据
