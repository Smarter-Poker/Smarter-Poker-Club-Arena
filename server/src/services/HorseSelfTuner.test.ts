/**
 * V12 HORSE SELF-TUNER — the per-horse self-improvement loop.
 * Pins the pure halves: hand-history measurement (VPIP/PFR/3-bet/fold-to-
 * 3-bet/WWSF/AF/net-bb) and the diagnose->nudge mapping with its bounds.
 */

import { describe, it, expect } from 'vitest';
import {
  accumulatePlayStats,
  diagnoseAndNudge,
  statSnapshot,
  MIN_HANDS_TO_TUNE,
  type HandRow,
  type PlayStats,
} from './HorseSelfTuner.js';

const a = (userId: string, action: string, amount: number, stage = 'preflop') => ({
  userId,
  action,
  amount,
  stage,
  seat: 0,
});

/** hero opens 6, villain 3-bets to 20, hero folds. Blinds sb/bb seats 1/2. */
const foldTo3BetHand = (): HandRow => ({
  actions: [
    a('hero', 'raise', 6),
    a('villain', 'raise', 20),
    a('sb', 'fold', 0),
    a('bb', 'fold', 0),
    a('hero', 'fold', 0),
  ],
  players: [
    { userId: 'hero', seat: 3 },
    { userId: 'villain', seat: 4 },
    { userId: 'sb', seat: 1 },
    { userId: 'bb', seat: 2 },
  ],
  winners: [{ userId: 'villain', amount: 15 }],
  big_blind: 2,
  button_seat: 6,
});

/** hero opens, bb calls, hero c-bets flop and wins. */
const wwsfWinHand = (): HandRow => ({
  actions: [
    a('hero', 'raise', 6),
    a('bb', 'call', 4),
    a('bb', 'check', 0, 'flop'),
    a('hero', 'bet', 8, 'flop'),
    a('bb', 'fold', 0, 'flop'),
  ],
  players: [
    { userId: 'hero', seat: 3 },
    { userId: 'bb', seat: 2 },
    { userId: 'sb', seat: 1 },
  ],
  winners: [{ userId: 'hero', amount: 13 }],
  big_blind: 2,
  button_seat: 6,
});

describe('HorseSelfTuner V12 — measurement', () => {
  it('computes VPIP, PFR, fold-to-3-bet, WWSF and postflop AF from real action shapes', () => {
    const tracked = new Set(['hero']);
    const stats = new Map<string, PlayStats>();
    accumulatePlayStats([foldTo3BetHand(), wwsfWinHand()], tracked, stats);
    const s = stats.get('hero')!;
    expect(s.hands).toBe(2);
    expect(s.vpip).toBe(2);
    expect(s.pfr).toBe(2);
    expect(s.openRaises).toBe(2);
    expect(s.faced3Bets).toBe(1);
    expect(s.foldTo3Bets).toBe(1);
    expect(s.sawFlop).toBe(1); // only the wwsf hand reached the flop
    expect(s.wonWhenSawFlop).toBe(1);
    expect(s.postAggr).toBe(1); // the flop c-bet
    // untracked players never pollute the map
    expect(stats.has('villain')).toBe(false);
    expect(stats.has('bb')).toBe(false);
  });

  it('net bb accounts for contributions, blinds, and winnings', () => {
    const tracked = new Set(['hero', 'bb']);
    const stats = new Map<string, PlayStats>();
    accumulatePlayStats([wwsfWinHand()], tracked, stats);
    // hero: contributed 6 (open) + 8 (c-bet) = 14, won 13 -> net -1 chip = -0.5bb
    expect(stats.get('hero')!.netBB).toBeCloseTo(-0.5, 5);
    // bb: posted 2, called 4 more, folded -> net -6 chips = -3bb
    expect(stats.get('bb')!.netBB).toBeCloseTo(-3, 5);
  });

  it('survives malformed hands without throwing', () => {
    const tracked = new Set(['hero']);
    const stats = new Map<string, PlayStats>();
    accumulatePlayStats(
      [
        { actions: null, players: null, winners: null, big_blind: null, button_seat: null },
        { actions: [{}] as never, players: [], winners: [], big_blind: 'x', button_seat: 1 },
        wwsfWinHand(),
      ],
      tracked,
      stats
    );
    expect(stats.get('hero')!.hands).toBe(1);
  });
});

describe('HorseSelfTuner V12 — diagnosis and bounded nudges', () => {
  const base = (over: Partial<PlayStats> = {}): PlayStats => ({
    hands: 1000,
    vpip: 250, // 25% — in band
    pfr: 200,
    threeBets: 40,
    threeBetOpps: 400,
    openRaises: 150,
    foldTo3Bets: 20,
    faced3Bets: 40, // 50% — in band
    sawFlop: 400,
    wonWhenSawFlop: 180, // 45% wwsf — in band
    postAggr: 300,
    postPassive: 200, // AF 1.5 — in band
    netBB: 50,
    ...over,
  });

  it('a winning horse inside every benchmark gets no change', () => {
    const r = diagnoseAndNudge(base(), {});
    expect(r.mods.tightness).toBe(1);
    expect(r.mods.aggression).toBe(1);
    expect(r.mods.bluffFreq).toBe(1);
    expect(r.reasons).toEqual(['within winning benchmarks - no change']);
  });

  it('too-loose tightens, too-tight loosens', () => {
    expect(diagnoseAndNudge(base({ vpip: 380 }), {}).mods.tightness).toBeGreaterThan(1);
    expect(diagnoseAndNudge(base({ vpip: 150 }), {}).mods.tightness).toBeLessThan(1);
  });

  it('folding to every 3-bet raises aggression and lowers tightness', () => {
    const r = diagnoseAndNudge(base({ foldTo3Bets: 32 }), {}); // 80% fold-to-3bet
    expect(r.mods.aggression).toBeGreaterThan(1);
    expect(r.mods.tightness).toBeLessThan(1);
    expect(r.reasons.join(' ')).toContain('fold-to-3bet');
  });

  it('low WWSF adds bluff volume; high WWSF trims it', () => {
    expect(diagnoseAndNudge(base({ wonWhenSawFlop: 140 }), {}).mods.bluffFreq).toBeGreaterThan(1);
    expect(diagnoseAndNudge(base({ wonWhenSawFlop: 230 }), {}).mods.bluffFreq).toBeLessThan(1);
  });

  it('nudges are bounded: many nights of the same leak cannot escape the caps', () => {
    let mods = {};
    for (let night = 0; night < 40; night++) {
      mods = diagnoseAndNudge(base({ vpip: 380, postPassive: 500, postAggr: 100 }), mods).mods;
    }
    const m = mods as { tightness: number; aggression: number; bluffFreq: number };
    expect(m.tightness).toBeLessThanOrEqual(1.18);
    expect(m.tightness).toBeGreaterThanOrEqual(0.85);
    expect(m.aggression).toBeLessThanOrEqual(1.18);
  });

  it('a big losing sample regresses dials toward neutral', () => {
    const r = diagnoseAndNudge(base({ netBB: -200 }), { tightness: 1.1, aggression: 0.9, bluffFreq: 1.12 });
    expect(r.mods.tightness).toBeLessThan(1.1);
    expect(r.mods.aggression).toBeGreaterThan(0.9);
    expect(r.reasons.join(' ')).toContain('regress');
  });

  it('small samples never move dials', () => {
    const r = diagnoseAndNudge(base({ hands: MIN_HANDS_TO_TUNE - 1, vpip: 200 }), {});
    expect(r.reasons[0]).toContain('sample too small');
  });

  it('snapshot rates are sane', () => {
    const snap = statSnapshot(base());
    expect(snap.vpip).toBeCloseTo(0.25, 4);
    expect(snap.wwsf).toBeCloseTo(0.45, 4);
    expect(snap.bb100).toBeCloseTo(5, 4);
  });
});
