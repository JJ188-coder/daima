#!/bin/bash
# huice-daily.sh - 每日慧经营数据同步
#
# 流程:
#   1. 检查 CDP Chrome 9222 是否在线
#   2. 跑 huice-export-cdp 采前一天数据 -> SQLite
#   3. 跑 write-storage 写入 dts 扩展 storage
#
# crontab: 0 9 * * * /Users/jiyuanyi/Documents/daima/scripts/huice-daily.sh >> /tmp/huice-daily.log 2>&1

# 路径自动推导: 本脚本所在目录的上一级 = 项目根
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_PREFIX="[huice-daily $(date '+%Y-%m-%d %H:%M:%S')]"

echo "$LOG_PREFIX === 每日慧经营数据同步开始 ==="
echo "$LOG_PREFIX 项目目录: $PROJECT_DIR"

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

STATUS=0

# 3. 采前一天数据
echo "$LOG_PREFIX 📅 采集前一天数据..."
node tools/huice-export-cdp.mjs --days 1 || {
  echo "$LOG_PREFIX ⚠️ 商品采集失败"
  STATUS=1
}

# 4. 写入 dts storage
echo "$LOG_PREFIX 📤 写入 dts storage..."
node tools/write-storage.mjs --days 1 || {
  echo "$LOG_PREFIX ⚠️ 写入 storage 失败"
  STATUS=1
}

# 5. 店铺维度日报
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d "yesterday" +%Y-%m-%d)
echo "$LOG_PREFIX 🏪 采集店铺日报 $YESTERDAY ..."
node "$PROJECT_DIR/tools/huice-shop-export-cdp.mjs" --dates "$YESTERDAY" || {
  echo "$LOG_PREFIX ⚠️ 店铺日报失败"
  STATUS=1
}

# 6. 拼多多推广费（当前登录店铺）
echo "$LOG_PREFIX 📣 采集拼多多推广费 $YESTERDAY ..."
node "$PROJECT_DIR/tools/pdd-promo-cdp.mjs" --dates "$YESTERDAY" || {
  echo "$LOG_PREFIX ⚠️ 推广费采集失败"
  STATUS=1
}

if [ "$STATUS" -ne 0 ]; then
  echo "$LOG_PREFIX ❌ 每日同步完成，但存在失败步骤"
  exit "$STATUS"
fi

echo "$LOG_PREFIX ✅ 每日同步完成"
