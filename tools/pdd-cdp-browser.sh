#!/usr/bin/env bash
# pdd-cdp-browser.sh — 启动 PDD 测试专用 Chrome（独立 profile + CDP 9222）
#
# 这个脚本解决一个 Chrome 144+ 的硬限制：
#   默认 profile（~/Library/Application Support/Google/Chrome）开不了 CDP，
#   Chrome 接受 --remote-debugging-port 但实际不开端口。
#   必须用独立 user-data-dir，CDP 才会真的监听。
#
# profile 路径：~/Library/Application Support/Google/ChromeCDP
#   - 第一次需要手动登录 PDD 一次
#   - 登录后 cookies 自动持久化，下次免登录
#   - Local State 含 cookies 解密 key，整个目录要一起保留
#
# 用法：
#   bash tools/pdd-cdp-browser.sh           # 启动
#   bash tools/pdd-cdp-browser.sh --stop    # 停止
#   bash tools/pdd-cdp-browser.sh --status  # 查状态
#
# CDP 端点：http://127.0.0.1:9222
#   curl http://127.0.0.1:9222/json/version
#   curl http://127.0.0.1:9222/json
#
# Playwright 连接：
#   const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

set -e

CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE_DIR="$HOME/Library/Application Support/Google/ChromeCDP"
CDP_PORT=9222
EXTENSION_PATH="/Users/longxiaking/Documents/daima/ts"
PID_FILE="$HOME/Library/Application Support/Google/ChromeCDP/.cdp-chrome.pid"

case "${1:-start}" in
  --stop|stop)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      kill "$PID" 2>/dev/null && echo "✓ Chrome PID=$PID 已停止"
      rm -f "$PID_FILE"
    else
      pkill -f "user-data-dir=$PROFILE_DIR" 2>/dev/null && echo "✓ 已按 profile 匹配杀掉" || echo "没找到运行实例"
    fi
    ;;

  --status|status)
    if curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null | grep -q Browser; then
      echo "✓ CDP 在线: http://127.0.0.1:$CDP_PORT"
      echo "  profile: $PROFILE_DIR"
      curl -s "http://127.0.0.1:$CDP_PORT/json" 2>/dev/null | python3 -c "
import sys, json
try:
  t = json.load(sys.stdin)
  print(f'  {len(t)} targets')
  for x in t[:5]:
    print(f'    [{x.get(\"type\",\"\")}] {x.get(\"title\",\"\")[:40]:40s} | {x.get(\"url\",\"\")[:70]}')
except: pass
"
    else
      echo "✗ CDP 未启动"
    fi
    ;;

  start|"")
    # 检查是否已经在跑
    if curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null | grep -q Browser; then
      echo "✓ Chrome 已经在跑，CDP: http://127.0.0.1:$CDP_PORT"
      exit 0
    fi

    # 检查端口是否被别的占
    if lsof -nP -iTCP:$CDP_PORT -sTCP:LISTEN > /dev/null 2>&1; then
      echo "✗ 端口 $CDP_PORT 被占用，请先释放："
      lsof -nP -iTCP:$CDP_PORT -sTCP:LISTEN
      exit 1
    fi

    mkdir -p "$PROFILE_DIR"

    echo "→ 启动 Chrome"
    echo "  profile:   $PROFILE_DIR"
    echo "  cdp port:  $CDP_PORT"
    echo "  extension: $EXTENSION_PATH"

    "$CHROME_APP" \
      --remote-debugging-port=$CDP_PORT \
      --user-data-dir="$PROFILE_DIR" \
      --disable-extensions-except="$EXTENSION_PATH" \
      --load-extension="$EXTENSION_PATH" \
      --no-first-page \
      --no-default-browser-check \
      --disable-blink-features=AutomationControlled \
      >/tmp/pdd-cdp-chrome.log 2>&1 &
    CHROME_PID=$!
    echo $CHROME_PID > "$PID_FILE"
    disown $CHROME_PID 2>/dev/null

    # 轮询等 CDP
    for i in 1 2 3 4 5 6 7 8 9 10; do
      sleep 2
      if curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null | grep -q Browser; then
        echo "[$((i*2))s] ✓ CDP 起来了: http://127.0.0.1:$CDP_PORT"
        echo ""
        echo "→ Playwright 连接:"
        echo "  const browser = await chromium.connectOverCDP('http://127.0.0.1:$CDP_PORT');"
        exit 0
      fi
    done

    echo "✗ 20s 内 CDP 没起来，看日志: /tmp/pdd-cdp-chrome.log"
    exit 1
    ;;

  *)
    echo "用法: bash tools/pdd-cdp-browser.sh [start|stop|status]"
    exit 1
    ;;
esac
