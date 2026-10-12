/**
 * THE BREAK A SWEEP DISCOVERED IS THE BREAK IT FINISHES (2026-09-29).
 *
 * Production 2026-09-29 (engine 41b91390): the $100 Freerolls 87a68e55 and
 * cb8f2dd1 held seven and five open table breaks while 33 and 37 of their
 * tables sat with one player each. Every step of a break visit answers to
 * `eliminationMutationAllowed()`, which turned false when the sweep's
 * five-second work budget ran out, so a visit stopped wherever the clock did
 * (`Break f1af44bb members not dispatched: destinations_unread` at 04:30:36Z)
 * and the next admission's discovery had already moved the server cursor on
 * to the next operation. 87a68e55's cursor went from revision 28 to 29 in
 * fifteen minutes. Begun breaks whose every member had moved (192437a7,
 * 4576ca30) and close_confirmed breaks held by dead lease generations
 * (7b44499f, 086b55a3, eb53ed4f) needed only a claim, a close and an ACK.
 *
 * These pins drive the real TournamentManager and the real
 * TournamentRetirementCustody; only the RPC transport is a fake.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { TournamentRetirementCustody } from '../services/TournamentRetirementCustody.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVENT = id(1);
const LIVE = id(3);
const DEAD = id(30);
const BUDGET_MS = 5_000;

let clock = 1_000_000;

interface Op {
  break_id: string;
  source_table_id: string;
  state: string;
  revision: string;
  custody_id: string | null;
  custody_generation: string | null;
  [key: string]: unknown;
}

function op(n: number, overrides: Partial<Op> = {}): Op {
  return {
    ok: true,
    reason: null,
    break_id: id(100 + n),
    tournament_id: EVENT,
    source_table_id: id(200 + n),
    lifecycle: '9007199254740993',
    state: 'begun',
    revision: '8',
    custody_id: id(300 + n),
    custody_generation: LIVE,
    terminal_handoff_required: false,
    members: [
      {
        user_id: id(400 + n),
        source_seat_id: id(500 + n),
        source_seat_number: 1,
        occupancy_id: id(600 + n),
        request_id: id(700 + n),
        active_request_id: null,
        winner_request_id: id(700 + n),
        destination_table_id: id(800 + n),
        destination_seat_number: 2,
      },
    ],
    ...overrides,
  };
}

function fixture(operations: Op[], options: { spend?: Partial<Record<string, number>> } = {}) {
  const events: string[] = [];
  const durable = new Map(operations.map((row) => [row.break_id, { ...row }]));
  const engines = new Map<string, any>();
  for (const row of operations) {
    if (row.state === 'close_confirmed') continue;
    engines.set(row.source_table_id, {
      stop: vi.fn(async () => {
        events.push(`stop:${row.break_id.slice(-3)}`);
      }),
      hasReleasedProcessOwnership: () => true,
      releaseTournamentMovePause: vi.fn(),
      parkForTournamentMove: vi.fn(async () => true),
      executeTournamentMoveAtBoundary: vi.fn(async (_owner: string, work: () => Promise<unknown>) =>
        work()
      ),
    });
  }
  const global = new Map(engines);
  const custody = new TournamentRetirementCustody<any>();
  const server: any = {
    getTableEngine: vi.fn((table: string) => global.get(table)),
    ownsTournamentTableEngine: (table: string, expected: unknown) => global.get(table) === expected,
    unregisterTableEngine: vi.fn((table: string, expected: unknown) => {
      if (global.get(table) !== expected) return false;
      global.delete(table);
      return true;
    }),
    withRetirementCustody: (
      binding: any,
      local: Map<string, any>,
      current: () => boolean,
      work: any,
      prepare: any
    ) => custody.withCustody(binding, global, local, current, work, prepare),
  };
  const manager: any = new TournamentManager(EVENT, server, LIVE, performance.now() + 60_000);
  manager.running = true;
  manager.eliminationSweepDeadlineAt = clock + BUDGET_MS;
  for (const [table, engine] of engines) manager.tableEngines.set(table, engine);
  manager.requestUrgentEliminationSweepAfter = vi.fn();
  manager.retireManagedTableFromHandForHand = vi.fn();
  manager.broadcast = vi.fn(async () => {});
  const spend = (step: string) => {
    clock += options.spend?.[step] ?? 0;
  };
  // The server cursor: ordinals in array order, up to `limit` operations per
  // page, as `fn_f06_discover_breaks` pages them (see
  // aBalancerIsNotStarvedByBreakDiscovery.law.test.ts - the manager asks for
  // the whole page and still visits one operation per unit).
  const order = operations.map((row) => row.break_id);
  let cursor = { revision: 0, index: -1 };
  const api: any = {
    discover: vi.fn(async (expected: string, limit: number) => {
      spend('discover');
      if (!Number.isInteger(limit) || limit < 1 || limit > 32)
        throw new Error('page size out of range');
      if (String(cursor.revision) !== expected)
        return {
          ok: false,
          cursor_revision: String(cursor.revision),
          wrapped: false,
          operations: [],
        };
      const open = order.filter((breakId) => durable.get(breakId)!.state !== 'acknowledged');
      let next = order.findIndex(
        (breakId, index) => index > cursor.index && open.includes(breakId)
      );
      let wrapped = false;
      if (next < 0) {
        wrapped = true;
        next = order.findIndex((breakId) => open.includes(breakId));
      }
      const page =
        next < 0
          ? []
          : order
              .slice(next)
              .filter((breakId) => open.includes(breakId))
              .slice(0, limit);
      cursor = {
        revision: cursor.revision + 1,
        index: page.length ? order.lastIndexOf(page[page.length - 1]) : next,
      };
      return {
        ok: true,
        cursor_revision: String(cursor.revision),
        wrapped,
        operations: page.map((breakId) => ({ ...durable.get(breakId)! })),
      };
    }),
    reconcile: vi.fn(async (breakId: string) => {
      spend('reconcile');
      return { ...durable.get(breakId)! };
    }),
    claimCustody: vi.fn(async (breakId: string, custodyId: string, expected: string) => {
      spend('claim');
      const row = durable.get(breakId)!;
      events.push(`claim:${breakId.slice(-3)}`);
      if (row.custody_id === custodyId && row.custody_generation === LIVE) return { ...row };
      if (row.revision !== expected || row.state === 'acknowledged')
        return { ok: false, reason: 'custody_revision_conflict' };
      const next = {
        ...row,
        custody_id: custodyId,
        custody_generation: LIVE,
        revision: String(BigInt(row.revision) + 1n),
      };
      durable.set(breakId, next);
      return { ...next };
    }),
    close: vi.fn(async (breakId: string) => {
      spend('close');
      events.push(`close:${breakId.slice(-3)}`);
      const next = { ...durable.get(breakId)!, state: 'close_confirmed' };
      durable.set(breakId, next);
      return { ...next };
    }),
    ackCleanup: vi.fn(
      async (breakId: string, custodyId: string, revision: string, kind: string) => {
        spend('ack');
        const row = durable.get(breakId)!;
        if (
          row.custody_id !== custodyId ||
          row.custody_generation !== LIVE ||
          row.revision !== revision
        )
          return { ok: false, reason: 'custody_revision_conflict' };
        events.push(`ack:${breakId.slice(-3)}:${kind}`);
        const next = { ...row, state: 'acknowledged', cleanup_kind: kind };
        durable.set(breakId, next);
        return { ...next };
      }
    ),
  };
  manager.tableBreakRpc = () => {
    if (!manager.eliminationMutationAllowed()) throw new Error('F06 manager authority unavailable');
    return api;
  };
  const visitAll = () =>
    manager.visitTournamentBreakPage((state: any) => manager.recoverTournamentBreak(state));
  return { manager, api, events, durable, custody, global, visitAll };
}

afterEach(() => vi.restoreAllMocks());

describe('a break the sweep starts is finished (2026-09-29)', () => {
  it('a close_confirmed break held by a dead generation is claimed, acknowledged and released even when the budget runs out mid-visit', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // 7b44499f: close_confirmed, custody of dead generation 301699b5,
    // revision 3, source table already closed and without an engine.
    const f = fixture(
      [op(1, { state: 'close_confirmed', revision: '3', custody_generation: DEAD })],
      // The custody claim alone spends the rest of the admission's budget.
      { spend: { claim: BUDGET_MS + 1 } }
    );
    await expect(f.visitAll()).resolves.toBe(true);
    expect(f.events).toEqual([`claim:101`, `ack:101:verified_absent`]);
    const row = f.durable.get(id(101))!;
    expect(row.state).toBe('acknowledged');
    expect(row.custody_generation).toBe(LIVE);
    expect(row.revision).toBe('4');
    expect(f.custody.admissionAllowed(id(201))).toBe(true);
    // The window closed with the visit: the spent budget answers again.
    expect(f.manager.eliminationMutationAllowed()).toBe(false);
  });

  it('a begun break whose members all moved stops its source engine, closes and acknowledges though the clock expired during the stop', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // 192437a7: begun, every member a winner, 0 seated, live custody.
    const f = fixture([op(2)], { spend: { reconcile: 2_000 } });
    await expect(f.visitAll()).resolves.toBe(true);
    expect(f.events).toEqual([`claim:102`, `stop:102`, `close:102`, `ack:102:retired`]);
    expect(f.durable.get(id(102))!.state).toBe('acknowledged');
    expect(f.global.has(id(202))).toBe(false);
    expect(f.manager.tableEngines.has(id(202))).toBe(false);
  });

  it('visits every open operation once in one admission while budget remains, and stops on the wrap', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const f = fixture([
      op(1, { state: 'close_confirmed', revision: '3', custody_generation: DEAD }),
      op(2),
      op(3, { state: 'close_confirmed', revision: '5', custody_generation: DEAD }),
    ]);
    await expect(f.visitAll()).resolves.toBe(true);
    for (const n of [101, 102, 103]) expect(f.durable.get(id(n))!.state).toBe('acknowledged');
    expect(f.api.close).toHaveBeenCalledTimes(1);
    expect(f.api.ackCleanup).toHaveBeenCalledTimes(3);
  });

  it('does not START another operation once the budget is spent', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const f = fixture(
      [
        op(1, { state: 'close_confirmed', revision: '3', custody_generation: DEAD }),
        op(2, { state: 'close_confirmed', revision: '3', custody_generation: DEAD }),
      ],
      { spend: { ack: BUDGET_MS + 1 } }
    );
    await expect(f.visitAll()).resolves.toBe(true);
    expect(f.durable.get(id(101))!.state).toBe('acknowledged');
    expect(f.durable.get(id(102))!.state).toBe('close_confirmed');
    expect(f.api.discover).toHaveBeenCalledTimes(1);
  });

  it('a new generation adopts the cursor revision the conflict returned and visits in the same pass', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const f = fixture([
      op(1, { state: 'close_confirmed', revision: '3', custody_generation: DEAD }),
    ]);
    // An earlier generation already advanced the durable cursor.
    await f.api.discover('0', 32);
    f.api.discover.mockClear();
    await expect(f.visitAll()).resolves.toBe(true);
    // The manager asks for the whole page and still visits one operation per
    // unit; see aBalancerIsNotStarvedByBreakDiscovery.law.test.ts.
    expect(f.api.discover.mock.calls.slice(0, 2)).toEqual([
      ['0', 32],
      ['1', 32],
    ]);
    expect(f.durable.get(id(101))!.state).toBe('acknowledged');
  });

  it('manager stop and the sweep abort still end the window', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const f = fixture([op(1)]);
    clock += BUDGET_MS + 1;
    f.manager.tournamentBreakVisitOpen = true;
    expect(f.manager.eliminationMutationAllowed()).toBe(true);
    f.manager.eliminationSweepSignal = { aborted: true };
    expect(f.manager.eliminationMutationAllowed()).toBe(false);
    f.manager.eliminationSweepSignal = null;
    f.manager.running = false;
    expect(f.manager.eliminationMutationAllowed()).toBe(false);
  });

  it('an operation left open names why (CLAUDE.md 10.86 rule 1)', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = op(4);
    (pending.members as any[])[0].winner_request_id = null;
    (pending.members as any[])[0].active_request_id = id(900);
    const f = fixture([pending]);
    await f.manager.retireTournamentBreak(pending);
    expect(f.manager.lastBreakRetirementRefusal(id(104))).toBe('members_unresolved:1_of_1');
    expect(warn).toHaveBeenCalledWith(
      `[Tournament:${EVENT.slice(0, 8)}] Break ${id(104).slice(0, 8)} not retired: members_unresolved:1_of_1`
    );
  });
});
