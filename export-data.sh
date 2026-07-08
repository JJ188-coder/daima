#!/bin/bash
# export-data.sh - 在旧机器上导出历史数据,供新机器导入
#
# 用法:
#   ./export-data.sh
#
# 生成:
#   daima-data-backup.tar.gz  (含 SQLite 数据库 + 慧经营登录状态)
#
# 将此文件拷到新机器 daima 项目根目录,运行 install.sh 会自动导入

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}📦 店透视数据导出工具${NC}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_FILE="daima-data-backup.tar.gz"
FILES_TO_PACK=()

# 1. SQLite 数据库
if [ -f "private/huice-data.sqlite" ]; then
  SIZE=$(du -h private/huice-data.sqlite | cut -f1)
  echo -e "  ${GREEN}✅ 数据库: private/huice-data.sqlite ($SIZE)${NC}"
  FILES_TO_PACK+=("private/huice-data.sqlite")

  # WAL 文件(如果有)
  for ext in shm wal; do
    [ -f "private/huice-data.sqlite-$ext" ] && FILES_TO_PACK+=("private/huice-data.sqlite-$ext")
  done
else
  echo -e "  ${YELLOW}⚠️  无数据库文件,跳过${NC}"
fi

# 2. 慧经营登录状态 (cookie 等)
if [ -f "private/huice-state.json" ]; then
  echo -e "  ${GREEN}✅ 登录状态: private/huice-state.json${NC}"
  FILES_TO_PACK+=("private/huice-state.json")
fi

# 3. 慧经营凭证
if [ -f "private/huice.env" ]; then
  echo -e "  ${GREEN}✅ 凭证文件: private/huice.env${NC}"
  FILES_TO_PACK+=("private/huice.env")
fi

if [ ${#FILES_TO_PACK[@]} -eq 0 ]; then
  echo -e "${RED}❌ 没有可导出的数据${NC}"
  exit 1
fi

echo ""
echo -e "${YELLOW}正在打包...${NC}"
tar czf "$BACKUP_FILE" "${FILES_TO_PACK[@]}"
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

echo ""
echo -e "${GREEN}✅ 导出完成: $BACKUP_FILE ($SIZE)${NC}"
echo ""
echo -e "${CYAN}下一步:${NC}"
echo -e "  1. 将 ${BACKUP_FILE} 拷到新机器"
echo -e "  2. 在新机器上:"
echo -e "     git clone https://github.com/JJ188-coder/daima.git"
echo -e "     cd daima"
echo -e "     cp /path/to/$BACKUP_FILE ."
echo -e "     ./install.sh"
echo ""
echo -e "${YELLOW}注意: 此文件含敏感凭证和登录状态,请勿上传到公开位置${NC}"
