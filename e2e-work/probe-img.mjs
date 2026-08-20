import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900},...(fs.existsSync(AUTH)?{storageState:AUTH}:{})});
const p=await ctx.newPage();
await p.goto('https://smarter.poker/hub/club-arena/',{waitUntil:'domcontentloaded',timeout:45000});
await p.waitForTimeout(10000);
const rows=await p.evaluate(()=>{
  const out=[];
  for (const img of document.querySelectorAll('img')){
    const r=img.getBoundingClientRect();
    if(r.width>0) out.push({src:(img.currentSrc||img.src).split('/').pop().slice(0,40),
      nat:`${img.naturalWidth}x${img.naturalHeight}`, disp:`${Math.round(r.width)}x${Math.round(r.height)}`,
      waste: Math.round((img.naturalWidth*img.naturalHeight)/Math.max(1,r.width*r.height))});
  }
  // css background-images too
  for (const el of document.querySelectorAll('*')){
    const bg=getComputedStyle(el).backgroundImage;
    if(bg && bg!=='none' && bg.includes('url(')){ const u=bg.match(/url\(["']?([^"')]+)/); if(u) out.push({src:'[bg] '+u[1].split('/').pop().slice(0,36),nat:'-',disp:'-',waste:0}); }
  }
  return out;
});
const seen=new Set();
rows.filter(r=>{if(seen.has(r.src))return false;seen.add(r.src);return true;})
    .sort((a,c)=>c.waste-a.waste).slice(0,16)
    .forEach(r=>console.log(`  natural ${r.nat.padEnd(11)} shown ${r.disp.padEnd(10)} ${String(r.waste).padStart(4)}x pixels  ${r.src}`));
await b.close();
