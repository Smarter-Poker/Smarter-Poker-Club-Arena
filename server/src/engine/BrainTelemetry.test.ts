/**
 * PROOF OF RECEIPT — the telemetry gate and the counters.
 * The whole point is that ONLY live decisions count: a league burst faking
 * "the fleet uses layer X" would defeat the instrument.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  enableBrainTelemetry,
  noteFire,
  telemetryOn,
  drainFires,
  restoreFires,
} from './BrainTelemetry.js';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { Card, SeatPlayer } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

function mkPlayer(cards: Card[]): SeatPlayer {
  return {
    seat: 1,
    user_id: 'hero',
    username: 'hero',
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  } as SeatPlayer;
}
const opp = (): SeatPlayer =>
  ({
    seat: 3,
    user_id: 'opp3',
    username: 'opp3',
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  }) as never as SeatPlayer;

function decideOnce(opts: Record<string, unknown>): void {
  seedFastRandom(4242);
  const hero = mkPlayer([c('A', 'spades'), c('K', 'spades')]);
  const gs: HorseGameStateV2 = {
    players: [hero, opp()],
    communityCards: [c('Q', 'hearts'), c('8', 'diamonds'), c('3', 'clubs')],
    pot: 12,
    currentBet: 0,
    minRaise: 2,
    stage: 'flop',
    gameVariant: 'nlh',
    bigBlind: 2,
    dealerSeat: 1,
    actionHistory: [],
    gameMode: 'cash',
    format: 'cash',
  } as HorseGameStateV2;
  HorseLogic.decide(hero, gs, 'balanced', {}, opts as never);
}

describe('BrainTelemetry', () => {
  beforeEach(() => {
    enableBrainTelemetry();
    drainFires();
  });

  it('counts and drains', () => {
    noteFire('x');
    noteFire('x');
    noteFire('y');
    const rows = drainFires();
    expect(rows).toContainEqual({ feature: 'x', fires: 2 });
    expect(rows).toContainEqual({ feature: 'y', fires: 1 });
    expect(drainFires()).toHaveLength(0);
  });

  it('restore merges a failed flush back', () => {
    noteFire('x');
    restoreFires([
      { feature: 'x', fires: 5 },
      { feature: 'z', fires: 1 },
    ]);
    const rows = drainFires();
    expect(rows).toContainEqual({ feature: 'x', fires: 6 });
    expect(rows).toContainEqual({ feature: 'z', fires: 1 });
  });

  it('the gate: only telemetry:true decisions count', () => {
    decideOnce({ mind: false }); // synthetic caller shape (league/tests)
    expect(drainFires()).toHaveLength(0);

    decideOnce({ telemetry: true });
    const rows = drainFires();
    const decide = rows.find((r) => r.feature === 'decide');
    expect(decide?.fires).toBe(1);
    expect(rows.some((r) => r.feature === 'decide_nlh')).toBe(true);
  });

  it('telemetryOn requires BOTH the boot switch and the opt-in', () => {
    expect(telemetryOn({ telemetry: true })).toBe(true);
    expect(telemetryOn({})).toBe(false);
    expect(telemetryOn(undefined)).toBe(false);
  });

  it('an Omaha live decision stamps the variant and the V15 layer when it runs', () => {
    seedFastRandom(777);
    const hero = mkPlayer([
      c('9', 'spades'),
      c('6', 'spades'),
      c('A', 'hearts'),
      c('J', 'diamonds'),
    ]);
    const gs: HorseGameStateV2 = {
      players: [hero, opp()],
      communityCards: [
        c('K', 'spades'),
        c('T', 'spades'),
        c('4', 'spades'),
        c('7', 'diamonds'),
        c('2', 'hearts'),
      ],
      pot: 40,
      currentBet: 20,
      minRaise: 20,
      stage: 'river',
      gameVariant: 'plo4',
      bigBlind: 2,
      dealerSeat: 3,
      actionHistory: [],
      gameMode: 'cash',
      format: 'cash',
    } as HorseGameStateV2;
    HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: true } as never);
    const rows = drainFires();
    expect(rows.some((r) => r.feature === 'decide_omaha')).toBe(true);
    expect(rows.some((r) => r.feature === 'v15_nut_status')).toBe(true);
  });
});

describe('league deep-reads harness', () => {
  it('sandboxed league hands accumulate mind read samples', async () => {
    const { playHand } = await import('../benchmark/HorseLeague.js');
    const { HorseMind } = await import('./HorseMind.js');
    const sb = HorseMind.createSandbox();
    for (let hnd = 0; hnd < 500; hnd++) {
      playHand(31000 + hnd * 7919, (hnd % 6) + 1, () => ({}), undefined, sb);
    }
    // Inside the sandbox, someone must have accumulated c-bet opportunities.
    const anyReads = HorseMind.runInSandbox(sb, () => {
      for (let s = 1; s <= 6; s++) {
        const ftc = HorseMind.foldToCbetOf(`league-${s}`);
        if (ftc !== null) return true;
      }
      return false;
    });
    expect(anyReads).toBe(true);
    // And NOTHING leaked into live memory.
    for (let s = 1; s <= 6; s++) {
      expect(HorseMind.foldToCbetOf(`league-${s}`)).toBeNull();
    }
  });
});
