import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const TID=process.argv[2]||'4bbc2576-4737-4343-bee4-cb22982f79ef';
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900}, ...(fs.existsSync(AUTH)?{storageState:AUTH}:{})});
const p=await ctx.newPage();
const log=[];
p.on('pageerror',e=>log.push('PAGEERROR: '+e.message.slice(0,200)));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/Content Security Policy/.test(t)) log.push('CONSOLE: '+t.slice(0,220));});
p.on('response',async r=>{ if(r.url().includes('atomic_table_buyin')||r.url().includes('/rest/v1/rpc/')){ let body=''; try{body=(await r.text()).slice(0,300);}catch{} log.push(`RPC ${r.status()} ${r.url().split('/rpc/')[1]||r.url().slice(-40)} :: ${body}`); }});
await p.goto('https://smarter.poker/hub/club-arena/table/'+TID,{waitUntil:'domcontentloaded',timeout:45000});
await p.waitForTimeout(11000);
console.log('FOOTER:', await p.locator('.action-panel-wrapper, [class*="spectator-footer"]').first().innerText().catch(()=>'(none)'));
const seat=p.locator('[aria-label*="open - click to sit"]').first();
console.log('open seat visible:', await seat.isVisible().catch(()=>false));
if(await seat.isVisible().catch(()=>false)){
  await seat.click({timeout:12000}).catch(e=>console.log('seat click failed:',e.message.slice(0,80)));
  await p.waitForTimeout(3000);
  const modal=p.locator('.buy-in-modal__confirm').first();
  console.log('modal visible:', await modal.isVisible().catch(()=>false), '| label:', await modal.innerText().catch(()=>'-'));
  console.log('modal disabled:', await modal.isDisabled().catch(()=>'?'));
  await p.screenshot({path:'/tmp/e2e-shots/probe-buyin-modal.png'});
  if(await modal.isVisible().catch(()=>false)){
    await modal.click({timeout:10000}).catch(e=>console.log('confirm click failed:',e.message.slice(0,80)));
    await p.waitForTimeout(8000);
  }
}
console.log('FOOTER AFTER:', await p.locator('.action-panel-wrapper, [class*="spectator-footer"]').first().innerText().catch(()=>'(none)'));
const toast=await p.locator('[class*="toast"]').allInnerTexts().catch(()=>[]);
console.log('TOASTS:', JSON.stringify(toast.slice(0,4)));
console.log('--- LOG ---'); log.slice(0,14).forEach(l=>console.log(' '+l));
await p.screenshot({path:'/tmp/e2e-shots/probe-buyin-after.png'});
await ctx.storageState({path:AUTH}).catch(()=>{});
await b.close();
