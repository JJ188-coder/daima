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
mkdir -p "$LAUNCH_DIR"

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
        <string>$SCRIPT_DIR/scripts/start-cdp-chrome.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/cdp-chrome-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/cdp-chrome-launchd.log</string>
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
        <string>$SCRIPT_DIR/scripts/huice-daily.sh</string>
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

# 卸载旧的(如果有)再加载
launchctl unload "$CDP_PLIST" 2>/dev/null || true
launchctl unload "$DAILY_PLIST" 2>/dev/null || true
launchctl load -w "$CDP_PLIST"
launchctl load -w "$DAILY_PLIST"

echo -e "  ${GREEN}✅ LaunchAgent 已加载:${NC}"
echo -e "     - com.daima.cdp-chrome (开机自启动 Chrome)"
echo -e "     - com.daima.huice-daily (每天 09:00 采集)"
echo ""

# === 6. 启动 CDP Chrome ===
echo -e "${YELLOW}[6/6] 启动 CDP Chrome...${NC}"
bash scripts/start-cdp-chrome.sh 2>/dev/null || true
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
echo -e "  - 日志: /tmp/huice-daily.log"
echo ""
