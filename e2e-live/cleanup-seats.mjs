// Sweep ALL live seats for the test account: follow the dock from the arena
// route, leave each table via the table menu, repeat until the dock is gone.
// Run after any walkthrough that seats the hero. Verifies via UI only; pair
// with a table_seats DB check for the final word.
import { chromium } from 'playwright';
import fs from 'fs';
const AUTH=process.env.E2E_AUTH||'/tmp/e2e-work/auth.json';
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900}, ...(fs.existsSync(AUTH)?{storageState:AUTH}:{})});
const page=await ctx.newPage();
let left=0;
async function leaveActive(){
  // active table HUD menu = visible trigger in the upper-left corner
  const hs=await page.locator('button[aria-label="Table menu"]').elementHandles();
  let menu=null;
  for (const h of hs){ const bb=await h.boundingBox(); if (bb && bb.width>0 && bb.x<200 && bb.y<120){ menu=h; break; } }
  if(!menu) return false;
  await menu.click(); await page.waitForTimeout(1200);
  const lv=page.locator('text=Leave Table').first();
  if(!(await lv.isVisible().catch(()=>false))){ await page.keyboard.press('Escape'); return false; }
  await lv.click(); await page.waitForTimeout(1200);
  const cf=page.locator('.leave-confirm__btn:not(.leave-confirm__btn--cancel)').last();
  if(!(await cf.isVisible().catch(()=>false))){ await page.keyboard.press('Escape'); return false; }
  await cf.click(); await page.waitForTimeout(6000);
  return true;
}
for(let round=0; round<8; round++){
  await page.goto('https://smarter.poker/hub/club-arena/',{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForTimeout(8000);
  await page.keyboard.press('Escape').catch(()=>{}); // stray drawer
  const dock=page.locator('text=/Return to game|Act now/i').first();
  const seen=await dock.waitFor({state:'visible',timeout:15000}).then(()=>true).catch(()=>false);
  if(!seen){ console.log(`round ${round}: no dock after 15s -- clean`); break; }
  const ok=await dock.click({timeout:8000}).then(()=>true).catch(()=>false);
  if(!ok){ console.log(`round ${round}: dock visible but unclickable`); continue; }
  await page.waitForTimeout(6000);
  // if spectating (not seated) at this tab, switch through table tabs
  for(let t=0;t<3;t++){
    const foot=await page.locator('.action-panel-wrapper, [class*="spectator-footer"]').first().innerText().catch(()=>'');
    if(!/Spectating, Tap An Open Seat/i.test(foot)) break;
    const other=page.locator('[class*="table-tab-bar__tab"]:not([class*="--active"]):not(:has-text("Lobby"))').first();
    if(!(await other.isVisible().catch(()=>false))) break;
    await other.click().catch(()=>{}); await page.waitForTimeout(3000);
  }
  if(await leaveActive()){ left++; console.log(`round ${round}: left a table (total ${left})`); }
  else console.log(`round ${round}: could not leave from this tab`);
}
console.log(`CLEANUP DONE -- tables left this run: ${left}`);
await ctx.storageState({path:AUTH}).catch(()=>{});
await b.close();
