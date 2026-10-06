/**
 * A BUSY FINISH LANE IS A WARNING UNTIL IT STRANDS A WINNER (2026-10-03).
 *
 * Incident 03f5b137: SNG 4b3f2f27 was refused three finish passes running
 * with a transient timeout (proven before commit, nothing moved), the engine
 * alerted at its streak of 3, the incident bridge filed it CRITICAL, and the
 * next pass paid the winner exactly once 25 seconds later. The unpaid winner
 * a busy lane could become is already paged by
 * fn_ca_tournament_finished_but_not_completed.
 *
 * These assertions pin the narrow shape: only proven timeout/deadlock finish
 * refusals become warnings; rule refusals, unknown outcomes and satellites do
 * not; and the alert closes only on a COMPLETED tournament with its terminal
 * receipt and escrow closed at zero.
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

const FIX = migrationNamed('a_busy_finish_lane_is_a_warning_until_it_strands_a_winner');
const code = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

describe('a busy finish lane is a warning until it strands a winner', () => {
  it('downgrades only a proven, known-outcome timeout or deadlock finish refusal', () => {
    expect(FIX).toContain("WHEN NEW.source = 'Tournament.atomic_finish_refused'");
    expect(FIX).toContain(
      "AND lower(COALESCE(NEW.context->>'proven_refusal', '')) IN ('true', 't', '1')"
    );
    expect(FIX).toContain(
      "AND lower(COALESCE(NEW.context->>'outcome_unknown', 'false')) IN ('false', 'f', '0')"
    );
    expect(FIX).toContain(
      "AND COALESCE(NEW.context->>'refusal_reason', '') IN ('timeout', 'deadlock')"
    );
    expect(FIX).not.toMatch(/atomic_satellite_finish_refused'\s*\n\s*AND/);
  });

  it('downgrades to warning, never to info and never to a skipped incident', () => {
    expect(FIX).toContain("THEN 'warning'");
    expect(code(FIX)).not.toMatch(/THEN 'info'/);
    expect(code(FIX)).not.toMatch(/RETURN NEW/);
  });

  it('inserts ahead of the postHandTasks branch and declares the guard redefinition', () => {
    expect(FIX).toContain("'mode', 'before'");
    expect(FIX).toContain('the warning branch must precede the postHandTasks.%% branch');
    expect(FIX).toContain('fn_ca_declare_guard_redefinition');
  });

  it('closes the alert only on a completed tournament with its receipt and a zero escrow', () => {
    expect(FIX).toContain(
      'JOIN public.tournament_terminal_settlements s ON s.tournament_id = t.id'
    );
    expect(FIX).toContain("AND t.status = 'COMPLETED'");
    expect(FIX).toContain('AND e.terminal_closed_at IS NOT NULL');
    expect(FIX).toContain('AND COALESCE(e.prize_balance, 0) = 0');
    expect(FIX).toContain('AND COALESCE(e.bounty_balance, 0) = 0');
    expect(FIX).toContain(
      "AND COALESCE(fa.context->>'refusal_reason', '') IN ('timeout', 'deadlock')"
    );
    expect(FIX).toContain('payout row(s) totalling');
  });

  it('edits by exact anchors against measured preimages, idempotently, with a live proof', () => {
    expect(FIX).toContain(
      "'fn_ca_financial_alert_to_incident',           '9fcf79de808e45cd4a1fad478ea93228'"
    );
    expect(FIX).toContain(
      "'fn_ca_tournament_finished_but_not_completed', '67618c4a085bb0950589c7ca0fee82a3'"
    );
    expect(FIX).toContain('IF v_n <> 1 THEN');
    expect(FIX).toContain('already carries the change; skipping');
    expect(FIX.match(/^-- @live-proof: .+$/gm)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(code(FIX)).not.toMatch(/cron\.schedule\s*\(/i);
    expect([...FIX].filter((ch) => (ch.codePointAt(0) ?? 0) > 127)).toEqual([]);
  });

  it('records the money evidence it rests on', () => {
    expect(FIX).toContain('The winner was unpaid for 3.5 minutes and paid exactly once.');
    expect(FIX).toContain('escrow');
  });
});
