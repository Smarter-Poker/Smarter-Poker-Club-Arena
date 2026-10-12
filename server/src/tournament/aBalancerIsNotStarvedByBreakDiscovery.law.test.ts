/**
 * A BALANCER IS NOT STARVED BY BREAK DISCOVERY (2026-09-29).
 *
 * The second half of the same freeze `aBreakTheSweepStartsIsFinished` was
 * written for. That law fixed the VISIT: a discovered operation is now worked
 * to the end once started. This one is about the CLAIM the balancer waits on.
 *
 * `checkTableBalance` will not plan a move until
 * `tournamentBreakDiscoveryComplete` is true, and the guard is right - a
 * balancer that has not seen every pending break can plan onto a table a break
 * already owns. Its PRICE was the defect. Asking `fn_f06_discover_breaks` for a
 * page of ONE made the claim cost a walk of the whole durable cursor twice,
 * ~2*(N+1) discovery calls for an event with N pending operations; the flag
 * lives only in this process, and the engine restarts every hour.
 *
 * Production 2026-09-29. Events 87a68e55 ("$100 Freeroll 6:00 AM") and
 * cb8f2dd1 ("$100 Freeroll 6:00 PM") held seven and five pending operations,
 * needing 16 and 12 calls. Between 04:44 and 05:10Z their durable cursors
 * advanced ONCE and twice - the process-wide elimination scheduler had 381 of
 * 408 managers queued behind four slots with an oldest wait of 478 s - so the
 * claim needed hours of admissions and expired every sixty minutes. Neither
 * event ever earned it. 38 players sat on 38 tables and 48 on 41, no table
 * able to deal to itself, for hours, while their level clocks reached 25 and
 * 16 and the average stack fell under one big blind. It is a ratchet: a
 * balancer that never runs is what leaves a field one player to a table, which
 * is what opens the breaks that make the claim slow to earn.
 *
 * The law: seeing every pending operation is ONE question the database answers
 * in one call - a wrap resets the server cursor to zero and pages from the
 * beginning in the same statement, so a wrapped page that did not FILL is
 * already the complete non-terminal set and no second traversal can add to it.
 * Working on an operation stays the separate, rationed question it was:
 * exactly one operation per budget-suspending unit, with the clock asked again
 * between units.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { supabase } from '../services/supabase.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EVENT = id(1);
const GENERATION = id(9);

/** A park_requested operation carries no members, which is what discovery pages. */
const operation = (n: number) => ({
  ok: true,
  reason: null,
  break_id: id(1000 + n),
  tournament_id: EVENT,
  source_table_id: id(2000 + n),
  lifecycle: String(n + 1),
  state: 'park_requested',
  revision: '0',
  custody_id: null,
  custody_generation: null,
  terminal_handoff_required: false,
  members: [],
});

/**
 * `fn_f06_discover_breaks`, exactly as production runs it: an ordinal cursor
 * under a revision CAS which resets to zero and reports `wrapped` when nothing
 * is left beyond it, and then pages from the beginning.
 */
function discoveryCursor(pendingCount: number) {
  const ops = Array.from({ length: pendingCount }, (_, i) => ({
    ordinal: (i + 1) * 10,
    state: operation(i),
  }));
  const cursor = { ordinal: 0, revision: 0 };
  const limits: number[] = [];
  const rpc = (parameters: { p_expected_cursor_revision: string; p_limit: number }) => {
    if (parameters.p_limit < 1 || parameters.p_limit > 32) throw new Error('F06_PAGE_SIZE');
    limits.push(parameters.p_limit);
    if (String(cursor.revision) !== String(parameters.p_expected_cursor_revision))
      return {
        ok: false,
        reason: 'cursor_revision_conflict',
        cursor_revision: String(cursor.revision),
        wrapped: false,
        operations: [],
      };
    let wrapped = false;
    if (!ops.some((op) => op.ordinal > cursor.ordinal)) {
      cursor.ordinal = 0;
      wrapped = true;
    }
    const page = ops.filter((op) => op.ordinal > cursor.ordinal).slice(0, parameters.p_limit);
    cursor.ordinal = page.length ? page[page.length - 1].ordinal : 0;
    cursor.revision += 1;
    return {
      ok: true,
      reason: null,
      cursor_revision: String(cursor.revision),
      wrapped,
      operations: page.map((op) => op.state),
    };
  };
  return { ops, limits, rpc };
}

function manager(pendingCount: number) {
  const m: any = new TournamentManager(EVENT, {} as any, GENERATION, performance.now() + 60_000);
  m.running = true;
  m.eliminationSweepDeadlineAt = 0;
  m.requestUrgentEliminationSweepAfter = vi.fn();
  const cursor = discoveryCursor(pendingCount);
  vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, p: any) => {
    if (name !== 'fn_f06_discover_breaks') throw new Error(`unexpected rpc ${name}`);
    return { data: cursor.rpc(p), error: null };
  }) as any);
  return { m, cursor };
}

/** Server reads spent before the manager knows the event's whole pending set. */
async function readsToCompleteDiscovery(pendingCount: number): Promise<number> {
  const { m, cursor } = manager(pendingCount);
  while (!m.tournamentBreakDiscoveryComplete) {
    // Past this the event is frozen: the flag expires with the hourly restart.
    if (cursor.limits.length > 64) return cursor.limits.length;
    await m.discoverTournamentBreaks();
  }
  expect(m.durableTournamentBreaks.size).toBe(pendingCount);
  return cursor.limits.length;
}

afterEach(() => vi.restoreAllMocks());

describe('a balancer is not starved by break discovery', () => {
  it('costs the same number of server reads at seven pending breaks as at one', async () => {
    const one = await readsToCompleteDiscovery(1);
    vi.restoreAllMocks();
    const seven = await readsToCompleteDiscovery(7);
    expect(seven).toBe(one);
    // Measured 2026-09-29: 87a68e55's cursor advanced ONCE in twenty-six
    // minutes. A claim that expires hourly cannot be owed sixteen of these.
    expect(seven).toBeLessThanOrEqual(2);
  });

  it('the cb8f2dd1 shape: five pending breaks are all known, and excluded, after two reads', async () => {
    const { m, cursor } = manager(5);
    await m.discoverTournamentBreaks();
    await m.discoverTournamentBreaks();
    expect(m.tournamentBreakDiscoveryComplete).toBe(true);
    expect([...m.durableTournamentBreaks.keys()].sort()).toEqual(
      cursor.ops.map((op) => op.state.break_id).sort()
    );
  });

  it('still suspends the work budget for exactly one operation at a time', async () => {
    const { m } = manager(5);
    const unitSizes: number[] = [];
    const work = m.visitTournamentBreakWork.bind(m);
    m.visitTournamentBreakWork = (page: unknown[], ...rest: unknown[]) => {
      // The window that suspends the budget is opened around ONE operation:
      // never a whole page, which would let a single admission run page-deep,
      // and never none, which suspends the clock to do nothing.
      unitSizes.push(page.length);
      expect(m.tournamentBreakVisitOpen).toBe(true);
      return work(page, ...rest);
    };
    const visited: string[] = [];
    await m.visitTournamentBreakPage(async (state: { break_id: string }) => {
      visited.push(state.break_id);
    });
    expect(unitSizes.every((size) => size === 1)).toBe(true);
    // And every pending operation is still reached, none of them twice.
    expect(visited.length).toBe(5);
    expect(new Set(visited).size).toBe(5);
  });

  it('asks the database for its whole page, never one row at a time', async () => {
    const { m, cursor } = manager(7);
    await m.discoverTournamentBreaks();
    expect(cursor.limits).toEqual([32]);
  });
});
