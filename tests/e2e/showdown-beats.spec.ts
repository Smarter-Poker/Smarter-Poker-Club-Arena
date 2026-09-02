/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIVE E2E — the SHOWDOWN beats, in a real browser, against production CSS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * SHOWDOWN POLISH 2026-08-25, rewritten for POKERBROS PARITY 2026-08-26. Same
 * method as live-animations.spec.ts: load the stylesheets production is
 * serving, mount the DOM exactly as the components render it, and read the
 * browser's own computed state to prove each showdown element behaves as the
 * measured reference does.
 *
 * Beats covered (all measured off the reference recording):
 *   - the banner enters with its hard-cut fade (ccBannerCut) and the hand
 *     name paints as clipped gradient text
 *   - the descriptive line and the hi-lo LOW WINNER line render under it
 *   - the MUCKED seat label animates in (handNameAppear)
 *   - a highlighted board card holds a STEADY warm-gold ring — no animation
 *   - a dimmed board card sits at the measured brightness(0.28)
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

test.describe('showdown beats match the measured reference with the CSS production serves', () => {
  test('banner cut, gradient name, steady highlight, 0.28 dim, MUCKED label', async ({ page }) => {
    await loadLiveCss(page);

    const result = await page.evaluate(() => {
      // Board label stack, exactly as CommunityCards renders it.
      const board = document.createElement('div');
      board.className = 'community-cards community-cards--showdown';
      const name = document.createElement('div');
      name.className = 'community-cards__hand-name';
      const nameText = document.createElement('span');
      nameText.className = 'community-cards__hand-name-text';
      nameText.textContent = 'Full House';
      const desc = document.createElement('div');
      desc.className = 'community-cards__hand-description';
      desc.textContent = 'Kings Full Of Nines';
      const low = document.createElement('div');
      low.className = 'community-cards__low-winner';
      low.textContent = 'Low: 5-4-3-2-1';
      name.appendChild(nameText);
      name.appendChild(desc);
      name.appendChild(low);
      board.appendChild(name);

      // A highlighted board card and a dimmed one, as CardFace renders them.
      const winCard = document.createElement('div');
      winCard.className = 'community-cards__card community-cards__card--highlighted';
      board.appendChild(winCard);
      const dimCard = document.createElement('div');
      dimCard.className = 'community-cards__card community-cards__card--dimmed';
      board.appendChild(dimCard);

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
      const winStyle = getComputedStyle(winCard);
      const dimStyle = getComputedStyle(dimCard);
      const textStyle = getComputedStyle(nameText);
      return {
        nameAnimations: animsOf(name, true),
        muckedAnimations: animsOf(mucked),
        // Reference-measured: the highlight is STEADY — a winning card must
        // run NO animation of its own (the entrance is the banner's cut).
        winCardAnimations: animsOf(winCard),
        winBoxShadow: winStyle.boxShadow,
        dimFilter: dimStyle.filter,
        nameClip:
          (textStyle as CSSStyleDeclaration & { webkitBackgroundClip?: string })
            .webkitBackgroundClip ?? textStyle.backgroundClip,
        lowRendered: lowStyle.display !== 'none' && lowStyle.textTransform === 'uppercase',
        descRendered: descStyle.display !== 'none' && descStyle.fontWeight !== '',
      };
    });

    // The banner enters with its hard cut; the MUCKED label animates in.
    expect(result.nameAnimations.join(',')).toContain('ccBannerCut');
    expect(result.muckedAnimations.join(',')).toContain('handNameAppear');
    // The winning card is steady (no animation) behind its warm-gold ring.
    expect(result.winCardAnimations.length).toBe(0);
    expect(result.winBoxShadow).toContain('rgb(233, 179, 85)');
    // The losing card sits at the measured dim.
    expect(result.dimFilter).toContain('brightness(0.28)');
    // The hand name paints as clipped gradient text.
    expect(result.nameClip).toBe('text');
    // The description and the hi-lo low line render with their own styles.
    expect(result.descRendered).toBe(true);
    expect(result.lowRendered).toBe(true);
  });
});
