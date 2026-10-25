import { describe, expect, it } from 'vitest';
import { cashRakeScope, MIDWAY_UNION_ID, scopedCashRake } from './cashRakePolicy.js';
import { getFullRakeConfig, getPlayerCountCaps, RAKE_SCHEDULE } from './RakeConfig.js';
import { ServerTableEngineBase } from '../engine/ServerTableEngineBase.js';
import { LightningHandHost } from '../lightning/LightningHandHost.js';
import { calculateRake } from '../engine/PokerEngine.js';
const variants = ['nlh', 'flh', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8', 'pineapple', 'short_deck'];
const stakes = [
  ...RAKE_SCHEDULE.map((r) => [r.sb, r.bb]),
  [0.02, 0.04],
  [1.5, 3],
  [2.5, 5],
  [200, 500],
];
describe('Midway cash policy, owner instruction 2026-10-21', () => {
  it('resolves direct union and member club scope before standalone permissions', () => {
    expect(cashRakeScope(MIDWAY_UNION_ID, null)).toBe('midway');
    expect(cashRakeScope(null, MIDWAY_UNION_ID)).toBe('midway');
    expect(cashRakeScope(null, null)).toBe('standalone');
    expect(cashRakeScope(undefined, undefined)).toBe('standard');
  });
  it.each(variants)('bounds every scheduled and unscheduled %s stake to 2.5 BB', (variant) => {
    for (const [sb, bb] of stakes) {
      for (const rakeCapBB of [undefined, -1, null, 0, 1, 2.5, 5, 999, NaN, Infinity]) {
        const full = getFullRakeConfig(sb, bb, variant, { scope: 'midway', rakeCapBB });
        const expectedBB =
          typeof rakeCapBB === 'number' && Number.isFinite(rakeCapBB) && rakeCapBB >= 0
            ? Math.min(rakeCapBB, 2.5)
            : 2.5;
        expect(full.rakeCap).toBe(Math.floor(bb * expectedBB * 100 + 1e-8) / 100);
        expect(full.rakeCap).toBeLessThanOrEqual(bb * 2.5 + 1e-9);
        expect(full.rakePercent).toBe(10);
        const old = getFullRakeConfig(sb, bb, variant);
        for (const key of [
          'bbjFeeBB',
          'bbjFeeDollars',
          'bbjEnabled',
          'bbjPayoutTotalPercent',
          'qualifyingHand',
          'rules',
        ] as const)
          expect(full[key]).toEqual(old[key]);
      }
    }
  });
  it('keeps 2.5 BB defaults and permits standalone custom rates and caps', () => {
    expect(getFullRakeConfig(5, 10, 'nlh', { scope: 'standalone' }).rakeCap).toBe(25);
    const full = getFullRakeConfig(5, 10, 'nlh', {
      scope: 'standalone',
      rakePercent: 15,
      rakeCapBB: 20,
    });
    expect(full.rakePercent).toBe(15);
    expect(full.rakeCap).toBe(200);
    expect(
      getFullRakeConfig(5, 10, 'nlh', { scope: 'midway', rakePercent: 15, rakeCapBB: 20 }).rakeCap
    ).toBe(25);
    expect(getFullRakeConfig(5, 10, 'nlh', { scope: 'midway', rakePercent: 15 }).rakePercent).toBe(
      10
    );
  });
  it('preserves no-flop/no-drop, heads-up and seat-gated three-handed reductions', () => {
    const full = getFullRakeConfig(0.1, 0.2, 'nlh', { scope: 'midway' });
    const config = (seats: number) => ({
      percent: full.rakePercent,
      cap: full.rakeCap,
      noFlopNoDrop: true,
      playerCountCaps: getPlayerCountCaps(full.rakeCap, seats),
    });
    expect(calculateRake(100, true, config(9), 2)).toBe(0.25);
    expect(calculateRake(100, true, config(9), 3)).toBe(0.38);
    expect(calculateRake(100, true, config(6), 3)).toBe(0.5);
    expect(calculateRake(100, true, config(9), 6)).toBe(0.5);
    expect(calculateRake(100, false, config(9), 6)).toBe(0);
  });
  it('uses the policy in physical and Lightning hand configs', () => {
    const physical = Object.create(ServerTableEngineBase.prototype) as any;
    physical.tableInfo = {
      union_id: MIDWAY_UNION_ID,
      small_blind: 0.1,
      big_blind: 0.2,
      game_variant: 'plo5',
      max_players: 9,
      rake_cap_bb: 20,
    };
    expect(physical.getRakeConfig(0.1, 0.2).cap).toBe(0.5);
    physical.tableInfo.union_id = null;
    physical.clubRakeDefaults = { rakePercent: 15, rakeCapBB: 20, unionId: null };
    expect(physical.getRakeConfig(0.1, 0.2).cap).toBe(4);
    expect(physical.getRakeConfig(0.1, 0.2).percent).toBe(15);
    const lightning = Object.create(LightningHandHost.prototype) as any;
    const config = lightning.buildHandConfig(
      {
        union_id: MIDWAY_UNION_ID,
        small_blind: 0.1,
        big_blind: 0.2,
        game_variant: 'plo5',
        max_players: 9,
        rake_cap_bb: 20,
      },
      1,
      2,
      []
    );
    expect(config.rakeConfig.cap).toBe(0.5);
    expect(config.rakeConfig.cashPolicy).toEqual({ version: 1, scope: 'midway' });
  });
  it('rounds fractional-cent caps downward and rejects non-finite settings', () => {
    expect(scopedCashRake(0.05, 'midway').rakeCap).toBe(0.12);
    expect(scopedCashRake(2, 'standalone', Infinity, NaN)).toEqual({ rakePercent: 10, rakeCap: 5 });
    expect(scopedCashRake(2, 'standalone', 0, 0)).toEqual({ rakePercent: 0, rakeCap: 0 });
  });
});
