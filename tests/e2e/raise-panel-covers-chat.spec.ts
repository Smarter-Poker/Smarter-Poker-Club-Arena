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

test('the open raise panel covers the chat button and keeps its taps', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.setContent(html);

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('.action-panel--raise')!.getBoundingClientRect();
    const chat = document.querySelector('#chat')!.getBoundingClientRect();
    const onTop = document.elementFromPoint(chat.x + chat.width / 2, chat.y + chat.height / 2);
    return {
      panelHeight: panel.height,
      chatInsidePanel: chat.y + chat.height > panel.y,
      /* The element that would receive the tap at the chat button's centre. */
      tapLandsInPanel: !!onTop && !!onTop.closest('.action-panel--raise'),
      tapLandsOnChat: onTop?.id === 'chat',
    };
  });

  /* The premise: the open panel really is taller than the 112px line. If a
     future redesign shrinks it under 112px the overlap disappears and this
     spec's other assertions become vacuous — surface that instead of
     silently passing. */
  expect(geometry.panelHeight).toBeGreaterThan(112);
  expect(geometry.chatInsidePanel).toBe(true);

  /* The fix: the panel wins the overlap. */
  expect(geometry.tapLandsInPanel).toBe(true);
  expect(geometry.tapLandsOnChat).toBe(false);
});
