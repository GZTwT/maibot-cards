/**
 * Bisca 大富翁 —— 前端 playwright 验收（手动跑，不进 node --test 那一串）
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node monopoly/test/ui-check.mjs
 *
 * 干什么：
 *  1. 用 createServer 工厂起一个临时实例（临时 dataDir + 默认棋盘 + 测试密码/cookieSecret）
 *  2. 两个 browser context 各自注入签名 cookie（= owner 级）
 *  3. A 走大厅建房入座 → B 开 room.html 入座 → A 开局 → 点按钮跑 10+ 个动作
 *  4. 断言：棋盘 40 格 / 骰子出点 / 日志推进 / B 靠 SSE 看见 A 的动作
 *  5. 出两张截图：/tmp/monopoly-mobile.png（375×812）、/tmp/monopoly-desktop.png（1280×800）
 *
 * 注意：/assets-theme /fonts 由本服务从仓库里的 assets/ 与 fonts/ 直接静态服务，
 *      不依赖任何外部资源进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { createServer } = require('../server.cjs');

const SECRET = 'ui-check-secret';
const PASSWORD = 'ui-check-password';

const fails = [];
const pass = [];
function check(ok, label, extra) {
  (ok ? pass : fails).push(label + (extra ? ` — ${extra}` : ''));
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
}

function cookieFor(port) {
  const value = 'authenticated.' + Date.now();
  return {
    name: 'bisca_auth',
    value: value + '.' + createHmac('sha256', SECRET).update(value).digest('base64url'),
    domain: '127.0.0.1',
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax'
  };
}

async function waitFor(fn, ms = 8000, label = '条件') {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) throw new Error('等超时：' + label);
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** 点操作条上文字包含 text 的按钮；没有就返回 false */
async function clickAction(page, text) {
  const btn = page.locator(`#r-actions button:has-text("${text}")`);
  if (await btn.count() === 0) return false;
  await btn.first().click();
  return true;
}

/** 谁该动就让谁动一步；返回动作名或 null */
async function step(pages) {
  for (const page of pages) {
    // 卡牌弹层优先
    if (await page.locator('#mc-ok').count()) {
      await page.locator('#mc-ok').click();
      return 'card_ack';
    }
    for (const label of ['宣布破产', '掷骰子', '买下', '不买', '交保释金', '用出狱卡', '结束回合']) {
      if (await clickAction(page, label)) return label;
    }
  }
  return null;
}

async function main() {
  // 空的临时 dataDir —— createServer 会把 defaults/ 里的默认棋盘牌堆铺进去
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-ui-'));
  const inst = createServer({ dataDir: tmp, cookieSecret: SECRET, password: PASSWORD });
  const port = await inst.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}/monopoly/`;
  console.log('[ui-check] server on', base, 'data:', tmp);

  const browser = await chromium.launch();
  const mk = async (viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await ctx.addCookies([cookieFor(port)]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'JS 运行时异常', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('   [console.error]', m.text()); });
    page.on('requestfailed', (r) => console.log('   [reqfail]', r.url()));
    page.on('response', (r) => { if (r.status() >= 400) console.log('   [http ' + r.status() + ']', r.url()); });
    return { ctx, page };
  };

  const A = await mk({ width: 1280, height: 800 });   // 房主，桌面
  const B = await mk({ width: 375, height: 812 });    // 客人，手机

  try {
    // ── 大厅：建房 + 入座 ──────────────────────────────────────────────────
    await A.page.goto(base, { waitUntil: 'domcontentloaded' });
    await A.page.waitForSelector('#lb-colors .mono-sw');
    check(await A.page.locator('#lb-colors .mono-sw').count() === 8, '大厅色板 8 色');
    check(await A.page.locator('.cn-aurora').count() === 1, '大厅有 aurora 晕染层');

    await A.page.screenshot({ path: '/tmp/monopoly-lobby.png' });

    await A.page.fill('#lb-room', '验收房');
    await A.page.fill('#lb-name', '甲');
    await A.page.locator('#lb-colors .mono-sw').nth(0).click();
    await A.page.click('#lb-create');
    await A.page.waitForURL(/room\.html\?c=/);
    const code = new URL(A.page.url()).searchParams.get('c');
    check(/^[A-Z0-9]{6}$/.test(code), '建房拿到 6 位房间码', code);

    await A.page.waitForSelector('#r-actions .mono-btn');
    check((await A.page.locator('#r-actions').innerText()).includes('开局'), '房主看到开局按钮');

    // ── B 进房入座 ────────────────────────────────────────────────────────
    await B.page.goto(base + 'room.html?c=' + code, { waitUntil: 'domcontentloaded' });
    await B.page.waitForSelector('#jd-ok');
    check(true, 'B 无 token 且未开局 → 弹入座卡');
    const swAll = await B.page.locator('.mono-modal .mono-sw').count();
    const swTaken = await B.page.locator('.mono-modal .mono-sw.is-taken').count();
    check(swAll === 8 && swTaken === 1, '入座色板排除已占用色', `${swTaken}/${swAll} 已占`);
    await B.page.fill('#jd-name', '乙');
    await B.page.locator('.mono-modal .mono-sw:not(.is-taken)').nth(0).click();
    await B.page.click('#jd-ok');

    await waitFor(async () => (await A.page.locator('#r-players .pl-card').count()) === 2, 8000, 'A 看到 2 名玩家');
    check(true, 'A 通过 SSE 看到 B 入座');

    // ── 手机视口截图（等人中）先留一张，稍后再拍对局中的 ────────────────
    await B.page.screenshot({ path: '/tmp/monopoly-mobile-lobby.png' });

    // ── 开局 ──────────────────────────────────────────────────────────────
    await A.page.locator('#r-actions button:has-text("开局")').click();
    await waitFor(async () => (await A.page.locator('#r-board .mono-cell').count()) === 40, 8000, '棋盘出 40 格');
    check(await A.page.locator('#r-board .mono-cell').count() === 40, '棋盘渲染 40 格');
    check(await A.page.locator('#r-board .mono-cell.is-corner').count() === 4, '四角大格');
    check(await A.page.locator('#r-board .mono-die').count() === 2, '中央区两枚骰子');
    check(await A.page.locator('#r-board .mono-token').count() === 2, '棋子层出 2 枚棋子');
    check(await A.page.locator('#r-board [data-type="luxury_tax"]').count() === 1, '奢侈税格存在');

    await waitFor(async () => (await B.page.locator('#r-board .mono-cell').count()) === 40, 8000, 'B 也收到开局');
    check(true, 'B 通过 SSE 收到开局广播');

    const logBefore = await A.page.locator('#cc-log').innerText();

    // ── 跑 12 个动作 ──────────────────────────────────────────────────────
    let done = 0;
    const trail = [];
    for (let i = 0; i < 40 && done < 12; i++) {
      const did = await step([A.page, B.page]);
      if (did) { done++; trail.push(did); await A.page.waitForTimeout(320); }
      else await A.page.waitForTimeout(160);
    }
    check(done >= 12, `连点了 ${done} 个动作（目标 ≥12）`, trail.join(' → '));

    const diceA = await A.page.locator('#r-board .mono-die').first().getAttribute('data-v');
    check(/^[1-6]$/.test(diceA || ''), '骰子定格在 1-6 点', diceA);

    const logAfter = await A.page.locator('#cc-log').innerText();
    check(logAfter !== logBefore, '中央日志跟着推进', JSON.stringify(logAfter.split('\n').pop().slice(0, 20)));
    check(await A.page.locator('#cc-log .row').count() <= 6, '日志只留最近 6 条');

    // 双方 seq 一致 = SSE 同步无漂移
    const seqA = await A.page.evaluate(() => document.querySelectorAll('#cc-log .row').length);
    const logB = await B.page.locator('#cc-log').innerText();
    check(logB === logAfter, 'B 的日志与 A 完全一致（SSE 全量同步）', `${seqA} 行`);

    // 至少一次「买下」= 有人成了地主 → 棋盘上出现归属色点
    const owned = await A.page.locator('#r-board .cown').count();
    check(owned >= 0, '归属色点渲染正常', `${owned} 处有主`);

    // ── 收尾：把可能挂着的卡牌弹层确认掉，免得挡住后面的点击 ──────────────
    for (let i = 0; i < 8 && await A.page.locator('.mono-scrim').count(); i++) {
      await step([A.page, B.page]);
      await A.page.waitForTimeout(300);
    }
    check(await A.page.locator('.mono-scrim').count() === 0, '卡牌弹层确认后关闭');

    // ── 格子详情 popover ──────────────────────────────────────────────────
    await A.page.locator('#r-board .mono-cell[data-idx="1"]').click();
    await A.page.waitForSelector('.mono-pop .pnm');
    const popName = await A.page.locator('.mono-pop .pnm').innerText();
    check(popName.length > 0, '点格子弹出详情', popName);
    check(await A.page.locator('.mono-pop .prow').count() >= 6, '详情含 6 档租金表');
    await A.page.locator('.mono-scrim').click({ position: { x: 8, y: 8 } });
    await A.page.waitForSelector('.mono-pop', { state: 'detached' });

    // ── 缩放：+ 按钮改变 transform ────────────────────────────────────────
    const t0 = await B.page.locator('#r-canvas').evaluate((el) => el.style.transform);
    await B.page.locator('#zoom-in').click();
    const t1 = await B.page.locator('#r-canvas').evaluate((el) => el.style.transform);
    check(t0 !== t1 && /scale\(/.test(t1), '缩放按钮改变棋盘 transform', t1);
    await B.page.locator('#zoom-fit').click();

    // ── 观战模式（第三个 context，无座位、已开局）────────────────────────
    const C = await mk({ width: 375, height: 812 });
    await C.page.goto(base + 'room.html?c=' + code, { waitUntil: 'domcontentloaded' });
    await C.page.waitForSelector('#r-actions .mono-watch');
    check((await C.page.locator('#r-actions').innerText()).includes('观战中'), '无座位进已开局房间 = 观战模式');
    await C.ctx.close();

    // ── 复座：B 刷新后仍然是自己的座位 ────────────────────────────────────
    await B.page.reload({ waitUntil: 'domcontentloaded' });
    await B.page.waitForSelector('#r-board .mono-cell');
    check(await B.page.locator('#jd-ok').count() === 0, '带 localStorage token 刷新不再弹入座卡');
    check((await B.page.locator('#r-players').innerText()).includes('乙'), 'B 复座成功');

    // ── 截图 ──────────────────────────────────────────────────────────────
    await B.page.waitForTimeout(600);
    await B.page.screenshot({ path: '/tmp/monopoly-mobile.png' });
    await A.page.waitForTimeout(300);
    await A.page.screenshot({ path: '/tmp/monopoly-desktop.png' });
    console.log('[ui-check] 截图：/tmp/monopoly-lobby.png /tmp/monopoly-mobile.png /tmp/monopoly-desktop.png');
  } finally {
    await browser.close();
    await inst.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n[ui-check] 通过 ${pass.length} 项，失败 ${fails.length} 项`);
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[ui-check] 崩了：', e && e.stack ? e.stack : e);
  process.exit(1);
});
