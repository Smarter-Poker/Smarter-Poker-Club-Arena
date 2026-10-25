/**
 * A REFUNDED EARLIER REGISTRATION IS NOT A SECOND ENTRY (2026-10-24)
 *
 * 20261024233030 was installed to release Happy Hour Bounty (NLH) Table 20,
 * then superseded by the stricter 20261024232734 (#7974), which production
 * now holds. This law pins that 20261024233030 is assert-only: it runs after
 * #7974 in version order, changes nothing, and refuses unless the never-dealt
 * proof holds exactly #7974's post-image.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20261024233030_a_refunded_earlier_registration_is_not_a_second_entry.sql';
const SUPERSEDED_BY = '20261024232734_a_refunded_earlier_entry_is_not_a_second_entry.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const WINNER = readFileSync(join(MIGRATIONS, SUPERSEDED_BY), 'utf8');

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
});
