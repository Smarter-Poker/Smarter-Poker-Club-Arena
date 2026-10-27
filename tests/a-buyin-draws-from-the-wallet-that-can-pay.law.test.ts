/**
 * A BUY-IN DRAWS FROM THE WALLET THAT CAN PAY, AND NO UNFUNDED SEAT IS HELD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-12:
 *   "Club arena - can't buy into tournaments or cash games even with chips in
 *    account."
 *   "A player should not be able to 'hold a seat' if they don't have
 *    sufficient chips. That should be checked before the seat is 'reserved'."
 *
 * Read from rows: at a Midway Union game Dan (kingfish) was charged by his
 * OLDEST member club, Club JAQK, which held 4.50, while SHARK CLUB held about
 * 2,650. The buy-in sheet said 4.50, the Sign Up card read the union's house
 * wallet and said 0, and the join door held him a chair for sixty seconds
 * before anything asked whether he could pay for it.
 *
 * These pin the cause in the migration in force for each function, so a later
 * redefinition that drops a rule fails here rather than at the felt.
 * Behaviour was proved against production in a rolled-back probe before the
 * migration was applied; see
 * docs/changelog/2026-10-12-a-buyin-draws-from-the-wallet-that-can-pay.md.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { functionBody, latestDeclaring } from './helpers/migrations';

const body = (fn: string) => functionBody(latestDeclaring(fn).sql, fn);
const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

// The horse input device may decline a new purchase before choosing a wallet.
// Remove only that bounded, side-effect-free choice, then preserve the entire
// captured economic wrapper and the original prohibition on identity pricing.
function assertHorseFundingRule(fn: string) {
  const choice = fn.match(
    /\n {2}-- A horse's purchase choice,[\s\S]*?RETURN jsonb_build_object\('ok',false,'reason','horse_tournament_reservation_budget'\);\n {2}END IF;\n/
  );
  if (choice) {
    expect(choice[0]).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\b|set_config|fn_ca_entry_paying_club|before_terminal_gate/i
    );
    expect(choice[0].match(/\bis_horse\b/g)).toHaveLength(1);
    expect(fn.indexOf(choice[0])).toBeLessThan(
      fn.indexOf('v_paying := public.fn_ca_entry_paying_club')
    );
  }
  const economic = choice ? fn.replace(choice[0], '') : fn;
  expect(economic).not.toMatch(/is_horse/);
  const captured = functionBody(
    src('tests/sql/fixtures/horse-future-purchase-before.sql'),
    'fn_register_horse_for_tournament'
  );
  expect(economic.replace(/\s+/g, ' ').trim()).toBe(captured.replace(/\s+/g, ' ').trim());
}

describe('cash: the buy-in is charged to a wallet that can pay', () => {
  it('atomic_table_buyin names the paying club to the gate when the default cannot cover it', () => {
    const fn = body('atomic_table_buyin');
    expect(fn).toMatch(
      /v_paying := public\.fn_ca_cash_paying_club\(p_user_id, p_table_id, p_club_id, p_amount\)/
    );
    expect(fn).toMatch(/COALESCE\(v_paying, p_club_id\), p_idempotency_key/);
    // The idempotency receipt still records what the caller asked for.
    expect(fn.indexOf("'club_id', p_club_id")).toBeGreaterThan(-1);
    expect(fn.indexOf("'club_id', p_club_id")).toBeLessThan(fn.indexOf('v_paying :='));
  });

  it('the paying club keeps one club at a time and only steps in when the default is short', () => {
    const fn = body('fn_ca_cash_paying_club');
    const seated = fn.indexOf('FROM public.table_seats ts');
    const defaultCovers = fn.indexOf('IF COALESCE(v_balance, 0) >= p_amount THEN');
    const fallback = fn.indexOf('fn_ca_union_wallet_that_can_pay');
    expect(seated).toBeGreaterThan(-1);
    expect(defaultCovers).toBeGreaterThan(seated);
    expect(fallback).toBeGreaterThan(defaultCovers);
    // Diamond and tournament tables are never steered.
    expect(fn).toMatch(/t\.tournament_id IS NULL/);
    expect(fn).toMatch(/c\.asset IS DISTINCT FROM 'diamonds'/);
  });

  it('the paying club is only ever a union MEMBER club, which the gate honours', () => {
    const fn = body('fn_ca_union_wallet_that_can_pay');
    expect(fn).toMatch(/FROM public\.union_clubs uc/);
    expect(fn).toMatch(/COALESCE\(m\.chip_balance, 0\) >= p_amount/);
    expect(fn).toMatch(/ORDER BY m\.chip_balance DESC, m\.joined_at ASC NULLS LAST, m\.club_id/);
  });

  it('the buy-in sheet reads the wallet the buy-in will spend', () => {
    const fn = body('fn_player_spendable_balance');
    expect(fn).toMatch(/fn_ca_cash_paying_club\(\s*p_user_id, p_table_id, p_club_id,/);
    expect(fn).toMatch(/fn_ca_cash_entry_need\(p_user_id, p_table_id\)/);
  });
});

describe('tournaments: the entry is charged to a wallet that can pay', () => {
  it('both registration doors declare the paying club for this transaction and clear it', () => {
    for (const door of ['fn_register_for_tournament', 'fn_register_horse_for_tournament']) {
      const fn = body(door);
      expect(fn, door).toMatch(/fn_ca_entry_paying_club\(/);
      expect(fn, door).toMatch(/set_config\('app\.ca_entry_paying_club',\s*p_tournament_id::text/);
      expect(fn, door).toMatch(/set_config\('app\.ca_entry_paying_club', '', true\)/);
    }
  });

  it('a horse is charged by the identical rule (CLAUDE.md 10.5)', () => {
    const person = body('fn_register_for_tournament');
    const horse = body('fn_register_horse_for_tournament');
    expect(person).not.toMatch(/is_horse/);
    assertHorseFundingRule(horse);
    for (const helper of [
      'fn_ca_entry_paying_club',
      'fn_ca_union_wallet_that_can_pay',
      'fn_ca_cash_paying_club',
      'fn_ca_cash_wallet_covers',
      'fn_ca_cash_entry_need',
    ]) {
      expect(body(helper), helper).not.toMatch(/is_horse/);
    }
  });

  it('the input-choice allowance cannot hide an identity branch in wallet funding', () => {
    const horse = body('fn_register_horse_for_tournament');
    expect(() =>
      assertHorseFundingRule(
        horse.replace('v_paying :=', 'IF is_horse THEN RETURN NULL; END IF; v_paying :=')
      )
    ).toThrow();
    expect(() =>
      assertHorseFundingRule(
        horse.replace('RETURN v_result;', 'IF is_horse THEN RETURN NULL; END IF; RETURN v_result;')
      )
    ).toThrow();
  });

  it('the resolver honours the declaration only for that tournament AND that player', () => {
    const fn = body('fn_tournament_club_for_user');
    expect(fn).toMatch(/split_part\(v_paying, ':', 1\) = p_tournament_id::text/);
    expect(fn).toMatch(/split_part\(v_paying, ':', 2\) = p_user_id::text/);
    // and never overrides a club the caller named
    expect(fn.indexOf('IF p_preferred_club IS NULL THEN')).toBeLessThan(
      fn.indexOf("current_setting('app.ca_entry_paying_club'")
    );
  });

  it("an entry's later money resolves to the club stamped on the entry", () => {
    const fn = body('fn_tournament_club_for_user');
    const stamped = fn.indexOf('FROM tournament_players tp');
    const oldest = fn.lastIndexOf('ORDER BY m.joined_at ASC NULLS LAST, m.club_id');
    expect(stamped).toBeGreaterThan(-1);
    expect(stamped).toBeLessThan(oldest);
  });

  it('the Sign Up card reads the wallet the entry will spend', () => {
    expect(body('fn_player_spendable_balance')).toMatch(
      /COALESCE\(\s*public\.fn_ca_entry_paying_club\(p_user_id, p_tournament_id\),/
    );
    expect(src('src/services/WalletService.ts')).toMatch(
      /p_tournament_id: opts\?\.tournamentId \?\? null/
    );
    expect(src('src/components/tournament/signUpDialog.tsx')).toMatch(
      /tournamentId \? \{ clubId, tournamentId \} : \{ clubId \}/
    );
    expect(src('src/hooks/useTournamentRegistration.ts')).toMatch(/tournamentId: t\.id,/);
  });
});

describe('no chair is held for a player who cannot pay for it', () => {
  it('the join door refuses before it writes a hold or a place in line', () => {
    const fn = body('fn_cash_game_join');
    const refuse = fn.indexOf("RAISE EXCEPTION 'INSUFFICIENT_CHIPS:%'");
    expect(refuse).toBeGreaterThan(-1);
    expect(fn).toMatch(/fn_ca_cash_wallet_covers\(v_uid, v_probe_table, NULL, v_need\)/);
    for (const write of [
      'UPDATE public.table_waitlist',
      'INSERT INTO public.table_waitlist',
      'INSERT INTO public.cash_game_waitlist',
    ]) {
      expect(fn.indexOf(write), write).toBeGreaterThan(refuse);
    }
  });

  it('a waitlist offer passes over a player who cannot pay and keeps their place', () => {
    const fn = body('fn_offer_open_seat');
    const skip = fn.indexOf('CONTINUE WHEN NOT public.fn_ca_cash_wallet_covers(');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(fn.indexOf('v_selected := true;'));
  });

  it('the lobby says how many chips the game needs', async () => {
    const { joinGameRefusalText } = await import('../src/services/cashGameLobby');
    expect(joinGameRefusalText(new Error('INSUFFICIENT_CHIPS:200.00'))).toBe(
      'Not Enough Chips. You Need At Least 200 Chips To Join This Game.'
    );
    expect(joinGameRefusalText(new Error('INSUFFICIENT_CHIPS:46.07'))).toBe(
      'Not Enough Chips. You Need At Least 46.07 Chips To Join This Game.'
    );
    expect(joinGameRefusalText(new Error('INSUFFICIENT_CHIPS'))).toBe(
      'Not Enough Chips To Join This Game.'
    );
  });
});

describe('the helpers are internal', () => {
  it('no browser role may call them', () => {
    const { sql } = latestDeclaring('fn_ca_cash_paying_club');
    for (const sig of [
      'fn_ca_union_wallet_that_can_pay(uuid, uuid, numeric)',
      'fn_ca_cash_paying_club(uuid, uuid, uuid, numeric)',
      'fn_ca_cash_entry_need(uuid, uuid)',
      'fn_ca_cash_wallet_covers(uuid, uuid, uuid, numeric)',
      'fn_ca_entry_paying_club(uuid, uuid)',
    ]) {
      expect(sql, sig).toContain(
        `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`
      );
    }
  });
});
