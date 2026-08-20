import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900},...(fs.existsSync(AUTH)?{storageState:AUTH}:{})});
const p=await ctx.newPage();
await p.goto('https://smarter.poker/hub/club-arena/',{waitUntil:'domcontentloaded',timeout:45000});
await p.waitForTimeout(11000);
await p.keyboard.press('Escape').catch(()=>{});
await p.waitForTimeout(1200);
const info=await p.evaluate(()=>{
  const cards=[...document.querySelectorAll('[class*="carouselCard"],[class*="clubCard"]')];
  const first=cards.find(c=>/CLUB JAQK/i.test(c.innerText||''));
  if(!first) return {found:false, sample:cards.slice(0,2).map(c=>(c.innerText||'').replace(/\s+/g,' ').slice(0,80))};
  return {
    found:true,
    text:(first.innerText||'').replace(/\s+/g,' ').slice(0,200),
    nameCount:((first.innerText||'').match(/CLUB JAQK/gi)||[]).length,
    membersCount:((first.innerText||'').match(/MEMBERS/gi)||[]).length,
    imgs:[...first.querySelectorAll('img')].map(i=>(i.currentSrc||i.src).split('/').slice(-2).join('/').split('?')[0]),
  };
});
console.log(JSON.stringify(info,null,1));
await b.close();
