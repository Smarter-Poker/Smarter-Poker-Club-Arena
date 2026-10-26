/**
 * A REFUNDED EARLIER REGISTRATION IS NOT A SECOND ENTRY (2026-10-24)
 *
 * 20261024233030 was installed to release Happy Hour Bounty (NLH) Table 20,
 * then superseded by the stricter 20261024232734 (#7974). This law pins that
 * 20261024233030 is assert-only and changes nothing, and (2026-10-26) that it
 * is marked SUPERSEDED BY 20261024232734 so no applier ever sends it:
 * production was amended again afterwards (20261025052637), so the post-image
 * it asserts is no longer production's. What actually ran is recorded
 * byte-exact as the recorded 20261024233424 file.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20261024233030_a_refunded_earlier_registration_is_not_a_second_entry.sql';
const SUPERSEDED_BY = '20261024232734_a_refunded_earlier_entry_is_not_a_second_entry.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const WINNER = readFileSync(join(MIGRATIONS, SUPERSEDED_BY), 'utf8');
const APPLIED = readFileSync(
  join(MIGRATIONS, '20261024233424_a_refunded_earlier_registration_is_not_a_second_entry.sql'),
  'utf8'
);

describe('a refunded earlier registration is not a second entry', () => {
  it('runs after the migration that supersedes it', () => {
    expect(FILE.split('_')[0] > SUPERSEDED_BY.split('_')[0]).toBe(true);
  });

  it('asserts exactly the post-image the superseding migration installs', () => {
    expect(WINNER).toContain("'631844035961b4995aab130e8e53e6b6'");
    expect(SQL).toContain("IS DISTINCT FROM '631844035961b4995aab130e8e53e6b6'");
  });

  it('changes nothing: no function body, no row, one transaction', () => {
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE/i);
    expect(SQL).not.toMatch(/\bEXECUTE\b/);
    expect(SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|public\.|smarter_private\.)/i);
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
  });

  it('is marked superseded, so no applier ever sends it', () => {
    expect(SQL.slice(0, 400)).toMatch(/^--\s*SUPERSEDED BY 20261024232734\b/m);
  });

  it('what production ran is recorded byte-exact under its applied version', () => {
    // A verified recording (scripts/ci/recorded-migrations.manifest.json): the
    // file is exactly supabase_migrations.schema_migrations.statements for
    // 20261024233424, whose md5 production reports as below.
    expect(createHash('md5').update(APPLIED).digest('hex')).toBe(
      '7c6506dcc60068f55cff10b9c3878ad1'
    );
  });
});
