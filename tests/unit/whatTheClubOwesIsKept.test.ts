/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHAT THE CLUB OWES ITS AGENTS IS KEPT, NOT RECOUNTED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04, phase 4 verification walk)
 *
 * The agent console's Payouts tab was opened in a browser on production and
 * read "The Commission Ledger Could Not Be Read"; the second open took
 * 8,870 ms. fn_ca_agent_payables summed every unsettled agent_commissions row
 * for the club on each open, and that set had doubled in a day (259,135 to
 * 499,933) because the estate writes 622,976 commission rows a day and nothing
 * has ever settled one. A figure read once an hour and changed a quarter of a
 * million times a day is a rollup. This pins the rollup, its triggers, and the
 * read that comes off it. After the change the same tab answered in 107 ms.
 *
 * tests/unit/theAgentNetworkReachesSomething.test.ts still pins the phase 3
 * migration file, which is history and correctly describes what that file
 * did. The live function is the one declared here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sliceDollarQuoted } from '../helpers/sourceWindow';

const MIGRATION = readFileSync(
  'supabase/migrations/20260904170000_what_the_club_owes_is_kept_not_recounted.sql',
  'utf8'
);

const fn = (name: string) => {
  const start = MIGRATION.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sliceDollarQuoted(MIGRATION.slice(start), '$function$');
};

describe('the rollup table', () => {
  it('is keyed by (club, agent) and carries what the payables read prints', () => {
    const ddl = MIGRATION.slice(
      MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS public.agent_commission_unsettled_rollup'),
      MIGRATION.indexOf('COMMENT ON TABLE public.agent_commission_unsettled_rollup')
    );
    expect(ddl).toContain('PRIMARY KEY (club_id, user_id)');
    for (const col of ['owed', 'rows_behind', 'oldest_unsettled', 'updated_at']) {
      expect(ddl, col).toContain(col);
    }
  });

  it('is not readable from the browser: the payables function is the only door', () => {
    expect(MIGRATION).toContain(
      'ALTER TABLE public.agent_commission_unsettled_rollup ENABLE ROW LEVEL SECURITY;'
    );
    expect(MIGRATION).toContain(
      'REVOKE ALL ON TABLE public.agent_commission_unsettled_rollup FROM PUBLIC, anon, authenticated;'
    );
  });
});

describe('the triggers maintain it one statement at a time', () => {
  it('are statement-level with transition tables, never row-level', () => {
    for (const name of [
      'trg_agent_commission_rollup_ins',
      'trg_agent_commission_rollup_upd',
      'trg_agent_commission_rollup_del',
    ]) {
      const at = MIGRATION.indexOf(`CREATE TRIGGER ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      const decl = MIGRATION.slice(at, MIGRATION.indexOf(';', at));
      expect(decl).toContain('FOR EACH STATEMENT');
      expect(decl).toMatch(/REFERENCING (OLD|NEW) TABLE/);
      expect(decl).not.toContain('FOR EACH ROW');
    }
  });

  it('adds an insert to the pair it belongs to and keeps the oldest date', () => {
    const body = fn('trg_agent_commission_rollup_insert');
    expect(body).toContain('WHERE n.settled_at IS NULL');
    expect(body).toContain('ON CONFLICT (club_id, user_id) DO UPDATE');
    expect(body).toContain('owed             = r.owed + EXCLUDED.owed');
    expect(body).toContain('least(r.oldest_unsettled, EXCLUDED.oldest_unsettled)');
  });

  it('recomputes only the pairs a settlement touched, and ignores a notes-only update', () => {
    const body = fn('trg_agent_commission_rollup_change');
    expect(body).toContain('o.settled_at IS DISTINCT FROM n.settled_at');
    expect(body).toContain('o.amount IS DISTINCT FROM n.amount');
    expect(body).toContain("IF v_pairs <> '[]'::jsonb THEN");
    expect(body).toContain('PERFORM public.fn_agent_commission_rollup_recompute(v_pairs);');
  });

  it('never raise: a display table must not refuse a commission', () => {
    for (const name of [
      'trg_agent_commission_rollup_insert',
      'trg_agent_commission_rollup_change',
    ]) {
      expect(fn(name)).not.toMatch(/RAISE EXCEPTION/);
    }
  });

  it('recompute reads the ledger for exactly the named pairs', () => {
    const body = fn('fn_agent_commission_rollup_recompute');
    expect(body).toContain('FROM jsonb_array_elements(p_pairs) p');
    expect(body).toContain('ac.settled_at IS NULL');
    expect(body).toContain('SET owed = EXCLUDED.owed');
  });
});

describe('the backfill and the assertion', () => {
  it('backfills inside the transaction and refuses to commit a rollup that disagrees with the ledger', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
    const block = sliceDollarQuoted(MIGRATION.slice(MIGRATION.lastIndexOf('DO $$')), '$$');
    expect(block).toContain('IF l_rows <> r_rows OR abs(l_owed - r_owed) > 0.000001 THEN');
    expect(block).toContain("IF n <> 3 THEN RAISE EXCEPTION 'expected 3 rollup triggers");
  });

  it('the rebuild holds the ledger still while it counts (20260904171000)', () => {
    // Found in the verification pass: DELETE-then-INSERT with no lock races a
    // commission landing mid-rebuild on the primary key.
    const later = readFileSync(
      'supabase/migrations/20260904171000_the_rollup_rebuild_holds_the_ledger_still.sql',
      'utf8'
    );
    const body = sliceDollarQuoted(
      later.slice(later.indexOf('FUNCTION public.fn_rebuild_agent_commission_rollup(')),
      '$function$'
    );
    expect(body).toContain('LOCK TABLE public.agent_commissions IN SHARE ROW EXCLUSIVE MODE;');
    expect(body.indexOf('LOCK TABLE')).toBeLessThan(body.indexOf('DELETE FROM'));
    expect(later).toContain(
      'REVOKE ALL ON FUNCTION public.fn_rebuild_agent_commission_rollup() FROM PUBLIC, anon, authenticated;'
    );
  });

  it('provides a rebuild for the one path triggers cannot see, gated to operators', () => {
    const body = fn('fn_rebuild_agent_commission_rollup');
    expect(body).toContain("coalesce(auth.role(), '') = 'service_role'");
    expect(body).toContain('DELETE FROM public.agent_commission_unsettled_rollup;');
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.fn_rebuild_agent_commission_rollup() FROM PUBLIC, anon, authenticated;'
    );
  });
});

describe('the payables read comes off the rollup', () => {
  const body = fn('fn_ca_agent_payables');

  it('keeps the gate and the cap', () => {
    expect(body).toContain('IF NOT fn_ca_can_manage_agents(p_club_id) THEN');
    expect(body).toContain('v_cap constant integer := 200;');
  });

  it('joins the rollup and never scans agent_commissions', () => {
    expect(body).toContain('LEFT JOIN agent_commission_unsettled_rollup o');
    expect(body).not.toContain('FROM agent_commissions');
  });

  it('keeps every key the page reads and adds when the rollup was last touched', () => {
    for (const key of [
      'agents',
      'cap',
      'total_owed',
      'total_rows',
      'total_estimate',
      'oldest_unsettled',
      'rollup_checked_at',
      'rows',
      'generated_at',
    ]) {
      expect(body, key).toContain(`'${key}'`);
    }
    for (const key of ['owed', 'rows_behind', 'oldest_unsettled', 'estimate', 'credit_available']) {
      expect(body, key).toContain(`'${key}'`);
    }
  });

  it('never filters on whether an agent is house-run', () => {
    expect(MIGRATION).not.toMatch(/is_horse/);
  });
});
