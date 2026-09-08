/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PRIZE LEDGER IDEMPOTENCY — the credit deduped, the ledger did not
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every prize path in the engine used to be written as two calls:
 *
 *     credit_player_wallet(user, amount, key)   idempotent
 *     log_wallet_transaction(... 'prize' ...)   not idempotent, always ran
 *
 * The 2026-07-28 "A3 FIX" deliberately gave the stuck-COMPLETING watchdog and
 * the normal finish path the IDENTICAL idempotency key so they would dedupe
 * against each other. They do — for the credit. `credit_player_wallet` returns
 * void, so the loser of that race could not tell it had credited nothing, and
 * wrote a ledger row regardless.
 *
 * So the fix did not remove the double payment; it turned a double PAYMENT
 * into a double ENTRY. Measured on 2026-08-22 across the preceding two days of
 * completed tournaments: 95 phantom prize rows, 7,446.45 chips of prize money
 * present in `wallet_transactions` and never paid to anybody. Every one of
 * them the pair ("Tournament winner prize: 1st place", "Tournament prize
 * (recovery): position 1 — <name>"), 0.06s to 0.7s apart, always place 1.
 * Balances were correct throughout; the ledger was not, and the ledger is what
 * profit, rakeback and the leaderboards are computed from.
 *
 * `fn_credit_and_log` performs both halves under the one key, so a second
 * caller — or a retry of the same caller after a committed-but-timed-out
 * attempt — writes neither. These tests pin that no prize, bounty or refund
 * path drifts back to the two-call shape.
 *
 * 2026-09-08: the live finish and recovery call one terminal database door.
 * That transaction derives and settles cash, bounty, rake, escrow, standings,
 * and COMPLETED together. Runtime code cannot call the generic obligation
 * payer or manufacture an idempotency key.
 *
 * Source-level, like spinEngineWiring: exercising the real thing needs a live
 * Postgres, three seated players and a race.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const tsCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260822190000_credit_player_wallet_once.sql';
const ATOMIC_CASH_MIGRATION =
  'supabase/migrations/20260908012648_tournament_cash_settlement_has_one_atomic_authority.sql';

/** Every engine file that pays a player for a tournament outcome. */
const PAYOUT_SOURCES = [
  'server/src/tournament/TournamentManagerEliminations.ts',
  'server/src/tournament/TournamentManager.ts',
  'server/src/tournament/tournamentRecovery.ts',
] as const;

describe('prize ledger idempotency — the engine side', () => {
  for (const path of PAYOUT_SOURCES) {
    const code = tsCode(read(path));

    it(`${path} never writes a wallet transaction as a separate call`, () => {
      // The ledger row must be produced by the same key that produced the
      // credit. A bare log_wallet_transaction next to a credit is the exact
      // shape that produced the phantom rows.
      expect(code).not.toMatch(/rpc\(\s*'log_wallet_transaction'/);
    });

    it(`${path} never calls a generic credit primitive`, () => {
      // The three primitives are banned from the engine (server-side law:
      // server/src/tournament/OneSettlePathForTournamentMoney.law.test.ts).
      expect(code).not.toMatch(/rpc\(\s*'credit_player_wallet'/);
      expect(code).not.toMatch(/rpc\(\s*'fn_credit_and_log'/);
      expect(code).not.toMatch(/rpc\(\s*'fn_credit_player_wallet_once'/);
    });
  }

  it('runtime tournament code has no generic per-obligation payment helper', () => {
    let totalCalls = 0;
    for (const path of PAYOUT_SOURCES) {
      const code = tsCode(read(path));
      // Each call site, from the opening brace of its input to the closing `}`.
      const calls =
        code.match(/settleTournamentObligation\(\s*supabase\s*,\s*\{[\s\S]*?\n\s*\}/g) ?? [];
      totalCalls += calls.length;
      expect(calls, `${path}: generic per-obligation payment call`).toEqual([]);
    }
    expect(totalCalls).toBe(0);
  });

  it('live finish and recovery delegate the whole ladder to the same atomic database payer', () => {
    const recovery = tsCode(read('server/src/tournament/tournamentRecovery.ts'));
    const cashRecovery = recovery.slice(
      recovery.indexOf('export async function recoverStuckCompletingTournaments')
    );
    const eliminations = tsCode(read('server/src/tournament/TournamentManagerEliminations.ts'));
    const terminalRpc = tsCode(read('server/src/tournament/terminalSettlementRpc.ts'));
    expect(cashRecovery).toMatch(/fn_complete_tournament_terminal/);
    expect(cashRecovery).toMatch(/p_observed_winner_id:\s*winnerId/);
    expect(cashRecovery).not.toMatch(/settleTournamentObligation\(/);
    expect(eliminations).toMatch(/requestTournamentTerminalReceipt\(/);
    expect(terminalRpc).toMatch(/fn_complete_tournament_terminal/);
    expect(terminalRpc).toMatch(/p_observed_winner_id:\s*observedWinnerId/);
    const finish = eliminations.slice(eliminations.indexOf('protected async finishTournament'));
    expect(finish).not.toMatch(/kind:\s*'place'/);

    for (const [name, src] of [
      ['recovery', cashRecovery],
      ['eliminations', eliminations],
      ['manager', tsCode(read('server/src/tournament/TournamentManager.ts'))],
    ] as const) {
      const built = (src.match(/`tourney:[^`]*`/g) ?? []).filter((k) => k.includes('${'));
      expect(built, `${name}: builds its own idempotency key`).toEqual([]);
    }
  });
});

describe('prize ledger idempotency — the database side', () => {
  const migration = sqlCode(read(MIGRATION));
  const atomicCashMigration = sqlCode(read(ATOMIC_CASH_MIGRATION));

  it('fn_credit_player_wallet_once returns boolean, not void', () => {
    expect(migration).toMatch(
      /FUNCTION public\.fn_credit_player_wallet_once\([\s\S]*?\)\s*RETURNS boolean/
    );
  });

  it('it reports false — not void — when the key was already used', () => {
    expect(migration).toMatch(/IF v_inserted = 0 THEN RETURN false; END IF;/);
  });

  it('credit_player_wallet keeps its name, arity and void return', () => {
    // Existing callers that only credit must not have to change, and an
    // accidental signature change would take every credit on the platform
    // down with it.
    expect(migration).toMatch(
      /FUNCTION public\.credit_player_wallet\(\s*p_user_id uuid,\s*p_amount numeric,\s*p_idempotency_key text DEFAULT NULL::text\s*\)\s*RETURNS void/
    );
    expect(migration).toMatch(
      /PERFORM public\.fn_credit_player_wallet_once\(p_user_id, p_amount, p_idempotency_key\)/
    );
  });

  it('fn_credit_and_log logs ONLY when it was the one that credited', () => {
    const start = atomicCashMigration.indexOf('FUNCTION public.fn_credit_and_log(');
    expect(start).toBeGreaterThan(-1);
    const body = atomicCashMigration.slice(start);
    const guard = body.indexOf('IF NOT v_credited THEN');
    const log = body.indexOf('PERFORM public.log_wallet_transaction');
    expect(guard, 'fn_credit_and_log must check whether it credited').toBeGreaterThan(-1);
    expect(log, 'fn_credit_and_log must write the ledger row').toBeGreaterThan(-1);
    // The early return has to come FIRST, or the guard is decoration.
    expect(guard).toBeLessThan(log);
  });

  it('an exact concurrent replay re-reads the key after losing the insert race', () => {
    const start = atomicCashMigration.indexOf('FUNCTION public.fn_credit_and_log(');
    const end = atomicCashMigration.indexOf(
      'REVOKE ALL ON FUNCTION public.fn_credit_and_log',
      start
    );
    const body = atomicCashMigration.slice(start, end);
    const falseCredit = body.indexOf('IF NOT v_credited THEN');
    const postRaceRead = body.indexOf('FROM public.wallet_credit_idempotency k', falseCredit);
    const missingKeyRefusal = body.indexOf('IF NOT FOUND THEN', postRaceRead);
    const mismatchedKeyRefusal = body.indexOf(
      'v_existing_key.user_id IS DISTINCT FROM p_user_id',
      postRaceRead
    );

    expect(falseCredit).toBeGreaterThan(-1);
    expect(postRaceRead).toBeGreaterThan(falseCredit);
    expect(missingKeyRefusal).toBeGreaterThan(postRaceRead);
    expect(mismatchedKeyRefusal).toBeGreaterThan(missingKeyRefusal);
    expect(body.slice(postRaceRead, missingKeyRefusal)).toMatch(/FOR SHARE/);
    expect(body.indexOf('RETURN false;', mismatchedKeyRefusal)).toBeGreaterThan(
      mismatchedKeyRefusal
    );
  });

  it('fn_credit_and_log refuses to run without an idempotency key', () => {
    expect(atomicCashMigration).toMatch(/fn_credit_and_log requires an idempotency key/);
  });

  it('the raw credit remains server-only and the evidence writer is now owner-only', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_credit_player_wallet_once\([^)]*\) FROM anon/
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_credit_player_wallet_once\([^)]*\) FROM authenticated/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_credit_player_wallet_once\([^)]*\) TO service_role/
    );

    // The atomic cash cutover narrows fn_credit_and_log one step further:
    // service_role receives only fn_settle_tournament_places and cannot call
    // the payout-evidence writer directly.
    expect(atomicCashMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_credit_and_log\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(atomicCashMigration).toMatch(
      /has_function_privilege\('service_role',[\s\S]{0,180}?public\.fn_credit_and_log[\s\S]{0,180}?'EXECUTE'\)/
    );
  });
});
