// Exercise the real downscale logic in a real browser against a real image.
import { chromium } from 'playwright';
const b=await chromium.launch({headless:true});
const p=await (await b.newContext()).newPage();
await p.goto('https://smarter.poker/hub/club-arena/',{waitUntil:'domcontentloaded',timeout:45000});
const out=await p.evaluate(async () => {
  async function downscaleImage(file, maxPx) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
    const bitmap = await createImageBitmap(file);
    try {
      const longest = Math.max(bitmap.width, bitmap.height);
      if (longest <= maxPx) return file;
      const scale = maxPx / longest;
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d'); if (!ctx) return file;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      const keepAlpha = file.type === 'image/png';
      const mime = keepAlpha ? 'image/png' : 'image/jpeg';
      const blob = await new Promise(r => canvas.toBlob(r, mime, keepAlpha ? undefined : 0.85));
      if (!blob) return file;
      const name = file.name.replace(/\.[^.]+$/, '') + (keepAlpha ? '.png' : '.jpg');
      return new File([blob], name, { type: mime, lastModified: Date.now() });
    } finally { bitmap.close?.(); }
  }
  // Build a 1179x1509 photo-like image in-page (same dimensions as the real
  // avatar) — no network, so CSP/CORS cannot interfere with the measurement.
  const c=document.createElement('canvas'); c.width=1179; c.height=1509;
  const cx=c.getContext('2d');
  for(let i=0;i<1509;i+=3){ cx.fillStyle=`hsl(${(i*0.24)%360} 70% ${40+((i*7)%35)}%)`; cx.fillRect(0,i,1179,3); }
  for(let i=0;i<2500;i++){ cx.fillStyle=`rgba(${(i*13)%255},${(i*29)%255},${(i*7)%255},0.5)`; cx.fillRect((i*37)%1179,(i*53)%1509,9,9); }
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.92));
  const orig=new File([blob],'avatar.jpg',{type:'image/jpeg'});
  const small=await downscaleImage(orig,512);
  const bm=await createImageBitmap(small);
  // already-small image must pass through untouched
  const tiny=await downscaleImage(new File([await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')).blob()],'t.png',{type:'image/png'}),512);
  return { origBytes: orig.size, newBytes: small.size, dims: bm.width+'x'+bm.height, type: small.type, tinyUntouched: tiny.name==='t.png' && tiny.type==='image/png' };
});
console.log(JSON.stringify(out,null,1));
await b.close();
