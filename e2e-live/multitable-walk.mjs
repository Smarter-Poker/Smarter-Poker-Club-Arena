// REAL-BROWSER multi-table walk against production club-arena.
// Verifies: join cash table -> + button -> embedded lobby with table alive ->
// second table -> off-table route keeps both mounted (persistent layer + dock).
// Supabase rotates refresh tokens: storageState is re-saved at end of EVERY run,
// and an empty/anonymous arena triggers a fresh credential login.
import { chromium } from 'playwright';
import fs from 'fs';
import { leaveAllSeats } from './lib/leave-all.mjs';
const AUTH=process.env.E2E_AUTH||'/tmp/e2e-work/auth.json';
const S=(n)=>`${process.env.E2E_SHOTS||'/tmp/e2e-shots'}/mt-${n}.png`;
const R=[]; const check=(n,ok,d='')=>{R.push({n,ok});console.log(`${ok?'PASS':'FAIL'} ${n}${d?' -- '+d:''}`)};
/**
 * A skipped step is NOT a passing step. The summary used to print only
 * "13/13 PASS" while a skip had quietly removed a core assertion from the run —
 * a test that can pass without testing, which is the exact failure shape this
 * suite exists to catch in the product. Skips are now counted, listed, and by
 * default make the run non-zero. Set E2E_ALLOW_SKIPS=1 when a skip really is
 * environmental (e.g. only one table exists in the lobby right now).
 */
const SKIPS=[];
const skip=(n,d)=>{SKIPS.push({n,d});console.log(`SKIP ${n} -- ${d}`)};

const browser=await chromium.launch({headless:true});
const opts={viewport:{width:1280,height:900}};
if (fs.existsSync(AUTH)) opts.storageState=AUTH;
const ctx=await browser.newContext(opts);
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(page.url().split('?')[0]+': '+e.message.slice(0,80)));

async function freshLogin(){
  await page.goto('https://smarter.poker/auth/login',{waitUntil:'domcontentloaded',timeout:40000});
  await page.waitForTimeout(2000);
  const cont=page.locator('button:has-text("Continue To Hub")').first();
  if(await cont.isVisible().catch(()=>false)){ await cont.click({timeout:10000}).catch(()=>{}); }
  else {
    await page.locator('input[type="email"]').first().fill(process.env.SP_EMAIL);
    await page.locator('input[type="password"]').first().fill(process.env.SP_PASS);
    await page.locator('button:has-text("Sign In"), button[type="submit"]').first().click({timeout:15000});
  }
  await page.waitForTimeout(6000);
}
async function acceptTermsIfShown(){
  const t=page.locator('text=I understand and agree to these terms').first();
  if(await t.isVisible().catch(()=>false)){
    console.log('NOTE: terms modal visible -- acknowledging on owner test account');
    await page.locator('input[type="checkbox"]').first().check().catch(async()=>{await t.click({timeout:8000}).catch(()=>{});});
    await page.locator('button:has-text("Enter Club Arena")').first().click({timeout:10000}).catch(()=>{});
    await page.waitForTimeout(5000);
    return true;
  }
  return false;
}
async function gotoArena(){
  await page.goto('https://smarter.poker/hub/club-arena/',{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForTimeout(9000);
  // the hamburger nav drawer sometimes restores open and covers the club
  // list -- dismiss it (Close control, then Escape as belt-and-braces)
  const b=await page.innerText('body').catch(()=>'');
  if(/GAME MODES/i.test(b) && /View Profile/i.test(b)){
    console.log('NOTE: nav drawer open on arrival -- closing');
    const close=page.locator('button:has-text("Close"), [aria-label*="close" i]').first();
    if(await close.isVisible().catch(()=>false)) await close.click({timeout:8000}).catch(()=>{});
    await page.keyboard.press('Escape').catch(()=>{});
    await page.waitForTimeout(2000);
  }
}
try{
  await gotoArena();
  let body=await page.innerText('body');
  if(/JOIN A CLUB/i.test(body) && !/CLUB JAQK/i.test(body)){ console.log('stale session -> fresh login'); await freshLogin(); await gotoArena(); body=await page.innerText('body'); }
  if(await acceptTermsIfShown()) body=await page.innerText('body');
  check('arena loads with club memberships', /CLUB JAQK|SHARK CLUB/i.test(body));
  await page.screenshot({path:S('00-clubs')});

  // enter club
  await page.locator('text=CLUB JAQK').first().click({timeout:15000});
  // wait for the table list to actually load (spinner can take a while); re-check terms each poll
  let links=[];
  for (let i=0;i<15;i++){
    await page.waitForTimeout(4000);
    await acceptTermsIfShown();
    links=await page.locator('a').evaluateAll(els=>els.map(e=>({h:e.getAttribute('href'),t:(e.innerText||'').replace(/\s+/g,' ').slice(0,60)})).filter(x=>x.h&&x.h.includes('/table/')));
    if(links.length) break;
    // some builds render tables behind a Cash/Games tab -- poke it if present
    const tab=page.locator('button:has-text("Cash"), [role="tab"]:has-text("Cash"), button:has-text("Games")').first();
    if(await tab.isVisible().catch(()=>false)) await tab.click({timeout:8000}).catch(()=>{});
    // stalled-fetch hang (ClubHomePage watchdog finding): after ~32s of
    // skeleton, do what a real user does -- reload once, keep polling.
    if(i===7){ console.log('NOTE: club home still loading after 32s -- reloading once (stalled-fetch finding)'); await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{}); await acceptTermsIfShown(); }
    // if the Retry panel surfaced (watchdog fix), press it
    const retry=page.locator('button:has-text("Retry")').first();
    if(await retry.isVisible().catch(()=>false)) await retry.click({timeout:8000}).catch(()=>{});
  }
  await page.screenshot({path:S('01-club-home')});
  console.log('TABLE LINKS: '+JSON.stringify(links.slice(0,6)));
  check('club home shows cash-table links', links.length>0, `n=${links.length}`);
  if(!links.length){ throw new Error('no joinable table links visible -- stopping walk'); }

  // join table 1: pick the LOWEST-stakes table with an open seat, navigate directly
  const parse=(l)=>{const m=l.t.match(/BLINDS ([\d.]+) \/ ([\d.]+) (\d+)\/(\d+)/); return m?{...l,bb:+m[2],seated:+m[3],cap:+m[4]}:null;};
  const cands=links.map(parse).filter(Boolean).filter(x=>x.seated<x.cap).sort((a,b)=>a.bb-b.bb);
  console.log('CHEAPEST OPEN: '+JSON.stringify(cands[0]));

  /**
   * 40 horses are playing these tables continuously, so a seat counted as open
   * when the lobby was listed is often gone by the time we arrive. Walk the
   * candidates cheapest-first until one actually lets us sit, instead of
   * failing the whole run on a race we can simply retry.
   */
  // Seats render a beat after the felt does; an instant check reported every
  // candidate as full and walked the whole queue for nothing.
  async function openSeatHere(){
    return await page.locator('[aria-label*="open - click to sit"]').first()
      .waitFor({state:'visible',timeout:8000}).then(()=>true).catch(()=>false);
  }
  const queue=(cands.length?cands:[links[0]]).slice(0,4);
  let t1=queue[0];
  for (const cand of queue){
    await page.goto('https://smarter.poker'+cand.h,{waitUntil:'domcontentloaded',timeout:40000});
    await page.waitForTimeout(10000);
    t1=cand;
    if (await openSeatHere()) break;
    console.log(`NOTE: ${cand.h.split('/table/')[1]} filled up before we arrived -- next candidate`);
  }
  console.log('T1 BUTTONS: '+JSON.stringify((await page.locator('button').allInnerTexts()).map(t=>t.replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,25)));
  await page.screenshot({path:S('02-table1')});
  body=await page.innerText('body');
  // buy-in modal?
  const buyBtn=page.locator('button:has-text("Buy In"), button:has-text("BUY IN"), button:has-text("Sit")').first();
  if(await buyBtn.isVisible().catch(()=>false)){
    await buyBtn.click({timeout:10000}).catch(()=>{}); await page.waitForTimeout(6000);
    await page.screenshot({path:S('03-after-buyin')});
    body=await page.innerText('body');
  }
  const seated1=/POT|Fold|Check|Call|Waiting|Hand #|Spectating/i.test(body);
  check('table 1 renders (seated or observing)', seated1);

  // ---- SEAT AT TABLE 1 (exact production selectors from source) ----
  body=await page.innerText('body');
  if (/Spectating, Tap An Open Seat/i.test(body)) {
    const seat=page.locator('[aria-label*="open - click to sit"]').first();
    const sat=await seat.click({timeout:15000}).then(()=>true).catch(()=>false);
    if(!sat) console.log('NOTE: no open seat clickable at ' + t1.h.split('/table/')[1]);
    await page.waitForTimeout(2500);
    await page.screenshot({path:S('02b-buyin')});
    const conf=page.locator('button.buy-in-modal__confirm').first();
    if (await conf.isVisible().catch(()=>false)) {
      console.log('BUYIN BTN: '+await conf.innerText());
      await conf.click({timeout:10000}).catch(()=>{});
      /**
       * atomic_table_buyin returns 204 well before the felt repaints — a flat
       * 6s wait asserted "not seated" on a seat the server had already sold us,
       * and then the teardown skipped a table we were really sitting at. Poll
       * for the spectator footer to clear instead of guessing a duration.
       */
      for (let w=0; w<12; w++) {
        await page.waitForTimeout(2000);
        if (!/Spectating, Tap An Open Seat/i.test(await page.innerText('body'))) break;
      }
    }
    body=await page.innerText('body');
  }
  await page.screenshot({path:S('02c-seated')});
  const seatedNow=!/Spectating, Tap An Open Seat/i.test(body);
  check('hero seated at table 1 (buy-in accepted)', seatedNow, body.match(/Seat Reserved[^\n]*|Spectating[^\n]*/i)?.[0]||'');

  // ---- + ADD TABLE (HUD upper-left, aria-label="Open another table") ----
  // Two entry points open the lobby tab: the in-table HUD control, and the
  // tab bar's empty-slot buttons (which only exist once a second table is
  // mounted). Both now carry the same accessible name; accept either.
  const plus=page.locator('button[aria-label="Open another table"], button.add-chips-icon-btn, button.table-tab-bar__add').first();
  const plusVisible=await plus.waitFor({state:'visible',timeout:20000}).then(()=>true).catch(()=>false);
  check('+ add-table button visible (upper-left HUD)', plusVisible);
  if(plusVisible){
    await plus.click({timeout:10000});
    // embedded ClubHomePage does its own fetches -- poll up to 40s (the
    // 2026-08-20 API degradation showed these can crawl), pressing the
    // watchdog Retry panel if it appears.
    let lobbyReady=false;
    for(let i=0;i<10;i++){
      await page.waitForTimeout(4000);
      body=await page.innerText('body');
      if(await page.locator('.multi-table-page__lobby-tab a[href*="/table/"]').count()>0){ lobbyReady=true; break; }
      const rtry=page.locator('.multi-table-page__lobby-tab button:has-text("Retry")').first();
      if(await rtry.isVisible().catch(()=>false)) await rtry.click({timeout:8000}).catch(()=>{});
    }
    await page.screenshot({path:S('04-embedded-lobby')});
    check('embedded lobby tab opened (club content, table 1 still mounted)', lobbyReady || /CLUB JAQK|Cash|Tournaments|Games/i.test(body));
    // tab bar must now exist (tables.length>1 renders TableTabBar)
    check('tab bar with first table + lobby tab present', await page.locator('.table-tab-bar__add, [class*="table-tab-bar"]').count()>0);

    // ---- JOIN TABLE 2 from the embedded lobby ----
    // the lobby list live-updates (realtime seat counts), which fails
    // Playwright's stability check on a plain click -- re-resolve fresh each
    // attempt and fall back to a DOM-level click.
    let t2h=null, t2clicked=false;
    for(let a=0;a<3 && !t2clicked;a++){
      const l2s=await page.locator('.multi-table-page__lobby-tab a[href*="/table/"]').evaluateAll(els=>els.map(e=>e.getAttribute('href')));
      t2h=l2s.find(h=>h && !h.includes(t1.h.split('/table/')[1]));
      if(!t2h) break;
      const l2=page.locator(`.multi-table-page__lobby-tab a[href="${t2h}"]`).first();
      t2clicked=await l2.click({timeout:6000}).then(()=>true).catch(()=>false);
      if(!t2clicked) t2clicked=await l2.evaluate(el=>{el.click();return true;}).catch(()=>false);
    }
    console.log('TABLE2 HREF: '+t2h+' clicked='+t2clicked);
    if(t2h && t2clicked){
      await page.waitForTimeout(9000);
      await page.screenshot({path:S('05-table2')});
      body=await page.innerText('body');
      // sit at table 2 too if spectating
      if (/Spectating, Tap An Open Seat/i.test(body)) {
        const seat2=page.locator('[aria-label*="open - click to sit"]').first();
        if (await seat2.isVisible().catch(()=>false)) {
          await seat2.click({timeout:12000}).catch(()=>{}); await page.waitForTimeout(2500);
          const conf2=page.locator('button.buy-in-modal__confirm').first();
          if (await conf2.isVisible().catch(()=>false)) { await conf2.click({timeout:10000}).catch(()=>{}); await page.waitForTimeout(6000); }
          body=await page.innerText('body');
        }
      }
      check('table 2 joined and rendered', /POT|Fold|Check|Call|Waiting|Seat Reserved|Post/i.test(body));
      check('two table tabs live simultaneously', (await page.locator('[class*="table-tab-bar__tab"]').count())>=2 || (await page.locator('[class*="table-tab"]').count())>=2);
    } else skip('table 2 join', t2h?'link found but unclickable after 3 attempts':'no second table link visible in embedded lobby');
  }

  // ---- DOCK TEST: SPA-navigate off-table via the history API ----
  // React Router v6 subscribes to popstate; pushState+popstate is a true
  // client-side nav (no reload, sockets stay up). The persistent layer must
  // hide the tables and surface the LiveTablesBar dock for the seated table.
  await page.evaluate(()=>{history.pushState({},'','/hub/club-arena/clubs');window.dispatchEvent(new PopStateEvent('popstate'));});
  await page.waitForTimeout(5000);
  await page.screenshot({path:S('06-offroute-dock')});
  body=await page.innerText('body');
  const offTable=!page.url().includes('/table/');
  const dock=/Return to game|live table|Action needed/i.test(body);
  check('SPA nav off-table hides tables and shows dock', offTable && dock, `off=${offTable} dockText=${dock}`);

  const ret=page.locator('text=/Return to game|Act now/i').first();
  if (await ret.isVisible().catch(()=>false)) {
    await ret.click({timeout:10000}).catch(()=>{}); await page.waitForTimeout(5000);
    await page.screenshot({path:S('07-returned')});
    check('dock returns to live table (SPA, socket intact)', page.url().includes('/table/') && /POT|Fold|Check|Call|Waiting|Seat Reserved|Post|Blind/i.test(await page.innerText('body')));
  } else skip('dock return','no Return to game control visible');

  // ---- CLEANUP: leave every live seat (shared, dock-driven teardown) ----
  const leaves=await leaveAllSeats(page, { rounds: 5 });
  check('left all seated tables (stack refunded, session clean)', leaves>=1, `leaves=${leaves}`);
  check('no page errors during walk', errs.length===0, errs.slice(0,2).join(' | '));
}catch(e){ check('walk completed', false, e.message.slice(0,160)); await page.screenshot({path:S('99-err')}).catch(()=>{}); }
await ctx.storageState({path:AUTH}).catch(()=>{});
const f=R.filter(x=>!x.ok).length;
const allowSkips=process.env.E2E_ALLOW_SKIPS==='1';
console.log(`\nMULTI-TABLE WALK: ${R.length-f}/${R.length} PASS` +
  (SKIPS.length?` -- ${SKIPS.length} SKIPPED (coverage gap${allowSkips?', allowed':''})`:''));
for (const s of SKIPS) console.log(`  skipped: ${s.n} -- ${s.d}`);
await browser.close();
process.exit(f || (SKIPS.length && !allowSkips) ? 1 : 0);
