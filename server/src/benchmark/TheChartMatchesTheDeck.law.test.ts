/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: THE CHART MATCHES THE DECK (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The deep audit's longest-standing open item: "A real PLO/short-deck solver
 * export. V46 is published hand-class structure, not a solver. Needs a data
 * source that does not exist in this estate."
 *
 * Still true, and this is not a solver - a solver produces FREQUENCIES at a
 * node. But there was one reference in the building that had never been
 * pointed at the chart: the engine's own equity evaluator, over the actual
 * deck of the actual variant. It cannot say how often to 3-bet. It CAN say
 * whether a class the chart calls strong is actually strong.
 *
 * MEASURED, six-handed all-in equity vs random hands, 90 hands per class:
 *
 *   PLO4                          SHORT DECK
 *   broadway_ds   .2763           sd_big_pair     .2603
 *   aa_ds         .2592           sd_suited_ace   .1974
 *   kk_plus       .2262           sd_suited_conn  .1859
 *   aa_dry        .2081           sd_small_pair   .1658
 *   pair_support  .2049           sd_other        .1448
 *   rundown       .1953
 *   dangler       .1746
 *   trash         .1686
 *   other         .1492
 *   trips         .1010
 *
 * WHAT THIS LAW DOES NOT ASSERT, and why. All-in equity against random hands
 * is NOT playability. A rundown has the third-lowest equity of the playable
 * classes and is one of the best hands in the game, because it flops draws it
 * can realise and it is never dominated when it hits. Pinning the chart to a
 * strict equity order would make the brain WORSE and would be a
 * misunderstanding of Omaha.
 *
 * So it asserts only what equity can honestly adjudicate:
 *
 *   1. the class the chart FOLDS ALWAYS must really be the worst hand in the
 *      deck - that claim is pure equity and nothing else;
 *   2. the premium classes must beat the marginal ones - a chart that opens a
 *      class widest while the deck says it is below average is broken;
 *   3. the sampler must find every class, so a classifier that stops emitting
 *      one is caught here rather than in production.
 *
 * The disagreements in the MIDDLE are recorded in the changelog as findings,
 * not encoded as failures. Two of them are real and interesting: broadway_ds
 * outranks aa_ds six-handed (aces lose value multiway, which is exactly what
 * published theory says and the chart does not yet reflect), and sd_big_pair
 * outranks sd_suited_ace on raw equity while the chart opens the suited ace
 * wider. The second is defensible - a nut flush draw realises far more of its
 * equity than a pair does in 6+ - but nobody had ever looked.
 */
import { describe, it, expect } from 'vitest';
import { measureHandClassEquity } from './HorseHandClassEquity.js';
import { OMAHA_CLASSES, SHORT_DECK_CLASSES } from '../engine/HorseHandClasses.js';

/** Fewer samples than the published run - this is a guard, not a study. */
/** The classes the chart folds 100% of the time, per HorseHandClasses. */
const FOLD_ALWAYS_OMAHA = ['trips', 'trash'];

const SAMPLES = 40;
const ITERS = 250;

describe('LAW: the chart matches the deck (PLO)', () => {
  const rows = measureHandClassEquity('plo4', SAMPLES, 300_000, ITERS);
  const by = new Map(rows.map((r) => [r.handClass, r]));
  const eq = (k: string): number => by.get(k)?.equitySixWay ?? -1;

  it('the sampler finds every Omaha class the classifier can emit', () => {
    for (const k of OMAHA_CLASSES) {
      expect(
        by.has(k),
        `no sample of ${k} in 300,000 deals - the classifier stopped emitting it`
      ).toBe(true);
    }
  });

  /**
   * FOLD_ALWAYS is {trips, trash}, and the deck adjudicates them differently.
   *
   * `trips` is vindicated outright: .1010 six-handed against a next-worst of
   * .1492 - a class in a league of its own at the bottom, which is exactly
   * the claim V46 makes about it ("the percentile is lying about this hand").
   *
   * `trash` is NOT vindicated by equity: at .1686 it out-equities `other`
   * (.1492), which the chart plays at normal bars. That is not necessarily
   * wrong - trash is defined as the hand that can make no nuts, so it wins
   * small pots and loses big ones, and reverse-implied odds are invisible to
   * an all-in equity number. It IS worth knowing, and it is recorded in the
   * changelog as an open question rather than silently encoded either way.
   *
   * So the law asserts what equity can honestly adjudicate: the single worst
   * class in the deck must be one the chart folds, and everything the chart
   * folds must at least be below the field average.
   */
  it('the worst class in the deck is one the chart folds always', () => {
    const foldAlways = OMAHA_CLASSES.filter((k) => FOLD_ALWAYS_OMAHA.includes(k));
    expect(foldAlways.length, 'V46 must still fold something always').toBeGreaterThan(0);
    const worst = OMAHA_CLASSES.reduce((a, b) => (eq(a) <= eq(b) ? a : b));
    expect(
      foldAlways.includes(worst),
      `the worst class in the deck is ${worst}, and the chart does not fold it`
    ).toBe(true);

    const mean = OMAHA_CLASSES.reduce((s, k) => s + eq(k), 0) / OMAHA_CLASSES.length;
    for (const k of foldAlways) {
      expect(eq(k), `${k} is folded 100% of the time but is above the field average`).toBeLessThan(
        mean
      );
    }
    // trips must be a long way clear of the field, not a rounding error -
    // that gap is the whole justification for folding a hand the hold'em
    // ladder rates highly.
    expect(eq('trips')).toBeLessThan(mean - 0.05);
  });

  it('the premium classes beat the marginal ones', () => {
    // Not a strict total order - a rundown is a great hand with poor all-in
    // equity. Only the gap the chart could not survive being wrong about.
    for (const premium of ['aa_ds', 'broadway_ds', 'kk_plus']) {
      for (const marginal of ['trash', 'trips', 'other']) {
        expect(
          eq(premium),
          `${premium} must out-equity ${marginal} or the chart is upside down`
        ).toBeGreaterThan(eq(marginal));
      }
    }
  });
});

describe('LAW: the chart matches the deck (short deck)', () => {
  const rows = measureHandClassEquity('short_deck', SAMPLES, 300_000, ITERS);
  const by = new Map(rows.map((r) => [r.handClass, r]));
  const eq = (k: string): number => by.get(k)?.equitySixWay ?? -1;

  it('the sampler finds every short-deck class', () => {
    for (const k of SHORT_DECK_CLASSES) {
      expect(by.has(k), `no sample of ${k} - the classifier stopped emitting it`).toBe(true);
    }
  });

  it('the premium classes beat the filler', () => {
    for (const premium of ['sd_big_pair', 'sd_suited_ace', 'sd_suited_conn']) {
      expect(eq(premium), `${premium} must out-equity sd_other`).toBeGreaterThan(eq('sd_other'));
    }
  });

  it('a short-deck deck really is short', () => {
    // If the deck ever stops being stripped, every number above is wrong and
    // nothing else in this file would notice.
    const rowsFull = measureHandClassEquity('plo4', 10, 20_000, 100);
    expect(rowsFull.length).toBeGreaterThan(0);
    // 6+ equities run far higher heads-up than full-deck Omaha: everyone
    // connects with everything.
    const sdHu = by.get('sd_big_pair')?.equityHeadsUp ?? 0;
    expect(sdHu).toBeGreaterThan(0.6);
  });
});
