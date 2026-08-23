/** Verifies the three mobile-fit CSS fixes against the real stylesheets at 375px. NOT COMMITTED. */
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ROOT = process.env.CA_ROOT || process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const css =
  read('src/pages/FriendsPage.css') +
  '\n' +
  read('src/pages/HandHistoryPage.css') +
  '\n' +
  read('src/pages/TableCreationPage.css');

const html = `<style>${css}
* { animation: none !important; } body { margin: 0; background: #111; }
.wrap { width: 375px; overflow: visible; }
</style>
<div class="wrap">
  <div class="friends-tabs" id="tabs">
    <button>Friends</button><button>Requests</button><button>Blocked</button>
    <button class="fr-filter-chip">Online</button>
    <button class="fr-filter-chip">At Table</button>
    <button class="fr-filter-chip">Recently Active</button>
  </div>
  <div class="hand-footer" id="footer">
    <span class="stakes">5/10</span>
    <span class="players">6 Players</span>
    <button class="analyze-btn">Analyze</button>
    <button class="share-btn">Share</button>
    <button class="replay-btn">Replay</button>
  </div>
  <div class="custom-stakes" id="stakes" style="padding: 0 16px">
    <div class="stake-input"><label>SB</label><input type="number" value="5"></div>
    <span class="stake-divider">/</span>
    <div class="stake-input"><label>BB</label><input type="number" value="10"></div>
  </div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
await page.setContent(html);
const out = await page.evaluate(() => {
  const r = (id) => {
    const el = document.getElementById(id);
    const b = el.getBoundingClientRect();
    return {
      right: Math.round(b.right),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      maxChildRight: Math.round(
        Math.max(...Array.from(el.querySelectorAll('*')).map((c) => c.getBoundingClientRect().right))
      ),
    };
  };
  return { tabs: r('tabs'), footer: r('footer'), stakes: r('stakes'), vw: window.innerWidth };
});
console.log(JSON.stringify(out, null, 1));
const ok =
  out.tabs.right <= 375 && // container fits (chips scroll inside)
  out.footer.maxChildRight <= 375 && // buttons wrapped
  out.stakes.maxChildRight <= 375; // inputs shrank
console.log(ok ? 'ALL FIXES HOLD' : 'FIX FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
