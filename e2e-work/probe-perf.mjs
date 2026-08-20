import { chromium } from 'playwright';
import fs from 'fs';
const AUTH='/tmp/e2e-work/auth.json';
const b=await chromium.launch({headless:true});
const ctx=await b.newContext({viewport:{width:1280,height:900}, ...(fs.existsSync(AUTH)?{storageState:AUTH}:{})});
const p=await ctx.newPage();
const js=[], other=[], fails=[];
p.on('response', async r=>{
  const u=r.url(), st=r.status();
  if(st>=400) fails.push(`${st} ${u.replace(/https:\/\/[^/]+/,'').slice(0,90)}`);
  let len=0; try{ len=parseInt(r.headers()['content-length']||'0',10)||0; }catch{}
  if(/\.js(\?|$)/.test(u)) js.push({u:u.split('/').pop().slice(0,44), len});
  else if(/\.(css|png|jpg|webp|woff2?)(\?|$)/.test(u)) other.push({u:u.split('/').pop().slice(0,40), len});
});
const t0=Date.now();
await p.goto('https://smarter.poker/hub/club-arena/',{waitUntil:'domcontentloaded',timeout:45000});
const domReady=Date.now()-t0;
await p.waitForTimeout(12000);
const nav=await p.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0]||{};return {ttfb:Math.round(n.responseStart||0),dcl:Math.round(n.domContentLoadedEventEnd||0),load:Math.round(n.loadEventEnd||0)};});
const fcp=await p.evaluate(()=>{const e=performance.getEntriesByName('first-contentful-paint')[0];return e?Math.round(e.startTime):null;});
const jsBytes=js.reduce((a,x)=>a+x.len,0), otherBytes=other.reduce((a,x)=>a+x.len,0);
console.log(`domcontentloaded wall: ${domReady}ms | TTFB ${nav.ttfb}ms | DCL ${nav.dcl}ms | load ${nav.load}ms | FCP ${fcp}ms`);
console.log(`JS on arena first load: ${js.length} files, ${(jsBytes/1048576).toFixed(2)} MB`);
console.log(`CSS/img/font: ${other.length} files, ${(otherBytes/1048576).toFixed(2)} MB`);
console.log('--- 15 biggest STATIC assets on the critical path ---');
other.sort((a,c)=>c.len-a.len).slice(0,15).forEach(x=>console.log(`  ${String(Math.round(x.len/1024)).padStart(5)} KB  ${x.u}`));
console.log('--- failed requests ---');
[...new Set(fails)].slice(0,10).forEach(f=>console.log('  '+f));
await b.close();
