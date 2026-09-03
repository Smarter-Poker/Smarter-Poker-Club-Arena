/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HEADS-UP IS ANNOUNCED (Dan 2026-08-28, bug 8)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "WHEN TWO PLAYERS ARE HEADS UP IN AN MTT, IT SHOULD PLAY THE
 * 'HEADS UP' ANIMATION BEFORE THE HEADS UP MATCH BEGINS. NOTHING PLAYED."
 *
 * BUG 8 WAS BUG 9 WEARING A DIFFERENT HAT. The trigger was
 * `Number(elimData.position) === 3`, on the reasoning that the player who
 * busts 3rd leaves exactly two behind. That is true only while the finishing
 * ladder is exact, and in `Union PKO Afternoon (PLO4)` 4f42d847 it was not:
 * the ladder was seeded one short, so the player who left two behind was
 * stamped place TWO, the test was false, and nothing fired.
 *
 * The ladder is fixed (#1652). But a cosmetic announcement must never be the
 * thing that silently reports a bookkeeping drift, so the gate no longer
 * depends on one exact number. The AUTHORITY was always the query underneath
 * it, which counts who is genuinely still in and announces only on exactly
 * two; the place check is now just a cheap pre-filter wide enough to survive
 * an off-by-one in either direction.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const TABLEPAGE = read('src/pages/TablePage.tsx');
const OVERLAY = read('src/components/tournament/HeadsUpOverlay.tsx');
const MODALS = read('src/components/table/TableModalsLayer.tsx');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const CODE = code(TABLEPAGE);

describe('the announcement does not hang on one exact place number', () => {
  it('no longer gates on position === 3', () => {
    expect(CODE).not.toMatch(/Number\(elimData\.position\) === 3/);
  });

  it('uses a range that survives an off-by-one in either direction', () => {
    expect(CODE).toMatch(/elimPlace >= 2/);
    expect(CODE).toMatch(/elimPlace <= 4/);
  });

  it('still lets the player COUNT be the authority, not the place', () => {
    // Two players actually still in is the only thing that means heads-up.
    expect(CODE).toMatch(/\.eq\('status', 'playing'\)/);
    expect(CODE).toMatch(/rows\.length === 2/);
  });

  it('announces once per tournament, so the wider gate cannot double-fire', () => {
    expect(CODE).toMatch(/headsUpAnnouncedRef/);
    expect(CODE).toMatch(/headsUpAnnouncedRef\.current\.add\(tid\)/);
    expect(CODE).toMatch(/!headsUpAnnouncedRef\.current\.has\(/);
  });

  it('still stands down on a Spin', () => {
    // Dan 2026-08-23: "you never have to announce 'heads up' with an animation
    // or final table on a spin" - it is three-handed from the first card.
    expect(CODE).toMatch(/tournamentFormatRef\.current !== 'spin'/);
  });
});

describe('the overlay is still wired to something that emits', () => {
  it('listens for HEADS_UP_SWITCH', () => {
    expect(OVERLAY).toMatch(/useMasterBusSubscription\('HEADS_UP_SWITCH'/);
  });

  it('is actually mounted', () => {
    expect(MODALS).toMatch(/<HeadsUpOverlay/);
  });

  it('and TablePage is a real emitter of that event', () => {
    // The dead-wiring this replaced: the only other emitter was
    // TournamentTimerService.checkTableSize, which had zero callers.
    expect(CODE).toMatch(/masterBus\.emit\('HEADS_UP_SWITCH'/);
  });
});
