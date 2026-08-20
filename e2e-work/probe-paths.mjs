import { chromium } from 'playwright';
const b=await chromium.launch({headless:true});
const p=await (await b.newContext({viewport:{width:1280,height:900}})).newPage();
for (const r of ['cashier','wallet','clubs','tournaments','profile']){
  const resp=await p.goto('https://smarter.poker/hub/club-arena/'+r,{waitUntil:'domcontentloaded',timeout:40000}).catch(()=>null);
  await p.waitForTimeout(2500);
  const t=(await p.innerText('body')).replace(/\s+/g,' ').slice(0,60);
  console.log(`  ${String(resp?.status()).padEnd(4)} /${r.padEnd(12)} "${t}"`);
}
await b.close();
