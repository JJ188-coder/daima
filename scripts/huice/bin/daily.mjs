#!/usr/bin/env node
/**
 * daily.mjs — 每日定时增量拉取昨日数据
 *
 * 业务规则:
 *   - 每天 8:30 后汇策才生成昨日数据
 *   - 本脚本每天 9:00 定时跑(cron: 0 9 * * *)
 *   - 拉取范围:昨日 1 天(可 --days N 调整)
 *   - 入库 daily_profit(自动 upsert,重复跑不冲突)
 *
 * 用法:
 *   node scripts/huice/bin/daily.mjs              # 默认拉昨日,所有拼多多店铺
 *   node scripts/huice/bin/daily.mjs --days 3     # 拉最近 3 天(补漏)
 *   node scripts/huice/bin/daily.mjs --shop "拼【周贝瑞"  # 单店
 *
 * cron 设置(macOS launchd 或 crontab):
 *   # 每天 9:00 跑
 *   0 9 * * * cd /Users/longxiaking/Documents/daima && /usr/local/bin/node scripts/huice/bin/daily.mjs >> output/huice-explore/daily.log 2>&1
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

// daily.mjs 本质是 backfill.mjs 的薄包装:固定 --days 1(昨日),默认 --all-pdd
const args = process.argv.slice(2);
const days = args.includes('--days') ? args[args.indexOf('--days') + 1] : '1';
const hasShop = args.includes('--shop');
const hasAllPdd = args.includes('--all-pdd');

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  // 同时写日志文件
  const logDir = resolve(process.cwd(), 'output/huice-explore');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  appendFileSync(resolve(logDir, 'daily.log'), line + '\n');
};

log('=== 每日增量拉取开始 ===');
log(`拉取天数: ${days}`);

// 业务时间检查:8:30 前昨日数据未生成,提示但不阻止(可能手动补漏)
const now = new Date();
const hour = now.getHours();
const minute = now.getMinutes();
if (hour < 8 || (hour === 8 && minute < 30)) {
  log(`⚠ 当前 ${hour}:${String(minute).padStart(2,'0')},昨日数据 8:30 后才生成`);
  log('  如需强制拉取继续,否则建议等 8:30 后');
}

// 调用 backfill.mjs
const backfillArgs = ['scripts/huice/bin/backfill.mjs', '--days', String(days)];
if (hasShop) {
  backfillArgs.push('--shop', args[args.indexOf('--shop') + 1]);
} else if (hasAllPdd || !hasShop) {
  // 默认所有拼多多店铺
  backfillArgs.push('--all-pdd');
}

log(`执行: node ${backfillArgs.join(' ')}`);

const child = spawn('node', backfillArgs, {
  cwd: process.cwd(),
  stdio: 'inherit',
});

child.on('close', (code) => {
  if (code === 0) {
    log('=== 每日增量拉取成功 ===');
  } else {
    log(`❌ 拉取失败,退出码 ${code}`);
  }
  process.exit(code);
});

child.on('error', (err) => {
  log(`❌ 启动失败: ${err.message}`);
  process.exit(1);
});
