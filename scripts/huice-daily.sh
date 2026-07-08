#!/bin/bash
# huice-daily.sh - 每日慧经营数据同步
#
# 流程:
#   1. 检查 CDP Chrome 9222 是否在线
#   2. 跑 huice-export-cdp 采前一天数据 -> SQLite
#   3. 跑 write-storage 写入 dts 扩展 storage
#
# crontab: 0 9 * * * /Users/jiyuanyi/Documents/daima/scripts/huice-daily.sh >> /tmp/huice-daily.log 2>&1

set -e

PROJECT_DIR="/Users/jiyuanyi/Documents/daima"
LOG_PREFIX="[huice-daily $(date '+%Y-%m-%d %H:%M:%S')]"

echo "$LOG_PREFIX === 每日慧经营数据同步开始 ==="

cd "$PROJECT_DIR"

# 1. 检查 CDP Chrome 是否在线
if ! curl -s --max-time 3 http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
  echo "$LOG_PREFIX ❌ CDP Chrome 9222 不在线,跳过"
  echo "$LOG_PREFIX    请确保 CDP Chrome 已启动: --remote-debugging-port=9222 --load-extension=dts/"
  exit 1
fi
echo "$LOG_PREFIX ✅ CDP Chrome 在线"

# 2. 检查慧经营标签页是否存在
HJY_TAB=$(curl -s http://127.0.0.1:9222/json/list | python3 -c "
import json, sys
tabs = json.load(sys.stdin)
for t in tabs:
    if t.get('type') == 'page' and 'hjy.huice.com' in t.get('url', ''):
        print('found')
        break
" 2>/dev/null)

if [ "$HJY_TAB" != "found" ]; then
  echo "$LOG_PREFIX ❌ 没找到 hjy.huice.com 标签页"
  echo "$LOG_PREFIX    请在 CDP Chrome 打开 https://hjy.huice.com/ 并确保已登录"
  exit 1
fi
echo "$LOG_PREFIX ✅ 慧经营标签页存在"

# 3. 采前一天数据
echo "$LOG_PREFIX 📅 采集前一天数据..."
node tools/huice-export-cdp.mjs --days 1

# 4. 写入 dts storage
echo "$LOG_PREFIX 📤 写入 dts storage..."
node tools/write-storage.mjs --days 1

echo "$LOG_PREFIX ✅ 每日同步完成"
