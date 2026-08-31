/**
 * THE BLIND LADDER THE CREATE-TABLE FORM OFFERS.
 *
 * Lifted out of TableConfigPage on 2026-08-31 so the slider index and the
 * blinds can be reconciled by a pure function that a test can reach. The
 * page kept the presets as a local const and the slider position as a
 * SEPARATE useState, so any path that set the blinds without moving the
 * slider (a loaded template) left the thumb pointing at one preset while the
 * form held another, and the next nudge snapped to a neighbour of the WRONG
 * one.
 *
 * Note for whoever extends this: RakeConfig's RAKE_SCHEDULE does not cover
 * every row here. Adding a preset without a schedule row means the table is
 * priced off a tier default rather than the published schedule.
 */
export interface BlindsPreset {
  label: string;
  sb: number;
  bb: number;
}

export const BLINDS_PRESETS: readonly BlindsPreset[] = [
  { label: '0.01/0.02', sb: 0.01, bb: 0.02 },
  { label: '0.02/0.05', sb: 0.02, bb: 0.05 },
  { label: '0.05/0.10', sb: 0.05, bb: 0.1 },
  { label: '0.10/0.25', sb: 0.1, bb: 0.25 },
  { label: '0.25/0.50', sb: 0.25, bb: 0.5 },
  { label: '0.50/1', sb: 0.5, bb: 1 },
  { label: '1/2', sb: 1, bb: 2 },
  { label: '2/5', sb: 2, bb: 5 },
  { label: '5/10', sb: 5, bb: 10 },
  { label: '10/25', sb: 10, bb: 25 },
  { label: '25/50', sb: 25, bb: 50 },
  { label: '50/100', sb: 50, bb: 100 },
];

/** 0.05/0.10 — the preset the form starts on. */
export const DEFAULT_BLINDS_INDEX = 2;

/**
 * THE LADDER A FIXED-LIMIT TABLE MAY BE BUILT ON.
 *
 * A limit game's whole bet ladder is derived from the big blind —
 * fixedLimitBetSize() makes the small bet one BB preflop and on the flop, and
 * the big bet 2x BB on the turn and river — and stakesLabel() names the table
 * by those BET sizes: blinds 1/2 is a "2/4" limit game. The small blind is not
 * a term in either.
 *
 * So on a preset where the big blind is NOT twice the small blind, the label
 * and the table disagree: an FLO8 table stored as small_blind 0.1,
 * big_blind 0.25 is labelled "0.25/0.50" in tables.stakes, on its lobby row
 * and in its header, and the 0.10 a player actually posts appears NOWHERE.
 * The database guard accepts it — it only requires bb > sb > 0 — so nothing
 * downstream would ever have caught it.
 *
 * A limit game with a small blind that is not half the big blind is also not
 * a structure anyone plays. Restricting the ladder is therefore the honest
 * fix, rather than teaching the label to carry a blind the format does not
 * have. Verified 2026-08-31: zero fixed-limit cash tables exist, so nothing
 * live is relabelled by this.
 */
export const LIMIT_BLINDS_PRESETS: readonly BlindsPreset[] = BLINDS_PRESETS.filter(
  (p) => Math.abs(p.bb - p.sb * 2) < 1e-9
);

/** The presets this variant may be built on. */
export function presetsFor(isFixedLimit: boolean): readonly BlindsPreset[] {
  return isFixedLimit ? LIMIT_BLINDS_PRESETS : BLINDS_PRESETS;
}

/** Money compares badly in binary; 1e-9 is far below a chip. */
const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/**
 * The slider position that EXACTLY matches these blinds, or null when the
 * pair is off the ladder. Null is a real answer: a template saved before a
 * preset changed carries blinds no slider position can represent, and
 * pretending otherwise is what produced the desynced thumb.
 */
export function blindsIndexFor(
  smallBlind: number,
  bigBlind: number,
  presets: readonly BlindsPreset[] = BLINDS_PRESETS
): number | null {
  const i = presets.findIndex((p) => same(p.sb, smallBlind) && same(p.bb, bigBlind));
  return i === -1 ? null : i;
}

/**
 * The closest preset by big blind, on a log scale so 0.02 -> 0.05 counts the
 * same distance as 50 -> 100. Ties resolve to the lower (cheaper) preset:
 * snapping a player's stakes UP costs them money, snapping down does not.
 */
export function nearestBlindsIndex(
  bigBlind: number,
  presets: readonly BlindsPreset[] = BLINDS_PRESETS
): number {
  if (!Number.isFinite(bigBlind) || bigBlind <= 0) {
    return Math.min(DEFAULT_BLINDS_INDEX, presets.length - 1);
  }
  let best = 0;
  let bestDistance = Infinity;
  presets.forEach((preset, i) => {
    const distance = Math.abs(Math.log(preset.bb) - Math.log(bigBlind));
    if (distance < bestDistance - 1e-12) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}
