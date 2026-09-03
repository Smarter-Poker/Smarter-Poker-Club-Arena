/**
 * Phase 4 (2026-08-22): the open raise panel must COVER the chat button, not
 * sit under it.
 *
 * The 112px widget line (TableHUD lower stack, chat button) clears the
 * COLLAPSED 3-button action bar by design. The OPEN raise panel is ~270px
 * tall at 375px, so everything on that line is inside it. The HUD renders
 * before the panel in the DOM, so its widgets are covered — correct. Chat
 * renders AFTER the panel and used to share its z-100, so the bubble floated
 * on top of the raise presets and stole their taps. TableChat now sits at
 * z-99, one below --z-action-panel.
 *
 * Same harness pattern as hero-card-row.spec.ts: the real stylesheets against
 * the markup the components emit, pure geometry, no server.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/*
 * TableHUD.css is in this list as of 2026-08-25, and the reason is the point of
 * the spec rather than a detail of it.
 *
 * The chat button's offset used to be a hardcoded 112px, so three stylesheets
 * were enough to place it. It is now `bottom: var(--sp-hud-line)`, and the only
 * declaration of that property lives on `.table-page` in TableHUD.css — which
 * this harness did not load, and under a markup root that this harness did not
 * have. An unresolved custom property does not degrade a `position: fixed`
 * offset, it deletes it: `bottom` computed to `auto` and the bubble jumped to
 * the top of the page, which read as "the panel no longer covers chat".
 *
 * So the harness now loads the sheet that declares the line and mounts the
 * markup inside `.table-page`, i.e. the real cascade. Keep it that way: a spec
 * that asserts geometry while loading only some of the stylesheets that produce
 * that geometry is measuring a page that never ships.
 */
const css =
  fs.readFileSync(path.join(process.cwd(), 'src/styles/design-tokens.css'), 'utf8') +
  '\n' +
  /* 2026-08-29: TablePage.css joined the list for the same reason TableHUD.css
     did on 2026-08-25 — the chat button's anchor moved again. --sp-hud-line
     reads --sp-action-reserve, and that reserve's only declaration now lives
     on .table-page in TablePage.css (the 2026-08-27 constant-reserve fix).
     Without it the line resolves from a fallback chain that no longer agrees
     with production, the bubble leaves the bar's neighbourhood, and this spec
     reports a covered-chat bug that does not exist. A geometry spec loads
     EVERY sheet that produces the geometry — that rule is written twenty
     lines up; this is the second time it was learned. */
  fs.readFileSync(path.join(process.cwd(), 'src/pages/TablePage.css'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(process.cwd(), 'src/components/table/ActionPanel.css'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(process.cwd(), 'src/components/table/TableHUD.css'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(process.cwd(), 'src/components/table/TableChat.css'), 'utf8');

const harness = `
  * { animation: none !important; transition: none !important; }
  body { margin: 0; }
`;

/* The raise-state panel as ActionPanel.tsx emits it (horizontal slider path),
   followed by the collapsed chat button — chat AFTER the panel, exactly the
   DOM order TablePage renders them in, because that order is half the bug. */
const html = `<style>${css}\n${harness}</style>
<div class="table-page">
<div class="action-panel action-panel--raise">
  <div class="raise-layout"><div class="raise-main">
    <div class="raise-header">
      <button class="raise-adjust raise-adjust--minus">-</button>
      <div class="raise-value"><span class="raise-value__amount">1,250</span><span class="raise-value__bb">12.5 BB</span></div>
      <button class="raise-adjust raise-adjust--plus">+</button>
    </div>
    <div class="raise-slider-wrap">
      <input type="range" class="raise-slider" min="0" max="100" value="40">
      <div class="raise-slider-ticks"></div>
    </div>
    <div class="raise-presets">
      <button class="raise-preset">2.5x</button>
      <button class="raise-preset">3x</button>
      <button class="raise-preset">Pot</button>
      <button class="raise-preset raise-preset--allin">All In</button>
    </div>
    <div class="raise-actions">
      <button class="raise-cancel">Cancel</button>
      <button class="raise-confirm">Raise 1,250</button>
    </div>
  </div></div>
</div>
<button class="chat-collapsed" id="chat">C</button>
</div>`;

test('the raise panel keeps its taps: chat is docked away and disarmed while raising', async ({
  page,
}) => {
  /* REWRITTEN 2026-08-29. The 2026-08-22 mechanism this spec pinned — chat at
     the bottom line, z-99 under the z-100 panel — was replaced twice over by
     Dan's own asks, and the spec ran in NO CI job so it kept asserting the
     dead version: on 2026-08-26 the collapsed bubble moved to the UPPER RIGHT
     on phones ("Move the messenger to the upper right corner", TableChat.css
     <=768px block), and TablePage.css's `.ca-raising` block now hides it
     outright (opacity 0, pointer-events none) while the raise panel is open.
     The BUG being guarded is unchanged — a chat bubble must never steal a
     raise tap — so the beats now pin the mechanisms that actually ship:
       1. at phone width the bubble docks top-right, out of the panel's band;
       2. while raising, a tap at the bubble's centre cannot land on chat.
     If either mechanism is replaced again, replace this pin IN THE SAME
     COMMIT (see the animations law's rule on moving pins with mechanisms). */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.setContent(html);

  const docked = await page.evaluate(() => {
    const chat = document.querySelector('#chat')!.getBoundingClientRect();
    const panel = document.querySelector('.action-panel--raise')!.getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector('#chat')!);
    return {
      chatTop: chat.y,
      chatAboveMid: chat.y + chat.height < window.innerHeight / 2,
      outsidePanel: chat.y + chat.height <= panel.y,
      bottomAuto: cs.bottom !== '' && chat.y < 120,
      panelHeight: panel.height,
    };
  });
  // The panel premise from the original spec: it is a real, tall panel.
  expect(docked.panelHeight).toBeGreaterThan(112);
  // 1. The bubble docks top-right, clear of the panel's band entirely.
  expect(docked.chatAboveMid).toBe(true);
  expect(docked.outsidePanel).toBe(true);

  // 2. And while raising, the bubble is disarmed even where it stands.
  const disarmed = await page.evaluate(() => {
    document.querySelector('.table-page')!.classList.add('ca-raising');
    const chat = document.querySelector('#chat')! as HTMLElement;
    const cs = getComputedStyle(chat);
    const r = chat.getBoundingClientRect();
    const onTop = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      pointerEvents: cs.pointerEvents,
      opacity: Number(cs.opacity),
      tapLandsOnChat: onTop?.id === 'chat',
    };
  });
  expect(disarmed.pointerEvents).toBe('none');
  expect(disarmed.opacity).toBe(0);
  expect(disarmed.tapLandsOnChat).toBe(false);
});
