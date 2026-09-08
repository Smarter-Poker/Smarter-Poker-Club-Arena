/**
 * LAW - diamonds enter and leave the Diamond Arena through two doors, both journaled and both
 * registered, and the arena is built log-only before a single table opens
 * (docs/DIAMOND-RULINGS.md rulings 14 and 16; CLAUDE.md 10.12;
 * docs/changelog/2026-09-08-diamond-arena-foundation.md).
 *
 * What this pins, and why each pin exists:
 *  - a club says which asset it is denominated in, and exactly one club can be the platform's;
 *  - the deposit and the withdrawal are mirrors: balance, journal row (class 'arena'), club
 *    wallet - and the register follows the journal, so a deposit is a burn and a withdrawal is
 *    a mint. Diamonds inside the arena are therefore always countable;
 *  - neither door calls the Mint. fn_ca_mint and fn_ca_burn are admin-only; a player's own
 *    action must never be the Mint's caller, and giving these doors a way around that check
 *    would put a hole in the door the whole standard rests on;
 *  - neither door compensates. A failure raises inside the one transaction, which undoes the
 *    other leg (CLAUDE.md 10.12);
 *  - the cross-asset seat guard and the 14-day settlement window are LOG-ONLY, because a guard
 *    that can refuse a seat can strand a player mid-hand and there is no arena traffic yet.
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
const ar = pick('_the_diamond_arena_accounting_foundation.sql');
const between = (from: string, to: string) => ar.slice(ar.indexOf(from), ar.indexOf(to));
const deposit = between(
  'FUNCTION public.fn_arena_deposit(',
  'REVOKE ALL ON FUNCTION public.fn_arena_deposit'
);
const withdraw = between(
  'FUNCTION public.fn_arena_withdraw(',
  'REVOKE ALL ON FUNCTION public.fn_arena_withdraw'
);

describe('a club says what it is denominated in', () => {
  it('adds asset and is_platform, and only one club may be the platform', () => {
    expect(ar).toContain("ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'chips'");
    expect(ar).toContain('ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false');
    expect(ar).toContain("CHECK (asset IN ('chips', 'diamonds'))");
    expect(ar).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_one_platform');
  });
  it('creates no club and moves no diamond', () => {
    expect(ar).toContain('the arena club is set, but this migration creates no club');
    expect(ar).toContain(
      'the register and the players disagree after a change that moves no money'
    );
  });
});

describe('both doors journal, and the register follows', () => {
  it('the deposit debits the wallet, journals class arena, and credits the club wallet', () => {
    expect(deposit).toContain('SET diamonds = diamonds - p_amount');
    expect(deposit).toContain("'arena_deposit', 'arena_deposit'");
    expect(deposit).toContain("'arena',");
    expect(deposit).toContain('UPDATE public.club_members');
  });
  it('the withdrawal is the mirror', () => {
    expect(withdraw).toContain('SET chip_balance = chip_balance - p_amount');
    expect(withdraw).toContain('SET diamonds = diamonds + p_amount');
    expect(withdraw).toContain("'arena_withdraw', 'arena_withdraw'");
  });
  it('neither door calls the Mint, which is admin-only', () => {
    expect(deposit).not.toContain('fn_ca_mint(');
    expect(deposit).not.toContain('fn_ca_burn(');
    expect(withdraw).not.toContain('fn_ca_mint(');
    expect(withdraw).not.toContain('fn_ca_burn(');
    expect(ar).toContain('THEY DO NOT CALL THE MINT, AND THAT IS DELIBERATE');
  });
  it('both doors are idempotent on their op id', () => {
    expect(deposit).toContain("'arena-deposit:' || p_op_id");
    expect(withdraw).toContain("'arena-withdraw:' || p_op_id");
    expect(
      (
        ar.match(
          /EXISTS \(SELECT 1 FROM public\.diamond_transactions WHERE reference_id = v_ref\)/g
        ) ?? []
      ).length
    ).toBe(2);
  });
  it('neither door compensates: a failure raises inside the transaction', () => {
    expect(withdraw).toContain("USING ERRCODE = 'P0431'");
    expect(deposit).toContain("USING ERRCODE = 'P0432'");
    for (const body of [deposit, withdraw]) {
      // The pin is on the CODE, not the prose: "refunded" is a purchase-lot column and the
      // withdrawal's comment says in words that there is nothing to compensate. What is
      // forbidden is calling a refund path or undoing a leg by hand after it committed.
      const code = body
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      expect(code).not.toMatch(/compensat/i);
      expect(code).not.toMatch(/refund\s*\(|refundSender|_refund'/i);
    }
  });
  it('a membership is a join, never a side effect of funding', () => {
    expect(deposit).not.toContain('INSERT INTO public.club_members');
    expect(deposit).toContain('ARENA_JOIN_REQUIRED');
  });
  it('the withdrawal reads the arena freeze scope', () => {
    expect(withdraw).toContain("f.scope = 'arena_withdrawals'");
  });
});

describe('the arena is measurable, and its rules start log-only', () => {
  it('the diamonds inside the arena can be counted', () => {
    expect(ar).toContain('FUNCTION public.fn_ca_arena_diamonds()');
    expect(ar).toContain('the arena holds diamonds before it exists');
  });
  it('the seat guard and the settlement window are log-only and flip like every other rule', () => {
    expect(ar).toContain("('DR15:cross_asset_seat', 'log'");
    expect(ar).toContain("('DR16:deposit_inside_settlement_window', 'log'");
    expect(ar).toContain('the seat guard is not log-only');
    expect(ar).toContain('the settlement window is not log-only');
    // negative control: a refusal shipped on day one is what this forbids
    expect(ar).not.toContain("('DR15:cross_asset_seat', 'refuse'");
  });
  it('the seat guard can never refuse a seat', () => {
    const guard = between(
      'FUNCTION public.fn_ca_arena_seat_is_same_asset()',
      'REVOKE ALL ON FUNCTION public.fn_ca_arena_seat_is_same_asset'
    );
    expect(guard).toContain('a seat is never refused by a reporting guard');
    expect(guard).not.toContain('RAISE EXCEPTION');
  });
});
