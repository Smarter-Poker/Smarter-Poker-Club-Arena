import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900},});
const p=await ctx.newPage();
const bad=[];
p.on('response',r=>{ if(r.status()===404) bad.push(r.url()); });
for (const route of ['/hub/club-arena/cashier','/hub/club-arena/wallet']){
  bad.length=0;
  await p.goto('https://smarter.poker'+route,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
  await p.waitForTimeout(9000);
  console.log(route+' -> '+bad.length+' x 404');
  [...new Set(bad)].forEach(u=>console.log('   '+u.replace('https://smarter.poker','')));
}
await b.close();
