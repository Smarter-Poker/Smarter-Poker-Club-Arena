/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MANAGER HONOURS THE POLICY, AND THE POLICY CANNOT EVICT - Phase 3
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PHASE3-CONTRACTS section 2 lists what HorseFleetManager must do with a fleet
 * policy, and section 0 lists what it must never do with one. This file pins
 * both halves.
 *
 * TWO KINDS OF ASSERTION, DELIBERATELY, and it is worth knowing which is
 * which. The NUMBERS are executed: every seat count below comes from running
 * the shipped helpers, composed exactly as the seeding loop composes them, and
 * the "unchanged" cases assert the SAME numbers HorseOccupancy.test.ts already
 * pins for the same tables at the same instant - if the policy layer moved any
 * of them, both files would go red together. The WIRING is read out of the
 * shipped source, which is the discipline HorseFleetSeatLaw.test.ts uses on
 * this same file, because seedAllTables is one 900-line method that reads six
 * paged tables and calls four RPCs, and a test that faked all of that would be
 * pinning the fake. Reading the source cannot drift from what runs.
 *
 * The one thing neither kind can prove is that the live engine does it, which
 * is what a rolled-back production sim is for (contract section 4).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cashTableFill, occupancyTargetFor } from './HorseBehavior.js';
import {
  FLEET_POLICY_DEFAULTS,
  applyBias,
  capBySeatedCount,
  withheldReason,
  type FleetPolicy,
} from './HorseFleetPolicy.js';

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');

/** seedAllTables itself, without the helpers that follow it. */
const CYCLE = SRC.slice(
  SRC.indexOf('private async seedAllTables'),
  SRC.indexOf('private buildFleetStateRows')
);
/** The seating loop, from the policy-withheld list down to the diagnostics. */
const LOOP = CYCLE.slice(
  CYCLE.indexOf('for (const table of tablesToSeed)'),
  CYCLE.indexOf('if (rollUnknown > 0)')
);
/** Everything the cycle still does after seating has been withheld. */
const AFTER_WITHHOLD = CYCLE.slice(CYCLE.indexOf('const cycleWithheld'));

function policy(over: Partial<FleetPolicy> = {}): FleetPolicy {
  return { ...FLEET_POLICY_DEFAULTS, ...over };
}

/* The same fixtures HorseOccupancy.test.ts uses, so "unchanged" is measured
   against the numbers that file already pins rather than against new ones. */
const tables = Array.from({ length: 400 }, (_, i) => `tbl-${i}-${i * 7919}`);
const T0 = 1_700_000_000_000;
const fullTables = tables.filter((id) => cashTableFill(id, T0) === 'full');
const sparseTables = tables.filter((id) => cashTableFill(id, T0) === 'sporadic');

/** The seeding loop's own two lines, in its own order: bias, then cap. */
function seatsAllowed(p: FleetPolicy, target: number, seatedNow: number, maxPlayers: number) {
  return capBySeatedCount(applyBias(target, p.occupancyBias, maxPlayers), seatedNow, p.maxPerTable);
}

// ═══════════════════════════════════════════════════════════════════════════
// NO POLICY ROW MEANS TODAY
// ═══════════════════════════════════════════════════════════════════════════

describe('an absent policy leaves the floor exactly as it is', () => {
  it('asks a full table for every seat, the same 9 and 6 the occupancy law pins', () => {
    expect(fullTables.length).toBeGreaterThan(0);
    for (const id of fullTables.slice(0, 40)) {
      const nine = occupancyTargetFor(id, 9, false, T0).seatTarget;
      const six = occupancyTargetFor(id, 6, false, T0).seatTarget;
      expect(nine).toBe(9);
      expect(six).toBe(6);
      expect(applyBias(nine, FLEET_POLICY_DEFAULTS.occupancyBias, 9)).toBe(9);
      expect(seatsAllowed(policy(), nine, 0, 9)).toBe(9);
      expect(seatsAllowed(policy(), six, 0, 6)).toBe(6);
    }
  });

  it('gives up exactly one seat per person waiting - still 8, 6 and 1', () => {
    const id = fullTables[0];
    for (const [waiting, expected] of [
      [0, 9],
      [1, 8],
      [3, 6],
      [99, 1],
    ] as const) {
      const target = occupancyTargetFor(id, 9, false, T0, waiting).seatTarget;
      expect(target).toBe(expected);
      expect(seatsAllowed(policy(), target, 0, 9)).toBe(expected);
    }
  });

  it('never takes a sparse table below one seat or above its own maximum', () => {
    expect(sparseTables.length).toBeGreaterThan(0);
    for (const id of sparseTables) {
      const target = occupancyTargetFor(id, 9, false, T0).seatTarget;
      expect(applyBias(target, FLEET_POLICY_DEFAULTS.occupancyBias, 9)).toBe(target);
      expect(seatsAllowed(policy(), target, 0, 9)).toBe(target);
    }
  });

  it('leaves the whole seat arithmetic identical to the subtraction it replaced', () => {
    for (let target = 0; target <= 9; target++) {
      for (let seated = 0; seated <= 9; seated++) {
        expect(seatsAllowed(policy(), Math.max(1, target), seated, 9)).toBe(
          Math.max(0, Math.max(1, target) - seated)
        );
      }
    }
  });

  it('withholds nothing at any hour, at any table, for any horse', () => {
    for (let hour = 0; hour < 24; hour++) {
      expect(
        withheldReason(policy(), {
          nowUTCHour: hour,
          seatedHorses: 584,
          seatedAtTable: 0,
          humansAtTable: 0,
          stakeBand: 'low',
          variant: 'nlh',
        })
      ).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SWITCH AND THE PAUSE
// ═══════════════════════════════════════════════════════════════════════════

describe('a disabled or paused fleet seats nobody and removes nobody', () => {
  it('names the cause rather than going quiet', () => {
    const ctx = { nowUTCHour: 12, seatedHorses: 0 };
    expect(withheldReason(policy({ enabled: false }), ctx)).toBe('fleet_disabled');
    expect(withheldReason(policy({ pauseNewSeatings: true }), ctx)).toBe('seating_paused');
  });

  it('withholds at every hour and at every table, empty ones included', () => {
    for (const p of [policy({ enabled: false }), policy({ pauseNewSeatings: true })]) {
      for (let hour = 0; hour < 24; hour++) {
        for (const seated of [0, 1, 5, 9]) {
          expect(
            withheldReason(p, { nowUTCHour: hour, seatedAtTable: seated, humansAtTable: 2 })
          ).not.toBeNull();
        }
      }
    }
  });

  it('is a skipped seating list, NOT an early return, so the cycle still runs', () => {
    /* Contract section 2: "when seating is withheld the cycle still runs,
       still prunes and still reports". An early return here would take the
       waitlist prune, the diagnostics, the overflow and retirement passes and
       the heartbeat with it, and the console would see an engine that had
       apparently died. */
    expect(CYCLE).toMatch(/const tablesToSeed = cycleWithheld \? \[\] : orderedTables;/);
    expect(CYCLE).toMatch(/for \(const table of tablesToSeed\)/);
    expect(AFTER_WITHHOLD).not.toMatch(/\breturn;/);
    expect(AFTER_WITHHOLD).toContain('this.pruneHorseWaitlist(horseIdSet)');
    /* Moved 2026-09-05 for Gate 7. This used to pin `this.spawnOverflowTables(`
       and `this.retireSurplusTables(` as the passes a withheld cycle still
       runs. Both writers are deleted (OPORD 1.4 s2.11: a cash table is opened
       and closed only by the cluster controller). The pass that survives a
       withhold is the Stable Hand's GAME order, and the fleet must still not
       have grown a table writer of its own.

       2026-09-06: `this.runTableLifecyclePass(` was pinned here too and is now
       DELETED, for the third time in the same list and the same reason. OPORD
       s18.2 names it with the other two; it acted on zero rows (no table on the
       platform carries auto_restart or auto_create_table); and its AUTO CREATE
       arm cloned `cluster_id`, `role` and `main_index`, so cloning a full Main
       1 minted a second Main 1 - the 3,000-tables-on-one-game shape. The fleet
       owns no lifecycle at all now. */
    expect(AFTER_WITHHOLD).toContain('this.openPlannedTables(');
    expect(AFTER_WITHHOLD).not.toContain('this.runTableLifecyclePass(');
    expect(AFTER_WITHHOLD).not.toContain('this.spawnOverflowTables(');
    expect(AFTER_WITHHOLD).not.toContain('this.retireSurplusTables(');
    // And nowhere else in the file either - not a helper, not a comment-out.
    expect(SRC).not.toContain('fn_table_lifecycle_pass');
    expect(AFTER_WITHHOLD).toContain('this.publishFleetState(');
  });

  it('stops a horse ANSWERING a seat call too, since that is a new seating', () => {
    expect(CYCLE).toMatch(/const claimed = cycleWithheld\s*\?\s*0/);
  });

  it('adds nothing anywhere that could stand a seated horse up', () => {
    /* HORSES ARE PLAYERS (CLAUDE.md 10.5) and contract section 0: "there is no
       new eviction mechanism". A stopped fleet drains through the rotator, the
       human-waiting release and bust-outs, all of which already existed. The
       manager's only reference to a seat row is the read it has always done. */
    expect(SRC).not.toMatch(/\.from\('table_seats'\)[\s\S]{0,120}\.delete\(/);
    expect(SRC).not.toContain('leaveTable');
    expect(SRC.match(/from\('table_seats'\)/g)?.length ?? 0).toBe(1);
    expect(SRC.match(/left_at/g)?.length ?? 0).toBe(1);
    expect(SRC).toContain(".is('left_at', null)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CAPS
// ═══════════════════════════════════════════════════════════════════════════

describe('a cap of N never seats N+1', () => {
  it('holds for every cap, every occupancy and every target', () => {
    for (const cap of [0, 1, 2, 4, 6, 9]) {
      const p = policy({ maxPerTable: cap });
      for (let seated = 0; seated <= 9; seated++) {
        for (let target = 1; target <= 9; target++) {
          const after = seated + seatsAllowed(p, target, seated, 9);
          expect(after).toBeLessThanOrEqual(Math.max(cap, seated));
          expect(after).toBeGreaterThanOrEqual(seated);
        }
      }
    }
  });

  it('cannot be lifted back over the cap by a bias above 1.0', () => {
    /* The order matters and this is the pin for it: the seeding loop biases
       the target and THEN caps it. Capping first would let a bias of 2.0 seat
       eight at a table an operator capped at four. */
    const p = policy({ maxPerTable: 4, occupancyBias: 2.0 });
    expect(seatsAllowed(p, 9, 0, 9)).toBe(4);
    expect(seatsAllowed(p, 5, 2, 9)).toBe(2);
    expect(LOOP.indexOf('applyBias(')).toBeLessThan(LOOP.indexOf('capBySeatedCount('));
  });

  it('seats nobody else at a table already over a cap, and stands nobody up', () => {
    const p = policy({ maxPerTable: 4 });
    expect(seatsAllowed(p, 9, 4, 9)).toBe(0);
    expect(seatsAllowed(p, 9, 7, 9)).toBe(0);
    expect(withheldReason(p, { seatedAtTable: 7 })).toBe('max_per_table_reached');
  });

  it('spends the fleet-wide cap as a budget rather than as a switch', () => {
    /* At 199 of a 200 cap the fleet still seats one more. Only a cap already
       reached withholds outright, and the budget is decremented per seat so a
       single cycle cannot spend it twice. */
    expect(withheldReason(policy({ maxHorses: 200 }), { seatedHorses: 199 })).toBeNull();
    expect(withheldReason(policy({ maxHorses: 200 }), { seatedHorses: 200 })).toBe(
      'max_horses_reached'
    );
    expect(CYCLE).toMatch(/globalPolicy\.maxHorses === null[\s\S]{0,120}POSITIVE_INFINITY/);
    expect(CYCLE).toMatch(/Math\.max\(0, globalPolicy\.maxHorses - seatedHorseCount\)/);
    expect(LOOP).toMatch(/seatsNeeded = Math\.min\(seatsNeeded, seatBudget\)/);
    expect(LOOP).toContain('seatBudget--');
    expect(CYCLE).toContain('seatBudget -= claimed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MINIMUM HUMANS
// ═══════════════════════════════════════════════════════════════════════════

describe('min_humans_to_seat withholds at one human and seats at two', () => {
  const p = policy({ minHumansToSeat: 2 });

  it('withholds a table with one human', () => {
    expect(withheldReason(p, { nowUTCHour: 12, humansAtTable: 1, seatedAtTable: 1 })).toBe(
      'below_min_humans'
    );
  });

  it('seats a table with two', () => {
    expect(withheldReason(p, { nowUTCHour: 12, humansAtTable: 2, seatedAtTable: 2 })).toBeNull();
    expect(seatsAllowed(p, 9, 2, 9)).toBe(7);
  });

  it('withholds an empty table, and the default of 0 never does', () => {
    expect(withheldReason(p, { humansAtTable: 0 })).toBe('below_min_humans');
    expect(withheldReason(policy(), { humansAtTable: 0 })).toBeNull();
  });

  it('is fed a COUNT of humans by the manager, not a boolean', () => {
    /* The loop only ever asked "is a human here". The count is new and the
       boolean is derived from it, so the human-rescue path that reads
       `humanAtTable` behaves exactly as it did. */
    expect(LOOP).toMatch(/const humansAtTable = tableOccupiedSeats\.filter\(/);
    expect(LOOP).toMatch(/const humanAtTable = humansAtTable > 0;/);
    expect(LOOP).toMatch(/humansAtTable,/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ONE READ PER CYCLE PER CLUB SCOPE
// ═══════════════════════════════════════════════════════════════════════════

describe('the policy is read once per cycle per club scope', () => {
  it('collects the scopes from the floor and reads each one before the loop', () => {
    expect(CYCLE).toMatch(/const policyScopes = new Set<string \| null>\(\[null\]\);/);
    expect(CYCLE).toMatch(/for \(const t of tables\)[\s\S]{0,60}policyScopes\.add\(t\.club_id\)/);
    expect(CYCLE).toMatch(/for \(const scope of policyScopes\)[\s\S]{0,80}getFleetPolicy\(scope\)/);
  });

  it('never reads it again inside the seating loop', () => {
    /* One round trip per table inside this loop is what stretched a 30-second
       cycle to 47 minutes on 2026-09-02. The cache would hide it; the loop
       still must not ask. */
    expect(LOOP).not.toContain('getFleetPolicy');
    expect(LOOP).toContain('policyFor(table.club_id)');
  });

  it('honours the causes in the contract order', () => {
    const order = [
      "if (!policy.enabled) return 'fleet_disabled';",
      "if (policy.pauseNewSeatings) return 'seating_paused';",
      "'max_horses_reached'",
      "'max_per_table_reached'",
      "'below_min_humans'",
      "'stake_band_excluded'",
      "'variant_excluded'",
      "'outside_schedule'",
    ];
    const POLICY_SRC = readFileSync(
      join(process.cwd(), 'src/services/HorseFleetPolicy.ts'),
      'utf8'
    );
    const REASON = POLICY_SRC.slice(POLICY_SRC.indexOf('export function withheldReason'));
    let at = -1;
    for (const needle of order) {
      const next = REASON.indexOf(needle);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE HEARTBEAT
// ═══════════════════════════════════════════════════════════════════════════

describe('every cycle beats, withheld or not', () => {
  it('publishes from `finally`, so no exit path can skip it', () => {
    const FINALLY = CYCLE.slice(CYCLE.lastIndexOf('} finally {'));
    expect(FINALLY).toContain('await this.publishFleetState(beat,');
    expect(CYCLE.match(/this\.publishFleetState\(/g)?.length ?? 0).toBe(1);
  });

  it('writes the state rows and the beat through the one contract RPC', () => {
    expect(SRC).toContain("supabase.rpc('fn_ca_fleet_state_upsert'");
    expect(SRC).toMatch(/p_rows: beat\.rows,/);
    expect(SRC).toMatch(/p_beat: \{/);
  });

  it('carries the reason a withheld cycle seated nobody', () => {
    expect(CYCLE).toMatch(/beat\.reason =\s*\n?\s*cycleWithheld/);
    expect(SRC).toMatch(/reason: beat\.reason,/);
  });

  it('says which cycle it was even when the cycle gave up early', () => {
    /* A cycle that skipped because a paged read came back truncated must not
       look the same from the console as a fleet an operator switched off. */
    for (const reason of [
      'table_list_incomplete',
      'union_map_incomplete',
      'seat_map_incomplete',
      'horse_pool_incomplete',
      'horse_ids_incomplete',
    ]) {
      expect(CYCLE).toContain(`beat.reason = '${reason}';`);
    }
  });

  it('marks the beat degraded when the policy could not be read', () => {
    expect(CYCLE).toMatch(/if \(p\.degraded\) beat\.degraded = true;/);
    expect(SRC).toMatch(/degraded: beat\.degraded,/);
  });

  it('sends null for what the seeding cycle genuinely does not know', () => {
    /* Contract section 2: "if a field is genuinely unknown this cycle, send
       null, never a guess". `horses_idle` is not total minus seated, because
       a horse in a tournament is neither; `horses_stuck` comes from
       last_action_at, which this cycle never reads; `seats_released` belongs
       to the rotator, the only thing that stands a horse up. */
    expect(SRC).toMatch(/horses_idle: null,/);
    expect(SRC).toMatch(/horses_stuck: null,/);
    expect(SRC).toMatch(/seats_released: null,/);
  });

  it('builds its rows from what the cycle already read, with no new query', () => {
    /* Ends at the NEXT method's banner rather than at its signature, so the
       comment that explains which counts are null is not read as code. */
    const BUILD = SRC.slice(
      SRC.indexOf('private buildFleetStateRows'),
      SRC.indexOf('ONE WRITE PER CYCLE')
    );
    expect(BUILD.length).toBeGreaterThan(0);
    expect(BUILD).not.toContain('supabase');
    expect(BUILD).not.toContain('await');
    // Session and action fields are not in the row at all, rather than guessed.
    expect(BUILD).not.toContain('session_started_at');
    expect(BUILD).not.toContain('last_action_at');
    expect(BUILD).not.toContain('hands_this_session');
  });
});
