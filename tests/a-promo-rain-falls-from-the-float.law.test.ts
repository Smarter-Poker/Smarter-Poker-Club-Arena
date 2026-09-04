/**
 * A PROMO RAIN FALLS FROM THE FLOAT THE SWEEP FILLS, AND LANDS AS CHIPS.
 *
 * 2026-09-03, Dan (binding): "WE WILL BUILD IN MORE PROMOTIONS THAT ARE
 * AUTOMATED LIKE HIGH HANDS AND RANDOM SPLASH POTS ETC, BUT FOR NOW, PROMO'S
 * ARE DISBURSED MANUALLY BY OWNERS." And: "PROMO CHIPS ARE TREATED EXACTLY LIKE
 * REGULAR CHIPS ALWAYS."
 *
 * The owner's splash pot already had a button. Three separate faults meant it
 * had never paid a chip, and the third was invisible from the outside:
 *
 *   1. it drew from bbj_pools.promo_balance, which the hourly sweep empties
 *      into the owner's float - 6.27 chips stood in the union's pool against
 *      40,184.01 in the float it had been swept to;
 *   2. it paid into club_members.promo_balance, a locked bucket that ruling 4B
 *      says is not a thing;
 *   3. fn_bbj_promo_payout_atomic refused any caller whose JWT said
 *      'authenticated' - which is every owner, because SECURITY DEFINER changes
 *      the database role and not the request's JWT. The rain delegates to it,
 *      so every owner-pressed rain died on 'Unauthorized' before reaching a
 *      line of money code.
 *
 * The rules this pins:
 *
 *   - the purse is the float the sweep fills (union promo_wallet, or a
 *     standalone club's promo_balance); the pool is the occasion, not the purse;
 *   - every share lands in an ordinary cashable chip_balance;
 *   - the debit declares its counterparty and skips its own table, so each
 *     player's credit is the one row that names both sides;
 *   - a short float refuses whole rather than paying part;
 *   - the EXECUTE grant is the gate, not the caller's JWT.
 *
 * SUPERSEDED IN PART, 2026-09-03 23:39 UTC. Dan: "WE'VE NEVER BUILT THE
 * SPLASH POT YET, OR DESIGNED RULES FOR IT, ITS SUPPOSED TO BE ADDED LATER,
 * ONCE WE WORK ALL THE BUGS OUT." So migration
 * 20260903233924_the_splash_pot_is_not_designed_yet_so_its_door_is_shut.sql
 * shuts fn_bbj_promo_rain - the owner-facing entry point - and revokes it from
 * authenticated. The money path proved here is not deleted; it is the path the
 * rain must reopen on once the splash pot has rules. This law keeps that path
 * pinned so the reopening cannot quietly regress to the pool, to a locked promo
 * bucket, or to a JWT check.
 *
 * Rolled-back probe as the real union owner: 500.00 left the float, 413 seated
 * players were credited ordinary chips across 413 declared
 * union_wallet -> player_wallet rows, member promo buckets stayed 0.00, and
 * conservation was 0.00.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
function read(fragment: string): string {
  const f = readdirSync(DIR)
    .filter((x) => x.includes(fragment))
    .sort()
    .pop();
  expect(f, `the migration containing "${fragment}" is missing`).toBeTruthy();
  return readFileSync(resolve(DIR, f as string), 'utf8');
}
const RAIN = read('a_promo_rain_falls_from_the_float');
const GATE = read('the_grant_is_the_gate_on_the_promo_payout');

function body(sql: string): string {
  const open = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_bbj_promo_payout_atomic');
  expect(open, 'fn_bbj_promo_payout_atomic has moved or gone').toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('a promo rain falls from the float', () => {
  it('draws from the float the sweep fills, not the pool it was swept out of', () => {
    const b = body(GATE);
    expect(b).toMatch(/SELECT COALESCE\(promo_wallet, 0\) INTO v_float\s+FROM union_wallets/);
    expect(b).toMatch(/SELECT COALESCE\(promo_balance, 0\) INTO v_float\s+FROM clubs/);
    expect(b).not.toMatch(/COALESCE\(v_pool\.promo_balance,0\) < p_amount/);
    expect(b).not.toMatch(/UPDATE bbj_pools SET promo_balance = promo_balance - p_amount/);
  });

  it('lands every share as ordinary cashable chips', () => {
    const b = body(GATE);
    expect(b).toMatch(
      /UPDATE club_members\s+SET chip_balance = COALESCE\(chip_balance, 0\) \+ v_amt/
    );
    expect(b).not.toMatch(/SET promo_balance = COALESCE\(promo_balance, 0\) \+ v_amt/);
    expect(b).toContain("'lands_as', 'ordinary_chips'");
  });

  it('declares the debit and skips its own table so one row names both sides', () => {
    const b = body(GATE);
    expect(b).toMatch(
      /fn_ca_declare_ledger\('promo', 'union_wallet', v_union, NULL,\s*'promo_rain:'/
    );
    expect(b).toMatch(
      /fn_ca_declare_ledger\('promo', 'promo_wallet', v_pool\.club_id, NULL,\s*'promo_rain:'/
    );
    expect(b).toContain("ARRAY['union_wallets']");
    expect(b).toContain("ARRAY['clubs']");
  });

  it('refuses a short float whole and keeps its idempotency key', () => {
    const b = body(GATE);
    expect(b).toContain("'insufficient_promo_balance'");
    expect(b).toContain("v_op_key := 'bbjpromo:'");
    expect(b).toContain("'already_paid', true");
  });

  it('makes the grant the gate instead of the caller JWT', () => {
    const b = body(GATE);
    expect(b).not.toContain("IF auth.role() = 'authenticated' THEN");
    expect(b).toContain('The GRANT is the gate');
    expect(GATE).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_bbj_promo_payout_atomic\(uuid, numeric, uuid\[\], text, text\)\s*FROM PUBLIC, anon, authenticated;/
    );
    expect(GATE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_bbj_promo_payout_atomic\(uuid, numeric, uuid\[\], text, text\)\s*TO service_role;/
    );
  });

  it('keeps the signature its callers pass, defaults included', () => {
    for (const sql of [RAIN, GATE]) {
      expect(sql).toContain('p_reason text DEFAULT NULL::text');
      expect(sql).toContain("p_event_type text DEFAULT 'custom'::text");
    }
  });
});
