/**
 * CRITICAL MEANS CHIPS ARE AT STAKE (2026-09-10).
 *
 * The drift board showed ten open incidents, every one with discrepancy 0,
 * its own WORST DISCREPANCY reading 0. Three engine sources - an outbox
 * handoff working as designed, a hand rolled back on a database stall, a
 * post-hand step that threw - sat on the MONEY board as CRITICAL because
 * fn_ca_financial_alert_to_incident defaulted every engine alert to critical.
 * Dan's rule: only critical errors that need his attention reach him.
 *
 * And one satellite sat RUNNING for sixteen hours because
 * fn_tournament_club_for_user tested membership by JOINing union_clubs, and
 * a union's own house club is never a row there - so the tournament's own
 * club could never be the preferred club and the ticket was refused for a
 * club mismatch the winner did not have.
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

const SEV = migrationNamed('a_drift_incident_is_critical_when_chips_are_at_stake');
const CLUB = migrationNamed('the_host_club_is_in_its_own_union');

describe('engine plumbing with no chip at stake files as info', () => {
  it('scopes the demotion to ServerTableEngine.* and postHandTasks.* only', () => {
    expect(SEV).toContain(
      "NEW.source LIKE ''ServerTableEngine.%'' OR NEW.source LIKE ''postHandTasks.%''"
    );
  });

  it('never demotes a money-shaped source, even with no amount in context', () => {
    expect(SEV).toContain(
      "NOT (NEW.source ~* ''prize|payout|bounty|rake|treasury|guarantee|insurance|bbj|rakeback'')"
    );
  });

  it('demotes only when both discrepancy and amount resolve to zero', () => {
    expect(SEV).toContain("NULLIF(NEW.context->>''discrepancy'','''')::numeric");
    expect(SEV).toContain("NULLIF(NEW.context->>''amount'','''')::numeric, 0) = 0");
    expect(SEV).toContain("THEN ''info''");
  });

  it('keeps the conservation exemption that was already there', () => {
    expect(SEV).toContain("WHEN NEW.source ~* ''conservation'' THEN ''info''");
  });

  it('resolves the historical zero-chip incidents WITH a root cause, never silently', () => {
    expect(SEV).toContain(
      "correction_ref='migration a_drift_incident_is_critical_when_chips_are_at_stake'"
    );
    expect(SEV).toContain('root_cause = CASE');
    expect(SEV).toContain('COALESCE(i.discrepancy_amount,0) = 0');
  });
});

describe('the host club is in its own union', () => {
  it('accepts the tournament own club as preferred without a union_clubs row', () => {
    expect(CLUB).toContain('AND (m.club_id = v_t_club');
    expect(CLUB).toContain('OR EXISTS (SELECT 1 FROM union_clubs uc');
  });

  it('still requires an active or approved membership', () => {
    expect(CLUB).toContain("m.status IN (''active'',''approved'')");
  });

  it('proves itself against the satellite winner it was written for', () => {
    expect(CLUB).toContain("'9da2d0b7-436d-4e47-826e-4c30077428a4'");
    expect(CLUB).toContain("IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid");
    expect(CLUB).toContain('resolver still returns % for the stuck satellite winner');
  });

  it('treats the horse winner exactly as a human (10.5)', () => {
    expect(CLUB).toContain('The winner is a horse; per 10.5 that changes');
    expect(CLUB).toContain('nothing about what they are owed');
  });
});
