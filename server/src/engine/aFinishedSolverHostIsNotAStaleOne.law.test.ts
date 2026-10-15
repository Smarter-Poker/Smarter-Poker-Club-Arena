/**
 * LAW: A FINISHED SOLVER HOST IS NOT A STALE ONE, AND A DATASET NOTHING IS
 *      WORKING ON IS NAMED FOR WHAT STOPPED IT (2026-10-15).
 *
 * fn_audit_solver_pipeline_liveness raised CRITICAL solver_worker_stale for M1
 * and M2 on every daily audit from 2026-10-07, on heartbeat age alone. Both
 * hosts had exited 0 (worker_state 'completed', rows_done = rows_planned):
 * the V31 hosts are finite one-shot runs and stop beating when they finish.
 * Meanwhile two datasets sat in 'building' with every run completed and a
 * compactor whose last word was 'failed', and no finding said so.
 *
 * WHAT THIS PINS, against the newest migration that defines the function:
 * 1. solver_worker_stale requires a NON-TERMINAL worker_state (every state of
 *    the solver_worker_heartbeats CHECK except completed and failed) AND a
 *    heartbeat older than 15 minutes.
 * 2. solver_dataset_abandoned is critical and requires state 'building' for
 *    over 24 hours, every host's latest run 'completed', and the compactor's
 *    latest heartbeat 'failed', and it carries the compactor's error_detail.
 * 3. Output shape stays what fn_run_horse_daily_audit appends: a jsonb array
 *    of {severity, category, code, title, evidence, recommendation}.
 * 4. The migration is one transaction, lock_timeout 3s, and refuses to run
 *    over anything but the md5 of the live body it was written against.
 * 5. NEGATIVE PROOF: the checker flags the previous body.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');

const THIS = '20261015134134_a_finished_solver_host_is_not_a_stale_one.sql';
const PREVIOUS = '20260927220533_uncommissioned_solver_pipeline_is_not_an_outage.sql';
const TABLES = '20260908181724_both_solver_hosts_and_the_compactor_leave_receipts.sql';
const LIVE_PREIMAGE_MD5 = '845d4d7ab0169c63ccf6efaeaa7f4a12';

const DEFINES = /CREATE OR REPLACE FUNCTION public\.fn_audit_solver_pipeline_liveness\(/;

function bodyOf(sql: string): string {
  const start = sql.search(DEFINES);
  if (start < 0) throw new Error('migration does not define fn_audit_solver_pipeline_liveness');
  const open = sql.indexOf('$function$', start);
  const close = sql.indexOf('$function$', open + 1);
  return sql.slice(open, close);
}

/** The worker states declared by the heartbeat table's CHECK. */
function declaredWorkerStates(): string[] {
  const m = /worker_state\s+text NOT NULL CHECK \(worker_state IN\s*\(([^)]*)\)\)/.exec(
    read(TABLES)
  );
  if (!m) throw new Error('worker_state CHECK not found');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}
const TERMINAL = ['completed', 'failed'];

/** Every way a body breaks this law. */
function violations(body: string): string[] {
  const out: string[] = [];
  const nonTerminal = declaredWorkerStates().filter((s) => !TERMINAL.includes(s));

  // 1. The condition that guards solver_worker_stale.
  const staleAt = body.indexOf("'code','solver_worker_stale'");
  if (staleAt < 0) out.push('solver_worker_stale is gone');
  else {
    const guard = body.slice(body.lastIndexOf('IF ', body.lastIndexOf('THEN', staleAt)), staleAt);
    const inList = /v_worker\.worker_state IN \(([^)]*)\)/.exec(guard);
    if (!inList) out.push('solver_worker_stale is not gated on worker_state');
    else {
      const states = [...inList[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
      if (JSON.stringify(states) !== JSON.stringify([...nonTerminal].sort()))
        out.push(`solver_worker_stale gates on ${states.join(',')}, not the non-terminal states`);
    }
    if (!/AND v_worker\.received_at < now\(\)-interval '15 minutes'/.test(guard))
      out.push('solver_worker_stale no longer requires a heartbeat over 15 minutes old');
  }

  // 2. The abandoned-dataset finding and every condition it needs.
  const abandonedAt = body.indexOf("'code','solver_dataset_abandoned'");
  if (abandonedAt < 0) out.push('solver_dataset_abandoned is missing');
  else {
    const loop = body.slice(
      body.lastIndexOf('FOR v_dataset IN', abandonedAt),
      body.indexOf('END LOOP;', abandonedAt)
    );
    const need: [RegExp, string][] = [
      [/d\.state = 'building'/, "state 'building'"],
      [/d\.created_at < now\(\) - interval '24 hours'/, 'over 24 hours'],
      [/bool_and\(lr\.worker_state = 'completed'\)/, 'every run completed'],
      [/w\.all_completed/, 'all_completed applied'],
      [/w\.machines_finished = cardinality\(d\.machine_ids\)/, 'every machine accounted for'],
      [/c\.compact_state = 'failed'/, "compactor last state 'failed'"],
      [
        /ORDER BY ch\.received_at DESC, ch\.sequence DESC\s+LIMIT 1/,
        "the compactor's LATEST heartbeat",
      ],
      [/'severity','critical'/, 'critical severity'],
      [/'compactor_error',v_dataset\.compact_error/, 'compactor error in evidence'],
      [/compactor failed: '\|\|\s*COALESCE\(v_dataset\.compact_error/, 'compactor error in title'],
    ];
    for (const [re, what] of need)
      if (!re.test(loop)) out.push(`solver_dataset_abandoned lost: ${what}`);
  }

  // 3. Shape.
  for (const m of body.matchAll(/jsonb_build_object\('severity',/g)) {
    const chunk = body.slice(m.index!, m.index! + 4000);
    for (const key of ["'category'", "'code'", "'title'", "'evidence'", "'recommendation'"])
      if (!chunk.includes(key)) out.push(`a finding lacks ${key}`);
  }
  if (!body.includes('RETURN v_findings;\nEND;'))
    out.push('the function no longer returns the findings array');
  return out;
}

describe('a finished solver host is not a stale one', () => {
  const sql = read(THIS);
  const body = bodyOf(sql);

  it('is the newest definition of fn_audit_solver_pipeline_liveness', () => {
    const definers = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => DEFINES.test(read(f)));
    expect(definers[definers.length - 1]).toBe(THIS);
  });

  it('the new body satisfies every condition', () => {
    expect(violations(body)).toEqual([]);
  });

  it('the stale gate leaves out exactly the terminal states', () => {
    const states = declaredWorkerStates();
    expect(states).toEqual(expect.arrayContaining(TERMINAL));
    const guard = /v_worker\.worker_state IN \(([^)]*)\)\s*AND v_worker\.received_at/.exec(
      body
    )![1];
    expect(guard).not.toContain("'completed'");
    expect(guard).not.toContain("'failed'");
  });

  it('a failed host still reaches solver_worker_failed, and a completed one with invalid rows too', () => {
    expect(body).toMatch(/ELSIF v_worker\.worker_state='failed' OR v_worker\.invalid_rows>0 THEN/);
  });

  it('is one transaction with a 3s lock timeout and an md5 preimage of the live body', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '3s';$/m);
    expect(sql).toContain(
      `IF md5(pg_get_functiondef('public.fn_audit_solver_pipeline_liveness(date)'::regprocedure)) IS DISTINCT FROM '${LIVE_PREIMAGE_MD5}' THEN`
    );
    expect(sql.indexOf('DO $pre$')).toBeLessThan(sql.search(DEFINES));
  });

  it('keeps the grants: service_role only', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_audit_solver_pipeline_liveness(date) FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_audit_solver_pipeline_liveness(date) TO service_role;'
    );
  });

  it('NEGATIVE PROOF: the previous body is flagged', () => {
    const found = violations(bodyOf(read(PREVIOUS)));
    expect(found).toContain('solver_worker_stale is not gated on worker_state');
    expect(found).toContain('solver_dataset_abandoned is missing');
  });

  it('NEGATIVE PROOF: a body that drops a condition is flagged', () => {
    expect(violations(body.replace("AND c.compact_state = 'failed'", ''))).toContain(
      "solver_dataset_abandoned lost: compactor last state 'failed'"
    );
    expect(violations(body.replace(",'paused')", ",'paused','completed')"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/not the non-terminal states/)])
    );
  });
});
