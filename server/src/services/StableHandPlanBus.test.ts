/**
 * HOW A PLAN REACHES THE SEEDER. The planner decides what the floor should
 * look like; only HorseFleetManager knows how to seat anybody. The bus is what
 * connects them without creating a second answer to "may this horse sit here".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  publishPlan,
  clearPlan,
  planIsFresh,
  seatBoosts,
  takeOpenOrders,
  PLAN_TTL_MS,
} from './StableHandPlanBus.js';
import { stakeForBand } from './StableHandController.js';
import type { FloorPlan } from './StableHandController.js';
import { MIDWAY_UNION_ID, PHASE_MAX_BB, stakeBandOf, variantLabel } from './StableHand.js';

const NOW = Date.UTC(2026, 8, 4, 14, 0, 0);

const plan = (over: Partial<FloorPlan> = {}): FloorPlan => ({
  seat: [],
  stand: [],
  open: [],
  close: [],
  park: [],
  alerts: [],
  metrics: [],
  ...over,
});

beforeEach(() => clearPlan());

describe('a stale plan is not a plan', () => {
  it('is fresh for two executor cycles and then is not', () => {
    publishPlan(plan(), NOW);
    expect(planIsFresh(NOW)).toBe(true);
    expect(planIsFresh(NOW + PLAN_TTL_MS - 1)).toBe(true);
    expect(planIsFresh(NOW + PLAN_TTL_MS)).toBe(false);
    // two cycles: one would make the seeder depend on which interval fired
    // first; much more is steering by a floor that has moved.
    expect(PLAN_TTL_MS).toBeGreaterThan(2 * 30_000);
    expect(PLAN_TTL_MS).toBeLessThan(4 * 30_000);
  });

  it('an expired plan reads as EMPTY, which is the seeder unchanged', () => {
    publishPlan(
      plan({
        seat: [{ tableId: 't1', hostId: MIDWAY_UNION_ID, seats: 3, reason: 'shape_full' }],
        open: [{ hostId: MIDWAY_UNION_ID, variant: 'nlh', band: 'low', count: 1 }],
      }),
      NOW
    );
    expect(seatBoosts(NOW).size).toBe(1);
    expect(seatBoosts(NOW + PLAN_TTL_MS).size).toBe(0);
    expect(takeOpenOrders(NOW + PLAN_TTL_MS)).toHaveLength(0);
  });

  it('never published at all is the same as expired', () => {
    expect(planIsFresh(NOW)).toBe(false);
    expect(seatBoosts(NOW).size).toBe(0);
    expect(takeOpenOrders(NOW)).toHaveLength(0);
  });
});

describe('seat orders become a per-table ask', () => {
  it('sums several orders for one table', () => {
    publishPlan(
      plan({
        seat: [
          { tableId: 't1', hostId: MIDWAY_UNION_ID, seats: 2, reason: 'shape_full' },
          { tableId: 't1', hostId: MIDWAY_UNION_ID, seats: 1, reason: 'occupancy_ramp' },
          { tableId: 't2', hostId: MIDWAY_UNION_ID, seats: 4, reason: 'shape_joinable' },
        ],
      }),
      NOW
    );
    expect(seatBoosts(NOW).get('t1')).toBe(3);
    expect(seatBoosts(NOW).get('t2')).toBe(4);
  });

  it('ignores a negative ask rather than lowering a target', () => {
    // A shape order that could LOWER a target would be a stand, and stands go
    // through the executor where the leave path is.
    publishPlan(
      plan({ seat: [{ tableId: 't1', hostId: MIDWAY_UNION_ID, seats: -5, reason: 'shape_full' }] }),
      NOW
    );
    expect(seatBoosts(NOW).get('t1')).toBe(0);
  });
});

describe('open orders are TAKEN, not read', () => {
  it('a second reader in the same window gets nothing', () => {
    // A table opened twice is the duplicate-board bug the recurring service
    // already carries a unique index to prevent.
    publishPlan(
      plan({ open: [{ hostId: MIDWAY_UNION_ID, variant: 'plo5', band: 'low', count: 1 }] }),
      NOW
    );
    expect(takeOpenOrders(NOW)).toHaveLength(1);
    expect(takeOpenOrders(NOW)).toHaveLength(0);
  });

  it('but the seat boosts survive the take - they are a standing ask', () => {
    publishPlan(
      plan({
        seat: [{ tableId: 't1', hostId: MIDWAY_UNION_ID, seats: 2, reason: 'shape_full' }],
        open: [{ hostId: MIDWAY_UNION_ID, variant: 'nlh', band: 'low', count: 1 }],
      }),
      NOW
    );
    takeOpenOrders(NOW);
    expect(seatBoosts(NOW).get('t1')).toBe(2);
  });
});

describe('the stake a new table opens at', () => {
  it('is the highest rung inside the band, not the cheapest', () => {
    // A floor whose new games are always its cheapest is not a floor anybody
    // grows into.
    expect(stakeForBand('micro')).toEqual({ sb: 0.05, bb: 0.1 });
    expect(stakeForBand('low')).toEqual({ sb: 0.25, bb: 0.5 });
    /* Still 1/2. The clamp moved to 25/50 on 2026-09-05, but `stakeBandOf`
       deliberately did NOT follow it up: a 'top' band spanning 1 through 50
       would let one label point a horse at both, which is the scatter Dan's
       one-stake-level ruling forbids. The high rungs are reached by the
       BANKROLL (affordableStakeWindow), not by a band label. */
    expect(stakeForBand('top')).toEqual({ sb: 1, bb: 2 });
  });

  it('is never above the phase clamp, by construction', () => {
    for (const band of ['micro', 'low', 'top'] as const) {
      const s = stakeForBand(band)!;
      expect(s.bb).toBeLessThanOrEqual(PHASE_MAX_BB);
      expect(stakeBandOf(s.bb)).toBe(band);
    }
  });
});

describe('a new table is named as copy a player reads', () => {
  it('Title Case, no em dash, and never mislabelled as a game it is not', () => {
    expect(variantLabel('short_deck')).toBe('Short Deck');
    expect(variantLabel('pineapple')).toBe('Crazy Pineapple');
    expect(variantLabel('nlh')).toBe('NLH');
    for (const v of ['nlh', 'plo4', 'short_deck', 'flh']) {
      expect(variantLabel(v)).not.toContain('—');
    }
    // an unknown variant keeps its own key rather than being called NLH
    expect(variantLabel('mystery_game')).toBe('MYSTERY_GAME');
  });
});

describe('SOURCE LAW: opening a table is the most refused thing in the fleet', () => {
  const raw = readFileSync(resolve(__dirname, 'HorseFleetManager.ts'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const method = src.slice(
    src.indexOf('private async openPlannedTables('),
    src.indexOf('private async spawnOverflowTables(')
  );

  it('refuses when the controller is off, during a freeze, and at night', () => {
    expect(method).toContain('if (!controllerEnabled()) return;');
    expect(method).toContain('if (isMaintenanceFrozen()) return;');
    expect(method).toContain('if (isNightWindow(chicagoNow().hour)) return;');
  });

  it('opens at most ONE table per host per cycle', () => {
    expect(method).toContain('if (openedThisCycle.has(order.hostId)) continue;');
    expect(method).toContain('openedThisCycle.add(order.hostId);');
  });

  it('refuses while the host is at its occupancy cap', () => {
    // A new table cannot be filled by bodies the curve does not allow.
    expect(method).toContain(
      'if (cap !== undefined && (bodiesOnHost.get(order.hostId)?.size ?? 0) >= cap) continue;'
    );
  });

  it('opens a GAME, never a table (Gate 7, 2026-09-05): the order is fn_cash_game_ensure, idempotent on the key', () => {
    // A repeated order for a key the host already runs returns the same game;
    // the count cannot creep because the database holds one game per
    // (club, variant, sb, bb) and refuses a cash table with no game behind it.
    expect(method).toContain("supabase.rpc('fn_cash_game_ensure', {");
    expect(method).toContain('p_club_id: order.hostId,');
    expect(method).toContain('p_variant: variant,');
    expect(method).toContain('p_sb: stake.sb,');
    expect(method).toContain('p_bb: stake.bb,');
    expect(method).not.toContain("from('tables').insert(");
  });

  it('stamps the HOST as the game club, so the host owns the game', () => {
    expect(method).toContain('p_club_id: order.hostId,');
  });

  it('clamps the seats to what the deck can serve', () => {
    expect(method).toContain('p_handedness: clampSeatsForVariant(variant, 9)');
  });
});
