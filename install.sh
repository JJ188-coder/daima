#!/bin/bash
# install.sh - 店透视 + 慧经营数据采集 一键部署 (macOS)
#
# 用法:
#   git clone https://github.com/JJ188-coder/daima.git
#   cd daima
#   ./install.sh
#
# 部署完成后,每天 09:00 自动采集前一天数据

set -e

# === 颜色 ===
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  店透视 + 慧经营采集 一键部署 (macOS)    ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# === 路径推导 ===
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
echo -e "${CYAN}项目目录: $SCRIPT_DIR${NC}"
echo ""

# === 1. 检查前置依赖 ===
echo -e "${YELLOW}[1/6] 检查前置依赖...${NC}"

# Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}❌ 未找到 Node.js。请安装 Node 20+: https://nodejs.org/${NC}"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo -e "${RED}❌ Node 版本过低 (当前 $(node -v),需要 20+)${NC}"
  exit 1
fi
echo -e "  ${GREEN}✅ Node.js $(node -v)${NC}"

# Google Chrome
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -f "$CHROME_PATH" ]; then
  echo -e "${RED}❌ 未找到 Google Chrome。请从 https://www.google.com/chrome/ 安装${NC}"
  exit 1
fi
echo -e "  ${GREEN}✅ Google Chrome${NC}"

# git
if ! command -v git &>/dev/null; then
  echo -e "${RED}❌ 未找到 git。请安装: xcode-select --install${NC}"
  exit 1
fi
echo -e "  ${GREEN}✅ git${NC}"

# python3 (仅用于 json 解析,macOS 自带)
if ! command -v python3 &>/dev/null; then
  echo -e "${YELLOW}⚠️  未找到 python3,部分功能可能受限${NC}"
else
  echo -e "  ${GREEN}✅ python3${NC}"
fi

echo ""

# === 2. 安装 Node 依赖 ===
echo -e "${YELLOW}[2/6] 安装 Node 依赖...${NC}"
npm install 2>&1 | tail -5
echo -e "  ${GREEN}✅ npm install 完成${NC}"
echo ""

# === 3. 配置慧经营凭证 ===
echo -e "${YELLOW}[3/6] 配置慧经营凭证...${NC}"
mkdir -p private

ENV_FILE="private/huice.env"

if [ -f "$ENV_FILE" ]; then
  echo -e "  ${GREEN}✅ 已存在 $ENV_FILE,跳过${NC}"
else
  echo -e "  请输入慧经营凭证 (从慧经营后台获取):"
  echo ""

  read -p "  商家 ID (HUICE_SELLER_ID): " SELLER_ID
  read -p "  用户名 (HUICE_USERNAME): " USERNAME
  read -s -p "  密码 (HUICE_PASSWORD): " PASSWORD
  echo ""
  read -p "  登录 URL [https://hjy.huice.com/]: " LOGIN_URL
  LOGIN_URL=${LOGIN_URL:-https://hjy.huice.com/}
  read -p "  目标 URL [https://hjy.huice.com/#/opertData/CommodityAnalysis]: " TARGET_URL
  TARGET_URL=${TARGET_URL:-https://hjy.huice.com/#/opertData/CommodityAnalysis}

  cat > "$ENV_FILE" << EOF
HUICE_SELLER_ID=$SELLER_ID
HUICE_USERNAME=$USERNAME
HUICE_PASSWORD=$PASSWORD
HUICE_LOGIN_URL=$LOGIN_URL
HUICE_TARGET_URL=$TARGET_URL
EOF
  chmod 600 "$ENV_FILE"
  echo -e "  ${GREEN}✅ 凭证已写入 $ENV_FILE${NC}"
fi
echo ""

# === 4. 导入历史数据 (可选) ===
echo -e "${YELLOW}[4/6] 检查历史数据...${NC}"
if [ -f "private/huice-data.sqlite" ]; then
  echo -e "  ${GREEN}✅ 已存在数据库 private/huice-data.sqlite${NC}"
elif [ -f "daima-data-backup.tar.gz" ]; then
  echo -e "  发现 daima-data-backup.tar.gz,正在导入..."
  tar xzf daima-data-backup.tar.gz -C private/ 2>/dev/null || true
  if [ -f "private/huice-data.sqlite" ]; then
    echo -e "  ${GREEN}✅ 历史数据导入完成${NC}"
  else
    echo -e "  ${YELLOW}⚠️  导入失败,将重新采集${NC}"
  fi
else
  echo -e "  ${YELLOW}⚠️  无历史数据备份,首次使用时 CDP Chrome 登录慧经营后运行:${NC}"
  echo -e "      node tools/huice-export-cdp.mjs --days 30"
  echo -e "      node tools/write-storage.mjs --days 30"
fi
echo ""

# === 5. 设定定时任务 ===
echo -e "${YELLOW}[5/6] 配置定时任务 (launchd)...${NC}"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LAUNCH_DIR" "$LOCAL_BIN"

# Node 绝对路径 (nvm 安装的 node 不在 launchd 默认 PATH 里)
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  # nvm fallback
  NODE_BIN="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin/node"
fi
if [ ! -f "$NODE_BIN" ]; then
  echo -e "${RED}❌ 找不到 node 可执行文件${NC}"
  exit 1
fi
echo -e "  ${CYAN}node 路径: $NODE_BIN${NC}"

# --- 创建 wrapper 脚本 (放 ~/.local/bin 避开 macOS TCC 对 ~/Documents 的保护) ---

# cdp-chrome wrapper
cat > "$LOCAL_BIN/daima-cdp-chrome.sh" << EOF
#!/bin/bash
PROJECT_DIR="$SCRIPT_DIR"
DTS_DIR="\$PROJECT_DIR/dts"

if curl -s --max-time 2 http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
  echo "[cdp-chrome] 9222 CDP 已在线,跳过"
  exit 0
fi

rm -f "\$HOME/.chrome-cdp-profile/SingletonLock" "\$HOME/.chrome-cdp-profile/SingletonSocket" 2>/dev/null

nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
  --user-data-dir="\$HOME/.chrome-cdp-profile" \\
  --remote-debugging-port=9222 \\
  --remote-debugging-address=127.0.0.1 \\
  --enable-extensions \\
  --load-extension="\$DTS_DIR" \\
  --no-first-run \\
  --no-default-browser-check \\
  --disable-features=TranslateUI \\
  > /tmp/chrome-cdp.log 2>&1 &

echo "[cdp-chrome] Chrome PID: \$!"

for i in \$(seq 1 15); do
  sleep 2
  if curl -s --max-time 2 http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo "[cdp-chrome] ✅ 9222 已上线"
    exit 0
  fi
done

echo "[cdp-chrome] ❌ 9222 启动超时"
exit 1
EOF
chmod +x "$LOCAL_BIN/daima-cdp-chrome.sh"

# huice-server wrapper (exec 后由 launchd 直接托管 Node 进程)
cat > "$LOCAL_BIN/daima-huice-server.sh" << EOF
#!/bin/bash
NODE_BIN="$NODE_BIN"
PROJECT_DIR="$SCRIPT_DIR"

exec "\$NODE_BIN" "\$PROJECT_DIR/tools/huice-server.mjs"
EOF

chmod +x "$LOCAL_BIN/daima-huice-server.sh"

# huice-daily wrapper (逻辑内联,用 node 替代 curl+python3,去掉 set -e)
cat > "$LOCAL_BIN/daima-huice-daily.sh" << 'DAILY_EOF'
#!/bin/bash
NODE_BIN="__NODE_BIN__"
PROJECT_DIR="__PROJECT_DIR__"

LOG_PREFIX="[huice-daily $(date '+%Y-%m-%d %H:%M:%S')]"

echo "$LOG_PREFIX === 每日慧经营数据同步开始 ==="

cd "$PROJECT_DIR" || { echo "$LOG_PREFIX ❌ cd 失败"; exit 1; }

# 用 node 检查 CDP + 慧经营标签页 (避开 curl/python3 在 launchd 下的差异)
HJY_CHECK=$("$NODE_BIN" -e '
const http = require("http");
const req = http.get("http://127.0.0.1:9222/json/list", {timeout: 5000}, (res) => {
  let data = "";
  res.on("data", d => data += d);
  res.on("end", () => {
    try {
      const tabs = JSON.parse(data);
      const found = tabs.some(t => t.type === "page" && (t.url||"").includes("hjy.huice.com"));
      console.log(found ? "ok" : "no_hjy");
    } catch(e) { console.log("parse_error"); }
  });
});
req.on("error", () => console.log("no_cdp"));
req.on("timeout", () => { req.destroy(); console.log("timeout"); });
' 2>/dev/null) || HJY_CHECK="error"

case "$HJY_CHECK" in
  ok)
    echo "$LOG_PREFIX ✅ CDP Chrome 在线"
    echo "$LOG_PREFIX ✅ 慧经营标签页存在"
    ;;
  no_hjy)
    echo "$LOG_PREFIX ❌ 没找到 hjy.huice.com 标签页"
    exit 1
    ;;
  *)
    echo "$LOG_PREFIX ❌ CDP Chrome 检查失败 (${HJY_CHECK:-empty})"
    exit 1
    ;;
esac

STATUS=0

# 采前一天商品数据
echo "$LOG_PREFIX 📅 采集前一天数据..."
"$NODE_BIN" tools/huice-export-cdp.mjs --days 1 || {
  echo "$LOG_PREFIX ⚠️ 商品采集失败"
  STATUS=1
}

# 写入 dts storage
echo "$LOG_PREFIX 📤 写入 dts storage..."
"$NODE_BIN" tools/write-storage.mjs --days 1 || {
  echo "$LOG_PREFIX ⚠️ 写入 storage 失败"
  STATUS=1
}

# 店铺维度日报
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d "yesterday" +%Y-%m-%d)
echo "$LOG_PREFIX 🏪 采集店铺日报 $YESTERDAY ..."
"$NODE_BIN" "$PROJECT_DIR/tools/huice-shop-export-cdp.mjs" --dates "$YESTERDAY" || {
  echo "$LOG_PREFIX ⚠️ 店铺日报失败"
  STATUS=1
}

# 拼多多推广费
echo "$LOG_PREFIX 📣 采集拼多多推广费 $YESTERDAY ..."
"$NODE_BIN" "$PROJECT_DIR/tools/pdd-promo-cdp.mjs" --dates "$YESTERDAY" || {
  echo "$LOG_PREFIX ⚠️ 推广费采集失败"
  STATUS=1
}

if [ "$STATUS" -ne 0 ]; then
  echo "$LOG_PREFIX ❌ 每日同步完成，但存在失败步骤"
  exit "$STATUS"
fi

echo "$LOG_PREFIX ✅ 每日同步完成"
DAILY_EOF

# 替换占位符
sed -i '' "s|__NODE_BIN__|$NODE_BIN|g" "$LOCAL_BIN/daima-huice-daily.sh"
sed -i '' "s|__PROJECT_DIR__|$SCRIPT_DIR|g" "$LOCAL_BIN/daima-huice-daily.sh"
chmod +x "$LOCAL_BIN/daima-huice-daily.sh"

echo -e "  ${GREEN}✅ wrapper 脚本已安装到 $LOCAL_BIN${NC}"

# --- 写 plist 文件 (用 /bin/bash 调用 wrapper,加 PATH+HOME 环境变量) ---

# cdp-chrome: 开机自启动
CDP_PLIST="$LAUNCH_DIR/com.daima.cdp-chrome.plist"
cat > "$CDP_PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.daima.cdp-chrome</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$LOCAL_BIN/daima-cdp-chrome.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/cdp-chrome-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/cdp-chrome-launchd.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
EOF

# huice-daily: 每天 09:00
DAILY_PLIST="$LAUNCH_DIR/com.daima.huice-daily.plist"
cat > "$DAILY_PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.daima.huice-daily</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$LOCAL_BIN/daima-huice-daily.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/huice-daily.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/huice-daily.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
EOF

# huice-server: 开机启动 HTTP 数据服务
SERVER_PLIST="$LAUNCH_DIR/com.daima.huice-server.plist"
cat > "$SERVER_PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.daima.huice-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$LOCAL_BIN/daima-huice-server.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/huice-server-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/huice-server-launchd.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
EOF

# 校验后逐个重载,避免某个任务加载失败时把其他服务留在停机状态
plutil -lint "$CDP_PLIST" "$DAILY_PLIST" "$SERVER_PLIST" > /dev/null
LAUNCH_DOMAIN="gui/$(id -u)"
for PLIST in "$SERVER_PLIST" "$DAILY_PLIST" "$CDP_PLIST"; do
  launchctl bootout "$LAUNCH_DOMAIN" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "$LAUNCH_DOMAIN" "$PLIST"
done

echo -e "  ${GREEN}✅ LaunchAgent 已加载:${NC}"
echo -e "     - com.daima.cdp-chrome  (开机自启动 Chrome)"
echo -e "     - com.daima.huice-daily (每天 09:00 采集)"
echo -e "     - com.daima.huice-server(开机启动 HTTP 数据服务)"
echo ""

# === 6. 检查 HTTP 服务 + CDP Chrome ===
echo -e "${YELLOW}[6/6] 检查 HTTP 服务 + CDP Chrome...${NC}"
for i in $(seq 1 10); do
  if curl -s --max-time 2 http://127.0.0.1:9911/health > /dev/null 2>&1; then
    echo -e "  ${GREEN}✅ HTTP 数据服务已上线${NC}"
    break
  fi
  sleep 1
done
bash "$LOCAL_BIN/daima-cdp-chrome.sh" 2>/dev/null || true
echo ""

# === 完成 ===
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║              ✅ 部署完成!                ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}下一步:${NC}"
echo ""
echo -e "  1. ${GREEN}在 CDP Chrome 里登录慧经营${NC}"
echo -e "     Chrome 已自动打开,在地址栏输入:"
echo -e "     ${CYAN}https://hjy.huice.com/${NC}"
echo -e "     登录后保持标签页打开"
echo ""
echo -e "  2. ${GREEN}手动采集一次测试${NC}"
echo -e "     ${CYAN}node tools/huice-export-cdp.mjs --days 1${NC}"
echo -e "     ${CYAN}node tools/write-storage.mjs --days 1${NC}"
echo ""
echo -e "  3. ${GREEN}查看运营看板${NC}"
echo -e "     ${CYAN}node tools/huice-report.mjs --days 7${NC}"
echo ""
echo -e "  4. ${GREEN}打开拼多多商品报表${NC}"
echo -e "     ${CYAN}https://mms.pinduoduo.com/sycm/goods_effect${NC}"
echo -e "     点击任意商品 -> 弹窗会显示 6 列慧经营数据"
echo ""
echo -e "${YELLOW}定时任务:${NC}"
echo -e "  - 每天 09:00 自动采集前一天数据"
echo -e "  - 开机自动启动 CDP Chrome"
echo -e "  - 开机自动启动 HTTP 数据服务 (日常 Chrome 也能看数据)"
echo -e "  - 日志: /tmp/huice-daily.log, /tmp/huice-server.log"
echo ""
