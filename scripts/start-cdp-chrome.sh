#!/bin/bash
# start-cdp-chrome.sh - 启动 CDP Chrome（带扩展 + 慧经营页面）
# 用途: launchd 开机自调用,保证 huice-daily.sh 9:00 能跑
#
# LaunchAgent: com.daima.cdp-chrome（开机启动）

# 检查是否已在运行
if lsof -nP -iTCP:9222 -sTCP:LISTEN > /dev/null 2>&1; then
  echo "[cdp-chrome] 9222 端口已在线,跳过"
  exit 0
fi

# 清理孤儿锁
rm -f "$HOME/.chrome-cdp-profile/SingletonLock" "$HOME/.chrome-cdp-profile/SingletonSocket" 2>/dev/null

# 启动 CDP Chrome
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.chrome-cdp-profile" \
  --remote-debugging-port=9222 \
  --enable-extensions \
  --load-extension="$HOME/Documents/daima/dts" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=TranslateUI \
  > /tmp/chrome-cdp.log 2>&1 &

echo "[cdp-chrome] Chrome PID: $!"

# 等 9222 上线
for i in $(seq 1 10); do
  sleep 2
  if lsof -nP -iTCP:9222 -sTCP:LISTEN > /dev/null 2>&1; then
    echo "[cdp-chrome] ✅ 9222 已上线"
    exit 0
  fi
done

echo "[cdp-chrome] ❌ 9222 启动超时"
exit 1
