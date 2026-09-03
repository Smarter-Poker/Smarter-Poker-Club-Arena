/**
 * ENGINE START — a database blip must not become a respawn loop.
 *
 * Timeline, 2026-08-22. Fixing the dealing-loop watchdog took
 * `dealing_loop_dead` from 1,603 kills in six hours to zero. `start_failed`
 * then became the fleet's dominant fault: 117 in fifteen minutes, arriving in
 * bursts — 86 across 43 tables inside a single minute.
 *
 * The cause is one layer up and is the same shape. `loadTable` is the FIRST
 * statement of start() and it is a database read. A throw from it landed in
 * start()'s catch as `start_failed` -> killForRestart -> GameServer rebuilds
 * the engine within 5s -> the same read -> the same throw. Worse, each turn
 * of that loop costs MORE database work than a retry would: a rebuilt engine
 * also re-runs seedHandCountFromHistory, checkCrashRecovery and
 * resolveOrphanedAddOns.
 *
 * dealingLoop had always treated exactly these errors as transient and backed
 * off. start() treated them as fatal. Same database, same error, opposite
 * response — and the fatal response was the expensive one. These pin the two
 * halves of the correction: one shared definition of "transient", and a start
 * path that survives one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const loadSeatedPlayers = vi.fn();
const loadTable = vi.fn();

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    loadSeatedPlayers: (...a: unknown[]) => loadSeatedPlayers(...a),
    loadTable: (...a: unknown[]) => loadTable(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { ServerTableEngineBase } = await import('./ServerTableEngineBase.js');

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const transient = () => new Error('TypeError: fetch failed');

afterEach(() => {
  vi.restoreAllMocks();
  loadTable.mockReset();
  loadSeatedPlayers.mockReset();
});

const TABLE_ROW = {
  id: TABLE,
  small_blind: 1,
  big_blind: 2,
  ante: 0,
  game_variant: 'nlh',
  action_time_seconds: 15,
  max_players: 6,
};

const seat = (n: number) => ({
  user_id: 'u' + n,
  seat_number: n,
  username: 'p' + n,
  stack: 1000,
  is_horse: true,
});

/**
 * An engine with everything start() touches AFTER the opening read stubbed
 * out. The subject here is the read and the wait sweep, not the rest of the
 * boot sequence.
 */
function startable() {
  const engine = new ServerTableEngine(TABLE) as any;
  const killed: string[] = [];
  engine.killForRestart = (reason: string) => {
    killed.push(reason);
    engine.running = false;
  };
  engine.sleep = async () => {};
  engine.seedHandCountFromHistory = async () => {};
  /* ── FLAKE FIX 2026-08-27 ──────────────────────────────────────────────
     This helper's own contract, three lines up, is "everything start()
     touches AFTER the opening read stubbed out". Three collaborators were
     not, and they are the only ones left that reach the (mocked) database:
     restoreButtonFromHistory runs before the wait loop, and
     restoreSitOutsFromSeats + evictExpiredSitOuts run inside every pass of
     it. With `sleep` stubbed to a no-op that loop has no pacing at all, so
     under a parallel `vitest run` those reads decide how long the test
     takes - and this file was already spending 8.06s of its 10s budget in
     isolation. On main it failed two ways at once: the first spec timed out,
     and its still-spinning loop then leaked an extra loadSeatedPlayers call
     into the next spec, which asserts an exact call count ("expected 2,
     got 3"). Both failures were reproduced on a clean checkout of main with
     these changes stashed, so this is a pre-existing flake, not a
     consequence of the audit work in this branch.

     Stubbed rather than given a real delay on purpose: this file's subject
     is the retry on the opening read and the seat sweep. Anything else it
     waits on is another test's job. */
  engine.restoreButtonFromHistory = async () => {};
  engine.restoreSitOutsFromSeats = () => {};
  engine.evictExpiredSitOuts = async () => {};
  engine.checkCrashRecovery = async () => false;
  engine.resolveOrphanedAddOns = async () => {};
  engine.broadcastCurrentState = async () => {};
  engine.scheduleHeartbeatCheck = () => {};
  engine.dealingLoop = async () => {};
  return { engine, killed };
}

describe('isTransientDbError - one definition, because two disagreed', () => {
  const is = (e: unknown) => (ServerTableEngineBase as any).isTransientDbError(e);

  it('recognises the wordings production actually produces', () => {
    for (const msg of [
      'TypeError: fetch failed',
      'Failed to fetch',
      'ECONNRESET',
      'ETIMEDOUT',
      'socket hang up',
      'supabase_timeout',
      'This operation was aborted',
    ]) {
      expect(is(new Error(msg))).toBe(true);
    }
  });

  it('treats a blown deal-step budget as transient - the loop already did', () => {
    expect(is(new Error('deal_step_timeout: load_seats exceeded 20s'))).toBe(true);
  });

  it('does NOT excuse a real bug as a network blip', () => {
    expect(is(new TypeError('this.handController.getStat is not a function'))).toBe(false);
    expect(is(new Error('column tables.rake_cap does not exist'))).toBe(false);
  });
});

/* Same reason as the budget note in src/benchmark/HorseLeague.test.ts: these
   specs drive a real start() loop and were spending 8.06s of the 10s default
   in isolation, so they lost the race under parallel load. The unstubbed
   collaborators in startable() above were the other half of that cost and are
   now stubbed; this budget covers the rest. */
describe(
  'start() survives a database blip instead of respawning through it',
  { timeout: 60_000 },
  () => {
    it('retries the opening loadTable and gets on with it', async () => {
      const { engine, killed } = startable();
      loadTable.mockRejectedValueOnce(transient()).mockResolvedValue(TABLE_ROW);
      loadSeatedPlayers.mockResolvedValue([seat(1), seat(2)]);

      await engine.start();

      expect(loadTable).toHaveBeenCalledTimes(2);
      expect(killed).toEqual([]);
      expect(engine.tableInfo).toMatchObject({ id: TABLE });
    });

    it('gives up after a bounded number of attempts, naming the stage it died in', async () => {
      const { engine, killed } = startable();
      loadTable.mockRejectedValue(transient());
      loadSeatedPlayers.mockResolvedValue([seat(1), seat(2)]);

      await engine.start();

      expect(loadTable).toHaveBeenCalledTimes(5);
      // Not a bare `start_failed`: a kill reason that is the same string for
      // every possible cause is how 1,603 rows produced no diagnosis at all.
      expect(killed).toEqual(['start_failed:start_load_table']);
    });

    it('does not retry a real bug - that would just delay the rebuild', async () => {
      const { engine, killed } = startable();
      loadTable.mockRejectedValue(new TypeError('loadTable is not a function'));
      loadSeatedPlayers.mockResolvedValue([seat(1), seat(2)]);

      await engine.start();

      expect(loadTable).toHaveBeenCalledTimes(1);
      expect(killed).toEqual(['start_failed:start_load_table']);
    });

    it('a failed seat sweep costs one sweep, not the engine', async () => {
      const { engine, killed } = startable();
      loadTable.mockResolvedValue(TABLE_ROW);
      // The sweep is a poll that already runs every 5s. Letting a blip escape it
      // aborted start() outright, on a table with players waiting to be dealt to.
      loadSeatedPlayers.mockRejectedValueOnce(transient()).mockResolvedValue([seat(1), seat(2)]);

      await engine.start();

      expect(loadSeatedPlayers).toHaveBeenCalledTimes(2);
      expect(killed).toEqual([]);
    });
  }
);
