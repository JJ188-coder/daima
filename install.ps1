# install.ps1 - 店透视 + 慧经营数据采集 一键部署 (Windows PowerShell)
#
# 用法:
#   git clone https://github.com/JJ188-coder/daima.git
#   cd daima
#   .\install.ps1
#
# 部署完成后,每天 09:00 自动采集前一天数据

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  店透视 + 慧经营采集 一键部署 (Windows)  ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# === 路径推导 ===
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $SCRIPT_DIR
Write-Host "项目目录: $SCRIPT_DIR" -ForegroundColor Cyan
Write-Host ""

# === 1. 检查前置依赖 ===
Write-Host "[1/6] 检查前置依赖..." -ForegroundColor Yellow

# Node.js
try {
    $nodeVer = (node -v) -replace 'v','' -split '\.' | Select-Object -First 1
    if ([int]$nodeVer -lt 20) {
        Write-Host "  ❌ Node 版本过低 (当前 $(node -v),需要 20+)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✅ Node.js $(node -v)" -ForegroundColor Green
} catch {
    Write-Host "  ❌ 未找到 Node.js。请安装 Node 20+: https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# Google Chrome
$chromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chromePath = $null
foreach ($p in $chromePaths) {
    if (Test-Path $p) { $chromePath = $p; break }
}
if (-not $chromePath) {
    Write-Host "  ❌ 未找到 Google Chrome。请从 https://www.google.com/chrome/ 安装" -ForegroundColor Red
    exit 1
}
Write-Host "  ✅ Google Chrome ($chromePath)" -ForegroundColor Green

# git
try { git --version | Out-Null; Write-Host "  ✅ git" -ForegroundColor Green }
catch { Write-Host "  ❌ 未找到 git。请安装: https://git-scm.com/" -ForegroundColor Red; exit 1 }

Write-Host ""

# === 2. 安装 Node 依赖 ===
Write-Host "[2/6] 安装 Node 依赖..." -ForegroundColor Yellow
npm install 2>&1 | Select-Object -Last 5
Write-Host "  ✅ npm install 完成" -ForegroundColor Green
Write-Host ""

# === 3. 配置慧经营凭证 ===
Write-Host "[3/6] 配置慧经营凭证..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "private" | Out-Null

$envFile = "private\huice.env"

if (Test-Path $envFile) {
    Write-Host "  ✅ 已存在 $envFile,跳过" -ForegroundColor Green
} else {
    Write-Host "  请输入慧经营凭证 (从慧经营后台获取):" -ForegroundColor White
    Write-Host ""

    $sellerId = Read-Host "  商家 ID (HUICE_SELLER_ID)"
    $username = Read-Host "  用户名 (HUICE_USERNAME)"
    $password = Read-Host "  密码 (HUICE_PASSWORD)" -AsSecureString
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    )
    $loginUrl = Read-Host "  登录 URL [https://hjy.huice.com/]"
    if (-not $loginUrl) { $loginUrl = "https://hjy.huice.com/" }
    $targetUrl = Read-Host "  目标 URL [https://hjy.huice.com/#/opertData/CommodityAnalysis]"
    if (-not $targetUrl) { $targetUrl = "https://hjy.huice.com/#/opertData/CommodityAnalysis" }

    $envContent = @"
HUICE_SELLER_ID=$sellerId
HUICE_USERNAME=$username
HUICE_PASSWORD=$plainPassword
HUICE_LOGIN_URL=$loginUrl
HUICE_TARGET_URL=$targetUrl
"@
    $envContent | Out-File -FilePath $envFile -Encoding UTF8 -NoNewline
    Write-Host "  ✅ 凭证已写入 $envFile" -ForegroundColor Green
}
Write-Host ""

# === 4. 导入历史数据 (可选) ===
Write-Host "[4/6] 检查历史数据..." -ForegroundColor Yellow
if (Test-Path "private\huice-data.sqlite") {
    Write-Host "  ✅ 已存在数据库 private\huice-data.sqlite" -ForegroundColor Green
} elseif (Test-Path "daima-data-backup.tar.gz") {
    Write-Host "  发现 daima-data-backup.tar.gz,正在导入..."
    # Windows 没有 tar,但 Win10+ 自带 tar.exe
    tar xzf daima-data-backup.tar.gz -C private\ 2>$null
    if (Test-Path "private\huice-data.sqlite") {
        Write-Host "  ✅ 历史数据导入完成" -ForegroundColor Green
    } else {
        Write-Host "  ⚠️  导入失败,将重新采集" -ForegroundColor Yellow
    }
} else {
    Write-Host "  ⚠️  无历史数据备份,首次使用时 CDP Chrome 登录慧经营后运行:" -ForegroundColor Yellow
    Write-Host "      node tools\huice-export-cdp.mjs --days 30"
    Write-Host "      node tools\write-storage.mjs --days 30"
}
Write-Host ""

# === 5. 设定定时任务 ===
Write-Host "[5/6] 配置定时任务 (Windows 计划任务)..." -ForegroundColor Yellow

# 先删除旧任务(如果有)
schtasks /Delete /TN "Daima_CDP_Chrome" /F 2>$null | Out-Null
schtasks /Delete /TN "Daima_Huice_Daily" /F 2>$null | Out-Null
schtasks /Delete /TN "Daima_Huice_Server" /F 2>$null | Out-Null

# CDP Chrome: 登录时启动
$cdpScript = "$SCRIPT_DIR\scripts\start-cdp-chrome.ps1"
schtasks /Create /TN "Daima_CDP_Chrome" /TR "powershell -ExecutionPolicy Bypass -File `"$cdpScript`"" /SC ONLOGON /RL HIGHEST /F 2>&1 | Out-Null

# Huice Daily: 每天 09:00
$dailyScript = "$SCRIPT_DIR\scripts\huice-daily.ps1"
schtasks /Create /TN "Daima_Huice_Daily" /TR "powershell -ExecutionPolicy Bypass -File `"$dailyScript`"" /SC DAILY /ST 09:00 /F 2>&1 | Out-Null

# Huice Server: 登录时启动 HTTP 数据服务
schtasks /Create /TN "Daima_Huice_Server" /TR "powershell -ExecutionPolicy Bypass -Command `"Start-Process node -ArgumentList '`$SCRIPT_DIR\tools\huice-server.mjs' -WindowStyle Hidden`"" /SC ONLOGON /RL HIGHEST /F 2>&1 | Out-Null

Write-Host "  ✅ Windows 计划任务已创建:" -ForegroundColor Green
Write-Host "     - Daima_CDP_Chrome  (登录时启动 Chrome)"
Write-Host "     - Daima_Huice_Daily (每天 09:00 采集)"
Write-Host "     - Daima_Huice_Server(登录时启动 HTTP 数据服务)"
Write-Host ""

# === 6. 启动 HTTP 服务 + CDP Chrome ===
Write-Host "[6/6] 启动 HTTP 服务 + CDP Chrome..." -ForegroundColor Yellow
Start-Process node -ArgumentList "$SCRIPT_DIR\tools\huice-server.mjs" -WindowStyle Hidden 2>$null
& powershell -ExecutionPolicy Bypass -File $cdpScript 2>$null
Write-Host ""

# === 完成 ===
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║              ✅ 部署完成!                ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  1. 在 CDP Chrome 里登录慧经营" -ForegroundColor Green
Write-Host "     Chrome 已自动打开,在地址栏输入:"
Write-Host "     https://hjy.huice.com/" -ForegroundColor Cyan
Write-Host "     登录后保持标签页打开"
Write-Host ""
Write-Host "  2. 手动采集一次测试" -ForegroundColor Green
Write-Host "     node tools\huice-export-cdp.mjs --days 1" -ForegroundColor Cyan
Write-Host "     node tools\write-storage.mjs --days 1" -ForegroundColor Cyan
Write-Host ""
Write-Host "  3. 查看运营看板" -ForegroundColor Green
Write-Host "     node tools\huice-report.mjs --days 7" -ForegroundColor Cyan
Write-Host ""
Write-Host "  4. 打开拼多多商品报表" -ForegroundColor Green
Write-Host "     https://mms.pinduoduo.com/sycm/goods_effect" -ForegroundColor Cyan
Write-Host "     点击任意商品 -> 弹窗会显示 6 列慧经营数据"
Write-Host ""
Write-Host "定时任务:" -ForegroundColor Yellow
Write-Host "  - 每天 09:00 自动采集前一天数据"
Write-Host "  - 登录时自动启动 CDP Chrome"
Write-Host "  - 日志: %TEMP%\huice-daily.log"
Write-Host ""
