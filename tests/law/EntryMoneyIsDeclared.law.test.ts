/**
 * LAW: ENTRY MONEY IS DECLARED (Chip Accounting Roadmap 1.2 + 1.3, standard R9)
 * ============================================================================
 * `docs/CHIP-ACCOUNTING-STANDARD.md` 3.3 R9: settlement_suspense must be zero;
 * an undeclared money movement is a bug in the caller, not a category. Every
 * chip_ledger row is written by the auto-ledger triggers from the GUCs
 * `app.ledger_category` / `app.ledger_counterparty` / `app.ledger_counterparty_entity`.
 * A writer that names no counterparty lands on a phantom (`settlement_suspense`
 * on the store tables, `table_stack` on the player wallet).
 *
 * Three migrations close that for tournament entry and prize money:
 *   20260902220500_the_undeclared_legs_name_their_counterparty  (entry legs, spin
 *     prize draw, BBJ promo sweeps)
 *   20260902221500_the_horse_door_declares_the_same_way          (horse entry door)
 *   20260902224000_every_entry_and_prize_leg_names_its_counterparty (the payout
 *     side: fn_credit_and_log, the one credit funnel every tournament prize,
 *     bounty and refund passes through)
 *
 * This law pins, across all three:
 *   1. EVERY function body they define names `app.ledger_category` (directly or
 *      through fn_ca_declare_ledger) AND a counterparty. No half declaration.
 *   2. The payout funnel declares `prize_liability` with the tournament as the
 *      entity, only for tournament categories, with set_config (never the raising
 *      primitive: a payout must never be refused by a ledger word), and restores
 *      the caller's settings after the credit.
 *   3. Declaration only: the payout migration keeps exactly one RAISE EXCEPTION
 *      in the funnel (the key guard it always had), and none of the three
 *      migrations redefines fn_settle_tournament_obligation (Phase 1.1's) or
 *      atomic_deduct_wallet_and_log (shared plumbing).
 *
 * Every pin carries a negative control so a regex that matches nothing cannot
 * pass by accident. Sibling law: tests/law/MoneyLegsDeclareTheirCounterparty.law.test.ts
 * pins the per-function shape of the first two migrations.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const FILES = [
  'supabase/migrations/20260902220500_the_undeclared_legs_name_their_counterparty.sql',
  'supabase/migrations/20260902221500_the_horse_door_declares_the_same_way.sql',
  'supabase/migrations/20260902224000_every_entry_and_prize_leg_names_its_counterparty.sql',
];
const PAYOUT = FILES[2];

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');

/** Every CREATE OR REPLACE FUNCTION ... $function$ body in a migration, by name. */
function functionBodies(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const open = source.indexOf('AS $function$', m.index);
    const close = source.indexOf('$function$', open + 'AS $function$'.length);
    expect(open, `${m[1]} body opens with $function$`).toBeGreaterThan(m.index);
    expect(close, `${m[1]} body closes with $function$`).toBeGreaterThan(open);
    out.set(m[1], source.slice(open + 'AS $function$'.length, close));
  }
  return out;
}

const NAMES_CATEGORY = /app\.ledger_category|fn_ca_declare_ledger\(/;
const NAMES_COUNTERPARTY = /app\.ledger_counterparty|fn_ca_declare_ledger\(/;
const DECLARES_PRIZE_LIABILITY =
  /set_config\('app\.ledger_counterparty', 'prize_liability', true\)/;
const DECLARES_ENTITY =
  /set_config\('app\.ledger_counterparty_entity', p_related_entity_id::text, true\)/;
const TOURNAMENT_ONLY =
  /v_ledger_cat IN \('tournament_prize', 'bounty', 'refund', 'tournament_refund'\)/;
const RESTORES_CP = /set_config\('app\.ledger_counterparty', COALESCE\(v_prev_cp, ''\), true\)/;
const RESTORES_ENTITY =
  /set_config\('app\.ledger_counterparty_entity', COALESCE\(v_prev_cp_entity, ''\), true\)/;
const USES_PRIMITIVE = /fn_ca_declare_ledger\(/;
const RAISES = /RAISE\s+EXCEPTION/g;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// A counterfeit funnel: credits, names a category, names NO counterparty, and
// refuses. Every pin below must FAIL against it or the pin is looking at nothing.
const COUNTERFEIT = `
  PERFORM set_config('app.ledger_category', v_ledger_cat, true);
  v_credited := public.fn_credit_player_wallet_once(p_user_id, p_amount, p_idempotency_key);
  IF NOT v_credited THEN
    RAISE EXCEPTION 'not credited';
  END IF;
  RAISE EXCEPTION 'refused by a ledger word';
`;

describe('every function the declaration migrations define names a category AND a counterparty', () => {
  for (const file of FILES) {
    it(`${path.basename(file)}: no half declaration`, () => {
      const bodies = functionBodies(read(file));
      expect(bodies.size, `${file} defines at least one function`).toBeGreaterThan(0);
      for (const [name, body] of bodies) {
        expect(body, `${name} names app.ledger_category`).toMatch(NAMES_CATEGORY);
        expect(body, `${name} names a counterparty`).toMatch(NAMES_COUNTERPARTY);
      }
    });
  }

  it('negative control: a body that names only a category fails the counterparty pin', () => {
    expect(COUNTERFEIT).toMatch(NAMES_CATEGORY);
    expect(COUNTERFEIT).not.toMatch(NAMES_COUNTERPARTY);
  });
});

describe('the payout funnel (fn_credit_and_log) names prize_liability with the tournament as entity', () => {
  const bodies = functionBodies(read(PAYOUT));
  const funnel = bodies.get('fn_credit_and_log') ?? '';

  it('is the only function the payout migration defines', () => {
    expect([...bodies.keys()]).toEqual(['fn_credit_and_log']);
  });

  it('declares prize_liability + entity, for tournament categories only', () => {
    expect(funnel).toMatch(DECLARES_PRIZE_LIABILITY);
    expect(funnel).toMatch(DECLARES_ENTITY);
    expect(funnel).toMatch(TOURNAMENT_ONLY);
    expect(COUNTERFEIT).not.toMatch(DECLARES_PRIZE_LIABILITY);
    expect(COUNTERFEIT).not.toMatch(DECLARES_ENTITY);
    expect(COUNTERFEIT).not.toMatch(TOURNAMENT_ONLY);
  });

  it("restores the caller's counterparty and entity after the credit", () => {
    expect(funnel).toMatch(RESTORES_CP);
    expect(funnel).toMatch(RESTORES_ENTITY);
    const declared = funnel.search(DECLARES_PRIZE_LIABILITY);
    const credited = funnel.indexOf('fn_credit_player_wallet_once(');
    const restored = funnel.search(RESTORES_CP);
    expect(declared).toBeLessThan(credited);
    expect(credited).toBeLessThan(restored);
    expect(COUNTERFEIT).not.toMatch(RESTORES_CP);
  });

  it('uses set_config, never the raising primitive (a payout is never refused by a ledger word)', () => {
    expect(funnel).not.toMatch(USES_PRIMITIVE);
    // Negative control: the pattern does see the primitive where it IS used.
    const spin = functionBodies(read(FILES[0])).get('fn_spin_settle_game') ?? '';
    expect(spin).toMatch(USES_PRIMITIVE);
  });
});

describe('declaration only', () => {
  it('the funnel keeps exactly the one RAISE EXCEPTION it always had (the key guard)', () => {
    const funnel = functionBodies(read(PAYOUT)).get('fn_credit_and_log') ?? '';
    expect(count(funnel, RAISES)).toBe(1);
    expect(funnel).toMatch(/RAISE EXCEPTION 'fn_credit_and_log requires an idempotency key'/);
    expect(count(COUNTERFEIT, RAISES)).toBe(2);
  });

  it('none of the three migrations redefines the settle function or the shared debit primitive', () => {
    for (const file of FILES) {
      const src = read(file);
      expect(src).not.toMatch(
        /CREATE OR REPLACE FUNCTION public\.fn_settle_tournament_obligation\(/
      );
      expect(src).not.toMatch(/CREATE OR REPLACE FUNCTION public\.atomic_deduct_wallet_and_log\(/);
      expect(src).not.toMatch(/ALTER TABLE public\.chip_ledger/);
    }
    // Negative control: the pattern does see a definition when there is one.
    expect(read(PAYOUT)).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_credit_and_log\(/);
  });

  it('each migration is one transaction', () => {
    for (const file of FILES) {
      const src = read(file);
      expect(count(src, /^BEGIN;/gm)).toBe(1);
      expect(count(src, /^COMMIT;/gm)).toBe(1);
    }
  });
});
