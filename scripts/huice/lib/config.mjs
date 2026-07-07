/**
 * config.mjs — huice CLI 配置加载
 *
 * 读取顺序 (后者覆盖前者):
 *   private/huice.env  →  process.env  →  显式传入的 override
 *
 * 零依赖手写 dotenv 解析 (5 行正则),避免引入 dotenv 包。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..', '..', '..', '..'); // scripts/huice/lib → 项目根
const ENV_FILE = resolve(__dirname, 'private/huice.env');

/** 解析 .env 文件 → 对象 (KEY=value, 忽略注释和空行) */
function parseDotenv(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    // 去掉首尾引号
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

/** 加载完整配置 (env 文件 → process.env → defaults) */
export function loadConfig(overrides = {}) {
  const fileEnv = parseDotenv(ENV_FILE);

  const config = {
    sellerId: process.env.HUICE_SELLER_ID || fileEnv.HUICE_SELLER_ID || '',
    username: process.env.HUICE_USERNAME || fileEnv.HUICE_USERNAME || '',
    password: process.env.HUICE_PASSWORD || fileEnv.HUICE_PASSWORD || '',
    loginUrl: process.env.HUICE_LOGIN_URL || fileEnv.HUICE_LOGIN_URL || 'https://hjy.huice.com/',
    targetUrl:
      process.env.HUICE_TARGET_URL ||
      fileEnv.HUICE_TARGET_URL ||
      'https://hjy.huice.com/#/businessAnalysisCenter/report/daily',
    cdpPort: parseInt(process.env.HUICE_CDP_PORT || fileEnv.HUICE_CDP_PORT || '9222', 10),
    chromePath:
      process.env.HUICE_CHROME_PATH ||
      fileEnv.HUICE_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    profileDir: resolve(__dirname, 'private/huice-profile'),
    stateFile: resolve(__dirname, 'private/huice-state.json'),
    outputDir: resolve(__dirname, 'output/huice-explore'),
    screenshotDir: resolve(__dirname, 'output/huice-explore/screenshots'),
  };

  return { ...config, ...overrides };
}

/** 校验必要凭证是否齐全 */
export function validateCredentials(config) {
  const missing = [];
  if (!config.sellerId) missing.push('HUICE_SELLER_ID');
  if (!config.username) missing.push('HUICE_USERNAME');
  if (!config.password) missing.push('HUICE_PASSWORD');
  return { ok: missing.length === 0, missing };
}
