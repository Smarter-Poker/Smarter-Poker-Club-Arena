/**
 * A DIAMOND OWN-DATA RPC REFUSES A STRANGER. IT NEVER ANSWERS ZERO.
 *
 * Four functions answer a question about ONE player's diamonds:
 * fn_diamond_wallet_summary, fn_diamond_flow_by_kind,
 * fn_diamond_arena_reconciliation and fn_diamond_lifetime_totals. Three of
 * them refused a caller who is neither the subject nor service_role, by name,
 * with SQLSTATE 42501. The fourth had no guard at all, and because its sums
 * are COALESCEd to zero it answered `lifetime_earned 0, lifetime_spent 0,
 * credits 0, debits 0` for a wallet that actually held 613,595 and 132,320
 * (measured on production 2026-09-30, as `authenticated`, for another user's
 * id). No money leaked - RLS policy diamond_transactions_select_own held - but
 * four confident zeros are indistinguishable from a brand-new account, and a
 * surface that prints them has been told something false.
 *
 * CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome and must
 * have its own name. Rule 2: never coerce an unreadable answer into an empty
 * one. The law is that all four carry the same guard, each with its own error
 * name, and that service_role may still name a user - the World Hub route
 * /api/store/diamond-transactions holds a service-role client and calls three
 * of them with an explicit p_user_id.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/** The migration production last ran for this function, not the first one. */
function latestDeclaring(needle: string): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const body = read(`${MIGRATIONS_DIR}/${files[i]}`);
    if (body.includes(needle)) return { file: files[i], body };
  }
  throw new Error(`no migration declares ${needle}`);
}

/** fn -> the name it refuses a stranger with. */
const OWN_DATA_RPCS: Record<string, string> = {
  fn_diamond_wallet_summary: 'wallet_summary_is_own_only',
  fn_diamond_flow_by_kind: 'diamond_flow_is_own_only',
  fn_diamond_arena_reconciliation: 'arena_reconciliation_is_own_only',
  fn_diamond_lifetime_totals: 'lifetime_totals_is_own_only',
};

describe('a diamond own-data RPC refuses a stranger', () => {
  it.each(Object.entries(OWN_DATA_RPCS))(
    '%s refuses a caller who is neither the subject nor service_role',
    (fn, refusal) => {
      const { file, body } = latestDeclaring(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      const decl = body.slice(body.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`));

      // A caller with no identity at all is its own refusal, not a zero.
      expect(decl, `${file}: ${fn} must refuse an unauthenticated caller`).toContain(
        "RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501'"
      );

      // The one expression, shared by all four, so one of them cannot drift
      // into a looser test than the other three.
      expect(decl, `${file}: ${fn} must pin the caller to auth.uid()`).toContain(
        "v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid()"
      );

      // Its own name, so a log line says which door was shut.
      expect(decl, `${file}: ${fn} must refuse by its own name`).toContain(
        `RAISE EXCEPTION '${refusal}' USING ERRCODE = '42501'`
      );

      // service_role must keep naming a user: the World Hub route depends on it.
      expect(decl).toContain("COALESCE(auth.jwt() ->> 'role', current_user)");

      // Horses are players (10.5): no diamond read has an include/exclude flag.
      expect(decl.slice(0, decl.indexOf('$fn$;')), `${fn} must not branch on is_horse`).not.toMatch(
        /is_horse/
      );
    }
  );

  it('fn_diamond_lifetime_totals still returns its four columns, for its own caller by default', () => {
    const { body } = latestDeclaring(
      'CREATE OR REPLACE FUNCTION public.fn_diamond_lifetime_totals('
    );
    const decl = body.slice(
      body.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_lifetime_totals(')
    );
    // The guard must not have cost the shape the two wallets read.
    expect(decl).toMatch(
      /RETURNS TABLE\(lifetime_earned bigint, lifetime_spent bigint, credits bigint, debits bigint\)/
    );
    // Own-user by default: the browser callers pass no argument in three of
    // the four, and this one is reached with the signed-in user's own id.
    expect(decl).toMatch(/p_user_id uuid DEFAULT auth\.uid\(\)/);
    // SECURITY INVOKER: RLS is still the thing that scopes the rows. A guard
    // is not a licence to run this as the owner.
    expect(decl.slice(0, decl.indexOf('$fn$'))).not.toMatch(/SECURITY DEFINER/);
  });
});
