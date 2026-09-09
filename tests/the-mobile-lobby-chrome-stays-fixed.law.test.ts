import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * THE THREE THINGS DAN PHOTOGRAPHED ON 2026-09-09, PINNED.
 *
 * Each of these shipped as a defect, was fixed in #4003, and is the kind of
 * change a later edit undoes without noticing - a zone nudged, a `position`
 * re-declared in a block that happens to come last, a safe-area padding put
 * back by somebody reading the iOS guidance rather than this file. 10.11 point
 * 4: the cause gets a test so the next agent cannot reintroduce it.
 *
 * Every assertion here is measured against the file, not against a memory of
 * it, and the CSS is comment-stripped first: this file's own explanations
 * quote the declarations being forbidden, and a naive grep would find them.
 */

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** CSS with every comment removed, so a quoted declaration cannot pass for a live one. */
const live = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Screen rules only. `@media print` ends this stylesheet with
 * `.bottomNav { display: none }`, and a naive last-rule-wins read picks that
 * one up and asserts the screen layout against the printer.
 */
const onScreen = (css: string) => css.replace(/@media\s+print\s*\{[^{}]*\{[^{}]*\}[^{}]*\}/g, '');

/** The LAST declaration of a property for a selector is the one that wins. */
function lastRuleFor(css: string, selector: string): string {
  const stripped = onScreen(live(css));
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...stripped.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  expect(matches.length, `no rule found for ${selector}`).toBeGreaterThan(0);
  return matches[matches.length - 1][1];
}

describe('the My Wallets count line', () => {
  const CSS = read('src/pages/ClubHomeMobilePremium.css');
  const PAGE = read('src/pages/ClubHomePage.tsx');
  const WALLET = read('src/components/wallet/DynamicWallet.tsx');

  /**
   * Dan, verbatim: it "shouldn't say LOADING BALANC. It should just have 5
   * BALANCES or how ever many wallets that user has only."
   */
  it('never prints the word Loading into the plate', () => {
    expect(PAGE).not.toContain('Loading Balances');
    const bay = PAGE.slice(PAGE.indexOf('lobby-wallets-trigger__copy'));
    const small = bay.slice(bay.indexOf('<small>'), bay.indexOf('</small>'));
    expect(small).toContain('visibleWalletCount > 0');
    // The fallback is empty. An empty bay for one frame is honest; a word that
    // has to be taken back is what he photographed.
    expect(small).toMatch(/:\s*''/);
    expect(small.toLowerCase()).not.toContain('loading');
  });

  /**
   * The count is decided by the viewer's ROLE, not by their money, so it does
   * not wait on a fetch that a dropped connection can strand. It is published
   * from a LAYOUT effect, before paint, which is what stopped a placeholder
   * feeling necessary in the first place.
   */
  it('publishes the count before paint, and before the loading skeleton returns', () => {
    expect(WALLET).toContain('useLayoutEffect');
    const publish = WALLET.indexOf('onVisibleWalletCountChange?.(visibleWalletCount)');
    const skeleton = WALLET.indexOf('if (loading || (effectiveVariant');
    const count = WALLET.indexOf('const visibleWalletCount = rows.length');
    expect(publish, 'the count publish disappeared').toBeGreaterThan(0);
    expect(skeleton, 'the loading skeleton disappeared').toBeGreaterThan(0);
    expect(count, 'the count is no longer derived from rows').toBeGreaterThan(0);
    // Order is the whole mechanism: computed, then published, then the early
    // return. Move the publish below the skeleton and the bay goes empty.
    expect(count).toBeLessThan(publish);
    expect(publish).toBeLessThan(skeleton);
    const effect = WALLET.slice(WALLET.lastIndexOf('useLayoutEffect', publish), publish);
    expect(effect, 'the publish is back on a post-paint useEffect').toContain('useLayoutEffect');
  });

  /**
   * "ALL FONTS AND BUTTONS MUST BE CENTERED INSIDE THEIR FRAMES" (Dan). The
   * painted MY WALLETS title's optical centre is 54.65% of the plate, measured
   * off the my-wallets-v1 master. The zone must be symmetric about it, and it
   * must actually centre TEXT: `place-items` centres grid items, and the count
   * is a bare text node, which is an anonymous item that fills the cell and is
   * then laid out by `text-align`.
   */
  it('is centred on the painted title, by text-align and not by place-items alone', () => {
    const body = lastRuleFor(CSS, '.club-home--unified-mobile .lobby-wallets-trigger__copy small');
    expect(body).toContain('text-align: center');

    const left = Number(body.match(/left:\s*([\d.]+)%/)?.[1]);
    const width = Number(body.match(/width:\s*([\d.]+)%/)?.[1]);
    expect(Number.isFinite(left) && Number.isFinite(width)).toBe(true);
    expect(left + width / 2).toBeCloseTo(54.65, 1);

    // 26.5% of the plate is 96.7px on a 393px phone, and the string it had to
    // hold was 109.7px. Anything that narrow clips again.
    expect(width).toBeGreaterThanOrEqual(40);
    // ...and the bay it sits in ends at the chevron divider, near 78%.
    expect(left + width).toBeLessThanOrEqual(78);
  });
});

describe('the lobby filter row', () => {
  const SORT = read('src/components/lobby/LobbySortBar.css');
  const TOP = read('src/components/lobby/ClubLobbyCommandTop.tsx');

  /**
   * Dan, verbatim: it "should lock under the FIND YOUR GAME row when it scrolls
   * up, it should not be able to scroll past that."
   */
  it('sticks under the selector deck, at an offset that is measured and not guessed', () => {
    const body = lastRuleFor(SORT, '.lobby-sortbar');
    expect(body).toContain('position: sticky');
    expect(body).toMatch(/--ca-global-header-height/);
    expect(body).toMatch(/--ca-lobby-controls-h/);
    // Under the deck's 30, so if the two ever meet this row passes beneath it.
    const z = Number(body.match(/z-index:\s*(\d+)/)?.[1]);
    expect(z).toBeLessThan(30);
  });

  it('the deck measures and publishes the height the row reads', () => {
    expect(TOP).toContain('--ca-lobby-controls-h');
    expect(TOP).toContain('useLayoutEffect');
    expect(TOP).toContain('ResizeObserver');
    // A route without this deck must not inherit the last value it saw.
    expect(TOP).toContain('removeProperty');
  });
});

describe('the global footer', () => {
  const CSS = read('src/components/club/ClubBottomNav.module.css');

  /**
   * Dan, verbatim: "THE FOOTER NEEDS TO BE LOCKED TO THE BOTTOM OF THE PAGE,
   * THERE SHOULDN'T BE A GAP BELOW IT WHERE YOU CAN SEE ANYTHING BELOW THE
   * FOOTER."
   */
  it('reserves no transparent strip under the frame', () => {
    const nav = lastRuleFor(CSS, '.bottomNav');
    // The safe area was reserved INSIDE this transparent box, below the
    // artwork, and the lobby scrolled through it. A desktop reports 0 for that
    // inset, which is why it survived review; an iPad reports about 20px.
    expect(live(CSS)).not.toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom/);
    // Any slack from the touch floor falls ABOVE the frame instead.
    expect(nav).toContain('justify-content: flex-end');
    expect(nav).toMatch(/flex-direction:\s*column/);
  });

  /**
   * The strip is CLOSED, not COVERED. A black skirt under the frame was
   * written first and thrown away: `footer-clearance.test.ts` forbids an opaque
   * backdrop here, and that is Dan's 2026-09-04 clipping rule. This restates it
   * beside the fix so the next person to meet a gap does not reach for paint.
   */
  it('is still transparent, so the fix cannot come back as a painted skirt', () => {
    expect(lastRuleFor(CSS, '.bottomNav')).toContain('background: transparent');
    expect(live(CSS)).not.toContain('background: #000');
  });
});
