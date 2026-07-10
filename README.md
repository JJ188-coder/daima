# 店透视 - 拼多多利润增强工具

> 给朋友用的版本。装好之后，拼多多商品报表里直接看每個商品的净利润、毛利率、退款额，亏损的红色标出来，每天自动同步数据。

---

## 这东西能干嘛？

你在拼多多后台看商品报表的时候，只有销量、访客这些数据，**看不到每个商品到底赚没赚钱**。

这个工具做的事：

1. **自动从慧经营采集数据**（每天 09:00 自动跑，不用你管）
2. **在拼多多商品报表弹窗里加 6 列真实数据**：

| 列名 | 举个例子 | 说明 |
|---|---|---|
| 净利润 | ¥123.45 | 扣了包装人工(1.15元/单) + 平台费(2%)之后真正赚到的钱 |
| 净利率 | 20.00% | 净利润 ÷ 销售额 |
| 毛利率 | 35.00% | 慧经营原始毛利率 |
| 退款额 | ¥56.78 | 当期退款总金额 |
| 推广费比 | 10.00% | 推广花了多少钱占 GMV 多少 |
| 保本ROI | 5.00 | 销售额 ÷ 净利润，低于这个 ROI 就亏 |

3. **亏损商品自动标红**，一眼就能看出来哪些在亏钱

4. **运营看板**，终端跑一下就能看：哪些商品亏最多、哪些赚最多、哪个店铺表现最好

---

## 装之前先准备好这些

你的电脑需要有这三个东西：

| 要装的 | 去哪下 | 为什么要 |
|---|---|---|
| **Node.js 20+** | https://nodejs.org | 跑数据采集脚本 |
| **Google Chrome** | https://www.google.com/chrome/ | 拼多多 + 慧经营 + 扩展载体 |
| **git** | https://git-scm.com/ | 下载代码 |

Mac 自带 git 和 python3（装了 Xcode Command Line Tools 就有）。

---

## 安装步骤

### 第 1 步：下载代码

打开终端（Mac）或 PowerShell（Windows），跑：

```bash
git clone https://github.com/JJ188-coder/daima.git
cd daima
```

### 第 2 步：一键部署

**Mac：**
```bash
./install.sh
```

**Windows：**
```powershell
.\install.ps1
```

它会自动帮你装依赖、配凭证、设定时任务、启动 Chrome。中间会问你几个问题：

```
商家 ID (HUICE_SELLER_ID): ______     ← 你的慧经营商家 ID
用户名 (HUICE_USERNAME): ______       ← 慧经营登录用户名
密码 (HUICE_PASSWORD): ______         ← 慧经营登录密码
```

这些信息只存在你电脑本地的 `private/huice.env` 文件里，不会上传到任何地方。

### 第 3 步：登录慧经营

部署完之后 Chrome 会自动打开。在地址栏输入：

```
https://hjy.huice.com/
```

登录之后**保持这个标签页开着不要关**。定时任务需要这个标签页才能采集数据。

### 第 4 步：手动跑一次测试

确认一切正常：

```bash
node tools/huice-export-cdp.mjs --days 1    # 采昨天的数据
node tools/write-storage.mjs --days 1        # 写进扩展
```

看到 `✅ 回采完成` 就说明成功了。

### 第 5 步：打开拼多多看看效果

打开 https://mms.pinduoduo.com/sycm/goods_effect

点任意一个商品，弹窗表格里会多出：
- **6 列绿色表头**：每个商品的净利润、净利率、毛利率、退款额、推广费比、保本ROI
- **7 列紫色表头**：店铺利润汇总（只统计有绿色利润数据的商品）
  - 店铺销售额、店铺原始净利、包装人工、平台费、店铺调整净利、店铺调整净利率、覆盖商品

亏损商品整行标红，一眼看出哪些在亏钱。

#### 关于店铺汇总

- 店铺汇总只统计**已显示慧经营绿色利润数据**的商品，未卖商品不计入
- 「覆盖商品」显示「有绿色利润的商品数 / 已扫描商品数」
- 未卖商品不会触发数据库查询，也不会被按零利润计入
- 覆盖不足或没有回采数据时，店铺汇总显示 `--`，不是零利润
- 店铺汇总依赖每日的慧经营「导出全部」任务正常完成

---

## 装好之后日常怎么用

### 自动的（不用管）

- 每天早上 **9 点**自动采集昨天的数据
- 开机自动启动 Chrome
- 开机自动启动 HTTP 数据服务（日常 Chrome 也能看数据）
- 你只需要保证 Chrome 里慧经营标签页是登录状态

### 手动操作

| 你想干嘛 | 跑什么命令 |
|---|---|
| 采集最近 N 天历史数据 | `node tools/huice-export-cdp.mjs --days 7` |
| 补采某几天的数据 | `node tools/huice-export-cdp.mjs --dates YYYY-MM-DD,YYYY-MM-DD` |
| 把数据写进扩展 | `node tools/write-storage.mjs --days 7` |
| 看运营看板 | `node tools/huice-report.mjs --days 7` |
| 手动启动 Chrome | `bash scripts/start-cdp-chrome.sh`（Mac）/ `powershell -File scripts\start-cdp-chrome.ps1`（Windows） |

### 运营看板长这样

```
📊 慧经营运营看板 (近 7 天)
════════════════════════════════════════
总览:
  销售额: ¥125,680.00
  净利润: ¥38,420.50
  退款额: ¥5,230.00
  亏损商品: 12 个

🔻 亏损 TOP 5:
  1. 某某零食  -¥1,230.00
  2. 某某坚果  -¥890.50
  ...

📈 盈利 TOP 5:
  1. 某某肉干  +¥5,680.00
  2. 某某饼干  +¥3,420.00
  ...
```

---

## 换电脑怎么办？

### 旧电脑导出

```bash
cd /path/to/daima
./export-data.sh
```

会生成一个 `daima-data-backup.tar.gz`（3MB 左右），里面包含：
- 所有历史数据（SQLite 数据库）
- 慧经营登录状态
- 凭证文件

### 新电脑导入

把 `daima-data-backup.tar.gz` 拷到新电脑，放在 `daima/` 目录下，然后跑 `./install.sh`，会自动检测并导入。

---

## 常见问题

### Q: Chrome 没自动打开 / 9222 端口不通

手动启动：
```bash
bash scripts/start-cdp-chrome.sh        # Mac
powershell -File scripts\start-cdp-chrome.ps1  # Windows
```

### Q: 数据没显示在拼多多报表里

1. 确认慧经营标签页是登录状态
2. 跑一下：`node tools/write-storage.mjs --days 7`
3. 刷新拼多多页面

### Q: 采集失败了

看日志找原因：
```bash
cat /tmp/huice-daily.log          # Mac
type %TEMP%\huice-daily.log      # Windows
```

补采失败的日期：
```bash
node tools/huice-export-cdp.mjs --dates YYYY-MM-DD
```

### Q: 凭证填错了想改

直接编辑 `private/huice.env` 文件，改成正确的值就行。

### Q: 不想每天自动跑了

**Mac：**
```bash
launchctl unload ~/Library/LaunchAgents/com.daima.huice-daily.plist
```

**Windows：**
```powershell
schtasks /Delete /TN "Daima_Huice_Daily" /F
```

---

## 安全说明

- 慧经营账号密码只存在你电脑的 `private/huice.env` 文件里，**不会上传到任何服务器**
- 数据库也在本地 `private/huice-data.sqlite`，**不联网**
- `export-data.sh` 导出的备份文件含账号密码，**别发给别人、别传网上**
- 扩展只往拼多多页面注入数据，**不往外发数据**

---

## 净利润怎么算的

```
调整后净利润 = 慧经营原始净利额 - 订单固定成本 - 平台费
             = 慧经营原始净利额 - (1.15元 × 销售件数) - (销售额 × 2%)
```

- **慧经营原始净利额**：单独保存，方便以后追溯。
- **调整后净利润**：页面里展示的净利润。
- **订单固定成本**：每单 1.15 元；当前口径里销售件数就是订单数。
- **平台费**：销售额的 2%。

多日数据合并时，净利率会用“合计调整后净利润 ÷ 合计销售额”重新计算。

---

## 有问题找我

装的过程中遇到什么问题，截图发我就行。
