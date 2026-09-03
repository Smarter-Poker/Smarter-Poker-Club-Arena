/**
 * Pins for the 2026-08-27 cashier phase-2 audit. Source-text assertions in
 * the house style: the migration files carry the guards; these fail loudly
 * if a later edit removes one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const PHASE2 = read(
  'supabase/migrations/20260827_cashier_phase2_cashout_union_and_reconciliation.sql'
);
const CLAMP = read('supabase/migrations/20260827_ensure_agent_row_respects_agents_role_check.sql');

describe('the cash out lifecycle conserves every chip', () => {
  it('approval mints the agents row through fn_ensure_agent_row', () => {
    expect(PHASE2).toMatch(/fn_ensure_agent_row\(v_req\.club_id, v_actor, v_role\)/);
  });

  it('expiry recreates a vanished membership so the refund always lands', () => {
    expect(PHASE2).toMatch(/on conflict \(club_id, user_id\) do update/);
  });

  it('requests refuse sub-cent amounts and carry a ceiling', () => {
    expect(PHASE2).toMatch(/Chips Move In Hundredths At Most/);
    expect(PHASE2).toMatch(/Amount Exceeds The Single Request Limit/);
  });
});

describe('union money stays inside the union and lands somewhere live', () => {
  it('never routes through the frozen wallets pool or the home-club resolver', () => {
    // The assert block at the bottom of the migration NAMES both functions to
    // prove their absence; a CALL is name-plus-parenthesis.
    expect(PHASE2).not.toMatch(/add_to_promo_wallet\(/);
    expect(PHASE2).not.toMatch(/atomic_credit_wallet_and_log\(/);
  });

  it('anon can no longer execute the union member send', () => {
    expect(PHASE2).toMatch(
      /revoke all on function public\.fn_union_send_to_member[\s\S]*from anon/
    );
  });

  it('union promo to an agent lands in the float the promo cashier spends', () => {
    expect(PHASE2).toMatch(
      /promo_wallet_balance = coalesce\(promo_wallet_balance,\s*0\) \+ p_amount/
    );
  });
});

describe('the nightly reconciliation watches the cashier', () => {
  it('files stuck escrow, negative balances and over-claims as critical', () => {
    expect(PHASE2).toMatch(/cashout_escrow_stuck/);
    expect(PHASE2).toMatch(/negative_balance/);
    expect(PHASE2).toMatch(/over_claimed_send/);
  });
});

describe('staff can hold floats despite agents_role_check', () => {
  it('the ensure-row helper clamps staff roles to a permitted tier', () => {
    expect(CLAMP).toMatch(/else 'super_agent'/);
  });
});
