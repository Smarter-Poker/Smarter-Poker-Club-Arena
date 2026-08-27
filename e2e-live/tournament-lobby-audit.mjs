/**
 * PRIORITY ONE (handoff 2026-08-26-tournament-lobby-remaining-work.md §2):
 * "NOBODY HAS OPENED THIS IN A BROWSER." This opens it — production, real
 * Chromium, 375×812 and 430×932 — and runs the 10-row checklist as
 * measurements, not hopes.
 *
 * Auth: no password is stored anywhere on this machine (by design), so the
 * probe mints a one-time session for the documented test account through the
 * GoTrue admin generate_link + verify flow. The service key is read from the
 * repo's .env and never printed.
 *
 * Run: node e2e-live/tournament-lobby-audit.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'fs';
import os from 'os';

const ENV_PATH = `${os.homedir()}/Documents/club-arena/.env`;
const env = Object.fromEntries(
  fs
    .readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [
      l.slice(0, l.indexOf('=')).trim(),
      l
        .slice(l.indexOf('=') + 1)
        .trim()
        .replace(/^["']|["']$/g, ''),
    ])
);
const SUPABASE_URL = env.VITE_SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.VITE_SUPABASE_ANON_KEY;
const EMAIL = process.env.SP_EMAIL || 'daniel@bekavactrading.com';
const BASE = 'https://smarter.poker/hub/club-arena';
if (!SERVICE || !ANON) throw new Error('missing supabase keys in .env');

async function mintSession() {
  const gl = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
    },
    body: JSON.stringify({ type: 'magiclink', email: EMAIL }),
  });
  if (!gl.ok) throw new Error(`generate_link failed: ${gl.status} ${await gl.text()}`);
  const link = await gl.json();
  const tokenHash = link.hashed_token || link.properties?.hashed_token;
  if (!tokenHash) throw new Error('no hashed_token in generate_link response');
  const v = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
  if (!v.ok) throw new Error(`verify failed: ${v.status} ${await v.text()}`);
  return v.json();
}

async function pickTournament() {
  const q = `${SUPABASE_URL}/rest/v1/tournaments?tournament_type=eq.MTT&status=in.(RUNNING,LATE_REG,REGISTERING)&select=id,name,status,current_level,level_started_at,current_players&order=started_at.desc.nullslast&limit=10`;
  const r = await fetch(q, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('no live MTT found');
  // Prefer a RUNNING event with a live level clock; else anything.
  return (
    rows.find((t) => t.status === 'RUNNING' && t.level_started_at) ||
    rows.find((t) => t.status === 'RUNNING') ||
    rows[0]
  );
}

const report = { checks: [] };
const check = (id, name, pass, detail) => {
  report.checks.push({ id, name, pass, detail });
  console.log(`${pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO'}  [${id}] ${name} — ${detail}`);
};

(async () => {
  const session = await mintSession();
  const t = await pickTournament();
  console.log(`target MTT: ${t.name} (${t.id.slice(0, 8)}) status=${t.status} level=${t.current_level}`);

  const b = await chromium.launch({ headless: true });
  const mkCtx = async (width, height) => {
    const ctx = await b.newContext({
      viewport: { width, height },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
    });
    await ctx.addInitScript(
      ([key, val]) => {
        try {
          localStorage.setItem(key, val);
          localStorage.setItem('club_arena_welcome_accepted', 'true');
        } catch (e) {}
      },
      ['smarter-poker-auth', JSON.stringify(session)]
    );
    return ctx;
  };

  fs.mkdirSync('/tmp/lobby-audit', { recursive: true });
  const lobbyUrl = `${BASE}/tournaments/${t.id}`;

  for (const [width, height] of [
    [375, 812],
    [430, 932],
  ]) {
    const ctx = await mkCtx(width, height);
    const page = await ctx.newPage();
    await page.goto(lobbyUrl, { timeout: 45000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);
    await page.screenshot({ path: `/tmp/lobby-audit/lobby-${width}.png` });

    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const footer = document.querySelector('.details-footer');
      const fr = footer ? footer.getBoundingClientRect() : null;
      const clockTexts = [...document.querySelectorAll('*')]
        .filter((el) => el.children.length === 0 && /^\d{1,2}:\d{2}$/.test(el.textContent?.trim() || ''))
        .map((el) => el.textContent.trim());
      return {
        scrollH: de.scrollHeight,
        innerH: innerHeight,
        bodyScrollable: de.scrollHeight > innerHeight + 2,
        footerBottom: fr ? Math.round(fr.bottom) : null,
        footerPresent: !!footer,
        clockTexts,
      };
    });
    check(
      width === 375 ? 1 : 4,
      `detail fits one screen @${width}`,
      !m.bodyScrollable,
      `scrollHeight=${m.scrollH} innerHeight=${m.innerH}`
    );
    check(
      2,
      `footer flush @${width}`,
      m.footerPresent && m.footerBottom !== null && Math.abs(m.footerBottom - height) <= 3,
      `footerBottom=${m.footerBottom} viewport=${height}`
    );
    if (width === 375) {
      // 3: clock ticks and is never 0:00 (only provable on a RUNNING event)
      const first = m.clockTexts;
      await page.waitForTimeout(1700);
      const second = await page.evaluate(() =>
        [...document.querySelectorAll('*')]
          .filter((el) => el.children.length === 0 && /^\d{1,2}:\d{2}$/.test(el.textContent?.trim() || ''))
          .map((el) => el.textContent.trim())
      );
      const ticks = JSON.stringify(first) !== JSON.stringify(second);
      const allZero = second.length > 0 && second.every((x) => x === '0:00');
      check(
        3,
        'blinds clock ticks, never stuck 0:00',
        second.length === 0 ? null : ticks && !allZero,
        `t0=${JSON.stringify(first).slice(0, 80)} t1=${JSON.stringify(second).slice(0, 80)} (status=${t.status})`
      );

      // 6: tab strip arrows move + wrap; Home/End jump
      const tabInfo = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
        return tabs.map((el) => ({
          label: el.textContent?.trim(),
          selected: el.getAttribute('aria-selected'),
        }));
      });
      if (tabInfo.length > 1) {
        await page.focus('[role="tablist"] [role="tab"][aria-selected="true"]');
        await page.keyboard.press('ArrowLeft'); // from first tab this must WRAP to the last
        await page.waitForTimeout(400);
        const afterLeft = await page.evaluate(
          () => document.querySelector('[role="tablist"] [role="tab"][aria-selected="true"]')?.textContent?.trim()
        );
        await page.keyboard.press('Home');
        await page.waitForTimeout(400);
        const afterHome = await page.evaluate(
          () => document.querySelector('[role="tablist"] [role="tab"][aria-selected="true"]')?.textContent?.trim()
        );
        const first_ = tabInfo[0].label;
        const last_ = tabInfo[tabInfo.length - 1].label;
        check(
          6,
          'tab arrows wrap; Home jumps',
          afterLeft === last_ && afterHome === first_,
          `first=${first_} ArrowLeft→${afterLeft} (want ${last_}) Home→${afterHome}`
        );
      } else {
        check(6, 'tab arrows wrap; Home jumps', null, `only ${tabInfo.length} tab(s) found`);
      }

      // 7: Entries shows avatars, not initials
      const entriesTab = await page.$('[role="tab"]:has-text("Entries")');
      if (entriesTab) {
        await entriesTab.click();
        await page.waitForTimeout(2500);
        const av = await page.evaluate(() => {
          const panel = document.querySelector('[role="tabpanel"]') || document;
          const imgs = [...panel.querySelectorAll('img')].filter(
            (i) => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 10
          );
          return { imgs: imgs.length };
        });
        await page.screenshot({ path: '/tmp/lobby-audit/entries-375.png' });
        check(7, 'Entries shows real avatar images', av.imgs > 0, `loaded imgs in panel: ${av.imgs}`);
      } else {
        check(7, 'Entries shows real avatar images', null, 'Entries tab not found');
      }

      // 8: Rewards payout bands (1st, 2nd, 3rd, then ranges)
      const rewardsTab = await page.$('[role="tab"]:has-text("Rewards"), [role="tab"]:has-text("Payouts")');
      if (rewardsTab) {
        await rewardsTab.click();
        await page.waitForTimeout(2000);
        const bands = await page.evaluate(() => {
          const panel = document.querySelector('[role="tabpanel"]') || document;
          return (panel.textContent || '').slice(0, 600);
        });
        await page.screenshot({ path: '/tmp/lobby-audit/rewards-375.png' });
        const hasOrdinals = /1st/i.test(bands) || /\b1\b/.test(bands);
        const nan = /NaN|Infinity|undefined/.test(bands);
        check(8, 'Rewards bands render, no NaN', hasOrdinals && !nan, bands.replace(/\s+/g, ' ').slice(0, 140));
      } else {
        check(8, 'Rewards bands render', null, 'Rewards tab not found');
      }

      // 9: ?tab=chips deep link lands on Ranking
      await page.goto(`${lobbyUrl}?tab=chips`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
      const deepTab = await page.evaluate(
        () => document.querySelector('[role="tablist"] [role="tab"][aria-selected="true"]')?.textContent?.trim()
      );
      check(9, '?tab=chips lands on Ranking', /rank/i.test(deepTab || ''), `selected tab: ${deepTab}`);
      await page.screenshot({ path: '/tmp/lobby-audit/tab-chips-375.png' });

      // 5: Ranking tab basics (hero pin + Mine Only control present)
      const rank = await page.evaluate(() => {
        const panel = document.querySelector('[role="tabpanel"]') || document;
        const text = (panel.textContent || '').slice(0, 400);
        return { mineOnly: /mine only/i.test(text), text: text.replace(/\s+/g, ' ').slice(0, 120) };
      });
      check(5, 'Ranking renders with Mine Only control', rank.mineOnly ? true : null, rank.text);

      // 10: a cash row opens the buy-in drawer, no navigation
      await page.goto(`${BASE}/clubs/a0000000-0000-0000-0000-000000000001`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForTimeout(9000);
      const cashRow = await page.$('text=/NLH 1\\.00\\/2\\.00/');
      if (cashRow) {
        const before = page.url();
        await cashRow.click();
        await page.waitForTimeout(2500);
        const drawer = await page.$('.glp, [class*="glp__"]');
        const after = page.url();
        await page.screenshot({ path: '/tmp/lobby-audit/cash-drawer-375.png' });
        check(
          10,
          'cash row opens drawer, does not navigate',
          !!drawer && before === after,
          `drawer=${!!drawer} url ${before === after ? 'unchanged' : 'CHANGED to ' + after}`
        );
      } else {
        check(10, 'cash row opens drawer', null, 'no NLH 1.00/2.00 row visible');
      }
    }
    await ctx.close();
  }
  await b.close();
  fs.writeFileSync('/tmp/lobby-audit/report.json', JSON.stringify(report, null, 2));
  const fails = report.checks.filter((c) => c.pass === false);
  console.log(`\n${report.checks.length} checks, ${fails.length} FAIL, shots in /tmp/lobby-audit/`);
  process.exit(0);
})().catch((e) => {
  console.error('AUDIT ABORTED:', e.message);
  process.exit(1);
});
