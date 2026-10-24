/**
 * THE MIGRATION APPLIER NEVER DROPS A DISPATCH (2026-10-24)
 *
 * apply-merged-migration.yml put every run in ONE concurrency group. GitHub
 * keeps at most one pending run per group and cancels the older pending run
 * when a newer one is queued, so three dispatches in a row applied one file
 * and silently cancelled two. 20261024193700, 20261024194135 and
 * 20261024204950 merged at 21:58 and never reached production, while late
 * registrations and rebuys kept being refused.
 *
 * The group is now per file, and the applier serializes different files with a
 * session advisory lock taken before it reads the migration history, so a run
 * that waited sees what the run ahead of it installed. A wait that times out
 * has sent nothing and is a refusal.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/apply-merged-migration.yml'),
  'utf8'
);
const APPLIER = readFileSync(resolve(ROOT, 'scripts/ci/apply-recorded-migration.mjs'), 'utf8');

describe('the migration applier never drops a dispatch', () => {
  it('keys its concurrency group by the migration file and never cancels a run', () => {
    const wf = parse(WORKFLOW) as {
      concurrency: { group: string; 'cancel-in-progress': boolean };
    };
    expect(wf.concurrency.group).toBe(
      'apply-merged-migration-${{ inputs.migration || github.event.client_payload.migration }}'
    );
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  it('serializes different files in the database, before the history read', () => {
    const lock = APPLIER.indexOf(
      "SELECT pg_advisory_lock(hashtextextended('apply-recorded-migration', 0))"
    );
    const history = APPLIER.indexOf('FROM supabase_migrations.schema_migrations');
    const connect = APPLIER.indexOf('await client.connect();');
    expect(connect).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(connect);
    expect(history).toBeGreaterThan(lock);
    // Bounded inside the job's 15 minutes, and a dry run never waits.
    expect(APPLIER).toContain('await client.query("SET lock_timeout = \'12min\'");');
    expect(APPLIER).toMatch(
      /if \(!DRY_RUN\) \{\s*try \{\s*await client\.query\("SET lock_timeout = '12min'"\);/
    );
  });

  it('a wait that timed out sent nothing, so it is a refusal and not an unknown', () => {
    expect(APPLIER).toMatch(
      /if \(e && e\.code === '55P03'\)\s*refused\('another migration is still being applied; nothing was sent - dispatch this file again'\);/
    );
  });
});
