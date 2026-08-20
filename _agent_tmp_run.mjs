import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';
const root='/tmp/h';
const types={'.css':'text/css','.html':'text/html','.png':'image/png'};
const srv=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
 const f=path.join(root,p); if(!fs.existsSync(f)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'content-type':types[path.extname(f)]||'text/plain'}); fs.createReadStream(f).pipe(res);});
await new Promise(r=>srv.listen(8931,r));
const b=await chromium.launch({args:['--no-sandbox']});
const SEATS=['villain-table','villain-vip','hero-table','villain-photo','top-villain'];
const VIEWS=[['desktop',1400,900],['tab640',640,900],['ph480',480,900],['ph375',375,760]];
const out={};
for(const [vn,vw,vh] of VIEWS) for(const seat of SEATS){
  const pg=await b.newPage({viewport:{width:vw,height:vh},deviceScaleFactor:2});
  await pg.goto('http://localhost:8931/?seat='+seat);
  await pg.waitForTimeout(300);
  const m=await pg.evaluate(()=>window.__measure());
  await pg.evaluate(()=>window.__hideInfo(true)); await pg.waitForTimeout(150);
  fs.writeFileSync(`/tmp/h/x_${vn}_${seat}.png`, await pg.screenshot({omitBackground:true}));
  fs.writeFileSync(`/tmp/h/f_${vn}_${seat}.png`, await (async()=>{await pg.evaluate(()=>window.__hideInfo(false));await pg.waitForTimeout(120);return pg.screenshot({omitBackground:true});})());
  out[`${vn}|${seat}`]={...m}; await pg.close();
}
await b.close(); srv.close();
fs.writeFileSync('/tmp/h/m2.json',JSON.stringify(out,null,2));
console.log('done');
