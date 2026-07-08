# huice-daily.ps1 - 每日慧经营数据同步 (Windows)
#
# 流程:
#   1. 检查 CDP Chrome 9222 是否在线
#   2. 跑 huice-export-cdp 采前一天数据 -> SQLite
#   3. 跑 write-storage 写入 dts 扩展 storage

$ErrorActionPreference = "Stop"

# 路径自动推导
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$PROJECT_DIR = Split-Path -Parent $SCRIPT_DIR
$logFile = Join-Path $env:TEMP "huice-daily.log"
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

function Log($msg) {
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

Log "=== 每日慧经营数据同步开始 ==="
Log "项目目录: $PROJECT_DIR"

Set-Location $PROJECT_DIR

# 1. 检查 CDP Chrome 是否在线
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3
} catch {
    Log "❌ CDP Chrome 9222 不在线,跳过"
    Log "   请确保 CDP Chrome 已启动: --remote-debugging-port=9222 --load-extension=dts/"
    exit 1
}
Log "✅ CDP Chrome 在线"

# 2. 检查慧经营标签页是否存在
try {
    $tabs = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/list" -TimeoutSec 5
    $hjyTab = $tabs | Where-Object { $_.type -eq "page" -and $_.url -like "*hjy.huice.com*" } | Select-Object -First 1
} catch {
    Log "❌ 无法获取标签页列表"
    exit 1
}

if (-not $hjyTab) {
    Log "❌ 没找到 hjy.huice.com 标签页"
    Log "   请在 CDP Chrome 打开 https://hjy.huice.com/ 并确保已登录"
    exit 1
}
Log "✅ 慧经营标签页存在"

# 3. 采前一天数据
Log "📅 采集前一天数据..."
node tools\huice-export-cdp.mjs --days 1
if ($LASTEXITCODE -ne 0) {
    Log "❌ huice-export-cdp 失败"
    exit 1
}

# 4. 写入 dts storage
Log "📤 写入 dts storage..."
node tools\write-storage.mjs --days 1
if ($LASTEXITCODE -ne 0) {
    Log "❌ write-storage 失败"
    exit 1
}

Log "✅ 每日同步完成"
