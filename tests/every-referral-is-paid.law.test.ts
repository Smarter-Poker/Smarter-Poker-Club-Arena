/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EVERY REFERRAL IS RECORDED AND PAID WHEN THE NEW PLAYER CONFIRMS (Dan 2026-10-17)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "YES PAY OUT DIAMONDS FOR ALL REFERRALS".
 *
 * Until 2026-10-17 no referral had ever been recorded: public.referrals held
 * zero rows and profiles.referred_by was NULL everywhere. The sign-up referrer
 * lived only in one browser's localStorage, and the reward endpoint read a
 * table nothing wrote, then withheld payment behind a verified phone, seven
 * days and five login days. Three players who arrived on kingfish's Club Arena
 * invite link were owed and never paid.
 *
 * The migration pinned here is the one place a referral is settled. These pins
 * keep it settling on confirmation, through the idempotent award path, never
 * blocking a sign-up, and never callable by a browser.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20261017223126_a_referral_is_recorded_and_paid_when_the_new_player_confirms.sql'
);
const sql = readFileSync(MIGRATION, 'utf8');

describe('every referral is recorded and paid when the new player confirms', () => {
  it('settles on email confirmation and on an account created already confirmed', () => {
    expect(sql).toMatch(
      /AFTER UPDATE OF email_confirmed_at ON auth\.users[\s\S]*?WHEN \(OLD\.email_confirmed_at IS NULL AND NEW\.email_confirmed_at IS NOT NULL\)/
    );
    expect(sql).toMatch(
      /AFTER INSERT ON auth\.users[\s\S]*?WHEN \(NEW\.email_confirmed_at IS NOT NULL\)/
    );
  });

  it('can never fail a sign-up: the settlement runs in its own savepoint', () => {
    const trigger = sql.slice(
      sql.indexOf('tr_auth_user_confirmed_settles_referral()\nRETURNS trigger')
    );
    expect(trigger).toMatch(
      /BEGIN\s+PERFORM public\.fn_settle_signup_referral\(NEW\.id\);\s+EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/
    );
  });

  it('pays through award_diamonds_v2 with the reference ids every door has always used', () => {
    expect(sql).toMatch(
      /award_diamonds_v2\(\s*v_referrer, 'referral_qualified',\s*'referral_qualified_' \|\| v_referrer \|\| '_' \|\| p_referee/
    );
    expect(sql).toMatch(
      /award_diamonds_v2\(\s*p_referee, 'referral_referee',\s*'referral_referee_' \|\| p_referee \|\| '_' \|\| v_referrer/
    );
    // No hand-written diamond row and no amount chosen here: the catalog decides.
    expect(sql).not.toMatch(/INSERT INTO public\.diamond_transactions/);
    expect(sql).not.toMatch(/SET diamonds\s*=/);
  });

  it('has no qualification gate beyond a confirmed email', () => {
    const fn = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_settle_signup_referral'),
      sql.indexOf('REVOKE ALL ON FUNCTION public.fn_signup_referrer')
    );
    expect(fn).toMatch(/email_not_verified/);
    for (const gate of [
      /phone_verified/,
      /interval '7 days'/i,
      /daily_login/,
      /20\b.*per month/i,
    ]) {
      expect(fn).not.toMatch(gate);
    }
  });

  it('reads the referrer from the account itself, never from a caller', () => {
    expect(sql).toMatch(/v_meta ->> 'referral_player_number'/);
    // A shared Referral Crew link carries a legacy code; it must still credit its owner.
    expect(sql).toMatch(/WHERE p\.referral_code = upper\(btrim\(v_meta ->> 'referral_code'\)\)/);
    expect(sql).toMatch(/v_meta ->> 'club_join_path'/);
    expect(sql).toMatch(/AND p\.id <> p_referee/);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_settle_signup_referral\(p_referee uuid\)/
    );
  });

  it('is never callable from a browser', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_settle_signup_referral\(uuid\) FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_signup_referrer\(uuid\) FROM PUBLIC, anon, authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_settle_signup_referral\(uuid\) TO service_role;/
    );
  });

  it('settles exactly the three owed players and asserts the money', () => {
    for (const id of [
      'ed50427d-046e-4685-b1f6-f3952442758a',
      '41da1807-7cd1-4e0e-b60c-38ffe0d962e9',
      'b52f183b-c0fc-4dcc-8d96-7d2a1cdb7216',
    ])
      expect(sql).toContain(id);
    expect(sql).toMatch(/v_after_k - v_before_k <> 1500/);
  });
});
