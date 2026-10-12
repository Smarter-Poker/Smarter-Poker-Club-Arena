/**
 * THE THAW RELEASES WHEN ITS TAIL IS DONE, NOT THREE MINUTES LATER (2026-10-02)
 *
 * The v3 thaw plans a release boundary in the future, credits every frozen
 * deadline up to it in installments, and keeps the platform closed until the
 * boundary. Its runway was GREATEST(8, 4 + CEIL(targets / 40) * 4) seconds.
 * That charges every target at level_started_at's 40-row batch, one target
 * batch per 4-second call. The worker credits one batch of EVERY step per
 * call, 200 rows for all steps but level_started_at.
 *
 * MEASURED 2026-10-02 16:00: 1,668 targets gave a 172s runway. The 7-call tail
 * finished in 4.2s and play resumed at 16:02:59. Every hour lost ~2.5
 * minutes, the release ran past the :03 close of the migration window, and
 * GameServer's sweep saw tables paused over ten minutes and rebuilt 80 of them.
 *
 * Replayed on a scratch Postgres 17 with the exact installed body (md5
 * 071941c4f82d9f676622dc671fb0db40) and the same target mix: old runway 172.0s,
 * new 32.0s, the same 8 calls, every target credited to the final duration. A
 * forced miss rebases to 64.0s and still credits every target once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const MARKER = 'CREATE OR REPLACE FUNCTION public.fn_thaw_platform(\n  p_announced_at';

/** The newest migration defining the five-argument v3 thaw: what Postgres ends up with. */
function governingThaw(): string {
  const all = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8').includes(MARKER));
  expect(all.length, 'no migration defines the v3 fn_thaw_platform').toBeGreaterThan(0);
  return readFileSync(resolve(MIGRATIONS, all[all.length - 1]), 'utf8');
}

describe('the thaw release runway counts installments, not targets', () => {
  const sql = governingThaw();

  it('no longer charges every target at the slowest batch size', () => {
    expect(sql).not.toMatch(/CEIL\(v_target_count::numeric\s*\/\s*40::numeric\)/);
  });

  it('sizes the runway from the slowest step, in calls of 4 seconds, at plan and at rebase', () => {
    const installments = sql.match(
      /SELECT COALESCE\(max\(s\.calls\), 0\) INTO v_installments[\s\S]*?GROUP BY x\.step\s*\) s;/g
    );
    expect(installments, 'both the plan and the rebase count installments').toHaveLength(2);
    for (const block of installments ?? []) {
      expect(block).toContain("CASE WHEN x.step='level_started_at' THEN 40 ELSE 200 END");
    }
    expect(sql).toContain('4::numeric + v_installments::numeric * 4::numeric\n    );');
    // A missed estimate still doubles per generation; no door opens on an expired one.
    expect(sql).toMatch(
      /\(4::numeric \+ v_installments::numeric \* 4::numeric\)\s*\* power\(2::numeric, LEAST\(v_existing\.release_generation, 8\)\)/
    );
  });

  it('uses the batch sizes the credit worker actually runs', () => {
    // The worker's batch sizes, from the native fixture copied byte-exact from
    // the installed definition. If the worker's batches change, the runway's
    // must change with them.
    const worker = readFileSync(
      resolve(ROOT, 'scripts/ci/fixtures/phase-three-current-thaw-authority.sql'),
      'utf8'
    );
    expect(worker).toContain(
      "v_batch := CASE WHEN v_step = 'level_started_at' THEN 40 ELSE 200 END;"
    );
    expect(worker).toContain("c_budget CONSTANT interval := INTERVAL '4 seconds';");
  });

  it('replaces only the installed body it was written against, and proves the result', () => {
    expect(sql).toContain("md5(p.prosrc) = '071941c4f82d9f676622dc671fb0db40'");
    expect(sql).toContain('MAINTENANCE_THAW_PREIMAGE_DRIFT');
    expect(sql).toContain('MAINTENANCE_THAW_POSTIMAGE_UNPROVEN');
    expect(sql).toMatch(/SET statement_timeout TO '35s'\n SET lock_timeout TO '32s'/);
  });
});
