/**
 * LAW: THE HEAVY HOURLY WATCHES DO NOT START TOGETHER (2026-10-04).
 *
 * Job 161 (rake-law-adherence-hourly) had no statement_timeout of its own and
 * died at the postgres role's 2 minutes in 7 of 23 runs, always inside the
 * :35-:42 pile-up of the union sweep, the escrow shadow and the ratchet watch.
 * It gets the 300 s prefix every other heavy watch has, and the ratchet watch
 * (job 214) moves from :35 to :29. The escrow shadow keeps the :35 its brief
 * fixed; the union sweep keeps :35.
 *
 * What this pins: exactly two jobs are touched, by id and preimage; 161 only
 * gains the prefix; 214 only moves; no job is created; and the escrow shadow
 * brief is not contradicted.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '20261004002936_the_heavy_hourly_watches_do_not_start_together.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');

describe('the heavy hourly watches do not start together', () => {
  it('touches only jobs 161 and 214, each checked against its preimage', () => {
    const altered = [...MIG.matchAll(/SELECT cron\.alter_job\((\d+),/g)].map((m) => m[1]);
    expect(altered.sort()).toEqual(['161', '214']);
    expect(MIG).toContain("j.command = 'SELECT public.fn_rake_law_check(''2 hours''::interval);'");
    expect(MIG).toContain("j.command = 'SET statement_timeout = ''300s''; select public.fn_ca_ratchet_watch();'");
    expect(MIG).not.toMatch(/cron\.schedule\(/);
    expect(MIG).not.toMatch(/alter_job\(236/);
  });

  it('161 only gains the timeout prefix and 214 only moves to :29', () => {
    expect(MIG).toContain("SELECT cron.alter_job(161, command := 'SET statement_timeout = ''300s''; ' || command)");
    expect(MIG).toContain("SELECT cron.alter_job(214, schedule := '29 * * * *')");
    expect(MIG).toMatch(/j\.jobid = 161 AND j\.active AND j\.schedule = '40 \* \* \* \*'/);
  });
});
