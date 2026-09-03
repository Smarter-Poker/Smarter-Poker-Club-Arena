/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ENTRIES LIST HAS TO FIT INSIDE ITS OWN PANEL AT 375px
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The 2026-08-28 flex-fill change removed `.et-scroll`'s `max-height` cap so the
 * list fills the panel instead of leaving 340px of void beside a scrollbar. It
 * was measured on an 860px desktop panel, and its own note then reasoned onto a
 * phone: "the fill is correct on a phone for the same reason it is correct
 * here."
 *
 * RENDERED AT 375x812 ON PRODUCTION, it was not:
 *
 *     .et-panel          321px
 *       .tl-section-head  18px
 *       .et-stats        128px    <- 40% of the panel
 *       .et-scroll       160px    <- its own min-height, NOT what was available
 *
 * Setting the floor to 0 in the live page dropped the list to 129px, which is
 * the truth: it was overflowing its parent by 31px and being held up by the
 * minimum. The panel had switched its own overflow on to cope, so the reader
 * got TWO nested scrollbars — the exact shape the flex-fill change existed to
 * remove — and about 2.7 of 49 rows.
 *
 * The cause was the stat grid, not the list. `.tl-stat-grid` is shared and asks
 * for `repeat(auto-fit, minmax(104px, 1fr))`; at a 309px inner width that
 * resolves to TWO columns, so Entries' THREE tiles took two rows with the second
 * half empty.
 *
 * Measured again after the fix, same page, same viewport:
 *
 *     stat grid   128px -> 64px      (one row of three)
 *     list        160px -> 195px     (and no longer propped: floor removed
 *                                     leaves it at 195, not 129)
 *     panel nested scrollbar  yes -> no
 *     visible rows            2.7 -> 4.1
 *
 * WHAT THIS PINS. jsdom does not lay out, so this cannot re-measure. It pins the
 * two rules the measurement produced, and the invariant that made the bug
 * possible: a floor larger than the space available is not a floor, it is an
 * overflow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(
  join(__dirname, '..', '..', 'src/components/tournament/details/EntriesTab.css'),
  'utf8'
);

/** Comments quote the old values; every assertion reads the rules only. */
const code = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The text of the `@media (max-width: 480px)` block, braces balanced. */
function phoneBlock(css: string): string {
  const at = css.indexOf('@media (max-width: 480px)');
  if (at < 0) return '';
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

/** Last `min-height` declared for a selector inside a block. */
function minHeightOf(block: string, selector: string): string | null {
  const at = block.lastIndexOf(selector + ' {');
  if (at < 0) return null;
  const body = block.slice(at, block.indexOf('}', at));
  const m = body.match(/min-height:\s*([^;]+);/);
  return m ? m[1].trim() : null;
}

const px = (v: string | null): number => (v ? parseFloat(v) : NaN);

describe('the entries list fits inside its panel on a phone', () => {
  const phone = phoneBlock(code);

  it('has a phone block at all', () => {
    // Zero-length is zero violations found; assert the block was located
    // before trusting anything read out of it.
    expect(phone.length).toBeGreaterThan(0);
  });

  it('puts the three stat tiles on ONE row', () => {
    // The shared auto-fit resolves to two columns at this width, which cost
    // 64px to a half-empty second row on the screen with the least to spare.
    const at = phone.lastIndexOf('.et-stats {');
    expect(at, '.et-stats is not overridden for phones').toBeGreaterThan(-1);
    const body = phone.slice(at, phone.indexOf('}', at));
    expect(body).toMatch(/grid-template-columns:\s*repeat\(3,/);
  });

  it('gives the list no floor at all, on any width (2026-08-30)', () => {
    /**
     * THIS USED TO ASSERT A LOWER FLOOR ON PHONES, and that was the right
     * shape while `.et-scroll` was itself the scroller: the list needed a
     * height, and the phone one had to be shorter than the desktop one.
     *
     * `.details-content` owns the scroll for every tab now, so the list is
     * free to be exactly as tall as its rows and a floor can only push the
     * panel's own content off the bottom. The old comment had already
     * reached the diagnosis - "a floor taller than the space available is
     * not a floor, it is an overflow" - and no floor is simply the whole of
     * that fix rather than half.
     *
     * So the guarantee is strictly stronger than the one it replaces: not
     * "the phone floor is lower" but "there is no floor to be too tall".
     */
    const base = px(
      minHeightOf(code.slice(0, code.indexOf('@media (max-width: 480px)')), '.et-scroll')
    );
    // A floor of 0 is the same statement as no floor; anything above it is
    // the regression.
    expect(Number.isFinite(base) ? base : 0).toBe(0);

    // And the phone block must not quietly reintroduce one.
    const onPhone = px(minHeightOf(phone, '.et-scroll'));
    expect(Number.isFinite(onPhone) ? onPhone : 0).toBe(0);
  });

  it('keeps the flex fill that used to need a floor behind it', () => {
    // With the floor gone (see above) the fill is the only thing sizing this
    // list inside its panel, which makes it MORE load-bearing than before,
    // not less. `max-height: none` matters for the same reason: the old
    // `min(58vh, 520px)` cap measured the viewport rather than the modal
    // sheet the list is rendered in.
    // The BASE rule, not the phone override. `lastIndexOf` finds the override,
    // which carries only a min-height -- the first draft of this case asserted
    // against that and failed for the wrong reason.
    const base = code.slice(0, code.indexOf('@media (max-width: 480px)'));
    const at = base.lastIndexOf('.et-scroll {');
    expect(at, 'no base .et-scroll rule').toBeGreaterThan(-1);
    const body = base.slice(at, base.indexOf('}', at));
    expect(body).toMatch(/flex:\s*1 1 auto/);
    expect(body).toMatch(/max-height:\s*none/);
  });

  it('leaves the panel able to shrink, so it never grows its own scrollbar', () => {
    // `min-height: 0` on the panel is what lets the list shrink inside it. A
    // flex item defaults to `min-height: auto` and refuses to go below its
    // content, which is how the nested scrollbar appeared.
    const at = code.lastIndexOf('.et-panel {');
    const body = code.slice(at, code.indexOf('}', at));
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });
});

describe('no sibling tab carries the same floor', () => {
  it('only EntriesTab sets a non-zero min-height on a scroll container', () => {
    // RankingTab's `.rk-list` uses `min-height: 0` plus a max-height cap, so it
    // can always shrink and cannot prop itself past its parent. This is the
    // check that the fix was needed in one place and not six.
    const dir = join(__dirname, '..', '..', 'src/components/tournament/details');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
      if (f === 'EntriesTab.css') continue;
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const re = /\.[\w-]*scroll[\w-]*\s*\{([^}]*)\}/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const mh = m[1].match(/min-height:\s*([0-9.]+)px/);
        if (mh && parseFloat(mh[1]) > 0) offenders.push(`${f}: ${m[0].slice(0, 40)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
