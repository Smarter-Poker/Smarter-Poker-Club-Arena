/**
 * V29 — pins for the finds made WHILE wiring the solver flop layer.
 *
 * The heads-up position inversion was found because the V29 consult missed
 * its cell in a test — the layer asked for the 'BB' chart with the dealer's
 * cards. That is the audit loop working: new wiring exposes old wiring.
 */
import { describe, it, expect } from 'vitest';
import { decidePreflopV7 } from './HorsePreflop.js';
import { HorseLogic } from './HorseLogic.js';
import type { Card, SeatPlayer } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

describe('the heads-up position inversion (V29 audit find)', () => {
  /**
   * classifyPosition's clockwise walk labels order[0] as 'sb' — true in a
   * ring, backwards heads-up where the DEALER posts the small blind. Every
   * two-handed table had SB and BB swapped: the bvb branch fired for the
   * wrong seat, V27 charts were consulted with positions inverted, V29 flop
   * cells missed or answered from the wrong side. The old line's own comment
   * said "dealer is SB" while the code did the opposite.
   */
  const players = [
    {
      seat: 1,
      user_id: 'nondealer',
      stack: 100,
      bet: 0,
      is_folded: false,
      is_sitting_out: false,
      cards: [c('2', 'hearts'), c('3', 'clubs')],
    },
    {
      seat: 3,
      user_id: 'dealer',
      stack: 100,
      bet: 0,
      is_folded: false,
      is_sitting_out: false,
      cards: [c('4', 'hearts'), c('5', 'clubs')],
    },
  ] as unknown as SeatPlayer[];

  it('the DEALER is the small blind heads-up; the other seat is the big blind', () => {
    // Pin via source, since classifyPosition is not exported.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = readFileSync(new URL('./HorseLogic.ts', import.meta.url).pathname, 'utf8');
    expect(src).toContain("if (n === 2) return heroSeat === dealerSeat ? 'sb' : 'bb';");
    expect(src).not.toContain("if (n === 2) return idx === 0 ? 'sb' : 'bb';");
    void players;
  });

  it('behavioral: the heads-up DEALER open-folds junk from the SB open threshold, not the BB defend', () => {
    // A dealer with 72o first to act heads-up: the SB open logic decides
    // (open ~0.24-0.44 bar -> junk folds or limps, never auto-checks as
    // "BB"). Before the fix the dealer classified 'bb' and with toCall>0
    // routed through BB defense thresholds.
    let checksAsBB = 0;
    for (let i = 0; i < 30; i++) {
      const d = HorseLogic.decide(
        players[1],
        {
          players,
          communityCards: [],
          pot: 3,
          currentBet: 2,
          minRaise: 4,
          stage: 'preflop',
          gameVariant: 'nlh',
          bigBlind: 2,
          dealerSeat: 3,
          actionHistory: [],
        } as never,
        'balanced',
        {},
        { v27GtoCharts: false }
      );
      // the dealer/SB has 1 to call — a 'check' would prove it thinks it is
      // the BB with the option
      if (d.action === 'check') checksAsBB++;
    }
    expect(checksAsBB).toBe(0);
  });
});

describe('V7 bvb fires for the actual small blind', () => {
  it('sb-labelled seat with oppsLeft 1 still reaches the bvb widened open', () => {
    // decidePreflopV7 is position-driven; this guards the contract the fix
    // restored: whoever classifyPosition calls "sb" heads-up IS the dealer,
    // and bvb widens their open. 0.30 strength opens at bvb (bar ~0.24-0.36),
    // folds at a full-ring sb bar (0.44) minus limp shelf.
    let opens = 0;
    for (let i = 0; i < 40; i++) {
      const d = decidePreflopV7({
        strength: 0.33,
        position: 'sb',
        raiserPosition: null,
        raises: 0,
        limpers: 0,
        callers: 0,
        oppsLeft: 1,
        toCall: 1,
        currentBet: 2,
        pot: 3,
        bigBlind: 2,
        stack: 200,
        stackBB: 100,
        tightness: 1,
        bluffFreq: 0.17,
        aggression: 1,
        slowplayFreq: 0.1,
        sizingMultiplier: 1,
        isOmaha: false,
        isPotLimit: false,
        riskAdd: 0,
        mode: 'cash',
        tableSize: 2,
        rand: () => (i % 10) / 10,
      } as never);
      if (d.a === 'raiseTo' || d.a === 'call') opens++;
    }
    expect(opens).toBeGreaterThan(25);
  });
});
