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
 * days and five login days. Players who arrived on kingfish's Club Arena
 * invite link were owed and never paid.
 *
 * The 2026-10-17 migration that fixed it merged but was never installed: its
 * backfill accepted exactly three players and aborted once a fourth
 * (ChaseOryan45) confirmed. 20261019092248 supersedes it. These pins keep the
 * one settlement paying on confirmation AND on a referral recorded after
 * confirmation, through the idempotent award path, never blocking a sign-up or
 * an invite claim, never callable by a browser, and never reading "paid" from
 * a refusal's wording.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(process.cwd(), 'supabase/migrations');
const MIGRATION = join(
  DIR,
  '20261019092248_every_confirmed_referral_is_paid_once_and_the_pending_one_co.sql'
);
const SUPERSEDED = join(
  DIR,
  '20261017223126_a_referral_is_recorded_and_paid_when_the_new_player_confirms.sql'
);
const sql = readFileSync(MIGRATION, 'utf8');
const settle = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_settle_signup_referral'),
  sql.indexOf('REVOKE ALL ON FUNCTION public.fn_signup_referrer')
);

describe('every referral is recorded and paid when the new player confirms', () => {
  it('the never-installed 2026-10-17 file is marked superseded so it can never run', () => {
    const old = readFileSync(SUPERSEDED, 'utf8');
    expect(old.split('\n')[0]).toMatch(/^-- SUPERSEDED BY 20261019092248\b/);
  });

  it('settles on email confirmation and on an account created already confirmed', () => {
    expect(sql).toMatch(
      /AFTER UPDATE OF email_confirmed_at ON auth\.users[\s\S]*?WHEN \(OLD\.email_confirmed_at IS NULL AND NEW\.email_confirmed_at IS NOT NULL\)/
    );
    expect(sql).toMatch(
      /AFTER INSERT ON auth\.users[\s\S]*?WHEN \(NEW\.email_confirmed_at IS NOT NULL\)/
    );
  });

  it('settles a referral recorded after the email was confirmed (the invite claim order)', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER on_referral_recorded_settles_referral\s+AFTER INSERT ON public\.referrals\s+FOR EACH ROW\s+WHEN \(NEW\.status = 'pending' AND NEW\.referee_id IS NOT NULL\)\s+EXECUTE FUNCTION public\.tr_referral_recorded_settles_referral\(\);/
    );
    // The settlement's own INSERT never re-enters it.
    expect(settle).toMatch(/set_config\('ca\.settling_referral', p_referee::text, true\)/);
    expect(sql).toMatch(
      /IF current_setting\('ca\.settling_referral', true\) IS DISTINCT FROM NEW\.referee_id::text THEN/
    );
  });

  it('never takes ACCESS EXCLUSIVE on auth.users: no DROP TRIGGER outside the rollback notes', () => {
    const body = sql.slice(sql.indexOf('\nBEGIN;\n'));
    expect(body).not.toMatch(/^DROP TRIGGER/m);
  });

  it('can never fail a sign-up or an invite claim: each trigger settles in its own savepoint', () => {
    const auth = sql.slice(
      sql.indexOf('tr_auth_user_confirmed_settles_referral()\nRETURNS trigger')
    );
    expect(auth).toMatch(
      /BEGIN\s+PERFORM public\.fn_settle_signup_referral\(NEW\.id\);\s+EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/
    );
    const recorded = sql.slice(
      sql.indexOf('tr_referral_recorded_settles_referral()\nRETURNS trigger')
    );
    expect(recorded).toMatch(
      /BEGIN\s+PERFORM public\.fn_settle_signup_referral\(NEW\.referee_id\);\s+EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/
    );
  });

  it('pays through award_diamonds_v2 with the reference ids every door has always used', () => {
    expect(settle).toMatch(
      /award_diamonds_v2\(\s*v_referrer, 'referral_qualified',\s*'referral_qualified_' \|\| v_referrer \|\| '_' \|\| p_referee/
    );
    expect(settle).toMatch(
      /award_diamonds_v2\(\s*p_referee, 'referral_referee',\s*'referral_referee_' \|\| p_referee \|\| '_' \|\| v_referrer/
    );
    // No hand-written diamond row and no amount chosen here: the catalog decides.
    expect(sql).not.toMatch(/INSERT INTO public\.diamond_transactions/);
    expect(sql).not.toMatch(/SET diamonds\s*=/);
  });

  it('reads "paid" from the journal, so a same-day repeat never flips a completed referral back', () => {
    // A repeat call is refused 'action_limit' (referral_referee is one a day)
    // before 'already_claimed' is reached; the 2026-10-17 body read that as
    // unpaid and set the row back to pending.
    expect(settle).not.toMatch(/->> 'reason' IN \('duplicate', 'already_claimed'\)/);
    expect(settle).toMatch(
      /t\.reference_id = 'referral_qualified_' \|\| v_referrer \|\| '_' \|\| p_referee/
    );
    expect(settle).toMatch(
      /t\.user_id = p_referee AND t\.amount > 0\s+AND t\.transaction_type = 'referral_referee'/
    );
    expect(settle).toMatch(
      /status\s+= CASE WHEN v_ok_referrer AND v_ok_referee THEN 'completed' ELSE status END/
    );
  });

  it('keeps and completes a pending row the invite claim already recorded', () => {
    expect(settle).toMatch(/ON CONFLICT \(referee_id\) DO NOTHING/);
    expect(settle).toMatch(/FROM public\.referrals r WHERE r\.referee_id = p_referee/);
    expect(settle).toMatch(/self_referral/);
  });

  it('has no qualification gate beyond a confirmed email', () => {
    expect(settle).toMatch(/email_not_verified/);
    for (const gate of [
      /phone_verified/,
      /interval '7 days'/i,
      /daily_login/,
      /20\b.*per month/i,
    ]) {
      expect(settle).not.toMatch(gate);
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

  it('settles every confirmed referral found at run time, never a hard-coded count, and asserts the money', () => {
    // Found from the sign-up record OR a recorded referral row.
    expect(sql).toMatch(
      /EXISTS \(SELECT 1 FROM public\.fn_signup_referrer\(u\.id\)\)\s+OR EXISTS \(SELECT 1 FROM public\.referrals x WHERE x\.referee_id = u\.id\)/
    );
    expect(sql).not.toMatch(/array_length\(v_settled, 1\) IS DISTINCT FROM 3/);
    // The four the probe found must be among them.
    for (const id of [
      'ed50427d-046e-4685-b1f6-f3952442758a',
      '41da1807-7cd1-4e0e-b60c-38ffe0d962e9',
      'b52f183b-c0fc-4dcc-8d96-7d2a1cdb7216',
      'b8645a41-f619-4c0e-accd-5c4779120583',
    ])
      expect(sql).toContain(id);
    expect(sql).toMatch(/IF v_n <> 1 OR v_amt <> 100 THEN/);
    expect(sql).toMatch(/IF v_n <> 1 OR v_amt <> 500 THEN/);
    expect(sql).toMatch(/v_issued <> 600 \* array_length\(v_settled, 1\)/);
    expect(sql).toMatch(/IF v_kingfish_owed < 2000 THEN/);
  });

  it('creates nothing that already exists and proves its installed bodies', () => {
    expect(sql).toMatch(/this migration replaces nothing/);
    expect(sql).toMatch(/post-image: installed bodies differ from this file/);
    expect(sql).not.toMatch(/__MD5_[A-Z_]+__/);
  });
});
