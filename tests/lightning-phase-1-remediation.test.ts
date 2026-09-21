/**
 * LIGHTNING 2.0 PHASE 1 REMEDIATION
 *
 * An adversarial audit of the merged Phase 1 delivery found three defects.
 * This pins the repair, and - more usefully - pins the three shapes that let
 * each defect through in the first place, so the next phase cannot reintroduce
 * them:
 *
 *   1. a backfill with no closed_at predicate, which stamped 985 closed
 *      sessions with a Cluster that did not exist while they were alive;
 *   2. SECURITY DEFINER on a reader that did not need it;
 *   3. an authoritative reader with no caller.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FILE = '20260920234647_lightning_phase_1_remediation_the_lobby_reads_one_lightning_.sql';
const SQL = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
/** Comment-stripped, so no pin below can be satisfied by prose. */
const CODE = SQL.replace(/--[^\n]*/g, '');

/** The Phase 1 migration is history: this file must not have edited it. */
const PHASE1 = '20260920172736_lightning_phase_1_the_cash_session_knows_its_cluster.sql';

describe('Phase 1 remediation: the retroactive bindings are cleared', () => {
  it('nulls cluster_id only for sessions that closed before their cluster existed', () => {
    expect(CODE).toMatch(/UPDATE public\.cash_player_session s\s+SET cluster_id = NULL/);
    expect(CODE).toMatch(/s\.closed_at IS NOT NULL/);
    expect(CODE).toMatch(/s\.closed_at < g\.created_at/);
  });

  it('never touches an open session', () => {
    // The repair is defined by closed_at IS NOT NULL. If that predicate ever
    // disappears, every live player's binding is destroyed.
    const stmt = CODE.slice(CODE.indexOf('SET cluster_id = NULL'));
    expect(stmt.slice(0, stmt.indexOf(';'))).toContain('closed_at IS NOT NULL');
  });

  it('carries a WHERE clause, so check-unqualified-writes stays green', () => {
    const stmt = CODE.slice(CODE.indexOf('UPDATE public.cash_player_session s'));
    expect(stmt.slice(0, stmt.indexOf(';'))).toMatch(/\bWHERE\b/);
  });
});

describe('Phase 1 remediation: the reader stops being a definer', () => {
  it('re-creates fn_cash_cluster_lightning_state as SECURITY INVOKER', () => {
    expect(CODE).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_state(p_game_id uuid)'
    );
    expect(CODE).toContain('SECURITY INVOKER');
    expect(CODE).not.toMatch(/fn_cash_cluster_lightning_state[\s\S]{0,300}?SECURITY DEFINER/);
  });

  it('keeps the body byte-identical to the one Phase 1 installed', () => {
    // Only the security attribute moves. If the body drifts here, the reader
    // and the thing Phase 1 qualified are no longer the same function.
    const phase1 = fs.readFileSync(path.join(MIGRATIONS, PHASE1), 'utf8');
    const grab = (s: string) => {
      const start = s.indexOf("SELECT jsonb_build_object(\n           'game_id'");
      return s.slice(start, s.indexOf('WHERE g.id = p_game_id;', start));
    };
    expect(grab(SQL)).not.toBe('');
    expect(grab(SQL)).toBe(grab(phase1));
  });

  it('still restates its grants, because the definer gate models the file', () => {
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) TO service_role;'
    );
  });
});

describe('Phase 1 remediation: the reader gets a caller', () => {
  it('patches the LIVE fn_cash_game_lobby body rather than restating it', () => {
    // Restating a 120-line client-facing definer to add one key is how a
    // transcription error reaches production. This estate patches instead.
    expect(CODE).toContain("pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure)");
    expect(CODE).toContain('EXECUTE v_new;');
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_game_lobby/);
  });

  it('refuses unless the anchor appears exactly once', () => {
    expect(CODE).toMatch(/IF v_hits <> 1 THEN/);
    expect(CODE).toMatch(/RAISE EXCEPTION 'expected exactly one tables key/);
    expect(CODE).toMatch(/IF v_new = v_old THEN RAISE EXCEPTION/);
  });

  it('verifies the patch took, inside the same transaction', () => {
    expect(CODE).toMatch(/does not read the Lightning state after the patch/);
  });

  it('is re-runnable: a lobby that already reads the state is left alone', () => {
    expect(CODE).toMatch(/already reads the Lightning state; leaving it alone/);
  });

  it('adds a key rather than changing one, so no client can break', () => {
    // Asserted against SQL, not CODE. The replacement text is a SQL string
    // literal inside the DO block, so its quotes are doubled and its own
    // explanatory lines start with -- , which the comment strip would eat.
    expect(SQL).toContain("''lightning'', public.fn_cash_cluster_lightning_state(g.id),");
    expect(SQL).toContain("''tables'', v_tables,");
    // The anchor is preserved rather than replaced, so the 'tables' key the
    // client already reads survives: the replacement text ends with it.
    expect(SQL).toMatch(
      /''lightning'', public\.fn_cash_cluster_lightning_state\(g\.id\),'\s*\|\| chr\(10\)\s*\|\| '\s*''tables'', v_tables,'/
    );
  });

  it('preserves the lobby grant to authenticated', () => {
    // The live ACL is postgres, authenticated, service_role. Revoking anon and
    // PUBLIC while restating the other two keeps the file honest for
    // check-definer-authorization without locking players out of their lobby.
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_game_lobby(uuid) TO authenticated, service_role;'
    );
  });
});

describe('Phase 1 remediation: scope and safety', () => {
  it('does not edit the merged Phase 1 migration, which is history', () => {
    expect(fs.existsSync(path.join(MIGRATIONS, PHASE1))).toBe(true);
    expect(CODE).not.toContain('ALTER TABLE public.cash_games');
    expect(CODE).not.toContain('ALTER TABLE public.cash_player_session');
    expect(CODE).not.toContain('CREATE INDEX');
  });

  it('starts no Phase 2 work: no new entity, no matcher, no conversion', () => {
    expect(CODE).not.toMatch(/CREATE TABLE/i);
    for (const tooEarly of ['matcher', 'reservation', 'pool_session', 'instance']) {
      expect(CODE.toLowerCase()).not.toContain(tooEarly);
    }
  });

  it('is a single transaction', () => {
    expect((CODE.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((CODE.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });

  it('declares live proofs that can actually fail', () => {
    const proofs = [...SQL.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1]);
    expect(proofs.length).toBeGreaterThanOrEqual(4);
    for (const p of proofs) expect(p).not.toContain(';');
    // The Phase 1 tautology, fixed. Its proof searched the function body for
    // "cluster_id", which the PRE-Phase-1 body already contained three times
    // (t.cluster_id, and v_t.cluster_id twice), so it was true either way.
    // This one pins the INSERT column list, which only the new body has.
    expect(proofs.join('\n')).toContain("position('table_id, cluster_id, variant' in");
    // And this one is the only thing anywhere that notices if the wiring
    // never reached production.
    expect(proofs.join('\n')).toContain(
      "position('fn_cash_cluster_lightning_state' in pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure))"
    );
  });
});
