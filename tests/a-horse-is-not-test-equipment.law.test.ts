/**
 * A HORSE IS NOT TEST EQUIPMENT, AND NOBODY ARMS A RULE BLIND.
 *
 * `fn_ca_is_cert_account` decides who is certification equipment rather than a
 * player. It matched horses two ways by accident - their fleet email domain
 * (`%@horses.smarter.poker`) and their uuid shape - and on 2026-09-08 that
 * classified **468 of 1,000 horses**, holding **1,324,300 diamonds**, as test
 * equipment. Zero of them were in `ca_cert_accounts`, the register that is
 * actually meant to say so.
 *
 * Eleven functions consult it. Those horses were refused the daily bonus, the
 * wheel and the games, left out of duel pairing, LEFT OUT OF THE COLLUSION SCAN,
 * and had their diamonds reported as harness money rather than player money.
 *
 * Its twin `fn_ca_is_fixture_account` had the identical defect, matched the
 * identical 468, and was fixed the same morning. This one was not - two
 * predicates meaning the same thing, one fixed, one not. They must agree.
 *
 * Then the door itself: the daily bonus opened only with `auth.uid()`, so a rule
 * saying horses qualify sat behind a door only a browser could open. The engine
 * supplies what a browser would (CLAUDE.md 10.5), and only the engine may - a
 * browser naming another player is refused rather than ignored.
 *
 * And the forecast, so this class of thing is found by counting rather than by
 * an assertion happening to fail: every rule already files an incident on exactly
 * the condition it refuses on, so what it WOULD refuse is what it HAS been
 * filing - one general answer, with no copy of the rule to drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('a horse is never certification equipment', () => {
  const sql = read('a_horse_is_not_test_equipment');
  const body = code(sql);

  it('asks the profile whether it is a horse, exactly as its twin does', () => {
    expect(body).toContain(
      'NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND COALESCE(p.is_horse, false))'
    );
  });

  it('asserts no horse is left classified as equipment', () => {
    expect(body).toContain('horses are still classified as certification equipment');
  });

  it('asserts the two predicates agree, which is why this was missed', () => {
    expect(body).toContain('the two harness predicates still disagree about horses');
  });

  it('keeps the deliberate register working for real cert accounts', () => {
    expect(body).toContain('ca_cert_accounts');
    expect(body).toContain('no active certification account reads as one any more');
    expect(body).toContain(
      'the structured-uuid harness no longer reads as certification equipment'
    );
  });

  it('checks the deploy gate does not trip on the reclassification', () => {
    expect(body).toContain('unexplained after a reclassification that moved no money');
  });

  it('moves no money', () => {
    expect(body).not.toMatch(/UPDATE\s+public\.profiles[^;]*diamonds\s*=/i);
    expect(body).toContain('players + float <> register after a change that moves no money');
  });
});

describe('a horse collects its daily bonus', () => {
  const sql = read('a_horse_collects_its_daily_bonus');
  const body = code(sql);

  it('lets the engine name the player it acts for', () => {
    expect(body).toContain('IF v_uid IS NULL AND public.fn_caller_is_engine() THEN');
    expect(body).toContain('v_uid := p_user_id;');
  });

  it('refuses a browser that names somebody else, rather than ignoring it', () => {
    expect(body).toContain('Cannot claim a daily bonus for another player');
  });

  it('still refuses a caller who is neither', () => {
    expect(body).toContain('requires an authenticated caller');
  });

  it('keeps one body so two cannot drift', () => {
    expect(body).toContain('DROP FUNCTION IF EXISTS public.fn_ca_daily_bonus_claim(integer, uuid)');
    expect(body).toContain('overloads of the daily bonus claim exist; two bodies drift');
  });

  it('keeps every other rule of the bonus', () => {
    for (const rule of [
      'already_claimed',
      'vip_only',
      'fn_ca_daily_bonus_eligibility',
      'idempotent',
      'award_diamonds_v2',
    ]) {
      expect(body).toContain(rule);
    }
    expect(body).toContain('a rule of the daily bonus was lost in the rewrite');
  });

  it('keeps players able to claim their own', () => {
    expect(body).toContain('players can no longer claim their own daily bonus');
    expect(body).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid) TO authenticated'
    );
  });
});

describe('the flip forecast', () => {
  const sql = read('the_flip_forecast');
  const body = code(sql);

  it('counts from what each rule files, not from a copy of the rule', () => {
    expect(body).toContain('FROM public.ca_diamond_rule_modes m');
    expect(body).toContain('LEFT JOIN public.ca_diamond_incidents i');
    expect(body).toContain('ON i.rule = m.rule');
  });

  it('reports its own blind spot rather than understating quietly', () => {
    expect(body).toContain("'(forecast confidence)'");
    expect(body).toContain('DR7:ledger_write_failed');
    expect(body).toContain('FLOOR, not a total');
  });

  it('tells a safe rule apart from an unknown one', () => {
    expect(body).toContain('SAFE TO ARM');
    expect(body).toContain('WOULD REFUSE');
    expect(body).toContain('ALREADY ARMED');
  });

  it('proves itself against the one rule already measured by hand', () => {
    expect(body).toContain("rule = 'DR7:user_over_daily_cap'");
    expect(body).toContain('contradicts what was measured by hand');
  });

  it('refuses nothing and moves nothing', () => {
    expect(body).toContain('STABLE');
    expect(body).not.toMatch(/INSERT INTO|UPDATE .* SET|DELETE FROM/i);
  });
});
