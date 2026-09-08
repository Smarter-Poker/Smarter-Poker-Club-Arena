/**
 * LAW - the diamond loop is closed: player-to-player transfers are off, and the one social
 * transfer that remains moves both legs in a single transaction with no compensating write
 * (docs/DIAMOND-RULINGS.md rulings 4 and 12; CLAUDE.md 10.12;
 * docs/changelog/2026-09-08-diamond-transfers-and-gifts.md).
 *
 * Every pin is a defect that was live on 2026-09-08:
 *  - send_stream_gift's idempotency guard looked for a reference key it never writes, so a
 *    replay gifted a second time;
 *  - both its journal legs were unclassified, so the classifier filed DR12 on every gift;
 *  - it locked two profile rows with one ORDER BY ... FOR UPDATE, which does not order locks;
 *  - a gift could move purchased diamonds, leaving the refund sub-ledger short;
 *  - it was granted to players but missing from the privileged-column guard, so a player's
 *    gift was refused 42501 - which nobody saw, because the route never called it;
 *  - the cap ladder exempted one hard-coded uuid and waived every cap for any account 120 days
 *    old or seven days past its first purchase;
 *  - two different cap policies were live under one function name.
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
const tr = pick('_transfers_are_off_gifts_are_atomic_and_the_waivers_are_gone.sql');
// The migration's own assertion block names the strings it forbids, so absence pins read the
// part that DEFINES the functions, not the part that checks them.
const defs = tr.slice(0, tr.indexOf('-- 5. Assertions.'));

describe('player-to-player transfers are off', () => {
  it('the door refuses and is revoked from authenticated', () => {
    expect(tr).toContain("'p2p_transfers_disabled'");
    expect(tr).toContain(
      'REVOKE ALL ON FUNCTION public.send_wallet_diamond_transfer(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;'
    );
    const body = defs.slice(defs.indexOf('FUNCTION public.send_wallet_diamond_transfer('));
    expect(body.slice(0, body.indexOf('$$;'))).not.toContain('UPDATE');
  });
  it('the legacy unjournaled pair is dropped', () => {
    expect(tr).toContain('DROP FUNCTION IF EXISTS public.transfer_diamonds_deduct(uuid, integer);');
    expect(tr).toContain('DROP FUNCTION IF EXISTS public.transfer_diamonds_credit(uuid, integer);');
  });
});

describe('one gift, one transaction, one policy', () => {
  it('the idempotency guard looks for the keys the function actually writes', () => {
    expect(tr).toContain("reference_id IN (v_ref, v_ref || ':sender', v_ref || ':recipient')");
  });
  it('both legs are classified, so the classifier never has to', () => {
    expect((tr.match(/'transferred'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(tr).toContain("'player:' || v_recipient::text");
    expect(tr).toContain("'player:' || v_sender::text");
  });
  it('the two profile rows are locked in a defined order', () => {
    expect(tr).toContain('LEAST(v_sender, v_recipient)');
    expect(tr).toContain('GREATEST(v_sender, v_recipient)');
  });
  it('purchased diamonds do not leave as a gift (rulings 1 and 4)', () => {
    expect(tr).toContain('fn_ca_giftable_balance');
    expect(tr).toContain('purchased_diamonds_not_giftable');
  });
  it('the gift path is authorised by the privileged-column guard', () => {
    expect(tr).toContain('send_stream_gift[(]');
  });
});

describe('the anti-farming ladder applies to everyone (rulings 4 and 12)', () => {
  it('no hard-coded exempt account survives', () => {
    expect(defs).not.toContain('47965354-0e56-43ef-931c-ddaab82af765');
    expect(defs.toLowerCase()).not.toContain('kingfish_sender_bypass');
  });
  it('neither waiver survives', () => {
    expect(defs).not.toContain('trusted_purchaser_7d_bypass');
    expect(defs).not.toContain('v_account_age_days >= TRUST_AGE_DAYS THEN');
  });
  it('the caps themselves are still there, and no lift date is promised', () => {
    expect(tr).toContain('CAP_PER_PAIR_24H');
    expect(tr).toContain('CAP_PER_USER_24H');
    expect(tr).toContain('CAP_BURST_60S');
    expect(tr).toContain('v_lift_at := NULL;');
  });
  it('only one cap policy exists under the name', () => {
    expect(tr).toContain(
      'DROP FUNCTION IF EXISTS public.fn_check_anti_farming_gift_cap(uuid, integer);'
    );
    expect(tr).toContain('there is still more than one gift cap policy under one name');
  });
});
