import { chromium } from 'playwright-core';
import fs from 'fs';

const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
// The anon key is the PUBLISHABLE client key (already shipped in every
// browser bundle) — a default here lets CI run without repo secrets.
const ANON = process.env.SB_ANON || 'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx';
// Dedicated fixture identity must be injected explicitly; never discover a workstation env file.
const EMAIL = process.env.SP_EMAIL || process.env.TEST_USER_EMAIL;
if (!EMAIL) throw new Error('SP_EMAIL (or TEST_USER_EMAIL) is not set - refusing to guess an account');
const PASS = process.env.TEST_PASS || process.env.SP_PASS;
const BASE = 'https://smarter.poker/hub/club-arena';
const CLUB = 'a0000000-0000-0000-0000-000000000001';
const TOUR = 'b9b7c003-d874-48f7-8749-ed2e9f832951';
const TABLE = '6e0e34c2-f51a-4fe2-aa4d-31fbc0384901';
const UNION = 'fade0000-0000-0000-0000-000000000001';
const OTHER = '4e5a0000-76ea-4bff-b44e-3c470e5f2434';

const routes = [
`/clubs/${CLUB}`,'/profile',`/clubs/${CLUB}/cashier`,'/transactions','/vip','/settlement-dashboard','/dev/bus','/analytics',
'/','/auth','/clubs/create',`/clubs/${CLUB}`,`/clubs/${CLUB}/agents`,`/clubs/${CLUB}/create-table`,`/clubs/${CLUB}/create-table/nlh`,`/clubs/${CLUB}/dashboard`,`/clubs/${CLUB}/dashboard-full`,`/clubs/${CLUB}/lobby`,`/clubs/${CLUB}/tournaments`,`/clubs/${CLUB}/messages`,`/tournaments/${TOUR}`,'/tournament-lobby','/tournaments','/tournament-results','/hand-history','/agent-management','/unions','/unions/create',`/unions/${UNION}`,`/unions/${UNION}/statements`,`/unions/${UNION}/settlement`,`/clubs/${CLUB}/settlement`,'/challenges','/profile',`/profile/${OTHER}`,'/settings','/leaderboard','/history','/wallet','/notifications','/messages','/messages/new','/messages/clubs','/search','/help','/cashier','/players','/data',`/clubs/${CLUB}/data`,'/admin','/player-sessions','/agent-dashboard',`/clubs/${CLUB}/cashier`,`/clubs/${CLUB}/cashier-classic`,'/hands',`/clubs/${CLUB}/agent-dashboard`,'/achievements',`/clubs/${CLUB}/members`,`/clubs/${CLUB}/promo-vault`,`/clubs/${CLUB}/members/${OTHER}`,`/clubs/${CLUB}/members/${OTHER}/statistics`,'/friends','/rakeback',`/clubs/${CLUB}/jackpot`,'/stats',`/stats/${OTHER}`,'/promotions',`/clubs/${CLUB}/promotions`,`/clubs/${CLUB}/settings`,'/transactions',`/invite/${CLUB}`,'/invite',`/report/${OTHER}`,`/clubs/${CLUB}/reports`,`/clubs/${CLUB}/announcements`,'/vip',`/clubs/${CLUB}/financials`,'/financial-alerts','/disputes',`/clubs/${CLUB}/disputes`,'/financial-health','/financial-admin','/rate-audit','/settlement-dashboard','/agent-portal','/rakeback-dashboard','/credit-admin','/settlement-history','/flash-pool','/session-history','/bonuses','/waitlist',`/clubs/${CLUB}/blacklist`,`/clubs/${CLUB}/rules`,'/notification-center','/clubs-list',`/clubs/${CLUB}/table-creation`,'/anti-cheat','/xmtt','/union-dashboard','/marketplace',`/unions/${UNION}/games`,'/union-games','/dev/bus','/health','/legal/tos','/legal/promotions','/legal/fair-gaming','/legal/privacy','/engine','/analytics',`/table/${TABLE}`,'/share/hand/test-hand-id','/replay','/sim',
];

async function login() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  return await r.json(); // { access_token, refresh_token, expires_in, expires_at?, token_type, user }
}

const audit = async (page) => page.evaluate(() => {
  const iw = window.innerWidth;
  const doc = document.documentElement;
  const offenders = [];
  const sel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0,3).join('.');
    return s;
  };
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > iw + 1 || (r.left < -1 && r.right > 0)) {
      // skip elements inside an overflow-x scroller (legit)
      let p = el.parentElement, inScroller = false;
      while (p) {
        const st = getComputedStyle(p);
        if ((st.overflowX === 'auto' || st.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) { inScroller = true; break; }
        p = p.parentElement;
      }
      const st0 = getComputedStyle(el);
      const decorative = st0.pointerEvents === 'none' && !(el.innerText || '').trim();
      // Marquees scroll their own content by transform on purpose — the
      // STARTING SOON strip's track is wider than any viewport by design.
      const inMarquee = !!el.closest('.mtt-ticker');
      if (!inScroller && !decorative && !inMarquee) offenders.push({ sel: sel(el), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
    }
  }
  // dedupe by selector, keep widest
  const seen = new Map();
  for (const o of offenders) { const k = o.sel; if (!seen.has(k) || seen.get(k).w < o.w) seen.set(k, o); }
  return {
    iw,
    scrollW: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0),
    pathname: location.pathname,
    offenders: [...seen.values()].sort((a,b)=>b.w-a.w).slice(0, 8),
  };
});

const START = parseInt(process.env.START || '0', 10);
const COUNT = parseInt(process.env.COUNT || '15', 10);
async function getSession() {
  try {
    const cached = JSON.parse(fs.readFileSync('/tmp/sb-session.json', 'utf8'));
    if (cached.expires_at && cached.expires_at * 1000 > Date.now() + 120000) return cached;
  } catch (e) {}
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const s = await login();
      fs.writeFileSync('/tmp/sb-session.json', JSON.stringify(s));
      return s;
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
  throw lastErr;
}
(async () => {
  const session = await getSession();
  const b = await chromium.launch({ headless: true });
  let results = [];
  try { results = JSON.parse(fs.readFileSync('/tmp/e2e-report.json', 'utf8')); } catch (e) {}
  results = results.filter(r => !r._chunkMark);
  const widths = [390, 360];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await ctx.addInitScript(([key, val]) => { try { localStorage.setItem(key, val); } catch (e) {} }, ['smarter-poker-auth', JSON.stringify(session)]);
  const page = await ctx.newPage();
  const uniq = process.env.ROUTES ? JSON.parse(process.env.ROUTES) : [...new Set(routes)];
  for (const route of uniq.slice(START, START + COUNT)) {
    if (results.some(r => r.route === route && !r.error)) continue;
    const entry = { route, checks: {} };
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + route, { timeout: 45000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5500);
      for (const w of widths) {
        await page.setViewportSize({ width: w, height: 844 });
        await page.waitForTimeout(700);
        const a = await audit(page);
        entry.checks[w] = { scrollW: a.scrollW, iw: a.iw, overflow: a.scrollW > a.iw + 1, pathname: a.pathname, offenders: a.offenders };
      }
    } catch (e) {
      entry.error = String(e).split('\n')[0];
    }
    results.push(entry);
    fs.writeFileSync('/tmp/e2e-report.json', JSON.stringify(results, null, 1));
    const c390 = entry.checks[390], c360 = entry.checks[360];
    console.log(route, '->', entry.error ? 'ERROR' : `${c390 && c390.overflow ? 'OVERFLOW390' : 'ok390'} ${c360 && c360.overflow ? 'OVERFLOW360' : 'ok360'} off:${c390 ? c390.offenders.length : '?'}`);
  }
  await b.close();
  console.log('DONE');
  if (process.env.FAIL_ON_FINDINGS === '1') {
    const bad = [];
    for (const r of results) {
      if (r.error) bad.push(`${r.route}: ${r.error}`);
      for (const w of ['390', '360']) {
        const c = (r.checks || {})[w] || {};
        if (c.overflow) bad.push(`${r.route}@${w}: page scrolls sideways (scrollW ${c.scrollW})`);
        for (const o of c.offenders || []) bad.push(`${r.route}@${w}: clipped ${o.sel} (right ${o.right})`);
      }
    }
    if (bad.length) {
      console.error('MOBILE AUDIT FAILURES:');
      for (const m of bad) console.error(' -', m);
      process.exit(1);
    }
    console.log('FAIL_ON_FINDINGS: clean.');
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
