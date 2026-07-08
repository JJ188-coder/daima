# 店透视 + 慧经营数据采集

> Chrome 扩展增强拼多多商品报表 + 慧经营数据自动采集入库

## 一句话介绍

在拼多多商品报表弹窗里注入 6 列慧经营真实数据（净利润/净利率/毛利率/退款额/推广费比/保本ROI），每天自动采集慧经营数据到本地 SQLite，亏损商品标红一目了然。

---

## 快速开始（3 步）

### 第 1 步：克隆项目

```bash
git clone https://github.com/JJ188-coder/daima.git
cd daima
```

### 第 2 步：一键部署

**macOS：**
```bash
./install.sh
```

**Windows（PowerShell）：**
```powershell
.\install.ps1
```

部署脚本会自动完成：
- ✅ 检查 Node 20+ / Chrome / git
- ✅ 安装 Node 依赖（better-sqlite3 等）
- ✅ 交互式配置慧经营凭证
- ✅ 导入历史数据（如果有备份）
- ✅ 设定每日 09:00 定时采集
- ✅ 启动 CDP Chrome

### 第 3 步：登录慧经营

CDP Chrome 会自动打开，在地址栏输入：

```
https://hjy.huice.com/
```

登录后**保持标签页打开**。然后手动采集一次测试：

```bash
node tools/huice-export-cdp.mjs --days 1    # 采昨天数据
node tools/write-storage.mjs --days 1        # 写入扩展
```

---

## 前置要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 20+ | http://nodejs.org |
| Google Chrome | 最新版 | 拼多多后台 + 慧经营 + 扩展载体 |
| git | 任意 | 克隆代码 |

macOS 自带 python3（仅用于 JSON 解析，无第三方依赖）。

---

## 从旧机器迁移数据

### 导出（旧机器上跑）

```bash
cd /path/to/daima
./export-data.sh
# 生成 daima-data-backup.tar.gz
```

### 导入（新机器上）

把 `daima-data-backup.tar.gz` 拷到新机器，放在 `daima/` 根目录下，然后跑 `install.sh`，会自动检测并导入。

---

## 功能说明

### 6 列真实数据注入

在拼多多商品报表弹窗（`mms.pinduoduo.com/sycm/goods_effect`）点击任意商品，弹窗表格会多出 6 列绿色表头的数据：

| 列名 | 说明 | 格式 |
|---|---|---|
| 净利润 | 扣除包装人工(1.15元/单) + 平台费(2%)后的利润 | ¥123.45（亏损红色加粗） |
| 净利率 | 净利润 / 销售额 | 33.43% |
| 毛利率 | 慧经营原始毛利率 | 45.20% |
| 退款额 | 当期退款总金额 | ¥56.78 |
| 推广费比 | 推广花费 / GMV | 13.07% |
| 保本ROI | 销售额 / 净利润 | 4.73 |

### 每日自动同步

- **09:00** 自动采集前一天慧经营数据
- 数据存入 `private/huice-data.sqlite`
- 自动写入扩展 storage，刷新拼多多页面即可看到最新数据

### 运营看板

```bash
node tools/huice-report.mjs --days 7     # 最近 7 天
node tools/huice-report.mjs --days 30    # 最近 30 天
node tools/huice-report.mjs --date 2026-07-07  # 指定日期
```

输出：
- 总览（总销售额/总净利润/总退款/亏损商品数）
- 亏损 TOP 10
- 盈利 TOP 10
- 店铺排名

---

## 常用命令

| 命令 | 说明 |
|---|---|
| `./install.sh` | 一键部署（macOS） |
| `.\install.ps1` | 一键部署（Windows） |
| `./export-data.sh` | 导出数据（换电脑用） |
| `node tools/huice-export-cdp.mjs --days 30` | 采集 30 天数据 |
| `node tools/huice-export-cdp.mjs --dates 2026-07-01,2026-07-02` | 采集指定日期 |
| `node tools/write-storage.mjs --days 7` | 写入 7 天数据到扩展 |
| `node tools/huice-report.mjs --days 7` | 查看 7 天运营看板 |
| `bash scripts/start-cdp-chrome.sh` | 手动启动 CDP Chrome |

---

## 项目结构

```
daima/
├── install.sh              # macOS 一键部署
├── install.ps1             # Windows 一键部署
├── export-data.sh          # 数据导出（换电脑用）
├── dts/                    # Chrome MV3 扩展「店透视」v5.0.17
│   ├── manifest.json
│   └── source/pdd-enhancer.js  # 核心注入逻辑
├── tools/                  # CDP 工具集
│   ├── huice-export-cdp.mjs    # 慧经营数据采集
│   ├── write-storage.mjs       # SQLite -> 扩展 storage
│   └── huice-report.mjs        # 运营看板
├── scripts/                # 定时任务脚本
│   ├── start-cdp-chrome.sh(.ps1)  # CDP Chrome 启动
│   └── huice-daily.sh(.ps1)      # 每日同步
└── private/                # 凭证 + 数据库（gitignored）
    ├── huice.env               # 慧经营凭证
    └── huice-data.sqlite       # SQLite 数据库
```

---

## 故障排查

### CDP Chrome 没启动 / 9222 端口不通

```bash
# 手动启动
bash scripts/start-cdp-chrome.sh      # macOS
powershell -File scripts\start-cdp-chrome.ps1  # Windows

# 检查是否在线
curl http://127.0.0.1:9222/json/version
```

### 扩展没加载

CDP Chrome 需要带 `--enable-extensions --load-extension=dts/` 启动。`install.sh` 会自动处理，手动启动 Chrome 不行。

### 慧经营标签页不存在

在 CDP Chrome 里打开 `https://hjy.huice.com/` 并登录，保持标签页打开。定时任务需要这个标签页才能采集数据。

### 采集失败

```bash
# 看日志
cat /tmp/huice-daily.log              # macOS
type %TEMP%\huice-daily.log           # Windows

# 补采失败日期
node tools/huice-export-cdp.mjs --dates 2026-07-05,2026-07-06
```

### 扩展列没显示数据

1. 确认拼多多商品报表弹窗已打开（点击任意商品的「数据分析」）
2. 确认 storage 有数据：`node tools/write-storage.mjs --days 7`
3. 刷新拼多多页面

---

## 定时任务

### macOS（launchd）

| 任务 | 时间 | 作用 |
|---|---|---|
| com.daima.cdp-chrome | 开机时 | 启动 CDP Chrome |
| com.daima.huice-daily | 每天 09:00 | 采集前一天数据 |

```bash
# 查看状态
launchctl list | grep daima

# 卸载
launchctl unload ~/Library/LaunchAgents/com.daima.cdp-chrome.plist
launchctl unload ~/Library/LaunchAgents/com.daima.huice-daily.plist
```

### Windows（计划任务）

| 任务 | 时间 | 作用 |
|---|---|---|
| Daima_CDP_Chrome | 登录时 | 启动 CDP Chrome |
| Daima_Huice_Daily | 每天 09:00 | 采集前一天数据 |

```powershell
# 查看状态
schtasks /Query /TN "Daima_Huice_Daily"

# 手动触发
schtasks /Run /TN "Daima_Huice_Daily"
```

---

## 安全说明

- 慧经营凭证只存在 `private/huice.env`，已 gitignore
- SQLite 数据库在 `private/huice-data.sqlite`，已 gitignore
- `export-data.sh` 导出的备份包含凭证，请勿上传到公开位置
- 扩展不会向任何第三方服务器发送数据
