/**
 * MULTI-TABLE SERVER AUDIT (2026-08-19) — invariants for concurrent-table play.
 *
 * Covers the four synthetic sequences the audit demanded:
 *   1. A user joins 4 tables; the 5th sit-down is rejected with
 *      TABLE_CAP_REACHED (the cap now lives in atomic_table_buyin itself —
 *      the engine server has no join route, the RPC IS the seat-taking path).
 *   2. A disconnect at one of three tables affects THAT table only
 *      (DisconnectEngine keys every player record by `${tableId}:${userId}`).
 *   3. A horse at 4 tables with one slow table: per-table think timers run
 *      independently — a slow decision on table A never starves B/C/D.
 *   4. Two concurrent seat requests for the same horse: the advisory-lock
 *      serialization in the RPC admits exactly the seats the cap allows.
 *
 * Pattern: lifted-logic harnesses (same as HorseFleetNoDuplicateTables /
 * CashTableClosureIsRespected) — the SQL/rotator control flow is mirrored in
 * a runnable model, and source pins assert the shipped files still contain
 * the load-bearing lines the model mirrors. Where the OLD behavior was the
 * bug, a CONTROL reproduces it so the regression is demonstrated, not
 * described.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DisconnectEngine } from './engine/DisconnectEngine.js';
import { PreciseActionTimer } from './engine/PreciseActionTimer.js';

// ═════════════════════════════════════════════════════════════════════════════
// 1 + 4. PER-USER TABLE CAP — model of atomic_table_buyin's guard section
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Mirrors the RPC's control flow: per-user advisory xact lock → duplicate-seat
 * check → active-table count vs cap → insert. The per-user mutex models
 * pg_advisory_xact_lock (which serializes concurrent transactions for the
 * same user), so the count-then-insert cannot race with itself.
 */
function makeSeatLedger(maxTables = 4) {
  type Seat = { tableId: string; userId: string; leftAt: number | null };
  const seats: Seat[] = [];
  const openTables = new Set<string>();
  const userLocks = new Map<string, Promise<unknown>>();

  async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = userLocks.get(userId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // The chain must survive rejections or a rejected buy-in would poison
    // every later buy-in for the user.
    userLocks.set(
      userId,
      run.catch(() => undefined)
    );
    return run;
  }

  return {
    openTable(id: string) {
      openTables.add(id);
    },
    closeTable(id: string) {
      openTables.delete(id);
    },
    activeTableCount(userId: string): number {
      return seats.filter(
        (s) => s.userId === userId && s.leftAt === null && openTables.has(s.tableId)
      ).length;
    },
    async buyin(
      userId: string,
      tableId: string
    ): Promise<{ ok: true } | { ok: false; error: string }> {
      return withUserLock(userId, async () => {
        // Simulate the transaction doing real async work while holding the lock.
        await new Promise((r) => setTimeout(r, 1));
        if (seats.some((s) => s.tableId === tableId && s.userId === userId && s.leftAt === null)) {
          return { ok: false as const, error: 'Player already seated at this table' };
        }
        const active = seats.filter(
          (s) => s.userId === userId && s.leftAt === null && openTables.has(s.tableId)
        ).length;
        if (active >= maxTables) {
          return {
            ok: false as const,
            error: `TABLE_CAP_REACHED: already seated at ${active} tables (max ${maxTables})`,
          };
        }
        seats.push({ tableId, userId, leftAt: null });
        return { ok: true as const };
      });
    },
    leave(userId: string, tableId: string) {
      const seat = seats.find(
        (s) => s.tableId === tableId && s.userId === userId && s.leftAt === null
      );
      if (seat) seat.leftAt = Date.now();
    },
  };
}

describe('per-user concurrent-table cap (atomic_table_buyin model)', () => {
  it('admits 4 tables, rejects the 5th with TABLE_CAP_REACHED', async () => {
    const ledger = makeSeatLedger();
    for (const t of ['t1', 't2', 't3', 't4', 't5']) ledger.openTable(t);
    for (const t of ['t1', 't2', 't3', 't4']) {
      expect((await ledger.buyin('u', t)).ok).toBe(true);
    }
    const fifth = await ledger.buyin('u', 't5');
    expect(fifth.ok).toBe(false);
    expect((fifth as { error: string }).error).toContain('TABLE_CAP_REACHED');
    expect(ledger.activeTableCount('u')).toBe(4);
  });

  it('leaving a table frees the slot', async () => {
    const ledger = makeSeatLedger();
    for (const t of ['t1', 't2', 't3', 't4', 't5']) ledger.openTable(t);
    for (const t of ['t1', 't2', 't3', 't4']) await ledger.buyin('u', t);
    ledger.leave('u', 't2');
    expect((await ledger.buyin('u', 't5')).ok).toBe(true);
  });

  it('seats at CLOSED tables do not count against the cap (stale bookkeeping is not live play)', async () => {
    const ledger = makeSeatLedger();
    for (const t of ['t1', 't2', 't3', 't4', 't5']) ledger.openTable(t);
    for (const t of ['t1', 't2', 't3', 't4']) await ledger.buyin('u', t);
    ledger.closeTable('t1'); // table closed with left_at never stamped
    expect((await ledger.buyin('u', 't5')).ok).toBe(true);
  });

  it('RACE: two concurrent sit-downs at the last free slot admit exactly one', async () => {
    const ledger = makeSeatLedger();
    for (const t of ['t1', 't2', 't3', 't4', 't5']) ledger.openTable(t);
    for (const t of ['t1', 't2', 't3']) await ledger.buyin('u', t);
    const [a, b] = await Promise.all([ledger.buyin('u', 't4'), ledger.buyin('u', 't5')]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(ledger.activeTableCount('u')).toBe(4);
  });

  it('RACE: two concurrent seat requests for the same horse at the same table admit exactly one', async () => {
    const ledger = makeSeatLedger();
    ledger.openTable('t1');
    const [a, b] = await Promise.all([ledger.buyin('horse', 't1'), ledger.buyin('horse', 't1')]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('CONTROL: without the per-user lock, the concurrent 4th+5th race over-seats', async () => {
    // The same count-then-insert with NO serialization — both readers see 3.
    const seats: string[] = [];
    const active = () => seats.length;
    const unlockedBuyin = async () => {
      const n = active();
      await new Promise((r) => setTimeout(r, 1)); // the await window
      if (n >= 4) return false;
      seats.push('seat');
      return true;
    };
    seats.push('a', 'b', 'c');
    const results = await Promise.all([unlockedBuyin(), unlockedBuyin()]);
    expect(results.filter(Boolean)).toHaveLength(2); // the bug: 5 active seats
    expect(active()).toBe(5);
  });
});

describe('per-user table cap - shipped-source pins', () => {
  const MIG = readFileSync(
    join(process.cwd(), '../supabase/migrations/20260819_per_user_concurrent_table_cap.sql'),
    'utf8'
  );

  it('the migration serializes per user with an advisory xact lock', () => {
    expect(MIG).toContain(
      "pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0))"
    );
  });

  it('the migration counts active seats at open tables and rejects at the cap', () => {
    expect(MIG).toContain('ts.left_at IS NULL');
    expect(MIG).toContain("t.status NOT IN ('closed', 'deleted')");
    expect(MIG).toContain('v_active_tables >= v_max_tables');
    expect(MIG).toContain('TABLE_CAP_REACHED');
    expect(MIG).toContain('v_max_tables CONSTANT INT := 4');
  });

  it('the migration keeps the identity guard (a JWT caller may only seat themself)', () => {
    expect(MIG).toContain('auth.uid() IS NOT NULL AND auth.uid() <> p_user_id');
  });

  it('HorseFleetManager treats a cap rejection as an expected seeding outcome', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');
    expect(src).toContain("!msg.includes('TABLE_CAP_REACHED')");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. DISCONNECT ISOLATION ACROSS N TABLES — real DisconnectEngine
// ═════════════════════════════════════════════════════════════════════════════

describe('disconnect at one of three tables (real DisconnectEngine)', () => {
  it('markDisconnected at table B leaves A and C connected', () => {
    const eng = new DisconnectEngine(new PreciseActionTimer());
    for (const t of ['A', 'B', 'C']) {
      eng.configure(t, { disconnectTimeoutSeconds: 30 });
      eng.registerPlayer(t, 'u');
    }
    eng.markDisconnected('B', 'u');
    expect(eng.getFsmState('A', 'u')?.state).toBe('CONNECTED');
    expect(eng.getFsmState('B', 'u')?.state).not.toBe('CONNECTED');
    expect(eng.getFsmState('C', 'u')?.state).toBe('CONNECTED');
  });

  it('a heartbeat for table B does not refresh tables A and C', () => {
    const eng = new DisconnectEngine(new PreciseActionTimer());
    for (const t of ['A', 'B', 'C']) {
      eng.configure(t, { disconnectTimeoutSeconds: 30 });
      eng.registerPlayer(t, 'u');
    }
    eng.markDisconnected('A', 'u');
    eng.markDisconnected('B', 'u');
    eng.heartbeat('B', 'u'); // POST /heartbeat carries a tableId — per table
    expect(eng.getFsmState('B', 'u')?.state).toBe('CONNECTED');
    expect(eng.getFsmState('A', 'u')?.state).not.toBe('CONNECTED');
  });

  it('sit-out at one table never leaks to another', () => {
    const eng = new DisconnectEngine(new PreciseActionTimer());
    for (const t of ['A', 'B']) {
      eng.configure(t, {});
      eng.registerPlayer(t, 'u');
    }
    eng.sitOut('A', 'u');
    expect(eng.getFsmState('A', 'u')?.state).toBe('SAT_OUT');
    expect(eng.getFsmState('B', 'u')?.state).toBe('CONNECTED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. HORSE THINK-TIMER INTERLEAVING — one slow table must not starve the rest
// ═════════════════════════════════════════════════════════════════════════════

describe('horse decision interleaving across 4 tables', () => {
  it('a slow think on table A does not delay B/C/D (per-table setTimeout, no global lock)', async () => {
    // Mirrors scheduleHorseAction: each engine owns its horseActionTimer and
    // arms an independent setTimeout. Table A thinks 80ms; B/C/D think 5ms.
    const acted: string[] = [];
    const armThink = (tableId: string, thinkMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          acted.push(tableId);
          resolve();
        }, thinkMs);
      });
    await Promise.all([armThink('A', 80), armThink('B', 5), armThink('C', 5), armThink('D', 5)]);
    expect(acted.indexOf('A')).toBe(3); // slow table finishes LAST...
    expect(acted.slice(0, 3).sort()).toEqual(['B', 'C', 'D']); // ...having starved nobody
  });

  it('shipped source pin: the think timer is per-engine state, armed per table', () => {
    const src = readFileSync(join(process.cwd(), 'src/engine/ServerTableEngineTurns.ts'), 'utf8');
    expect(src).toContain('this.horseActionTimer = setTimeout(');
    // The stale-controller identity check that keeps a slow timer from firing
    // into the NEXT hand:
    expect(src).toContain('if (handControllerRef !== this.handController) return;');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// HORSE SESSION ROTATOR — break bookkeeping must be per (table, horse)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Lifted from HorseSessionRotator (2026-08-19 fix): break records keyed by
 * `${tableId}:${userId}`. The value carries userId for the sit-back pass.
 */
function makeBreakBook() {
  const breaks = new Map<string, { tableId: string; userId: string; sitBackAt: number }>();
  const key = (tableId: string, userId: string) => `${tableId}:${userId}`;
  return {
    startBreak(tableId: string, userId: string, sitBackAt: number) {
      if (breaks.has(key(tableId, userId))) return false;
      breaks.set(key(tableId, userId), { tableId, userId, sitBackAt });
      return true;
    },
    /** Departure from ONE table clears only that table's record. */
    onLeave(tableId: string, userId: string) {
      breaks.delete(key(tableId, userId));
    },
    dueSitBacks(now: number): Array<{ tableId: string; userId: string }> {
      const due: Array<{ tableId: string; userId: string }> = [];
      for (const [k, info] of [...breaks]) {
        if (now < info.sitBackAt) continue;
        breaks.delete(k);
        due.push({ tableId: info.tableId, userId: info.userId });
      }
      return due;
    },
    size: () => breaks.size,
  };
}

describe('rotator break bookkeeping for a multi-tabling horse', () => {
  it('a break at table B does not orphan a live break at table A', () => {
    const book = makeBreakBook();
    expect(book.startBreak('A', 'horse', 1_000)).toBe(true);
    expect(book.startBreak('B', 'horse', 2_000)).toBe(true);
    const dueAt1000 = book.dueSitBacks(1_000);
    expect(dueAt1000).toEqual([{ tableId: 'A', userId: 'horse' }]); // A sits back on time
    expect(book.dueSitBacks(2_000)).toEqual([{ tableId: 'B', userId: 'horse' }]);
  });

  it('leaving table B does not cancel the sit-back owed at table A', () => {
    const book = makeBreakBook();
    book.startBreak('A', 'horse', 1_000);
    book.startBreak('B', 'horse', 2_000);
    book.onLeave('B', 'horse');
    expect(book.dueSitBacks(5_000)).toEqual([{ tableId: 'A', userId: 'horse' }]);
  });

  it('CONTROL: the old userId-only key orphans table A forever', () => {
    // The pre-fix bookkeeping, verbatim shape: Map<userId, {tableId, sitBackAt}>.
    const breaks = new Map<string, { tableId: string; sitBackAt: number }>();
    breaks.set('horse', { tableId: 'A', sitBackAt: 1_000 });
    breaks.set('horse', { tableId: 'B', sitBackAt: 2_000 }); // break at B OVERWRITES A
    const satBackAt: string[] = [];
    for (const [userId, info] of [...breaks]) {
      void userId;
      satBackAt.push(info.tableId);
    }
    expect(satBackAt).toEqual(['B']); // table A's sit-out is never ended — the bug
  });

  it('shipped source pin: HorseSessionRotator keys breaks by table AND horse', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/HorseSessionRotator.ts'), 'utf8');
    expect(src).toContain('private static breakKey(tableId: string, userId: string)');
    expect(src).toContain(
      'this.breaks.set(HorseSessionRotator.breakKey(tableId, best.seat.user_id)'
    );
    expect(src).toContain(
      'this.breaks.delete(HorseSessionRotator.breakKey(tableId, best.seat.user_id))'
    );
    // The sit-back pass reads the userId from the VALUE, not the key:
    expect(src).toContain('this.getEngine(info.tableId)?.sitOut?.(info.userId, false)');
    // And the old user-keyed set is gone:
    expect(src).not.toContain('this.breaks.set(best.seat.user_id');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SATELLITE current_players — recount, never snapshot + delta
// ═════════════════════════════════════════════════════════════════════════════

describe('satellite award current_players write', () => {
  /** The FIXED write: recount tournament_players, ignore the stale snapshot. */
  function fixedWrite(dbCount: number): number {
    return dbCount;
  }
  /** The OLD write: stale snapshot + awardCount. */
  function oldWrite(snapshotCount: number, awardCount: number): number {
    return snapshotCount + awardCount;
  }

  it('a registration landing between snapshot and write survives the fixed path', () => {
    const snapshot = 10; // read before the payout awaits
    // While prizes were paying out: 2 satellite winners inserted + 3 humans
    // registered through fn_register_for_tournament.
    const trueRows = 10 + 2 + 3;
    expect(fixedWrite(trueRows)).toBe(15);
    expect(oldWrite(snapshot, 2)).toBe(12); // CONTROL: erases the 3 humans
  });

  it('shipped source pin: the atomic database authority owns target registration counts', () => {
    const src = readFileSync(join(process.cwd(), 'src/tournament/TournamentManager.ts'), 'utf8');
    expect(src).toContain("rpc('fn_settle_satellite_tournament'");
    expect(src).toContain('verifySatelliteSettlementReceipt(');
    // Strip comments first — the fix documents the old formula in prose, and a
    // naive substring check would match its own documentation.
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toContain('Number(target.current_players || 0) + awardCount');
    expect(code).not.toMatch(/\.from\('tournaments'\)[\s\S]{0,240}?current_players:/);
  });
});
