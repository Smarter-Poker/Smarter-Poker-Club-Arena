import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900},...(fs.existsSync(AUTH)?{storageState:AUTH}:{})});
const p=await ctx.newPage();
const seen=new Map();
p.on('response', async r=>{
  const u=r.url(); if(!/\.js(\?|$)/.test(u)) return;
  let n=0; try { n=(await r.body()).length; } catch {}
  seen.set(u.split('/').pop().slice(0,46), n);
});
await p.goto(process.argv[2]||'https://smarter.poker/hub/club-arena/',{waitUntil:'domcontentloaded',timeout:45000});
await p.waitForTimeout(14000);
const arr=[...seen.entries()].sort((a,c)=>c[1]-a[1]);
const total=arr.reduce((a,x)=>a+x[1],0);
console.log(`JS actually transferred: ${arr.length} files, ${(total/1048576).toFixed(2)} MB`);
arr.slice(0,14).forEach(([n,s])=>console.log(`  ${String(Math.round(s/1024)).padStart(5)} KB  ${n}`));
await b.close();
