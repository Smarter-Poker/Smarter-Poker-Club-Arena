// Signed-out visitor page loads (passive): each page once, fresh context, no storage.
// Run from the repository root: node docs/evidence/profile-privacy-2026-10-01/signed-out-visit.mjs <url> [<url> ...]
// Reports document status, final URL, Supabase responses >= 400, and console errors that mention
// permission / 42501 / profiles.
import { chromium } from 'playwright';
const pages = process.argv.slice(2);
const browser = await chromium.launch();
const out = [];
for (const url of pages) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const bad = [];
  const cons = [];
  let sb = 0,
    sbProfiles = 0;
  page.on('response', async (r) => {
    const u = r.url();
    if (/supabase\.co|\/rest\/v1\/|\/auth\/v1\//.test(u)) {
      sb++;
      if (
        /profiles|get_public_profile|get_my_full_profile|fn_profile_presence|get_visible_live_streams/.test(
          u
        )
      )
        sbProfiles++;
      if (r.status() >= 400) {
        const body = await r.text().then(
          (t) => t.slice(0, 160),
          () => ''
        );
        bad.push(
          `${r.status()} ${r.request().method()} ${u.replace(/\?.*/, '').slice(0, 120)} ${body}`
        );
      }
    }
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && /permission|42501|profiles|denied/i.test(m.text()))
      cons.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => cons.push('pageerror: ' + String(e).slice(0, 200)));
  let status = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    status = resp ? resp.status() : null;
    await page.waitForTimeout(9000);
  } catch (e) {
    cons.push('nav: ' + String(e).slice(0, 160));
  }
  const title = await page.title().catch(() => '');
  const text = (
    await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')
  )
    .replace(/\s+/g, ' ')
    .slice(0, 140);
  out.push({
    url,
    status,
    final: page.url(),
    title,
    supabaseResponses: sb,
    profileResponses: sbProfiles,
    failed: bad,
    consoleErrors: cons,
    text,
  });
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 1));
