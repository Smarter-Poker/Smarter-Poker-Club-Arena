import { chromium } from 'playwright';
const b=await chromium.launch({headless:true});
const p=await (await b.newContext({viewport:{width:1280,height:900}})).newPage();
const bad=[];
p.on('response',r=>{ if(r.status()===404) bad.push(r.url()); });
for (const u of ['https://smarter.poker/cashier','https://smarter.poker/wallet']){
  bad.length=0;
  await p.goto(u,{waitUntil:'domcontentloaded',timeout:45000}).catch(e=>console.log('nav err',e.message.slice(0,60)));
  await p.waitForTimeout(7000);
  console.log(`${u} -> final=${p.url()} | ${bad.length} x 404`);
  [...new Set(bad)].slice(0,5).forEach(x=>console.log('   '+x.replace('https://smarter.poker','')));
}
await b.close();
