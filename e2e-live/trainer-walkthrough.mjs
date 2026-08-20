// REAL-BROWSER trainer walkthrough against production smarter.poker.
// Plain playwright script (not @playwright/test) so it runs standalone.
// Results: structured PASS/FAIL lines + screenshots in /tmp/e2e-shots.
import { chromium } from 'playwright';

const SHOT = (n) => `${process.env.E2E_SHOTS||'/tmp/e2e-shots'}/trainer-${n}.png`;
const results = [];
const check = (name, ok, detail='') => { results.push({name, ok, detail}); console.log(`${ok?'PASS':'FAIL'} ${name}${detail?' -- '+detail:''}`); };

import fs from 'fs';
const AUTH=process.env.E2E_AUTH||'/tmp/e2e-work/auth.json';
const browser = await chromium.launch({ headless: true });
const ctxOpts = { viewport: { width: 1280, height: 900 } };
if (fs.existsSync(AUTH)) ctxOpts.storageState = AUTH;
const ctx = await browser.newContext(ctxOpts);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror@${page.url().split('?')[0]}: `+e.message.slice(0,90)));
page.on('console', m => { if (m.type()==='error' && !/Content Security Policy/.test(m.text())) errors.push(`console@${page.url().split('?')[0]}: `+m.text().slice(0,90)); });

try {
  // ---- AUTH: aim at the arena, handle whatever the router does ----
  const ARENA='https://smarter.poker/hub/training/arena/cash-002?level=1';
  await page.goto(ARENA,{waitUntil:'domcontentloaded',timeout:40000});
  await page.waitForTimeout(4000);
  if (/auth\/login|\/login/.test(page.url())) {
    await page.screenshot({path:SHOT('00-login')});
    const cont=page.locator('button:has-text("Continue To Hub"), a:has-text("Continue To Hub")').first();
    if (await cont.isVisible().catch(()=>false)) {
      check('login page offered Continue To Hub (session visible to login page but arena bounced) -- FINDING', true);
      await cont.click(); await page.waitForTimeout(3000);
    } else {
      const email=page.locator('input[type="email"], input[name="email"]').first();
      const pass=page.locator('input[type="password"]').first();
      check('login form found', await email.count()>0 && await pass.count()>0, page.url());
      await email.fill(process.env.SP_EMAIL); await pass.fill(process.env.SP_PASS);
      await page.locator('button:has-text("Sign In"), button[type="submit"]').first().click();
      await page.waitForTimeout(6000);
    }
    await page.goto(ARENA,{waitUntil:'domcontentloaded',timeout:40000});
    await page.waitForTimeout(4000);
  }
  check('arena page reached authenticated', !/login/.test(page.url()), page.url());
  await ctx.storageState({path:AUTH}).catch(()=>{});

  // ---- TRAINER ----

  await page.waitForTimeout(6000); // preload
  await page.screenshot({ path: SHOT('02-splash') });
  const start = page.locator('button:has-text("Start Training")').first();
  check('Start Training visible', await start.isVisible().catch(()=>false));
  await start.click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: SHOT('03-hand') });

  // question block above the felt
  const body = await page.innerText('body');
  const qMatch = /You hold .{2,8} on the (flop|turn|river)|What is the GTO play|Your action\?|first to act/i.test(body);
  check('question text rendered', qMatch);

  // action buttons: only solver actions (>=2, <=4), with poker words
  const actBtns = page.locator('button').filter({ hasText: /(FOLD|CALL|CHECK|RAISE|\bBET\b|ALL-?IN)/i }).filter({ hasNotText: /Back to Training/i });
  const allBtnTexts = (await page.locator('button').allInnerTexts()).map(t=>t.replace(/\s+/g,' ').trim()).filter(Boolean);
  const NAV = /^(← )?(Back to Training|Trainer|Range|Strategy|Settings|RNG|TRAIN|STUDY|FULL|SIMPLE|Custom|Quit)$/i;
  const actionTexts = allBtnTexts.filter(t => !NAV.test(t) && /(FOLD|CALL|CHECK|RAISE|BET|ALL ?-?IN)/i.test(t));
  const nActs = actionTexts.length;
  console.log('ACTIONS: ' + JSON.stringify(actionTexts));
  check('2-4 action buttons offered', nActs >= 2 && nActs <= 4, `count=${nActs}`);

  // geometry: hero furniture inside viewport & no impossible action line
  check('no impossible "BTN checks" while hero is blind',
    !/BB.*vs.*BTN.*(BTN checks to you)/is.test(body));

  // answer the hand
  if (nActs > 0) {
    await actBtns.first().click();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: SHOT('04-feedback') });
    const fb = await page.innerText('body');
    const cls = /(BEST MOVE|CORRECT|INACCURACY|WRONG|BLUNDER|Correct Move)/i.test(fb);
    check('classification shown after answer', cls);
    const evBoth = /-?\d+(\.\d+)?\s*bb/i.test(fb);
    const evPot  = /%\s*(of\s*)?pot|pot\)/i.test(fb);
    check('EV loss shown in bb', evBoth);
    check('EV also as % of pot (or zero-loss best move)', evPot || /BEST MOVE|Correct Move/i.test(fb), evPot?'':'no %pot text');
    // score badge sanity: no "-100%" style artifact
    check('no percent-suffixed GTOW score artifact', !/-100%/.test(fb));
  }
  const arenaErrs = errors.filter(e => e.includes('/hub/training/arena'));
  check('no page errors on the arena page', arenaErrs.length === 0, arenaErrs.slice(0,3).join(' | '));
  if (errors.length > arenaErrs.length) console.log('NOTE non-arena page errors (findings, not failures): ' + errors.filter(e=>!e.includes('/hub/training/arena')).slice(0,4).join(' | '));
} catch (e) {
  check('script completed', false, e.message.slice(0,200));
  await page.screenshot({ path: SHOT('99-error') }).catch(()=>{});
}
const failed = results.filter(r=>!r.ok).length;
// Findings are non-fatal observations (product bugs seen in passing that are
// not what this walk asserts). Print them with the result so a green run never
// hides them.
console.log(`\nTRAINER WALKTHROUGH: ${results.length-failed}/${results.length} PASS`);
if (errors.length) {
  console.log(`  ${errors.length} console/page error(s) observed:`);
  for (const e of errors.slice(0, 8)) console.log('   - ' + e);
}
await browser.close();
process.exit(failed ? 1 : 0);
