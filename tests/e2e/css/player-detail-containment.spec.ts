import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const recordCSS = readFileSync(resolve('src/pages/MemberManagementPage.css'), 'utf8');
const statsCSS = readFileSync(resolve('src/pages/PlayerStatisticsPage.css'), 'utf8');

for (const width of [375, 393, 768]) {
  test(`player detail controls fit the application shell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.setContent(`<style>${recordCSS}${statsCSS}
      *, *::before, *::after { box-sizing: border-box; }
      html, body { margin: 0; }
      .application-shell { width: calc(100% - ${width > 720 ? 97 : 32}px); margin: auto; }
    </style><main class="application-shell">
      <section class="member-mgmt-page">
        <header class="mm-header"><button class="mm-back" aria-label="Go Back">‹</button></header>
        <section class="mm-credential"><div class="mm-credential__content">Player Record</div></section>
        <div class="mm-ledger-grid">
          <section class="mm-range"><div class="mm-range__tabs"><button>Overall</button><button>7 Days</button><button>Custom</button></div>
            <div class="mm-range__custom"><label class="mm-date"><span>From</span><input type="date" value="2026-10-01" /></label><label class="mm-date"><span>To</span><input type="date" value="2026-10-11" /></label><button class="mm-range__confirm">Confirm</button></div></section>
          <section class="mm-card mm-stats"><h2 class="mm-card__title">Downline</h2><div class="mm-downline"><button class="mm-downline__row"><span class="mm-downline__names"><span class="mm-downline__alias">River Shark</span></span><span class="mm-downline__number">No. 2050</span><span class="mm-downline__fees">123,456.78</span><span class="mm-downline__open">›</span></button><p class="mm-downline__more">Showing 60 Of 207<button class="mm-downline__show-more">Show 60 More</button></p></div></section>
          <section class="mm-card mm-roles"><div class="mm-roles__confirm"><p>Change River Shark To Agent?</p><div class="mm-roles__rates"><label class="mm-field"><span class="mm-field__label">Agent Rakeback Percent (0 To 70)</span><input type="number" value="40" /></label><p class="mm-roles__rates-note">This Rate Covers The Agent Account And Every Sub Agent Under Them. The Agent Sets The Rakeback Their Players Receive From Their Agent Dashboard.</p></div><div class="mm-roles__confirm-actions"><button class="mm-roles__confirm-yes">Confirm</button><button class="mm-roles__confirm-no">Cancel</button></div></div></section>
        </div>
      </section>
      <section class="player-stats-page"><header class="ps-hero"><div class="ps-hero__content">Player Statistics</div></header><section class="ps-controls"><label class="ps-variant"><span>Game</span><select><option>No Limit Holdem</option></select></label><div class="ps-range__tabs"><button>Overall</button><button>Week</button><button>Month</button><button>Custom</button></div><div class="ps-range__custom"><label class="ps-date"><span>From</span><input type="date" value="2026-10-01" /></label><label class="ps-date"><span>To</span><input type="date" value="2026-10-11" /></label><button class="ps-range__confirm">Confirm</button></div></section><div class="ps-cards"><section class="ps-card">Volume</section></div></section>
    </main>`);
    await page.evaluate(() => document.fonts.ready);
    for (const root of ['.member-mgmt-page', '.player-stats-page']) {
      const frame = await page.locator(root).boundingBox();
      const shell = await page.locator('.application-shell').boundingBox();
      expect(frame!.x).toBeGreaterThanOrEqual(shell!.x - 0.5);
      expect(frame!.x + frame!.width).toBeLessThanOrEqual(shell!.x + shell!.width + 0.5);
      for (const panel of await page.locator(`${root} > *`).all()) {
        const box = await panel.boundingBox();
        expect(box!.x, `${root} panel clips left`).toBeGreaterThanOrEqual(frame!.x - 0.5);
        expect(box!.x + box!.width, `${root} panel clips right`).toBeLessThanOrEqual(
          frame!.x + frame!.width + 0.5
        );
      }
      for (const control of await page
        .locator(`${root} input, ${root} select, ${root} button`)
        .all()) {
        const box = await control.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(frame!.x - 0.5);
        expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.5);
        const containingPanel = await control.evaluate((node) => {
          const panel = node.closest('.mm-range, .mm-card, .ps-controls, .mm-header')!;
          const own = node.getBoundingClientRect();
          const outer = panel.getBoundingClientRect();
          return own.left >= outer.left - 0.5 && own.right <= outer.right + 0.5;
        });
        expect(containingPanel, 'control escapes its own inner panel').toBe(true);
        expect(
          await control.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
          await control.evaluate(
            (node) =>
              `${node.outerHTML} clips its own content: ${node.scrollWidth}/${node.clientWidth}`
          )
        ).toBe(true);
      }
    }
  });
}
