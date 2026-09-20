/**
 * LAW - the diamond loop is closed: a player-to-player transfer goes through exactly ONE
 * atomic, authenticated, journaled platform door, the retired manual doors stay retired,
 * and the one social transfer moves both legs in a single transaction with no compensating
 * write (docs/DIAMOND-RULINGS.md rulings 4 and 12; CLAUDE.md 10.12;
 * docs/changelog/2026-09-08-diamond-transfers-and-gifts.md).
 *
 * RETARGETED 2026-09-20. This law used to assert that player-to-player transfers were OFF,
 * which is what migration 20260908031918 did on 2026-09-08. Dan amended ruling 4 the SAME
 * DAY to allow them through one atomic, authenticated, journaled path, and 20260909200327
 * built exactly that. The law and the ruling had been in written conflict ever since, and
 * Phase 4 of the build programme requires the door the law was forbidding. The still-true
 * pins from the old law are kept verbatim below; only the "transfers are off" claim is
 * replaced by what actually governs the door now.
 *
 * WHAT IS TRUE, AND WHY diamond_wallet_transfers IS EMPTY. The door exists, is granted to
 * authenticated and to nobody else, and writes its own append-only row. It runs under the
 * SENDER'S JWT. fn_guard_profile_privileged_columns refuses any write to profiles.diamonds
 * that is neither service-role nor made from a call stack naming a listed money RPC, and
 * the route is NOT on that list yet, so every attempt answers 42501 at the first wallet
 * UPDATE and rolls back. Read in production 2026-09-20: diamond_wallet_transfers holds 0
 * rows, ever. The one-line guard admission is migration 20260919223115 on branch
 * agent/cw-diamond-gate/fix/the-health-watch-resolves-what-it-filed, which is not applied,
 * so that fact is documented here rather than pinned: a test may not assert a file that is
 * not on main. See docs/runbooks/diamond-launch-owner-steps-2026-09-20.md step A2.
 *
 * Every pin in the gift section is a defect that was live on 2026-09-08:
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
const door = pick('_atomic_wallet_diamond_transfers.sql');
const custody = pick('_poker_diamond_custody.sql');
// The migration's own assertion block names the strings it forbids, so absence pins read the
// part that DEFINES the functions, not the part that checks them.
const defs = tr.slice(0, tr.indexOf('-- 5. Assertions.'));

describe('a transfer goes through one platform door (ruling 4 as amended 2026-09-08)', () => {
  it('the door is defined, security definer, and pins its search path', () => {
    expect(door).toContain('CREATE OR REPLACE FUNCTION public.send_wallet_diamond_transfer(');
    expect(door).toContain('SECURITY DEFINER');
    expect(door).toContain('SET search_path = public, pg_temp');
  });

  it('the door is granted to authenticated and to nobody else', () => {
    expect(door).toContain(
      'REVOKE ALL ON FUNCTION public.send_wallet_diamond_transfer(uuid,integer,text,text)'
    );
    expect(door).toContain('FROM PUBLIC,anon,authenticated,service_role;');
    expect(door).toContain(
      'GRANT EXECUTE ON FUNCTION public.send_wallet_diamond_transfer(uuid,integer,text,text) TO authenticated;'
    );
  });

  it('every transfer writes its own append-only row naming both sides and both journal legs', () => {
    expect(door).toContain('CREATE TABLE public.diamond_wallet_transfers (');
    expect(door).toContain(
      'INSERT INTO public.diamond_wallet_transfers(id,sender_id,recipient_id,request_id,amount,message,'
    );
    expect(door).toContain('sender_journal_id,recipient_journal_id)');
    expect(door).toContain('CREATE TRIGGER wallet_transfers_append_only BEFORE UPDATE OR DELETE');
  });

  it('only the two participants can read a transfer row', () => {
    expect(door).toContain(
      'ALTER TABLE public.diamond_wallet_transfers ENABLE ROW LEVEL SECURITY;'
    );
    expect(door).toContain(
      'CREATE POLICY wallet_transfer_participants ON public.diamond_wallet_transfers'
    );
    expect(door).toContain('USING ((SELECT auth.uid()) IN (sender_id, recipient_id));');
  });
});

describe('the retired doors stay retired', () => {
  it('the legacy unjournaled transfer pair is dropped', () => {
    expect(tr).toContain('DROP FUNCTION IF EXISTS public.transfer_diamonds_deduct(uuid, integer);');
    expect(tr).toContain('DROP FUNCTION IF EXISTS public.transfer_diamonds_credit(uuid, integer);');
  });

  it('the manual arena deposit and withdraw pair raises instead of moving money', () => {
    expect(custody).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_arena_deposit(p_amount integer,p_op_id text)'
    );
    expect(custody).toContain(
      "RAISE EXCEPTION 'Manual arena deposits are retired; use game reservation.'"
    );
    expect(custody).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_arena_withdraw(p_amount integer,p_op_id text)'
    );
    expect(custody).toContain(
      "RAISE EXCEPTION 'Manual arena withdrawals are retired; use game release.'"
    );
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
