#!/bin/bash
# start-huice-server.sh - 启动本地 HTTP 数据服务
# 用途: launchd 开机自调用,让日常 Chrome 扩展也能读慧经营数据
#
# LaunchAgent: com.daima.huice-server (开机启动)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 检查是否已在运行
if lsof -nP -iTCP:9911 -sTCP:LISTEN > /dev/null 2>&1; then
  echo "[huice-server] 9911 端口已在线,跳过"
  exit 0
fi

# 启动 HTTP 服务
nohup node "$PROJECT_DIR/tools/huice-server.mjs" \
  > /tmp/huice-server.log 2>&1 &

echo "[huice-server] PID: $!"

# 等 9911 上线
for i in $(seq 1 5); do
  sleep 1
  if lsof -nP -iTCP:9911 -sTCP:LISTEN > /dev/null 2>&1; then
    echo "[huice-server] ✅ 9911 已上线"
    exit 0
  fi
done

echo "[huice-server] ❌ 9911 启动超时"
exit 1
