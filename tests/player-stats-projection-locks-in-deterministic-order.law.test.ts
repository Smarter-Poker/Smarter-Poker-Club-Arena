/**
 * ===========================================================================
 *  LAW: PLAYER_STATS PROJECTION LOCKS IN DETERMINISTIC ORDER
 * ===========================================================================
 *
 * fn_project_hand_side_effects_after_post_commit_20260908's Projection 2
 * (legacy player_stats fold/winnings totals) inserted one row per seated
 * player of a hand in a single multi-row `INSERT ... ON CONFLICT`, with no
 * `ORDER BY` on its source query. Postgres does not guarantee any particular
 * row-lock acquisition order for such a statement without one; the order
 * actually taken depends on the join plan (a hash join over the `seated`/
 * `won` CTEs here), which is not stable across concurrent executions
 * touching an overlapping player set.
 *
 * fn_process_cash_accounting_source (reached from
 * fn_credit_agent_commissions_batch, the cash rakeback/commission credit
 * path) locks the SAME player_stats rows one at a time, in a fixed
 * `ORDER BY club_id, player_id` (public.apply_rakeback_player_stats per
 * loop iteration). Both paths run for the same hand concurrently: the
 * hand-side-effects projection is driven off hand_projection_outbox right
 * after a hand commits, and the cash-accounting source off the same hand's
 * rake_record at the same time.
 *
 * Read live from public.postgres_logs (ClickHouse) at 2026-09-28T16:05:54Z /
 * 16:06:11Z: a process running fn_project_hand_side_effects deadlocked
 * against a concurrent process running fn_credit_agent_commissions_batch,
 * both reporting "waits for ShareLock on transaction <xid>; blocked by
 * process <pid>" - row-level contention on player_stats, not the advisory
 * locks each function separately takes (different keyspaces:
 * 'hand-projection:<table_id>' vs 'accounting_cash_hand:<hand_id>' /
 * 'accounting_cash_source:<rake_id>', so those cannot be what collided).
 * `DatabaseDeadlocksElevated` (severity=critical) fired between 12 and
 * ~4006 deadlocks/10min through 2026-09-28 (board
 * Smarter-Poker/Smarter-Poker-Club-Arena #5070, 124 rows, never previously
 * tracked despite the severity).
 *
 * Projections 3 and 4 in the same function already order their multi-row
 * writes (`ORDER BY f.user_id, f.hand_id`, `ORDER BY 1, 3`) for exactly this
 * reason - Projection 2 was the one left unordered. The fix adds
 * `ORDER BY s.uid::uuid` to Projection 2's source SELECT: v_club is a single
 * constant value within this statement, so ordering by uid alone equals
 * ordering by (club_id, player_id) for the overlapping club, matching the
 * cash-accounting path's lock order. This changes only the order rows are
 * locked and written within the statement, never which rows are written or
 * their final values (still an `INSERT ... ON CONFLICT DO UPDATE`
 * accumulation) - a lock-ordering fix, not a money change.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceSqlStatement } from './helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '..');
const MIG_DIR = path.join('supabase', 'migrations');

const MIGRATIONS = fs
  .readdirSync(path.join(ROOT, MIG_DIR))
  .filter((f) => f.endsWith('.sql'))
  .sort();

const BODY = new Map<string, string>(
  MIGRATIONS.map((f) => [f, fs.readFileSync(path.join(ROOT, MIG_DIR, f), 'utf8')])
);

/** The LAST migration (by version) that redefines the function is the live one. */
function currentDefiner(qualified: string): string {
  const [schema, name] = qualified.split('.');
  const re = new RegExp(
    String.raw`create\s+or\s+replace\s+function\s+(?:${schema}\s*\.\s*)?"?${name}"?\s*\(`,
    'i'
  );
  const definers = MIGRATIONS.filter((f) => re.test(BODY.get(f) as string));
  expect(definers.length, `${qualified} must be defined by a migration`).toBeGreaterThan(0);
  return definers[definers.length - 1];
}

function projector(): { file: string; stmt: string } {
  const file = currentDefiner('public.fn_project_hand_side_effects_after_post_commit_20260908');
  return {
    file,
    stmt: sliceSqlStatement(
      BODY.get(file) as string,
      'CREATE OR REPLACE FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908'
    ),
  };
}

describe('player_stats projection locks in deterministic order', () => {
  it('scans a real migration tree (an empty sweep must not read as a pass)', () => {
    // CLAUDE.md 10.86 rule 2.
    expect(MIGRATIONS.length).toBeGreaterThan(1000);
  });

  it("Projection 2's player_stats insert orders its source rows before ON CONFLICT", () => {
    const { file, stmt } = projector();
    // Isolate the player_stats INSERT specifically, so this cannot pass by
    // matching an ORDER BY that belongs to a different projection's INSERT.
    const start = stmt.indexOf('INSERT INTO public.player_stats');
    expect(start, `${file}: Projection 2's "INSERT INTO public.player_stats" not found`).toBeGreaterThanOrEqual(
      0
    );
    const conflictAt = stmt.indexOf('ON CONFLICT (user_id,club_id)', start);
    expect(
      conflictAt,
      `${file}: Projection 2's ON CONFLICT (user_id,club_id) clause not found after its INSERT`
    ).toBeGreaterThan(start);
    const insertWindow = stmt.slice(start, conflictAt);
    expect(
      /order\s+by\s+s\.uid(?:::uuid)?\s*$/im.test(insertWindow.trimEnd()) ||
        /order\s+by\s+s\.uid(?:::uuid)?\s*\n/i.test(insertWindow),
      `${file}: Projection 2's player_stats INSERT must ORDER BY s.uid so row-lock acquisition ` +
        'is deterministic across concurrent statements - without it, Postgres locks rows in ' +
        'join-plan order (a hash join here), which is not stable across executions and can ' +
        'deadlock against fn_process_cash_accounting_source (public.apply_rakeback_player_stats), ' +
        'which locks the same player_stats rows one at a time in a fixed club_id/player_id order'
    ).toBe(true);
  });

  it('the deterministic order matches the cash-accounting path\'s lock key (uid, i.e. user_id/player_id)', () => {
    const { file, stmt } = projector();
    // Guards against a future edit that adds an ORDER BY on the wrong column
    // (e.g. an unrelated column that happens to satisfy the regex above but
    // does not actually align the two paths' lock order).
    const start = stmt.indexOf('INSERT INTO public.player_stats');
    const conflictAt = stmt.indexOf('ON CONFLICT (user_id,club_id)', start);
    const insertWindow = stmt.slice(start, conflictAt);
    expect(
      /order\s+by\s+s\.uid/i.test(insertWindow),
      `${file}: the ORDER BY must sort by s.uid (the seated-player CTE's uid column, which the ` +
        'SELECT list casts to user_id) - the same identity fn_process_cash_accounting_source ' +
        'locks player_stats rows by'
    ).toBe(true);
  });

  it('the fix does not touch which rows are written or their accumulation, only their lock order', () => {
    const { file, stmt } = projector();
    // The ON CONFLICT DO UPDATE accumulation arithmetic must be byte-identical
    // to before the fix - this is a lock-ordering change, never a value change.
    expect(
      stmt.includes(
        'hands_dealt=ps.hands_dealt+EXCLUDED.hands_dealt,\n      sum_big_blind=ps.sum_big_blind+EXCLUDED.sum_big_blind,\n      total_winnings=ps.total_winnings+EXCLUDED.total_winnings,\n      updated_at=now();'
      ),
      `${file}: Projection 2's ON CONFLICT DO UPDATE arithmetic must be unchanged by this fix`
    ).toBe(true);
  });

  it('Projections 3 and 4 keep their own deterministic order (the pattern this fix now matches)', () => {
    const { file, stmt } = projector();
    expect(
      /order\s+by\s+1,\s*3[\s\S]{0,80}on\s+conflict\s+do\s+nothing;\s*\n\s*\n\s*insert\s+into\s+public\.ca_hand_player_stat/i.test(
        stmt
      ),
      `${file}: ca_hand_player_idx insert must keep its ORDER BY 1, 3`
    ).toBe(true);
    expect(
      /order\s+by\s+f\.user_id,\s*f\.hand_id/i.test(stmt),
      `${file}: ca_hand_player_stat insert must keep its ORDER BY f.user_id, f.hand_id`
    ).toBe(true);
  });
});
