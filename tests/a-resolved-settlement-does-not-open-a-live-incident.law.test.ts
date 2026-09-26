/**
 * A RESOLVED SETTLEMENT DOES NOT OPEN A LIVE INCIDENT (2026-09-24).
 *
 * fn_ca_financial_alert_to_incident fires AFTER INSERT ON financial_alerts
 * and, absent a named exemption, always raised a ca_drift_incidents row for
 * a 'critical' alert - even when the row it was handed was inserted already
 * resolved=true, i.e. a settlement migration's own audit proof of damage it
 * had ALREADY fixed and restored in the same transaction. The trigger is
 * AFTER INSERT ONLY, so an incident opened from one of these rows could
 * never close itself: it sat open and kept re-escalating for something
 * already fixed. Found via three stray incidents opened on 2026-09-23
 * (tournament.blind_clock_burned_past_its_witness,
 * tournament.blind_clock_ran_while_stalled, tournament.stranded_event), each
 * still open, unclassified, occurrences=1, days after the event they named
 * was already settled.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const migrationNamed = (slug: string): string => {
  const hit = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(`_${slug}.sql`))
    .sort();
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const FIX = migrationNamed('a_resolved_settlement_does_not_open_a_live_incident');

describe('an already-resolved financial_alerts row does not open a live incident', () => {
  it('skips incident creation once resolved is true, right after the existing early returns', () => {
    expect(FIX).toContain("IF NEW.severity <> ''critical'' THEN RETURN NEW; END IF;");
    expect(FIX).toContain("IF NEW.source LIKE ''drift_incident:%'' THEN RETURN NEW; END IF;");
    expect(FIX).toContain('IF NEW.resolved THEN RETURN NEW; END IF;');
  });

  it('still asserts the guard appears exactly once before rewriting, so a changed function aborts the migration instead of silently no-opping', () => {
    expect(FIX).toContain('IF v_n <> 1 THEN');
    expect(FIX).toContain('substitution produced no change');
  });

  it('is idempotent: a second run recognizes its own prior application and skips the function rewrite', () => {
    expect(FIX).toContain(
      "position('A RESOLVED SETTLEMENT DOES NOT OPEN A LIVE INCIDENT' in v_src) > 0"
    );
    expect(FIX).toContain("RAISE NOTICE 'already applied; skipping the function';");
  });

  it('resolves the historical stray incidents WITH a named root cause, never silently', () => {
    expect(FIX).toContain(
      "correction_ref='migration a_resolved_settlement_does_not_open_a_live_incident'"
    );
    expect(FIX).toContain('root_cause = ');
    expect(FIX).toContain(
      'fn_ca_financial_alert_to_incident raised this incident from a financial_alerts row that was inserted already resolved=true'
    );
  });

  it('matches stray incidents by shape (open, first occurrence, raised in the same instant as an already-resolved alert) rather than by a hardcoded id list', () => {
    expect(FIX).toContain("WHERE i.status='open'");
    expect(FIX).toContain('i.occurrences=1');
    expect(FIX).toContain('fa.resolved=true');
    expect(FIX).toContain('abs(extract(epoch from (i.created_at - fa.created_at))) < 5');
  });

  it('names its own change in the header rather than leaving the scan for it', () => {
    expect(FIX).toContain('A RESOLVED SETTLEMENT DOES NOT OPEN A LIVE INCIDENT');
  });
});
