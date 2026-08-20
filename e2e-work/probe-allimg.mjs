import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900},...(fs.existsSync(AUTH)?{storageState:AUTH}:{})});
const p=await ctx.newPage();
const worst=new Map();
const routes=['','clubs','tournaments','cashier','wallet','profile','marketplace','leaderboard','settings','vip','rakeback','messages','achievements'];
for (const r of routes){
  await p.goto('https://smarter.poker/hub/club-arena/'+r,{waitUntil:'domcontentloaded',timeout:40000}).catch(()=>{});
  await p.waitForTimeout(5000);
  const rows=await p.evaluate(()=>[...document.querySelectorAll('img')].map(i=>{
    const b=i.getBoundingClientRect();
    return {src:(i.currentSrc||i.src), nw:i.naturalWidth, nh:i.naturalHeight, dw:Math.round(b.width), dh:Math.round(b.height)};
  }).filter(x=>x.dw>0 && x.nw>0));
  for(const x of rows){
    const name=x.src.split('/').slice(-2).join('/').split('?')[0];
    if(!x.src.includes('/hub/club-arena/') && !x.src.includes('/images/')) continue;
    const prev=worst.get(name);
    const box=Math.max(x.dw,x.dh);
    if(!prev || box>prev.box) worst.set(name,{box, nat:Math.max(x.nw,x.nh), nw:x.nw, nh:x.nh});
  }
}
const out=[...worst.entries()].map(([n,v])=>({n, ...v, ratio: Math.round((v.nat*v.nat)/(v.box*v.box))}))
  .filter(x=>x.ratio>=9).sort((a,c)=>c.ratio-a.ratio);
console.log(`images drawn at <=1/9 of their pixels (${out.length}):`);
out.slice(0,30).forEach(x=>console.log(`  ${String(x.ratio).padStart(4)}x  natural ${x.nw}x${x.nh} shown ${x.box}px  ${x.n}`));
await b.close();
