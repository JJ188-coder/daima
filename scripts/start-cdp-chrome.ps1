# start-cdp-chrome.ps1 - 启动 CDP Chrome（带扩展 + 慧经营页面）
# 用途: Windows 计划任务登录时调用,保证 huice-daily.ps1 9:00 能跑

# 路径自动推导: 本脚本所在目录的上一级 = 项目根
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$PROJECT_DIR = Split-Path -Parent $SCRIPT_DIR
$DTS_DIR = Join-Path $PROJECT_DIR "dts"
$PROFILE_DIR = Join-Path $env:USERPROFILE ".chrome-cdp-profile"

# Chrome 路径
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
    Write-Host "[cdp-chrome] ❌ 未找到 Google Chrome" -ForegroundColor Red
    exit 1
}

# 检查 9222 端口是否已在线
try {
    $tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port 9222 -WarningAction SilentlyContinue
    if ($tcp.TcpTestSucceeded) {
        Write-Host "[cdp-chrome] 9222 端口已在线,跳过"
        exit 0
    }
} catch {}

# 清理孤儿锁
$lockFiles = @(
    Join-Path $PROFILE_DIR "SingletonLock",
    Join-Path $PROFILE_DIR "SingletonSocket"
)
foreach ($f in $lockFiles) {
    if (Test-Path $f) { Remove-Item $f -Force 2>$null }
}

# 启动 CDP Chrome
$logFile = Join-Path $env:TEMP "chrome-cdp.log"

Start-Process -FilePath $chromePath -ArgumentList @(
    "--user-data-dir=`"$PROFILE_DIR`"",
    "--remote-debugging-port=9222",
    "--enable-extensions",
    "--load-extension=`"$DTS_DIR`"",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=TranslateUI"
) -WindowStyle Normal -RedirectStandardOutput $logFile -RedirectStandardError $logFile

Write-Host "[cdp-chrome] Chrome 已启动"

# 等 9222 上线
for ($i = 1; $i -le 10; $i++) {
    Start-Sleep -Seconds 2
    try {
        $tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port 9222 -WarningAction SilentlyContinue
        if ($tcp.TcpTestSucceeded) {
            Write-Host "[cdp-chrome] ✅ 9222 已上线"
            exit 0
        }
    } catch {}
}

Write-Host "[cdp-chrome] ❌ 9222 启动超时"
exit 1
