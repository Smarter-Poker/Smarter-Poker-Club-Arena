/**
 * A MONEY AUDIT GETS THE TIME IT DECLARES (2026-10-02, launch-gate sweep).
 *
 * Pinned on migration 20261002170500. pg_cron statements run under the
 * role's 2-minute limit; a set_config inside the statement does not move the
 * timer of the statement already running. Nine money audits now open their
 * cron command with a separate SET statement_timeout, two re-read windows are
 * narrowed to what one run needs while still covering every row, and the
 * treasury legs fn_ca_treasury_positions aggregates are indexed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(
  HERE,
  '../supabase/migrations/20261002170500_a_money_audit_gets_the_time_it_declares.sql'
);
const sql = readFileSync(FILE, 'utf8');

describe('a money audit gets the time it declares', () => {
  it('builds the treasury leg indexes concurrently before one transaction', () => {
    const begin = sql.search(/^BEGIN;$/m);
    expect(begin).toBeGreaterThan(-1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    for (const ix of ['idx_chip_ledger_treasury_in', 'idx_chip_ledger_treasury_out']) {
      const at = sql.indexOf(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ix}`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(begin);
    }
    expect(sql).toMatch(/WHERE to_type = 'club_treasury' AND to_entity_id IS NOT NULL;/);
    expect(sql).toMatch(/WHERE from_type = 'club_treasury' AND from_entity_id IS NOT NULL;/);
    expect(sql).not.toMatch(/^\s*DROP\b/im);
  });

  it('every audit command opens with its own budget, set where it takes effect', () => {
    for (const id of [121, 144, 155, 156, 214, 226, 227, 230, 263]) {
      expect(sql).toMatch(
        new RegExp(`SELECT cron\\.alter_job\\(${id}, command := 'SET statement_timeout = ''(300|600)s''; '`)
      );
    }
    expect(sql).toMatch(/command LIKE 'SET statement_timeout = %'\) <> 9/);
  });

  it('narrows only the two windows that re-read far more than one run needs', () => {
    expect(sql).toMatch(
      /replace\(command, 'fn_rake_attribution_drift_audit\(24\)',\s+'fn_rake_attribution_drift_audit\(2\)'\)/
    );
    expect(sql).toMatch(
      /replace\(command, 'fn_detect_results_without_a_hand\(\)',\s+'fn_detect_results_without_a_hand\(1\)'\)/
    );
    // no function body changes
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });
});
