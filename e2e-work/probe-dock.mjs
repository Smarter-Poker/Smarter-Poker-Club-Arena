import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900}, ...(fs.existsSync(AUTH)?{storageState:AUTH}:{})});
const page=await ctx.newPage();
page.on('console',m=>{ if(/table_seats|rebuild|dock/i.test(m.text())) console.log('CONSOLE:',m.text().slice(0,120)); });
await page.goto('https://smarter.poker/hub/club-arena/',{waitUntil:'domcontentloaded',timeout:45000});
for(let i=1;i<=6;i++){
  await page.waitForTimeout(5000);
  const bar=await page.locator('[class*="live-tables-bar"]').count();
  const txt=await page.innerText('body').then(t=>/Return to game|Act now/i.test(t));
  console.log(`t+${i*5}s bar=${bar} dockText=${txt} url=${page.url().slice(-24)}`);
}
await page.screenshot({path:'/tmp/e2e-shots/probe-dock.png'});
await ctx.storageState({path:AUTH}).catch(()=>{});
await b.close();
