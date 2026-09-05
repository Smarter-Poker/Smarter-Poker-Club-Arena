import { chromium } from 'playwright-core';
import fs from 'fs';

const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const ANON = process.env.SB_ANON || 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
const PASS = process.env.TEST_PASS || process.env.SP_PASS;
// 2026-09-04: no default account. Read SP_EMAIL from .env.local or refuse.
const EMAIL = process.env.SP_EMAIL || process.env.TEST_USER_EMAIL;
if (!EMAIL) throw new Error('SP_EMAIL (or TEST_USER_EMAIL) is not set - refusing to guess an account');
const BASE = 'https://smarter.poker/hub/club-arena';
const CLUB = 'a0000000-0000-0000-0000-000000000001';
const TABLE = process.env.TABLE_ID || '6e0e34c2-f51a-4fe2-aa4d-31fbc0384901';
const OTHER = '4e5a0000-76ea-4bff-b44e-3c470e5f2434';

const routes = JSON.parse(process.env.ROUTES || 'null') || [
  '/', `/clubs/${CLUB}`, `/clubs/${CLUB}/members`, `/table/${TABLE}`, '/profile', '/friends', '/messages', `/clubs/${CLUB}/lobby`,
];

async function login() {
  try {
    const cached = JSON.parse(fs.readFileSync('/tmp/sb-session.json', 'utf8'));
    if (cached.expires_at && cached.expires_at * 1000 > Date.now() + 120000) return cached;
  } catch (e) {}
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    if (r.ok) { const s = await r.json(); fs.writeFileSync('/tmp/sb-session.json', JSON.stringify(s)); return s; }
    await new Promise(res => setTimeout(res, 3000));
  }
  throw new Error('login failed');
}

(async () => {
  const session = await login();
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    hasTouch: true, isMobile: true, deviceScaleFactor: 3,
  });
  await ctx.addInitScript(([key, val]) => { try { localStorage.setItem(key, val); } catch (e) {} }, ['smarter-poker-auth', JSON.stringify(session)]);
  await ctx.addInitScript(() => { try { localStorage.setItem('club_arena_welcome_accepted', 'true'); } catch (e) {} });
  const page = await ctx.newPage();
  const report = [];
  for (const route of routes) {
    try {
      await page.goto(BASE + route, { timeout: 45000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(7000);
      const data = await page.evaluate(() => {
        const out = [];
        for (const img of document.querySelectorAll('img')) {
          const r = img.getBoundingClientRect();
          const cs = getComputedStyle(img);
          const isAvatarish = /avatar|profile|orb|seat|member|logo/i.test((img.className||'') + ' ' + (img.closest('[class*="avatar" i],[class*="seat" i],[class*="orb" i],[class*="member" i]')?.className || ''));
          if (!isAvatarish) continue;
          out.push({
            src: (img.currentSrc || img.src || '').slice(0, 140),
            cls: String(img.className).slice(0, 60),
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            w: Math.round(r.width), h: Math.round(r.height),
            display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
            onscreen: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight,
          });
        }
        // background-image avatars
        for (const el of document.querySelectorAll('[class*="avatar" i],[class*="seat" i]')) {
          const cs = getComputedStyle(el);
          if (cs.backgroundImage && cs.backgroundImage !== 'none' && !cs.backgroundImage.includes('gradient')) {
            const r = el.getBoundingClientRect();
            out.push({ bg: cs.backgroundImage.slice(0, 140), cls: String(el.className).slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) });
          }
        }
        return out;
      });
      const shot = '/tmp/shots' + route.replace(/[^a-z0-9]/gi, '_') + '.png';
      await page.screenshot({ path: shot, fullPage: false });
      report.push({ route, avatars: data, shot });
      const broken = data.filter(a => a.src !== undefined && (!a.complete || a.naturalWidth === 0) && a.display !== 'none');
      console.log(route, '-> avatar imgs:', data.filter(a=>a.src!==undefined).length, '| BROKEN:', broken.length, broken.slice(0,3).map(b=>b.src.slice(0,90)));
    } catch (e) {
      console.log(route, 'ERROR', String(e).split('\n')[0]);
    }
    fs.writeFileSync('/tmp/avatar-report.json', JSON.stringify(report, null, 1));
  }
  await b.close();
  console.log('DONE');
  if (process.env.FAIL_ON_FINDINGS === '1') {
    const bad = [];
    for (const r of report) {
      for (const av of r.avatars || []) {
        if (av.src !== undefined && av.complete && av.naturalWidth === 0 && av.display !== 'none' && av.onscreen) {
          bad.push(`${r.route}: broken avatar ${av.src.slice(-80)}`);
        }
      }
    }
    if (bad.length) {
      console.error('AVATAR AUDIT FAILURES:');
      for (const m of bad) console.error(' -', m);
      process.exit(1);
    }
    console.log('FAIL_ON_FINDINGS: clean.');
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
