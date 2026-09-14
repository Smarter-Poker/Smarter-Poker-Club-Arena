import { describe, expect, it } from 'vitest';
import { captureHorsePublicDeductions as capture } from './HorsePublicDeductions.js';
import { HandController } from './HandController.js';
import { calculateRake } from './PokerEngine.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const config = (): HandConfig => ({
  tableId: 'offline-deductions',
  handNumber: 1,
  gameVariant: 'nlh',
  smallBlind: 1,
  bigBlind: 2,
  rakeConfig: {
    percent: 8,
    cap: 10,
    noFlopNoDrop: true,
    playerCountCaps: [
      { players: 2, cap: 3 },
      { players: 6, cap: 10 },
    ],
  },
  bbjConfig: { enabled: true, feeBB: 0.25, minPotBB: 20, minPlayersDealt: 3 },
});

describe('public deductions use the controller rules at the action', () => {
  it('freezes the full public rules and preserves exact tier order', () => {
    const c = config();
    const snapshot = capture(c);
    expect(snapshot).toMatchObject({
      status: 'captured',
      rules: 'controller-rake-bbj-v1',
      rake: {
        percent: 8,
        cap: 10,
        noFlopNoDrop: true,
        playerCountCaps: [
          [2, 3],
          [6, 10],
        ],
      },
      bbj: { enabled: true, feeBB: 0.25, minPotBB: 20, minPlayersDealt: 3 },
    });
    if (snapshot.status !== 'captured') throw Error('missing rules');
    for (const value of [
      snapshot,
      snapshot.rake,
      snapshot.rake.playerCountCaps,
      ...snapshot.rake.playerCountCaps,
      snapshot.bbj,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    c.rakeConfig.percent = 3;
    c.rakeConfig.playerCountCaps![0].cap = 99;
    c.bbjConfig!.feeBB = 1;
    expect(snapshot.rake.percent).toBe(8);
    expect(snapshot.rake.playerCountCaps[0][1]).toBe(3);
    expect(snapshot.bbj?.feeBB).toBe(0.25);
  });

  it('records rules that retain the canonical heads-up ceiling, cap and no-flop behavior', () => {
    const c = config(),
      snapshot = capture(c);
    if (snapshot.status !== 'captured') throw Error('missing rules');
    const restored = {
      ...snapshot.rake,
      playerCountCaps: snapshot.rake.playerCountCaps.map(([players, cap]) => ({ players, cap })),
    };
    for (const players of [2, 3, 6, 9])
      for (const pot of [1, 14.55, 40, 200, 1000])
        for (const flop of [false, true])
          expect(calculateRake(pot, flop, restored, players)).toBe(
            calculateRake(pot, flop, c.rakeConfig, players)
          );
    expect(calculateRake(40, true, restored, 2)).toBe(2);
    expect(calculateRake(40, true, restored, 6)).toBe(3.2);
    expect(calculateRake(1000, true, restored, 2)).toBe(3);
    expect(calculateRake(1000, false, restored, 6)).toBe(0);
  });

  it('captures changes at the next accepted action without retroactively changing earlier nodes', () => {
    const c = config();
    const players: SeatPlayer[] = [1, 2, 3].map((seat) => ({
      seat,
      user_id: `u${seat}`,
      username: 'private-name',
      stack: 200,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    }));
    const controller = new HandController(c, players, 1);
    const events: Extract<HandEvent, { type: 'PLAYER_ACTION' }>[] = [];
    controller.onEvent((e) => {
      if (e.type === 'PLAYER_ACTION') events.push(e);
    });
    controller.start();
    expect(controller.performAction(1, 'call', undefined, 'player')).toBe(true);
    c.rakeConfig.percent = 3;
    expect(controller.performAction(2, 'call', undefined, 'player')).toBe(true);
    const first = events[0].publicNode,
      second = events[1].publicNode;
    if (first?.status !== 'captured' || second?.status !== 'captured') throw Error('nodes missing');
    expect(first.deductions).toMatchObject({ status: 'captured', rake: { percent: 8 } });
    expect(second.deductions).toMatchObject({ status: 'captured', rake: { percent: 3 } });
    expect(JSON.stringify(first.deductions)).not.toMatch(/private-name|cards|user_id/);
    expect(controller.getState().actionHistory.every((a) => a.publicNode === undefined)).toBe(true);
  });

  it('keeps absent BBJ explicit and unsupported timed rake out of model pricing', () => {
    const c = config();
    delete c.bbjConfig;
    expect(capture(c)).toMatchObject({ status: 'captured', bbj: null });
    c.rakeConfig.timedRake = { amountPerMinute: 0.2 };
    expect(capture(c)).toEqual({
      version: 1,
      status: 'unavailable',
      reason: 'timed_rake_unsupported',
    });
  });

  it.each([NaN, Infinity, -1, 101])(
    'excludes invalid configured percent %s without changing the source',
    (percent) => {
      const c = config();
      c.rakeConfig.percent = percent;
      expect(capture(c)).toMatchObject({
        status: 'unavailable',
        reason: 'invalid_deduction_config',
      });
      expect(Object.is(c.rakeConfig.percent, percent)).toBe(true);
    }
  );

  it('rejects oversized/malformed tiers and jackpot rules rather than guessing rates', () => {
    const c = config();
    c.rakeConfig.playerCountCaps = Array.from({ length: 11 }, () => ({ players: 2, cap: 1 }));
    expect(capture(c).status).toBe('unavailable');
    c.rakeConfig.playerCountCaps = [{ players: 1, cap: 2 }];
    expect(capture(c).status).toBe('unavailable');
    c.rakeConfig.playerCountCaps = [];
    c.bbjConfig!.feeBB = NaN;
    expect(capture(c).status).toBe('unavailable');
  });
});
