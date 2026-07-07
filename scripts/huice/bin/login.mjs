#!/usr/bin/env node
/**
 * login.mjs — 汇策 ERP 无头登录验证脚本
 *
 * 流程:
 *   1. 读 private/huice.env 取凭证
 *   2. 无头启动 Playwright (复用 private/huice-profile cookies)
 *   3. 导航到目标 URL (会自动跳登录页)
 *   4. 自动填表单 (卖家账号/账户名/密码) + 勾选同意 + 点登录
 *   5. 等待跳转成功 (URL 不含 login, 标题不含「登录」)
 *   6. 截图到 output/huice-explore/screenshots/login-verify.png
 *   7. 导出 storageState → private/huice-state.json (解决 session cookie 不持久化的坑)
 *
 * 用法: node scripts/huice/bin/login.mjs
 *       node scripts/huice/bin/login.mjs --headed   (有头调试)
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateCredentials } from '../lib/config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = (...a) => console.log('[huice-login]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // ── 1. 加载配置 ──
  const config = loadConfig();
  const v = validateCredentials(config);
  if (!v.ok) {
    log(`❌ 凭证缺失: ${v.missing.join(', ')}`);
    log(`   请检查 private/huice.env 文件`);
    process.exit(1);
  }

  // 命令行参数
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');

  log(`🚀 汇策登录验证 (headless=${!headed})`);
  log(`   sellerId: ${config.sellerId}`);
  log(`   target:   ${config.targetUrl}`);
  log(`   profile:  ${config.profileDir}`);

  // ── 2. 清理孤儿锁 (进程已死但锁残留) ──
  const lockFile = resolve(config.profileDir, 'SingletonLock');
  if (existsSync(lockFile)) {
    log(`⚠ 发现 SingletonLock,尝试清理...`);
    try {
      // 检查锁指向的进程是否还活着
      const lockContent = readFileSync(lockFile, 'utf8').trim();
      const pidMatch = lockContent.match(/(\d+)$/);
      if (pidMatch) {
        const pid = parseInt(pidMatch[1], 10);
        try {
          process.kill(pid, 0); // 不发信号,只检查进程是否存在
          log(`❌ 锁指向的进程 ${pid} 仍存活,请先关闭占用 huice-profile 的 Chrome`);
          process.exit(1);
        } catch {
          log(`   进程 ${pid} 已死,安全清理孤儿锁`);
          unlinkSync(lockFile);
        }
      }
    } catch (e) {
      log(`   清理锁时出错: ${e.message} (继续尝试)`);
    }
  }

  // 确保输出目录存在
  for (const d of [config.screenshotDir, config.profileDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  // ── 3. 启动浏览器 (无头 + 持久化 profile) ──
  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.chromePath,
    headless: !headed,
    viewport: { width: 1600, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=TranslateUI',
    ],
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    // ── 4. 导航到目标 URL ──
    log(`\n🌐 导航到 ${config.targetUrl}`);
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    log(`   当前 URL: ${page.url()}`);
    log(`   页面标题: ${await page.title()}`);

    // 截图登录前状态
    await page.screenshot({ path: resolve(config.screenshotDir, '01-before-login.png') });

    // ── 5. 判断是否已登录 (cookies 有效) ──
    const currentUrl = page.url();
    const title = await page.title();
    const onLoginPage =
      currentUrl.includes('login') ||
      currentUrl.includes('signin') ||
      title.includes('登录') ||
      title.includes('Login') ||
      (await page.locator('input[type="password"]').isVisible({ timeout: 2000 }).catch(() => false));

    if (!onLoginPage) {
      log(`\n✅ 已登录 (cookies 有效),跳过登录步骤`);
      await page.screenshot({ path: resolve(config.screenshotDir, 'login-verify.png'), fullPage: true });

      // 采集登录确认信息
      const info = await page.evaluate(() => {
        const userInfo = document.body.innerText.match(/admin[\-\s]*\w+/)?.[0] || '';
        return {
          url: location.href,
          title: document.title,
          userInfo,
          bodyHead: document.body.innerText.slice(0, 300),
        };
      });
      log(`   用户信息: ${info.userInfo}`);
      log(`   body 头部: ${info.bodyHead.slice(0, 100)}`);

      // 导出 storageState
      await exportStorageState(context, config);
      log(`\n📸 截图已保存: ${resolve(config.screenshotDir, 'login-verify.png')}`);
      log(`✅ 验证完成 (免登录)`);
      return;
    }

    log(`\n🔑 需要登录,开始自动填表单...`);

    // ── 6. 自动登录 ──
    // 卖家账号
    await page.locator('input[placeholder*="卖家账号"]').first().fill(config.sellerId);
    log(`   ✓ 卖家账号: ${config.sellerId}`);

    // 账户名
    await page.locator('input[placeholder*="账号名"]').first().fill(config.username);
    log(`   ✓ 账户名: ${config.username}`);

    // 密码
    await page.locator('input[type="password"]').first().fill(config.password);
    log(`   ✓ 密码: ******`);

    await sleep(500);

    // 勾选「我已阅读并同意」(Element UI checkbox — 点击 label)
    const isChecked = await page.evaluate(() =>
      !!document.querySelector('.el-checkbox.is-checked, .el-checkbox__input.is-checked'),
    );
    if (!isChecked) {
      await page.locator('.el-checkbox').first().click();
      log(`   ✓ 勾选同意`);
    } else {
      log(`   ✓ 已默认勾选`);
    }

    await sleep(500);
    await page.screenshot({ path: resolve(config.screenshotDir, '02-form-filled.png') });

    // ── 7. 点击登录 ──
    log(`\n👉 点击登录按钮...`);
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      page.locator('button:has-text("登录"), button.login-submit-account').first().click(),
    ]);
    await sleep(5000);

    const postUrl = page.url();
    const postTitle = await page.title();
    log(`   登录后 URL: ${postUrl}`);
    log(`   登录后标题: ${postTitle}`);

    // ── 8. 检查登录结果 ──
    const stillOnLogin =
      postUrl.includes('login') || postTitle.includes('登录') || postTitle.includes('Login');

    // 检查错误提示 / 验证码
    const postState = await page.evaluate(() => {
      const errors = Array.from(
        document.querySelectorAll('.el-message, .el-message__content, .el-form-item__error, .el-notification'),
      )
        .map(e => e.textContent.trim())
        .filter(Boolean);
      const hasCaptcha = !!document.querySelector(
        '.captcha, [class*="captcha"], [class*="Captcha"], img[src*="captcha"], [class*="slider"], [class*="verify"]',
      );
      const userInfo = document.body.innerText.match(/admin[\-\s]*\w+/)?.[0] || '';
      return { errors, hasCaptcha, userInfo, bodyHead: document.body.innerText.slice(0, 400) };
    });

    if (postState.hasCaptcha) {
      log(`\n⚠ 检测到验证码!无头模式无法自动通过`);
      await page.screenshot({ path: resolve(config.screenshotDir, '03-captcha-detected.png') });
      log(`   建议: 用 --headed 参数手动通过验证码:`);
      log(`     node scripts/huice/bin/login.mjs --headed`);
      logCapture(postState, postUrl);
      return;
    }

    if (stillOnLogin) {
      log(`\n❌ 登录失败 (仍在登录页)`);
      if (postState.errors.length > 0) {
        log(`   错误提示: ${postState.errors.join(' | ')}`);
      }
      await page.screenshot({ path: resolve(config.screenshotDir, '03-login-failed.png') });
      return;
    }

    // ── 9. 登录成功 ──
    log(`\n✅ 登录成功!`);
    log(`   用户: ${postState.userInfo || '(未识别)'}`);

    // 关闭可能存在的弹窗
    await closePopups(page);
    await sleep(1500);

    // 完整截图
    await page.screenshot({ path: resolve(config.screenshotDir, 'login-verify.png'), fullPage: true });
    logCapture(postState, postUrl);

    // ── 10. 导出 storageState ──
    await exportStorageState(context, config);

    log(`\n📸 验证截图: ${resolve(config.screenshotDir, 'login-verify.png')}`);
    log(`✅ 登录验证完成`);
  } catch (err) {
    log(`\n❌ 错误: ${err.message}`);
    await page.screenshot({ path: resolve(config.screenshotDir, '99-error.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

/** 关闭首页常见弹窗 */
async function closePopups(page) {
  await page.evaluate(() => {
    // 300S 后关闭 / 确定 / 关闭 这类弹窗按钮
    ['300S后关闭', '确定', '关闭', '取 消', '取消', '知道了'].forEach(text => {
      document.querySelectorAll('button, .el-button, div, span').forEach(el => {
        if (el.textContent.trim() === text && el.offsetParent !== null) {
          // 只点弹窗里的,不点表单里的
          if (el.closest('.el-dialog, .el-overlay, .el-message-box, [class*="modal"], [class*="popup"]')) {
            el.click();
          }
        }
      });
    });
  });
}

/** 导出 storageState (cookies + localStorage) */
async function exportStorageState(context, config) {
  try {
    await context.storageState({ path: config.stateFile });
    log(`💾 storageState 已导出: ${config.stateFile}`);
  } catch (e) {
    log(`⚠ storageState 导出失败: ${e.message}`);
  }
}

/** 打印登录后捕获的信息 */
function logCapture(state, url) {
  console.log('');
  console.log('━━━ 登录后状态 ━━━');
  console.log(`  URL:      ${url}`);
  console.log(`  用户:     ${state.userInfo || '(未识别)'}`);
  if (state.errors.length > 0) {
    console.log(`  ⚠ 提示: ${state.errors.join(' | ')}`);
  }
  console.log(`  body 头部: ${state.bodyHead.slice(0, 150)}`);
}

main().catch(e => {
  console.error('[huice-login] Fatal:', e);
  process.exit(1);
});
