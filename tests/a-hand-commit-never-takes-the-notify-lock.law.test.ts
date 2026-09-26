/**
 * ===========================================================================
 *  LAW: A HAND COMMIT NEVER TAKES THE NOTIFY LOCK
 * ===========================================================================
 *
 * Every committed hand inserts a row into public.hand_projection_outbox. From
 * 2026-09-10 to 2026-09-26 an AFTER INSERT trigger on that table called
 * pg_notify(). A transaction that has queued a notification takes Postgres's
 * single cluster-wide notification lock ("object 0 of class 1262") at
 * pre-commit and keeps it until its commit, WAL flush included, has finished.
 * So every hand commit in the fleet committed one at a time.
 *
 * Nobody listened: the engine's LISTEN session needs ENGINE_PG_LISTEN_URL,
 * which was never set on the engine host, and the only LISTEN in the database
 * was PostgREST's own "pgrst". Measured 04:00-09:00 UTC 2026-09-26: 2,754
 * PostgREST COMMITs waited more than a second for the lock (max 5.6 s), in
 * exactly the buckets where the lease heartbeat lost the shared pool and the
 * fleet was quarantined. The checkpoint sync stalls (26.5 s at 07:11) were the
 * spark; this lock is what made one stalled flush every hand's problem.
 *
 * 20260926090827_hand_commit_stops_notifying_nobody detached the trigger. This
 * law replays every migration in version order and refuses if any trigger that
 * is still attached to hand_projection_outbox, by the last definition of its
 * function, notifies. A future wake-up for the projection worker must not ride
 * the hand's own commit; the worker's in-process commit wake and its poll
 * already carry it (server/src/services/supabase/handProjection.ts).
 *
 * The replay is exported below and proved against a synthetic migration set
 * that re-attaches the trigger, so the law is shown to be able to fail.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.resolve(__dirname, '..', 'supabase', 'migrations');
const TABLE = 'hand_projection_outbox';

export type MigrationFile = { name: string; sql: string };

function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/** The latest body of public.<fn>() across the files, in order; null if never defined. */
function latestFunctionBody(files: MigrationFile[], fn: string): string | null {
  let body: string | null = null;
  const head = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?"?${fn}"?\\s*\\(`,
    'gi'
  );
  for (const f of files) {
    for (const m of f.sql.matchAll(head)) {
      const rest = f.sql.slice(m.index ?? 0);
      const as = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
      if (!as) continue;
      const start = (as.index ?? 0) + as[0].length;
      const end = rest.indexOf(as[1], start);
      if (end === -1) continue;
      body = rest.slice(start, end);
    }
  }
  return body;
}

/**
 * Replays CREATE/DROP TRIGGER statements on hand_projection_outbox in file
 * order and returns every trigger still attached, with whether its function's
 * latest body notifies.
 */
export function liveOutboxTriggers(
  files: MigrationFile[]
): { trigger: string; fn: string; notifies: boolean }[] {
  const live = new Map<string, string>();
  for (const f of files) {
    for (const raw of stripLineComments(f.sql).split(';')) {
      const stmt = raw.trim().replace(/\s+/g, ' ');
      const onTable = new RegExp(`\\bON (?:public\\.)?"?${TABLE}"?\\b`, 'i');
      if (!onTable.test(stmt)) continue;
      const create =
        /^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER "?(\w+)"? .*EXECUTE (?:FUNCTION|PROCEDURE) (?:public\.)?"?(\w+)"?\s*\(/i.exec(
          stmt
        );
      if (create) {
        live.set(create[1], create[2]);
        continue;
      }
      const drop = /^DROP TRIGGER (?:IF EXISTS )?"?(\w+)"?/i.exec(stmt);
      if (drop) live.delete(drop[1]);
    }
  }
  return [...live.entries()].map(([trigger, fn]) => {
    const body = latestFunctionBody(files, fn) ?? '';
    const code = stripLineComments(body);
    return { trigger, fn, notifies: /\bpg_notify\s*\(|\bNOTIFY\s+[A-Za-z"_]/i.test(code) };
  });
}

function repoMigrations(): MigrationFile[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS, name), 'utf8') }));
}

describe('LAW: a hand commit never takes the notify lock', () => {
  const files = repoMigrations();

  it('no trigger left on hand_projection_outbox notifies', () => {
    const live = liveOutboxTriggers(files);
    const notifying = live.filter((t) => t.notifies);
    expect(notifying, JSON.stringify(notifying)).toEqual([]);
  });

  it('the replay sees the triggers that are really there', () => {
    // The post-commit obligations trigger is still attached; if the replay
    // stopped seeing it, a silent parser would pass the first test for free.
    const names = liveOutboxTriggers(files).map((t) => t.trigger);
    expect(names).toContain('a0_finish_hand_post_commit_obligations');
    expect(names).not.toContain('z9_notify_hand_projection_outbox');
  });

  it('the detaching migration states a proof the live check can run', () => {
    const f = files.find((x) => x.name.endsWith('_hand_commit_stops_notifying_nobody.sql'));
    expect(f, 'the detaching migration is missing').toBeTruthy();
    expect(f!.sql).toMatch(/^-- @live-proof: .*hand_projection_outbox.*pg_notify/m);
    expect(f!.sql).toMatch(/SET LOCAL lock_timeout/);
  });

  it('NEGATIVE: re-attaching the notify trigger after the detach is caught', () => {
    const reattach: MigrationFile = {
      name: '29991231235959_reattach.sql',
      sql: 'BEGIN;\nCREATE TRIGGER z9_notify_hand_projection_outbox\n  AFTER INSERT ON public.hand_projection_outbox\n  FOR EACH ROW EXECUTE FUNCTION public.trg_notify_hand_projection_outbox();\nCOMMIT;\n',
    };
    const live = liveOutboxTriggers([...files, reattach]);
    expect(live.filter((t) => t.notifies).map((t) => t.trigger)).toEqual([
      'z9_notify_hand_projection_outbox',
    ]);
  });

  it('NEGATIVE: a new trigger function that notifies is caught', () => {
    const fresh: MigrationFile = {
      name: '29991231235959_fresh.sql',
      sql: "BEGIN;\nCREATE OR REPLACE FUNCTION public.trg_wake() RETURNS trigger LANGUAGE plpgsql AS $fn$\nBEGIN\n  PERFORM pg_notify('w', NEW.hand_id::text);\n  RETURN NEW;\nEND;\n$fn$;\nCREATE TRIGGER z8_wake AFTER INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION trg_wake();\nCOMMIT;\n",
    };
    const live = liveOutboxTriggers([...files, fresh]);
    expect(live.filter((t) => t.notifies).map((t) => t.trigger)).toEqual(['z8_wake']);
  });
});
