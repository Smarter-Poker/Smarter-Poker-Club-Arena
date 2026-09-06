/**
 * V45 (2026-09-05) - A READ IS SCOPED TO THE GAME IT WAS LEARNED IN
 *
 * From the deep audit: "Reads are one bucket per player. A player's PLO6
 * VPIP (~60% by structure) pollutes their NLH read; their HU stats pollute
 * 6-max." The scoped overlay is fed by the same observation, read in
 * preference at 40 hands, persisted like the pooled row, and the recency
 * window stays pooled.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HorseMind, readScopeOf, SCOPE_MIN_HANDS } from './HorseMind.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { ActionRecord, HandStage, SeatPlayer } from '../types.js';

beforeEach(() => {
  seedFastRandom(0x45);
  HorseMind.reset();
});

function rec(
  seat: number,
  action: ActionRecord['action'],
  amount: number,
  stage: HandStage,
  ts: number,
  extra: Partial<ActionRecord> = {}
): ActionRecord {
  return { seat, userId: `p-${seat}`, action, amount, timestamp: ts, stage, ...extra };
}

/** One hand where p-3 opens and everyone folds; distinct timestamp per hand. */
function openFoldHand(n: number): ActionRecord[] {
  const t0 = 1_700_000_000_000 + n * 100_000;
  return [
    rec(1, 'sb' as ActionRecord['action'], 1, 'preflop', t0),
    rec(2, 'bb' as ActionRecord['action'], 2, 'preflop', t0 + 100),
    rec(3, 'raise', 6, 'preflop', t0 + 200, { isFullRaise: true }),
    rec(1, 'fold', 0, 'preflop', t0 + 300),
    rec(2, 'fold', 0, 'preflop', t0 + 400),
  ];
}
/** One hand where p-1 opens and p-3 CALLS (a station). */
function stationHand(n: number): ActionRecord[] {
  const t0 = 1_700_300_000_000 + n * 100_000;
  return [
    rec(1, 'raise', 6, 'preflop', t0, { isFullRaise: true }),
    rec(2, 'fold', 0, 'preflop', t0 + 100),
    rec(3, 'call', 6, 'preflop', t0 + 200),
    rec(1, 'bet', 8, 'flop', t0 + 300, { isFullRaise: true }),
    rec(3, 'call', 8, 'flop', t0 + 400),
  ];
}
/** One hand where p-1 opens and p-3 FOLDS (a nit). */
function foldHand(n: number): ActionRecord[] {
  const t0 = 1_700_500_000_000 + n * 100_000;
  return [
    rec(1, 'raise', 6, 'preflop', t0, { isFullRaise: true }),
    rec(2, 'fold', 0, 'preflop', t0 + 100),
    rec(3, 'fold', 0, 'preflop', t0 + 200),
  ];
}

describe('V45 scope', () => {
  it('names the card family and the table size', () => {
    expect(readScopeOf('nlh', 6)).toBe('holdem:full');
    expect(readScopeOf('plo6', 2)).toBe('omaha:hu');
    expect(readScopeOf('plo4', 4)).toBe('omaha:short');
    expect(readScopeOf('short_deck', 9)).toBe('holdem:full');
    expect(readScopeOf('flo8', 3)).toBe('omaha:short');
    expect(readScopeOf(undefined, 0)).toBe('holdem:hu');
  });

  it('the same observation feeds the pooled bucket and the scoped bucket, and only the scope in flight', () => {
    HorseMind.setDecisionScope('omaha:full');
    for (let i = 0; i < 3; i++) HorseMind.observe(openFoldHand(i), []);
    HorseMind.setDecisionScope(null);
    const pooled = HorseMind.getStats('p-3')!;
    const omaha = HorseMind.getScopedStats('p-3', 'omaha:full')!;
    expect(pooled.hands).toBe(3);
    expect(pooled.pfr).toBe(3);
    expect(omaha.hands).toBe(3);
    expect(omaha.pfr).toBe(3);
    expect(HorseMind.getScopedStats('p-3', 'holdem:full')).toBeUndefined();
    // recency stays pooled
    expect(omaha.rHands).toBe(0);
    expect(pooled.rHands).toBeGreaterThan(0);
  });

  it('a read prefers the scoped bucket at 40 hands and the pooled one below', () => {
    // 50 Omaha hands where p-3 calls everything (a station in Omaha)
    HorseMind.setDecisionScope('omaha:full');
    for (let i = 0; i < 50; i++) HorseMind.observe(stationHand(i), []);
    // 50 hold em hands where p-3 folds to every open (a nit in hold em)
    HorseMind.setDecisionScope('holdem:full');
    for (let i = 0; i < 50; i++) HorseMind.observe(foldHand(i), []);
    HorseMind.setDecisionScope(null);
    const pooled = HorseMind.getStats('p-3')!;
    expect(pooled.hands).toBe(100);
    expect(pooled.folds).toBe(50);
    expect(pooled.passive).toBe(100);
    // in an Omaha decision the read sees a station; in a hold em one, a nit
    HorseMind.setDecisionScope('omaha:full');
    const omahaExploit = HorseMind.exploit('p-3', false);
    HorseMind.setDecisionScope('holdem:full');
    const holdemExploit = HorseMind.exploit('p-3', false);
    HorseMind.setDecisionScope(null);
    const pooledExploit = HorseMind.exploit('p-3', false);
    // bluff a station less than a nit
    expect(omahaExploit.bluffMod).toBeLessThan(holdemExploit.bluffMod);
    // the pooled read (a 50% folder) sits at or between the two
    expect(pooledExploit.bluffMod).toBeGreaterThanOrEqual(omahaExploit.bluffMod);
    expect(pooledExploit.bluffMod).toBeLessThan(holdemExploit.bluffMod);
    // a scope with too few hands falls back to pooled
    HorseMind.setDecisionScope('omaha:hu');
    expect(HorseMind.exploit('p-3', false)).toEqual(pooledExploit);
    HorseMind.setDecisionScope(null);
    expect(SCOPE_MIN_HANDS).toBe(40);
  });

  it('decide() sets the scope from the hand and clears it on every exit', () => {
    const hero = {
      seat: 2,
      user_id: 'h',
      username: 'h',
      stack: 200,
      bet: 2,
      totalInvested: 2,
      cards: [
        { rank: 'A', suit: 'hearts' },
        { rank: 'K', suit: 'hearts' },
      ],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
    } as SeatPlayer;
    const villain = { ...hero, seat: 3, user_id: 'v', bet: 6, stack: 194, cards: [] } as SeatPlayer;
    const gs = {
      players: [hero, villain],
      communityCards: [],
      pot: 9,
      currentBet: 6,
      minRaise: 4,
      stage: 'preflop' as HandStage,
      gameVariant: 'plo4',
      bigBlind: 2,
      dealerSeat: 3,
      gameMode: 'cash' as const,
      format: 'cash',
      actionHistory: [rec(3, 'raise', 6, 'preflop', 1_700_900_000_000, { isFullRaise: true })],
    } as unknown as HorseGameStateV2;
    HorseLogic.decide(hero, gs, 'balanced', {}, {});
    expect(HorseMind.currentScope()).toBeNull();
    // the observation made inside decide() landed in omaha:hu
    expect(HorseMind.getScopedStats('p-3', 'omaha:hu')?.pfr ?? 0).toBe(1);
    // a throw still clears it
    const broken = { ...gs, players: null } as unknown as HorseGameStateV2;
    HorseLogic.decide(hero, broken, 'balanced', {}, {});
    expect(HorseMind.currentScope()).toBeNull();
  });

  it('settlement observation lands the deep reads in the scoped bucket too', () => {
    const t0 = 1_701_000_000_000;
    const actions = [
      rec(2, 'bb' as ActionRecord['action'], 2, 'preflop', t0),
      rec(3, 'raise', 6, 'preflop', t0 + 1000, { isFullRaise: true }),
      rec(2, 'call', 4, 'preflop', t0 + 2000),
      rec(2, 'check', 0, 'flop', t0 + 3000),
      rec(3, 'bet', 8, 'flop', t0 + 4000, { isFullRaise: true }),
      rec(2, 'fold', 0, 'flop', t0 + 5000),
    ];
    HorseMind.observeHandComplete('t:1', actions, 2, null, 'holdem:short');
    expect(HorseMind.currentScope()).toBeNull();
    expect(HorseMind.getStats('p-2')!.cbetOpps).toBe(1);
    expect(HorseMind.getScopedStats('p-2', 'holdem:short')!.cbetOpps).toBe(1);
    expect(HorseMind.getScopedStats('p-2', 'holdem:short')!.cbetFolds).toBe(1);
    expect(HorseMind.getScopedStats('p-2', 'holdem:full')).toBeUndefined();
  });

  it('export / import round-trip keeps the scoped rows and never downgrades memory', () => {
    HorseMind.setDecisionScope('holdem:full');
    for (let i = 0; i < 5; i++) HorseMind.observe(openFoldHand(i), []);
    HorseMind.setDecisionScope(null);
    const rows = HorseMind.exportDirtyScoped();
    const row = rows.find((r) => r.user_id === 'p-3')!;
    expect(row.scope).toBe('holdem:full');
    expect(row.hands).toBe(5);
    expect(HorseMind.dirtyScopedCount()).toBe(0);
    // a stale snapshot does not downgrade
    expect(
      HorseMind.importScoped([{ user_id: 'p-3', scope: 'holdem:full', hands: 2, pfr: 1 }])
    ).toBe(0);
    expect(HorseMind.getScopedStats('p-3', 'holdem:full')!.hands).toBe(5);
    // a richer one applies
    expect(
      HorseMind.importScoped([{ user_id: 'p-9', scope: 'omaha:hu', hands: 60, vpip: 40 }])
    ).toBe(1);
    expect(HorseMind.getScopedStats('p-9', 'omaha:hu')!.vpip).toBe(40);
    // requeue puts a flushed row back
    HorseMind.requeueDirtyScoped([{ user_id: 'p-3', scope: 'holdem:full' }]);
    expect(HorseMind.dirtyScopedCount()).toBe(1);
  });
});
