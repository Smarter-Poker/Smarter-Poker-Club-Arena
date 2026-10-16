/**
 * SIGNUP NEVER FREEZES (2026-10-16).
 *
 * Every signup error in production for 30 days was one row:
 * handle_new_user_v2_create_wallet, SQLSTATE 55006, "INSERT on wallets was
 * refused". The signup trigger creates the player wallet exactly once, inside
 * the auth.users INSERT; the freeze guard refused it between :55 and :00 and
 * the trigger swallowed the error, so an account made during the break never
 * got a wallet at all.
 *
 * LAW 1 - A NEW WALLET HOLDING NOTHING IS IDENTITY, NOT MONEY. The freeze guard
 *   lets a wallets INSERT through when balance and locked_balance are both
 *   zero, beside the zero-balance club_members exemption, and before the
 *   bypass and role checks.
 * LAW 2 - EVERYTHING ELSE ON wallets IS STILL REFUSED. The exemption is
 *   INSERT-only and names both balances; the refusal itself is unchanged, and
 *   the journal exemption it shares the guard with is carried over intact.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) => /^\d{14}_signup_wallet_never_freezes\.sql$/.test(n));
if (!file) throw new Error('the migration is not in the tree');
const sql = readFileSync(resolve(MIG, file), 'utf8');

const guard = (): string => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen(');
  expect(start, 'fn_refuse_while_frozen is defined in the migration').toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('signup never freezes', () => {
  it('LAW 1: a zero-balance wallets INSERT passes the freeze guard, beside the onboarding exemption and before the bypass', () => {
    const g = guard();
    const at = g.indexOf("IF TG_TABLE_NAME = 'wallets' AND TG_OP = 'INSERT'");
    expect(at).toBeGreaterThan(-1);
    expect(g.slice(at)).toMatch(
      /^IF TG_TABLE_NAME = 'wallets' AND TG_OP = 'INSERT'\s+AND COALESCE\(\(to_jsonb\(NEW\) ->> 'balance'\)::numeric, 0\) = 0\s+AND COALESCE\(\(to_jsonb\(NEW\) ->> 'locked_balance'\)::numeric, 0\) = 0 THEN\s+RETURN NEW;\s+END IF;/
    );
    expect(at).toBeGreaterThan(g.indexOf("IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'"));
    expect(at).toBeLessThan(g.indexOf('fn_freeze_bypass_active()'));
    expect(at).toBeLessThan(g.indexOf('request.jwt.claims'));
  });

  it('LAW 2: the refusal, the onboarding exemption and the journal exemption are all still there', () => {
    const g = guard();
    expect(g).toMatch(/IF public\.fn_platform_frozen\(\) THEN\s+RAISE EXCEPTION\s+'PLATFORM_FROZEN/);
    expect(g).toMatch(/USING ERRCODE = '55006'/);
    expect(g).toMatch(
      /IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth\(\) > 1 THEN\s+RETURN COALESCE\(NEW, OLD\);\s+END IF;/
    );
    // only INSERT is exempt on wallets: no UPDATE or DELETE branch names the table
    expect(g.match(/TG_TABLE_NAME = 'wallets'/g)?.length).toBe(1);
    expect(sql).toMatch(/RAISE EXCEPTION 'the freeze guard does not carry the signup wallet exemption'/);
    expect((sql.match(/^BEGIN;$/gm) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;$/gm) || []).length).toBe(1);
  });
});
