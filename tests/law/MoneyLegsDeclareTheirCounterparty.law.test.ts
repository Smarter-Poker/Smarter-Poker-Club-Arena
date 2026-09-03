/**
 * LAW: MONEY LEGS DECLARE THEIR COUNTERPARTY (Chip Accounting Roadmap 1.2 + 1.3)
 * ============================================================================
 * `docs/CHIP-ACCOUNTING-STANDARD.md` 3.3 R9: settlement_suspense must be zero;
 * an undeclared money movement is a bug in the caller, not a category. The
 * auto-ledger journals every balance write, and a writer that has not declared
 * `app.ledger_category` / `app.ledger_counterparty` lands as `adjustment` and/or
 * against `settlement_suspense`. On 2026-09-02 the four biggest undeclared legs
 * (suspense net +185,526.56 per 24h) were declared by
 * 20260902220500_the_undeclared_legs_name_their_counterparty and the horse
 * registration door by 20260902221500_the_horse_door_declares_the_same_way.
 *
 * This law pins the shape of those migrations:
 *   1. Registration (both doors) and the rebuy core declare
 *      `tournament_buyin | rebuy | addon` -> `prize_liability` and stamp
 *      `app.ledger_tournament`, with set_config (never fn_ca_declare_ledger, whose
 *      vocabulary check RAISEs: a vocabulary miss must never refuse a buy-in).
 *   2. fn_spin_settle_game declares `spin_prize` -> `prize_liability` against the
 *      spin tournament through the primitive.
 *   3. Both BBJ promo sweeps declare `promo` -> `union_wallet | promo_wallet` and
 *      autoskip the credit side so one move is one row.
 *   4. The lane is DECLARATION ONLY: no function body gained a RAISE EXCEPTION
 *      (the counts are pinned to what the live bodies had before the edit) and no
 *      migration adds a refusal outside its post-apply assertion block.
 *
 * Every pin carries a negative control so a regex that matches nothing cannot
 * pass by accident.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MAIN = 'supabase/migrations/20260902220500_the_undeclared_legs_name_their_counterparty.sql';
const HORSE = 'supabase/migrations/20260902221500_the_horse_door_declares_the_same_way.sql';

const main = fs.readFileSync(path.join(process.cwd(), MAIN), 'utf8');
const horse = fs.readFileSync(path.join(process.cwd(), HORSE), 'utf8');

/** The body of one CREATE OR REPLACE FUNCTION ... $function$ ... $function$ block. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined in the migration`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('AS $function$', start);
  const close = source.indexOf('$function$', open + 'AS $function$'.length);
  expect(open, `${name} body opens with $function$`).toBeGreaterThan(start);
  expect(close, `${name} body closes with $function$`).toBeGreaterThan(open);
  return source.slice(open + 'AS $function$'.length, close);
}

const REGISTER = functionBody(main, 'fn_register_for_tournament');
const REBUY = functionBody(main, 'process_tournament_rebuy_before_one_minute_addon');
const SPIN = functionBody(main, 'fn_spin_settle_game');
const SWEEP = functionBody(main, 'fn_sweep_bbj_promo');
const SWEEP_ALL = functionBody(main, 'fn_sweep_bbj_promo_all');
const HORSE_REGISTER = functionBody(horse, 'fn_register_horse_for_tournament');

// A counterfeit body: declares nothing, and refuses. Every pin below must FAIL
// against it, or the pin is not actually looking at anything.
const COUNTERFEIT = `
  v_ok := public.atomic_deduct_wallet_and_log(v_uid, v_split.charge, 'tournament_buyin', 'x', NULL, NULL, p_tournament_id);
  IF NOT v_ok THEN
    RAISE EXCEPTION 'insufficient balance';
  END IF;
  PERFORM set_config('app.ledger_category', 'spin_prize', true);
`;

const RAISES = /RAISE\s+EXCEPTION/g;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const DECLARES_BUYIN = /set_config\('app\.ledger_category', 'tournament_buyin', true\)/;
const DECLARES_CAT_VAR = /set_config\('app\.ledger_category', v_cat, true\)/;
const DECLARES_PRIZE_LIABILITY =
  /set_config\('app\.ledger_counterparty', 'prize_liability', true\)/;
const DECLARES_ENTITY =
  /set_config\('app\.ledger_counterparty_entity', p_tournament_id::text, true\)/;
const STAMPS_TOURNAMENT = /set_config\('app\.ledger_tournament', p_tournament_id::text, true\)/;
const RESTORES = /set_config\('app\.ledger_category', COALESCE\(v_led_cat, ''\), true\)/;
const USES_PRIMITIVE = /fn_ca_declare_ledger\(/;

describe('registration and rebuy debits declare tournament_buyin -> prize_liability', () => {
  it('the human door declares, stamps the tournament, and restores', () => {
    expect(REGISTER).toMatch(DECLARES_BUYIN);
    expect(REGISTER).toMatch(DECLARES_PRIZE_LIABILITY);
    expect(REGISTER).toMatch(DECLARES_ENTITY);
    expect(REGISTER).toMatch(STAMPS_TOURNAMENT);
    expect(REGISTER).toMatch(RESTORES);
    expect(COUNTERFEIT).not.toMatch(DECLARES_BUYIN);
    expect(COUNTERFEIT).not.toMatch(DECLARES_PRIZE_LIABILITY);
    expect(COUNTERFEIT).not.toMatch(STAMPS_TOURNAMENT);
  });

  it('the horse door declares exactly the same way (R11)', () => {
    expect(HORSE_REGISTER).toMatch(DECLARES_BUYIN);
    expect(HORSE_REGISTER).toMatch(DECLARES_PRIZE_LIABILITY);
    expect(HORSE_REGISTER).toMatch(DECLARES_ENTITY);
    expect(HORSE_REGISTER).toMatch(STAMPS_TOURNAMENT);
    expect(HORSE_REGISTER).toMatch(RESTORES);
  });

  it('the rebuy core declares its own category (rebuy | addon) -> prize_liability', () => {
    expect(REBUY).toMatch(DECLARES_CAT_VAR);
    expect(REBUY).toMatch(DECLARES_PRIZE_LIABILITY);
    expect(REBUY).toMatch(STAMPS_TOURNAMENT);
    expect(REBUY).toMatch(RESTORES);
    expect(COUNTERFEIT).not.toMatch(DECLARES_CAT_VAR);
  });

  it('the player-facing doors never use the raising primitive', () => {
    // fn_ca_declare_ledger RAISEs on a vocabulary miss; a buy-in must never be
    // refused by a ledger word. The player-facing paths use set_config only.
    for (const body of [REGISTER, HORSE_REGISTER, REBUY]) {
      expect(body).not.toMatch(USES_PRIMITIVE);
    }
    // Negative control: the pattern does see the primitive where it IS used.
    expect(SPIN).toMatch(USES_PRIMITIVE);
  });

  it('the declaration wraps the debit, not atomic_deduct_wallet_and_log itself', () => {
    // The shared debit primitive is not redefined by either migration.
    expect(main).not.toMatch(/CREATE OR REPLACE FUNCTION public\.atomic_deduct_wallet_and_log\(/);
    expect(horse).not.toMatch(/CREATE OR REPLACE FUNCTION public\.atomic_deduct_wallet_and_log\(/);
    // ... but both doors still call it.
    expect(REGISTER).toMatch(/public\.atomic_deduct_wallet_and_log\(/);
    expect(HORSE_REGISTER).toMatch(/public\.atomic_deduct_wallet_and_log\(/);
  });
});

describe('the spin prize and the BBJ promo sweep name their counterparty', () => {
  it('fn_spin_settle_game declares spin_prize -> prize_liability against the spin tournament', () => {
    expect(SPIN).toMatch(
      /fn_ca_declare_ledger\('spin_prize', 'prize_liability', p_tournament_id\)/
    );
    // The old one-liner that left the counterparty to suspense is gone.
    expect(SPIN).not.toMatch(/set_config\('app\.ledger_category', 'spin_prize', true\)/);
    expect(COUNTERFEIT).toMatch(/set_config\('app\.ledger_category', 'spin_prize', true\)/);
  });

  it('both sweeps declare promo -> union_wallet | promo_wallet and autoskip the credit side', () => {
    const DECLARES_PROMO =
      /fn_ca_declare_ledger\('promo',\s*CASE WHEN v_union_id IS NOT NULL THEN 'union_wallet' ELSE 'promo_wallet' END,\s*COALESCE\(v_union_id, (p_club_id|r\.club_id)\), NULL, NULL, ARRAY\['union_wallets', 'clubs'\]\)/;
    const CLEARS_SKIP = /set_config\('app\.ledger_autoskip_union_wallets', '', true\)/;
    for (const body of [SWEEP, SWEEP_ALL]) {
      expect(body).toMatch(DECLARES_PROMO);
      expect(body).toMatch(CLEARS_SKIP);
    }
    expect(COUNTERFEIT).not.toMatch(DECLARES_PROMO);
    expect(COUNTERFEIT).not.toMatch(CLEARS_SKIP);
  });
});

describe('declaration only: no refusal was added', () => {
  // The live bodies before the edit had exactly these RAISE EXCEPTION counts.
  const PINNED: Array<[string, string, number]> = [
    ['fn_register_for_tournament', REGISTER, 2],
    ['process_tournament_rebuy_before_one_minute_addon', REBUY, 21],
    ['fn_spin_settle_game', SPIN, 3],
    ['fn_sweep_bbj_promo', SWEEP, 0],
    ['fn_sweep_bbj_promo_all', SWEEP_ALL, 0],
    ['fn_register_horse_for_tournament', HORSE_REGISTER, 0],
  ];

  it.each(PINNED)('%s keeps its pre-edit RAISE EXCEPTION count', (_name, body, n) => {
    expect(count(body, RAISES)).toBe(n);
  });

  it('the negative control does raise', () => {
    expect(count(COUNTERFEIT, RAISES)).toBe(1);
  });

  it('each migration raises only inside its post-apply assertion block', () => {
    for (const text of [main, horse]) {
      const assertAt = text.indexOf('DO $assert$');
      expect(assertAt).toBeGreaterThan(0);
      const bodiesOnly = text.slice(0, assertAt);
      const functionRaises = PINNED.filter(([, body]) => bodiesOnly.includes(body)).reduce(
        (sum, [, body]) => sum + count(body, RAISES),
        0
      );
      // Every RAISE before the assertion block belongs to an unchanged function body.
      expect(count(bodiesOnly, RAISES)).toBe(functionRaises);
    }
  });

  it('neither migration touches money, a CHECK, or a grant', () => {
    for (const text of [main, horse]) {
      expect(text).not.toMatch(/\bALTER TABLE\b/i);
      expect(text).not.toMatch(/\bGRANT\b|\bREVOKE\b/);
      expect(text).not.toMatch(
        /\bUPDATE\s+public\.club_members\s+SET\s+chip_balance\s*=\s*chip_balance\s*\+/i
      );
    }
    expect('ALTER TABLE public.chip_ledger DROP CONSTRAINT x').toMatch(/\bALTER TABLE\b/i);
  });
});
