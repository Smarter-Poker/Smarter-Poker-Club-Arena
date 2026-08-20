import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({viewport:{width:1280,height:900}, ...(fs.existsSync(AUTH)?{storageState:AUTH}:{})});
const page=await ctx.newPage();
await page.goto('https://smarter.poker/hub/club-arena/table/b1be7efe-e861-4854-bf1c-18652cd429b1',{waitUntil:'domcontentloaded',timeout:45000});
await page.waitForTimeout(10000);
const info=await page.evaluate(()=>{
  const els=[...document.querySelectorAll('button[aria-label="Table menu"], button.add-chips-icon-btn, [class*="table-menu__trigger"]')];
  return els.map(e=>{const r=e.getBoundingClientRect();const st=getComputedStyle(e);return {aria:e.getAttribute('aria-label'),cls:e.className.slice(0,40),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),display:st.display,vis:st.visibility,op:st.opacity};});
});
console.log(JSON.stringify(info,null,1));
console.log('URL',page.url());
const foot=await page.evaluate(()=>document.querySelector('[class*="spectator-footer"], .action-panel-wrapper')?.innerText?.slice(0,80));
console.log('FOOTER:',foot);
await page.screenshot({path:'/tmp/e2e-shots/probe-menu.png'});
await ctx.storageState({path:AUTH});
await browser.close();
