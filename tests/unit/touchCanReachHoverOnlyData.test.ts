/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DATA THAT ONLY A POINTER COULD REACH
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Hover was removed estate-wide on 2026-08-29 (tests/no-hover-effects.law.test.ts).
 * That pass deliberately kept the `onMouseEnter` handlers that deliver DATA
 * rather than paint — chart and heatmap readouts, the training range viewer,
 * the two Tooltip components — on the grounds that they are information, not
 * decoration.
 *
 * They were still only reachable with a pointer. Club Arena is mobile-first
 * (CLAUDE.md section 10 rule 6) and a phone has no `mouseenter`, so on the
 * device most of this product is used from, every one of these delivered its
 * content to nobody:
 *
 *   Tooltip (common)      handlers for focus/blur on a <span> with no tabIndex,
 *                         so focus never landed on it and the pair never fired
 *   Tooltip (tooltips)    mouse handlers only, on a plain <div>
 *   ActivityHeatmap       the count and date lived in a mouseenter handler
 *   RangeViewer           the frequency IS the tool, and it was hover-gated
 *   PositionalRadar       axis focus, and the table row that highlights it
 *   PositionWinRates      the per-position readout on an SVG circle
 *
 * Each now answers to tap and to keyboard as well, and is focusable so that the
 * focus handlers mean something. `HoleCardHeatmap` already had a click route
 * and is asserted here so it cannot lose it.
 *
 * WHAT THIS PINS is the ROUTE, not the implementation: that a non-pointer user
 * can reach the same content. If you replace a handler with a better mechanism,
 * move the pin to it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Files whose data was reachable by pointer only. */
const SURFACES = [
  'components/common/Tooltip.tsx',
  /* components/tooltips/Tooltip.tsx was DELETED 2026-09-05: a second Tooltip
     nothing imported, unreachable from main/App/ClubArenaRoot and absent from
     the built bundle. The surface it guarded no longer exists. */
  'components/common/ActivityHeatmap.tsx',
  'components/training/RangeViewer.tsx',
  'components/stats/PositionalRadar.tsx',
  'components/stats/PositionWinRates.tsx',
  'components/stats/HoleCardHeatmap.tsx',
] as const;

describe('every hover-driven readout has a non-pointer route', () => {
  for (const file of SURFACES) {
    it(`${file} answers to something other than a mouse`, () => {
      const src = strip(read(file));
      // It must still have the pointer route -- this is not a removal.
      expect(src, `${file} lost its pointer route`).toMatch(/onMouseEnter/);
      // ...and at least one route a finger or a keyboard can take.
      const hasTap = /onClick=/.test(src);
      const hasFocus = /onFocus=/.test(src);
      expect(hasTap || hasFocus, `${file} is still pointer-only`).toBe(true);
    });

    it(`${file} makes the element it listens on actually focusable`, () => {
      // The bug in components/common/Tooltip.tsx exactly: focus and blur
      // handlers on a bare <span>. Nothing focuses a span, so the handlers had
      // never once fired on their own -- the intent was there and the effect
      // was not.
      const src = strip(read(file));
      if (!/onFocus=/.test(src)) return; // tap-only is a legitimate answer
      const focusable = /tabIndex=/.test(src) || /<button/.test(src);
      expect(focusable, `${file} has onFocus but nothing that can take focus`).toBe(true);
    });
  }

  it('a tooltip opened by tap can be closed again', () => {
    // A pointer user moves away. A finger cannot, so an open-only toggle traps
    // the tooltip on screen.
    // components/tooltips/Tooltip.tsx was DELETED 2026-09-05 with the rest of
    // components/tooltips/, which no module imported and which never reached
    // the built bundle. One Tooltip remains and it is the one this checks.
    for (const file of ['components/common/Tooltip.tsx']) {
      const src = strip(read(file));
      expect(src, `${file} has no dismiss route`).toMatch(/Escape/);
    }
  });
});

describe('dead assets and dead columns', () => {
  it('the duplicate satellite icon is gone and nothing imports it', () => {
    // 22,434 bytes of byte-identical duplicate, kept for one day so a stale JS
    // chunk would not draw a broken image. No importer, and no reference in the
    // bundle currently serving.
    const badge = read('components/tournament/details/SatelliteSeatBadge.tsx');
    expect(badge).toContain('satellite-winner-v3.png');
    expect(strip(badge)).not.toContain('satellite-seat-icon.png');
  });

  it('nothing reads profiles.streak_days, which is zero on every row', () => {
    // A dead column stays alive because the next person greps, finds a reader,
    // and assumes it means something. SettingsPage fetched it into a data
    // export and never read the value.
    const settings = strip(read('pages/SettingsPage.tsx'));
    expect(settings).not.toContain('streak_days');
  });

  /* REMOVED 2026-09-05 with the component it guarded.
     `.lock-overlay` lived in VIPBenefitsGrid.css, which drew the six-rung VIP
     ladder - bronze through an invented "royal" - with a padlock on every rung
     the player had not reached. Nothing implemented any rung, so the grid, its
     stylesheet and this case were deleted together (see
     tests/vip-is-not-a-ladder.law.test.ts, which now pins their absence).
     The bug this case recorded is still worth knowing: the overlay's opacity
     was 0, lifted to 1 only by `.benefit-card.locked:hover`, so the padlock had
     never once appeared on a phone. */
});
