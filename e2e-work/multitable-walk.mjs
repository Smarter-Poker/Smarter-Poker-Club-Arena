// REAL-BROWSER multi-table walk against production club-arena.
// Verifies: join cash table -> + button -> embedded lobby with table alive ->
// second table -> off-table route keeps both mounted (persistent layer + dock).
// Supabase rotates refresh tokens: storageState is re-saved at end of EVERY run,
// and an empty/anonymous arena triggers a fresh credential login.
import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const S=(n)=>`/tmp/e2e-shots/mt-${n}.png`;
const R=[]; const check=(n,ok,d='')=>{R.push({n,ok});console.log(`${ok?'PASS':'FAIL'} ${n}${d?' -- '+d:''}`)};
const skip=(n,d)=>{console.log(`SKIP ${n} -- ${d}`)};

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
  if(await cont.isVisible().catch(()=>false)){ await cont.click(); }
  else {
    await page.locator('input[type="email"]').first().fill(process.env.SP_EMAIL);
    await page.locator('input[type="password"]').first().fill(process.env.SP_PASS);
    await page.locator('button:has-text("Sign In"), button[type="submit"]').first().click();
  }
  await page.waitForTimeout(6000);
}
async function acceptTermsIfShown(){
  const t=page.locator('text=I understand and agree to these terms').first();
  if(await t.isVisible().catch(()=>false)){
    console.log('NOTE: terms modal visible -- acknowledging on owner test account');
    await page.locator('input[type="checkbox"]').first().check().catch(async()=>{await t.click();});
    await page.locator('button:has-text("Enter Club Arena")').first().click({timeout:10000}).catch(()=>{});
    await page.waitForTimeout(5000);
    return true;
  }
  return false;
}
async function gotoArena(){
  await page.goto('https://smarter.poker/hub/club-arena/',{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForTimeout(9000);
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
    if(await tab.isVisible().catch(()=>false)) await tab.click().catch(()=>{});
    // stalled-fetch hang (ClubHomePage watchdog finding): after ~32s of
    // skeleton, do what a real user does -- reload once, keep polling.
    if(i===7){ console.log('NOTE: club home still loading after 32s -- reloading once (stalled-fetch finding)'); await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{}); await acceptTermsIfShown(); }
    // if the Retry panel surfaced (watchdog fix), press it
    const retry=page.locator('button:has-text("Retry")').first();
    if(await retry.isVisible().catch(()=>false)) await retry.click().catch(()=>{});
  }
  await page.screenshot({path:S('01-club-home')});
  console.log('TABLE LINKS: '+JSON.stringify(links.slice(0,6)));
  check('club home shows cash-table links', links.length>0, `n=${links.length}`);
  if(!links.length){ throw new Error('no joinable table links visible -- stopping walk'); }

  // join table 1: pick the LOWEST-stakes table with an open seat, navigate directly
  const parse=(l)=>{const m=l.t.match(/BLINDS ([\d.]+) \/ ([\d.]+) (\d+)\/(\d+)/); return m?{...l,bb:+m[2],seated:+m[3],cap:+m[4]}:null;};
  const cands=links.map(parse).filter(Boolean).filter(x=>x.seated<x.cap).sort((a,b)=>a.bb-b.bb);
  console.log('CHEAPEST OPEN: '+JSON.stringify(cands[0]));
  const t1=cands[0]||links[0];
  await page.goto('https://smarter.poker'+t1.h,{waitUntil:'domcontentloaded',timeout:40000});
  await page.waitForTimeout(10000);
  console.log('T1 BUTTONS: '+JSON.stringify((await page.locator('button').allInnerTexts()).map(t=>t.replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,25)));
  await page.screenshot({path:S('02-table1')});
  body=await page.innerText('body');
  // buy-in modal?
  const buyBtn=page.locator('button:has-text("Buy In"), button:has-text("BUY IN"), button:has-text("Sit")').first();
  if(await buyBtn.isVisible().catch(()=>false)){
    await buyBtn.click(); await page.waitForTimeout(6000);
    await page.screenshot({path:S('03-after-buyin')});
    body=await page.innerText('body');
  }
  const seated1=/POT|Fold|Check|Call|Waiting|Hand #|Spectating/i.test(body);
  check('table 1 renders (seated or observing)', seated1);

  // ---- SEAT AT TABLE 1 (exact production selectors from source) ----
  body=await page.innerText('body');
  if (/Spectating, Tap An Open Seat/i.test(body)) {
    const seat=page.locator('[aria-label*="open - click to sit"]').first();
    await seat.click({timeout:15000});
    await page.waitForTimeout(2500);
    await page.screenshot({path:S('02b-buyin')});
    const conf=page.locator('button.buy-in-modal__confirm').first();
    if (await conf.isVisible().catch(()=>false)) {
      console.log('BUYIN BTN: '+await conf.innerText());
      await conf.click(); await page.waitForTimeout(6000);
    }
    body=await page.innerText('body');
  }
  await page.screenshot({path:S('02c-seated')});
  const seatedNow=!/Spectating, Tap An Open Seat/i.test(body);
  check('hero seated at table 1 (buy-in accepted)', seatedNow, body.match(/Seat Reserved[^\n]*|Spectating[^\n]*/i)?.[0]||'');

  // ---- + ADD TABLE (HUD upper-left, aria-label="Open another table") ----
  const plus=page.locator('button[aria-label="Open another table"], button.add-chips-icon-btn').first();
  const plusVisible=await plus.isVisible().catch(()=>false);
  check('+ add-table button visible (upper-left HUD)', plusVisible);
  if(plusVisible){
    await plus.click(); await page.waitForTimeout(8000);
    await page.screenshot({path:S('04-embedded-lobby')});
    body=await page.innerText('body');
    check('embedded lobby tab opened (club content, table 1 still mounted)', /CLUB JAQK|Cash|Tournaments|Games/i.test(body));
    // tab bar must now exist (tables.length>1 renders TableTabBar)
    check('tab bar with first table + lobby tab present', await page.locator('.table-tab-bar__add, [class*="table-tab-bar"]').count()>0);

    // ---- JOIN TABLE 2 from the embedded lobby ----
    const l2s=await page.locator('.multi-table-page__lobby-tab a[href*="/table/"]').evaluateAll(els=>els.map(e=>e.getAttribute('href')));
    const t2h=l2s.find(h=>h && !h.includes(t1.h.split('/table/')[1]));
    console.log('TABLE2 HREF: '+t2h);
    if(t2h){
      await page.locator(`.multi-table-page__lobby-tab a[href="${t2h}"]`).first().click();
      await page.waitForTimeout(9000);
      await page.screenshot({path:S('05-table2')});
      body=await page.innerText('body');
      // sit at table 2 too if spectating
      if (/Spectating, Tap An Open Seat/i.test(body)) {
        const seat2=page.locator('[aria-label*="open - click to sit"]').first();
        if (await seat2.isVisible().catch(()=>false)) {
          await seat2.click(); await page.waitForTimeout(2500);
          const conf2=page.locator('button.buy-in-modal__confirm').first();
          if (await conf2.isVisible().catch(()=>false)) { await conf2.click(); await page.waitForTimeout(6000); }
          body=await page.innerText('body');
        }
      }
      check('table 2 joined and rendered', /POT|Fold|Check|Call|Waiting|Seat Reserved|Post/i.test(body));
      check('two table tabs live simultaneously', (await page.locator('[class*="table-tab-bar__tab"]').count())>=2 || (await page.locator('[class*="table-tab"]').count())>=2);
    } else skip('table 2 join','no second table link visible in embedded lobby');
  }

  // ---- LEAVE TABLE 2 via menu: the leave nav lands on the club lobby
  // (a real non-table SPA route), where the LiveTablesBar dock must surface
  // for still-live table 1. This IS the dock test, on the real user path. ----
  const tableTab=page.locator('[class*="table-tab-bar__tab"]:not(:has-text("Lobby"))').last();
  if (await tableTab.isVisible().catch(()=>false)) { await tableTab.click().catch(()=>{}); await page.waitForTimeout(2500); }
  async function leaveActiveTable(tag){
    const menu=page.locator('button[aria-label="Table menu"]').filter({visible:true}).first();
    if (!(await menu.isVisible().catch(()=>false))) return false;
    await menu.click({timeout:8000}).catch(()=>{}); await page.waitForTimeout(1200);
    const leave=page.locator('text=Leave Table').filter({visible:true}).first();
    if (!(await leave.isVisible().catch(()=>false))) { await page.keyboard.press('Escape'); return false; }
    await leave.click().catch(()=>{}); await page.waitForTimeout(1200);
    const confL=page.locator('.leave-confirm__btn:not(.leave-confirm__btn--cancel)').last();
    if (await confL.isVisible().catch(()=>false)) { await confL.click(); await page.waitForTimeout(6000); return true; }
    await page.keyboard.press('Escape'); return false;
  }
  const left2=await leaveActiveTable('t2');
  await page.screenshot({path:S('06-after-leave2')});
  body=await page.innerText('body');
  const onTableRoute=page.url().includes('/table/');
  const dock=/Return to game|live table|Action needed/i.test(body);
  check('leave table 2 lands off-table with dock for live table 1', left2 && dock, `left=${left2} url=${page.url().slice(-40)}`);

  // ---- DOCK RETURN: back to table 1 without a reload ----
  const ret=page.locator('text=/Return to game/i').first();
  if (await ret.isVisible().catch(()=>false)) {
    await ret.click(); await page.waitForTimeout(5000);
    await page.screenshot({path:S('07-returned')});
    check('dock returns to live table 1 (SPA nav, socket intact)', page.url().includes('/table/') && /POT|Fold|Check|Call|Waiting|Seat Reserved|Post/i.test(await page.innerText('body')));
  } else skip('dock return','no Return to game control visible');

  // ---- CLEANUP: leave table 1 to refund the stack ----
  const left1=await leaveActiveTable('t1');
  await page.waitForTimeout(3000);
  await page.screenshot({path:S('08-after-cleanup')});
  check('left table 1 (stack refunded, session clean)', left1);
  check('no page errors during walk', errs.length===0, errs.slice(0,2).join(' | '));
}catch(e){ check('walk completed', false, e.message.slice(0,160)); await page.screenshot({path:S('99-err')}).catch(()=>{}); }
await ctx.storageState({path:AUTH}).catch(()=>{});
const f=R.filter(x=>!x.ok).length;
console.log(`\nMULTI-TABLE WALK: ${R.length-f}/${R.length} PASS`);
await browser.close();
process.exit(f?1:0);
