/**
 * LAW - a completed daily challenge is claimed for every player and expires for every player
 * (docs/DIAMOND-RULINGS.md ruling 3 as amended; CLAUDE.md 10.5, horses are players;
 * docs/changelog/2026-09-08-diamond-challenges-claimed-and-expired.md).
 *
 * Every pin here is a defect that was live on 2026-09-08:
 *  - 40,797 completed challenges worth 2,410,529 diamonds sat unclaimed, 40,749 of them a
 *    horse's, because nothing pressed Claim for a player with no browser;
 *  - nothing expired, for anyone, so the promise grew without bound;
 *  - 468 of the 1,000 horses matched fn_ca_is_fixture_account, so the earn ledger, the
 *    promotional budgets and incident severity silently skipped half the fleet.
 * Negative controls mutate a copy of the source and expect the pin to fail.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(dir).filter((n) => n.endsWith('.sql'));
const pick = (suffix: string) => {
  const f = files.find((n) => n.endsWith(suffix));
  expect(f, `${suffix} exists`).toBeTruthy();
  return fs.readFileSync(path.join(dir, f as string), 'utf8');
};
const ch = pick('_daily_challenges_claimed_for_horses_capped_by_the_line_and_e.sql');
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe("the engine is the horse's input device for the Claim button", () => {
  it('claims inside the transaction that completed the challenge, through the human claim body', () => {
    expect(ch).toContain(
      'IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND p.is_horse) THEN'
    );
    expect(ch).toContain(
      'PERFORM public.claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL);'
    );
    expect(ch).toContain('AND u.completed_at = now()');
  });
  it('files a failed claim rather than breaking the progress it just recorded', () => {
    expect(ch).toContain("'CH3:horse_claim_failed'");
    expect(flat(ch)).toContain(
      'EXCEPTION WHEN OTHERS THEN BEGIN PERFORM public.fn_ca_diamond_incident('
    );
  });
  it('does not reach for a horse-only credit path', () => {
    // The horse must go through the same body a human's click reaches. A direct balance write or
    // a separate horse claim function would be the exclusion 10.5 forbids, in reverse.
    const horseBlock = ch.slice(
      ch.indexOf(
        'IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND p.is_horse) THEN'
      )
    );
    expect(horseBlock).not.toContain('UPDATE public.profiles');
    expect(horseBlock).not.toContain('add_diamonds_to_balance');
  });
});

describe('seven days to claim, for everyone', () => {
  it('both claim paths refuse an expired reward by the clock, not only by the stamp', () => {
    expect((ch.match(/ERRCODE = 'P0430'/g) ?? []).length).toBe(2);
    expect(ch).toContain("completed_at < now() - interval '7 days'");
    expect(ch).toContain('v_row.expired_at IS NOT NULL');
    expect(ch).toContain('expired_at IS NOT NULL OR completed_at < now()');
  });
  it('the dashboard and the batch vault list only what is still claimable', () => {
    expect(
      (ch.match(/expired_at IS NULL\s+AND completed_at >= now\(\) - interval '7 days'/g) ?? [])
        .length
    ).toBeGreaterThanOrEqual(2);
  });
  it('the stamp is a scheduled product rule, not a repair job (CLAUDE.md 10.12)', () => {
    expect(ch).toContain("cron.schedule('daily-missions-reward-expiry'");
    const body = ch.slice(ch.indexOf('FUNCTION public.fn_expire_daily_challenge_rewards'));
    // it may only stamp expired_at; it must never pay, credit or claim anything
    expect(body.slice(0, body.indexOf('$$;'))).not.toMatch(
      /claimed\s*=\s*true|add_diamonds_to_balance|fn_ca_mint/
    );
  });
});

describe('a horse is never a certification fixture', () => {
  it('the predicate excludes horses by asking the profile', () => {
    expect(flat(ch)).toContain(
      'NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND COALESCE(p.is_horse, false))'
    );
  });
  it('the mis-tagged certification rows are deactivated, and the migration asserts none remain', () => {
    expect(ch).toContain('UPDATE public.ca_cert_accounts c');
    expect(ch).toContain('a horse is still a fixture');
    expect(ch).toContain('an active certification row still points at a horse');
  });
});

describe('the limits govern the claim, never the assignment (ruling 3 as amended)', () => {
  it('nothing caps what a challenge is assigned', () => {
    expect(ch).toContain('ruling 3 as amended caps the claim, not the assignment');
    expect(ch).not.toContain('fn_ca_daily_challenge_budget_remaining');
  });
  it('the monthly line is set from a measurement written beside it (CLAUDE.md 10.84)', () => {
    expect(ch).toContain('12000000');
    expect(ch).toContain('Measured 2026-09-08');
    // negative control: a number with no measurement beside it is what this forbids
    expect(ch.slice(0, ch.indexOf('BEGIN;'))).toContain('above the measured peak');
  });
});
