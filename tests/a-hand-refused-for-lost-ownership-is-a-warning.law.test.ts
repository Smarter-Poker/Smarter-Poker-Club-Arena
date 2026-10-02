/**
 * A HAND REFUSED FOR LOST OWNERSHIP IS A WARNING (2026-10-02).
 *
 * When the engine cannot prove it still owns a table it refuses its own hand
 * commit ("atomic hand commit refused (lease_proof_expired)") before writing
 * anything, kills that generation, and the successor commits the exact hand
 * (741 of 812 since 2026-10-01) or the hand was never played (71, rolled back
 * whole). The engine reports it twice: as
 * ServerTableEngine.authoritative_hand_semantic_refusal, which the drift
 * trigger already treats as a rate, and again as
 * postHandTasks.hand_history_failed, which filed a CRITICAL drift incident per
 * burst and kept fn_ca_midway_burnin_gate red for 24 h after every one
 * (19:37:28 525ed81f, 20:53:56 b36dc53f).
 *
 * These assertions pin that the downgrade is that narrow: one source, two
 * exact refusal reasons, warning rather than silence, and every other
 * post-hand failure still decided by the moves_chips branch.
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

const FIX = migrationNamed('a_hand_refused_for_lost_ownership_is_a_warning');

describe('a hand refused for lost ownership files as a warning, not a critical', () => {
  it('scopes the branch to postHandTasks.hand_history_failed only', () => {
    expect(FIX).toContain("WHEN NEW.source = 'postHandTasks.hand_history_failed'");
  });

  it('matches exactly the two ownership refusal reasons, by prefix up to the closing paren', () => {
    expect(FIX).toContain("split_part(COALESCE(NEW.context->>'error', ''), ')', 1)");
    expect(FIX).toContain("IN ('atomic hand commit refused (lease_proof_expired',");
    expect(FIX).toContain("'atomic hand commit refused (hand_lease_stale')");
    expect(FIX).not.toMatch(/LIKE\s+'%lease_proof_expired%'/);
  });

  it('downgrades to warning, never to info and never to a skipped incident', () => {
    expect(FIX).toContain("THEN 'warning'");
    expect(FIX).not.toMatch(/hand_history_failed[\s\S]{0,400}THEN 'info'/);
    expect(FIX).not.toMatch(/hand_history_failed[\s\S]{0,400}RETURN NEW/);
  });

  it('inserts ahead of the moves_chips branch, which still decides every other post-hand step', () => {
    expect(FIX).toContain("v_new := replace(v_src, v_anchor, v_ins || v_anchor);");
    expect(FIX).toContain("WHEN NEW.source LIKE 'postHandTasks.%'");
    expect(FIX).toContain("IN ('false','f','0')");
    expect(FIX).toContain('the warning branch must precede the postHandTasks.%% branch');
  });

  it('refuses to apply against a changed function and is idempotent', () => {
    expect(FIX).toContain('IF v_n <> 1 THEN');
    expect(FIX).toContain('substitution produced no change');
    expect(FIX).toContain(
      "IF position('A HAND REFUSED FOR LOST OWNERSHIP IS A WARNING' in v_src) > 0 THEN"
    );
  });

  it('proves a neighbouring refusal and a transport failure are not selected', () => {
    expect(FIX).toContain("split_part('atomic hand commit refused (stack_mismatch)', ')', 1)");
    expect(FIX).toContain('[DB] authoritative hand commit failed for table x hand #1');
  });

  it('declares the guard redefinition and carries a live proof', () => {
    expect(FIX).toContain('fn_ca_declare_guard_redefinition');
    expect(FIX).toContain(
      "@live-proof: (SELECT position('A HAND REFUSED FOR LOST OWNERSHIP IS A WARNING' in pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure)) > 0)"
    );
  });

  it('records the money evidence it rests on', () => {
    expect(FIX).toContain('Not one moved a chip.');
    expect(FIX).toContain('exact_original_post_commit_complete');
  });
});
