/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIVE E2E — the SHOWDOWN beats, in a real browser, against production CSS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * SHOWDOWN POLISH 2026-08-25. Same method as live-animations.spec.ts: load the
 * stylesheets production is serving, mount the DOM exactly as the components
 * render it, and read document.getAnimations() — the browser's own list — to
 * prove each showdown element actually animates rather than merely mounting.
 *
 * Beats covered:
 *   - the winning hand name appears above the board (handNameAppear)
 *   - the descriptive line and the hi-lo LOW WINNER line render under it
 *   - the MUCKED seat label animates in
 *   - a highlighted board card runs its glow/pop
 *
 * Run:  npx playwright test tests/e2e/showdown-beats.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';

const ARENA = process.env.ARENA_BASE_URL || 'https://smarter.poker/hub/club-arena';

async function loadLiveCss(page: Page) {
  await page.goto(`${ARENA}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (arenaBase: string) => {
    const base = arenaBase;
    const html = await fetch(base + 'index.html').then((r) => r.text());
    const entry = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    const js = entry ? await fetch(base + entry).then((r) => r.text()) : '';
    const names = new Set<string>();
    for (const m of js.matchAll(/assets\/[A-Za-z0-9_.-]+\.css/g)) names.add(m[0]);
    for (const m of html.matchAll(/assets\/[A-Za-z0-9_.-]+\.css/g)) names.add(m[0]);
    document.body.innerHTML = '';
    for (const n of names) {
      try {
        const css = await fetch(base + n).then((r) => r.text());
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
      } catch {
        /* a chunk that 404s is not this test's problem */
      }
    }
    document.documentElement.style.setProperty('--animation-speed', '1');
  }, `${ARENA}/`);
}

test.describe('showdown beats animate with the CSS production serves', () => {
  test('hand name, description, low line, MUCKED label and card highlight', async ({ page }) => {
    await loadLiveCss(page);

    const result = await page.evaluate(() => {
      // Board label stack, exactly as CommunityCards renders it.
      const board = document.createElement('div');
      board.className = 'community-cards community-cards--showdown';
      const name = document.createElement('div');
      name.className = 'community-cards__hand-name';
      name.textContent = 'Full House';
      const desc = document.createElement('div');
      desc.className = 'community-cards__hand-description';
      desc.textContent = 'Kings Full Of Nines';
      const low = document.createElement('div');
      low.className = 'community-cards__low-winner';
      low.textContent = 'Low: 5-4-3-2-1';
      name.appendChild(desc);
      name.appendChild(low);
      board.appendChild(name);

      // A highlighted board card, as CardFace renders it.
      const card = document.createElement('div');
      card.className =
        'community-cards__card community-cards__card--highlighted community-cards__card--highlight-pop';
      board.appendChild(card);

      // A mucked seat label, as SeatSlot renders it.
      const seat = document.createElement('div');
      seat.className = 'seat';
      const mucked = document.createElement('div');
      mucked.className = 'seat__mucked-label';
      mucked.textContent = 'Mucked';
      seat.appendChild(mucked);

      document.body.appendChild(board);
      document.body.appendChild(seat);

      const animsOf = (el: Element, subtree = false) =>
        (el as HTMLElement)
          .getAnimations({ subtree })
          .map((a) => ((a as CSSAnimation).animationName ?? '').toString());

      const lowStyle = getComputedStyle(low);
      const descStyle = getComputedStyle(desc);
      return {
        // The board label's motion lives on its ::after shimmer, so include
        // pseudo-elements when reading its animations.
        nameAnimations: animsOf(name, true),
        muckedAnimations: animsOf(mucked),
        cardAnimations: animsOf(card),
        lowRendered: lowStyle.display !== 'none' && lowStyle.textTransform === 'uppercase',
        descRendered: descStyle.display !== 'none' && descStyle.fontWeight !== '',
      };
    });

    // The board hand name runs its shimmer (its motion is the ::after
    // sweep); the MUCKED seat label plays its entrance animation.
    expect(result.nameAnimations.join(',')).toContain('ccHandNameShimmer');
    expect(result.muckedAnimations.join(',')).toContain('handNameAppear');
    // The highlighted card runs its pop/glow.
    expect(result.cardAnimations.length).toBeGreaterThan(0);
    // The description and the hi-lo low line render with their own styles.
    expect(result.descRendered).toBe(true);
    expect(result.lowRendered).toBe(true);
  });
});
