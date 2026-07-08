#!/usr/bin/env node
/**
 * probe.mjs — 探测汇策利润分析页 DOM 结构
 *
 * 目的:摸清"每日利润分析"页面的真实 DOM 结构
 *  - 店铺选择器长什么样?
 *  - 查询按钮怎么点?
 *  - 表格是 el-table 还是自定义?列头/数据在哪个选择器?
 *  - Tab 切换怎么触发?
 *
 * 输出: output/huice-explore/probe-result.json + 截图
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const log = (...a) => console.log('[probe]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!existsSync(config.screenshotDir)) mkdirSync(config.screenshotDir, { recursive: true });

  // 清理孤儿锁
  const lock = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lock)) {
    try {
      const content = readFileSync(lock, 'utf8').trim();
      const pid = parseInt((content.match(/(\d+)$/) || [])[1] || '0', 10);
      if (pid) {
        try { process.kill(pid, 0); }
        catch { unlinkSync(lock); log(`清理孤儿锁 PID ${pid}`); }
      }
    } catch {}
  }

  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.chromePath,
    headless: true,
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    // 导航到利润分析页
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);

    // 如果需要登录
    if (page.url().includes('login') || (await page.locator('input[type="password"]').isVisible({ timeout: 2000 }).catch(() => false))) {
      log('⚠ 需要重新登录');
      await context.close();
      process.exit(1);
    }

    log('已进入利润分析页:', page.url());
    await page.screenshot({ path: resolve(config.screenshotDir, 'probe-01-landed.png') });

    // ===== 1. 探测筛选区(店铺/日期/查询按钮)=====
    log('\n=== 1. 筛选区探测 ===');
    const filterArea = await page.evaluate(() => {
      const info = {
        selects: [],          // 下拉框
        datePickers: [],      // 日期选择器
        buttons: [],          // 按钮
        tabs: [],             // Tab
        radioGroups: [],      // 单选组(口径)
        bodyText: '',
      };

      // el-select / el-date-editor / button
      document.querySelectorAll('.el-select, [class*="select"]').forEach(el => {
        const t = el.textContent.trim().slice(0, 50);
        const rect = el.getBoundingClientRect();
        if (t && rect.width > 0) {
          info.selects.push({
            text: t,
            class: el.className,
            placeholder: el.querySelector('input')?.placeholder || '',
            // 是否含"店铺"
            isShop: t.includes('店铺') || el.querySelector('input')?.placeholder?.includes('店铺'),
          });
        }
      });

      document.querySelectorAll('.el-date-editor, [class*="date"], [class*="Date"]').forEach(el => {
        const t = el.textContent.trim().slice(0, 50);
        const rect = el.getBoundingClientRect();
        if (rect.width > 0) {
          info.datePickers.push({
            text: t,
            class: el.className,
            input: el.querySelector('input')?.value || el.querySelector('input')?.placeholder || '',
          });
        }
      });

      document.querySelectorAll('button, .el-button').forEach(el => {
        const t = el.textContent.trim();
        const rect = el.getBoundingClientRect();
        if (t && t.length < 20 && rect.width > 0) {
          info.buttons.push({
            text: t,
            class: el.className,
            type: el.getAttribute('type') || '',
          });
        }
      });

      document.querySelectorAll('.el-tabs__item').forEach(el => {
        const t = el.textContent.trim();
        if (t) info.tabs.push(t);
      });

      document.querySelectorAll('.el-radio-button__inner, .el-radio__label').forEach(el => {
        const t = el.textContent.trim();
        if (t && t.length < 20) info.radioGroups.push(t);
      });

      // 筛选区整体文本
      const filterContainer = document.querySelector('.filter-container, .search-form, [class*="filter"], [class*="search"], .el-form');
      if (filterContainer) info.bodyText = filterContainer.textContent.trim().slice(0, 800);

      return info;
    });

    log('下拉框:', filterArea.selects.length);
    filterArea.selects.forEach(s => log(`  ${s.isShop ? '🏪 ' : ''}${s.text} | placeholder: ${s.placeholder}`));
    log('日期:', filterArea.datePickers.map(d => `${d.input||d.text}`).join(' | '));
    log('按钮:', filterArea.buttons.map(b => b.text).join(' | '));
    log('Tab:', filterArea.tabs.join(' | '));
    log('单选:', filterArea.radioGroups.join(' | '));
    log('筛选区文本:', filterArea.bodyText.slice(0, 300));

    // ===== 2. 探测表格区 =====
    log('\n=== 2. 表格区探测 ===');
    const tableInfo = await page.evaluate(() => {
      const info = { type: 'unknown', headers: [], sampleRow: null, rowCount: 0 };

      // el-table?
      const elTable = document.querySelector('.el-table');
      if (elTable) {
        info.type = 'el-table';
        info.headers = Array.from(elTable.querySelectorAll('thead th .cell, thead th'))
          .map(th => th.textContent.trim())
          .filter(Boolean);
        const rows = elTable.querySelectorAll('tbody tr');
        info.rowCount = rows.length;
        if (rows[0]) {
          info.sampleRow = Array.from(rows[0].querySelectorAll('td .cell, td'))
            .map(td => td.textContent.trim())
            .slice(0, 30);
        }
        return info;
      }

      // 普通 table?
      const plainTable = document.querySelector('table');
      if (plainTable) {
        info.type = 'plain-table';
        info.headers = Array.from(plainTable.querySelectorAll('thead th')).map(th => th.textContent.trim());
        const rows = plainTable.querySelectorAll('tbody tr');
        info.rowCount = rows.length;
        if (rows[0]) info.sampleRow = Array.from(rows[0].querySelectorAll('td')).map(td => td.textContent.trim());
        return info;
      }

      // 自定义表格?
      const gridTable = document.querySelector('[class*="grid"], [class*="Grid"], .vxe-table, [class*="table-body"], [class*="TableBody"]');
      if (gridTable) {
        info.type = 'custom-' + gridTable.className.split(' ')[0];
        const headerCells = gridTable.querySelectorAll('[class*="header"] [class*="cell"], [class*="th"], .vxe-header--column');
        info.headers = Array.from(headerCells).map(c => c.textContent.trim()).filter(Boolean);
        const rows = gridTable.querySelectorAll('[class*="row"], [class*="Row"], .vxe-body--row');
        info.rowCount = rows.length;
        if (rows[0]) info.sampleRow = Array.from(rows[0].querySelectorAll('[class*="cell"], [class*="td"]')).map(c => c.textContent.trim()).slice(0, 30);
        return info;
      }

      return info;
    });

    log('表格类型:', tableInfo.type);
    log('行数:', tableInfo.rowCount);
    log('表头:', tableInfo.headers.join(' | '));
    if (tableInfo.sampleRow) {
      log('样例行:', tableInfo.sampleRow.join(' | '));
    }

    // ===== 3. 尝试选店铺并查询 =====
    log('\n=== 3. 尝试选店铺+查询 ===');
    // 先点店铺下拉
    const shopOpened = await page.evaluate(() => {
      const selects = document.querySelectorAll('.el-select');
      for (const sel of selects) {
        const ph = sel.querySelector('input')?.placeholder || '';
        const text = sel.textContent.trim();
        if (ph.includes('店铺') || text.includes('店铺') || ph.includes('选择')) {
          sel.click();
          return true;
        }
      }
      return false;
    });

    if (shopOpened) {
      log('店铺下拉已点开');
      await sleep(1000);
      await page.screenshot({ path: resolve(config.screenshotDir, 'probe-02-shop-dropdown.png') });

      // 看下拉选项
      const shopOptions = await page.evaluate(() => {
        const opts = Array.from(document.querySelectorAll('.el-select-dropdown__item, [class*="dropdown"] [class*="item"]'))
          .map(el => el.textContent.trim())
          .filter(t => t && t.length < 40);
        return [...new Set(opts)].slice(0, 20);
      });
      log('店铺选项:', shopOptions.join(' | '));

      // 点第一个非"全部"的选项
      const selected = await page.evaluate(() => {
        const opts = document.querySelectorAll('.el-select-dropdown__item:not(.selected)');
        for (const opt of opts) {
          const t = opt.textContent.trim();
          if (t && t !== '全部' && !t.includes('请选择')) {
            opt.click();
            return t;
          }
        }
        return null;
      });
      log('选中店铺:', selected);
      await sleep(500);
    }

    // 点查询
    const queried = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, .el-button');
      for (const btn of btns) {
        const t = btn.textContent.trim();
        if (['查询', '查 询', '搜索'].includes(t)) { btn.click(); return t; }
      }
      return null;
    });
    log('点击查询:', queried);
    await sleep(6000); // 等数据加载
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    await page.screenshot({ path: resolve(config.screenshotDir, 'probe-03-after-query.png'), fullPage: true });

    // 重新探测表格(查询后)
    const tableAfterQuery = await page.evaluate(() => {
      const info = { type: 'unknown', headers: [], rowCount: 0, sampleRows: [] };
      const elTable = document.querySelector('.el-table');
      const target = elTable || document.querySelector('table') || document.querySelector('[class*="grid"], [class*="Grid"]');
      if (!target) return info;

      info.type = elTable ? 'el-table' : (target.tagName === 'TABLE' ? 'plain-table' : 'custom');
      info.headers = Array.from(target.querySelectorAll('thead th .cell, thead th')).map(th => th.textContent.trim()).filter(Boolean);
      const rows = target.querySelectorAll('tbody tr');
      info.rowCount = rows.length;
      const max = Math.min(5, rows.length);
      for (let i = 0; i < max; i++) {
        info.sampleRows.push(Array.from(rows[i].querySelectorAll('td .cell, td')).map(td => td.textContent.trim()).slice(0, 30));
      }
      return info;
    });

    log('\n=== 4. 查询后表格 ===');
    log('行数:', tableAfterQuery.rowCount);
    log('表头:', tableAfterQuery.headers.join(' | '));
    if (tableAfterQuery.sampleRows.length > 0) {
      log('前 3 行数据:');
      tableAfterQuery.sampleRows.slice(0, 3).forEach((r, i) => log(`  [${i}] ${r.join(' | ')}`));
    }

    // 写结果
    const result = {
      url: page.url(),
      title: await page.title(),
      filterArea,
      tableBeforeQuery: tableInfo,
      tableAfterQuery,
      timestamp: new Date().toISOString(),
    };
    const outFile = resolve(config.outputDir, 'probe-result.json');
    if (!existsSync(config.outputDir)) mkdirSync(config.outputDir, { recursive: true });
    writeFileSync(outFile, JSON.stringify(result, null, 2));
    log(`\n📄 结果已写入: ${outFile}`);

  } catch (err) {
    log('❌ 错误:', err.message);
    await page.screenshot({ path: resolve(config.screenshotDir, 'probe-99-error.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

import { readFileSync, unlinkSync } from 'node:fs';
main().catch(e => { console.error('[probe] Fatal:', e); process.exit(1); });
