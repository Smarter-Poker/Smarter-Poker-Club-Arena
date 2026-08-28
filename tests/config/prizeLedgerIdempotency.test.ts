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

    it(`${path} pays through fn_credit_and_log, not credit_player_wallet`, () => {
      expect(code).not.toMatch(/rpc\(\s*'credit_player_wallet'/);
    });
  }

  it('every fn_credit_and_log call supplies a key, a category and a description', () => {
    for (const path of PAYOUT_SOURCES) {
      const code = tsCode(read(path));
      // Each call site, from the opening brace to its closing `});`.
      const calls = code.match(/rpc\(\s*'fn_credit_and_log',\s*\{[\s\S]*?\n\s*\}\);/g) ?? [];
      expect(calls.length, `${path} should pay through fn_credit_and_log`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `${path}: missing p_idempotency_key`).toMatch(/p_idempotency_key:/);
        expect(call, `${path}: missing p_category`).toMatch(/p_category:/);
        expect(call, `${path}: missing p_description`).toMatch(/p_description:/);
      }
    }
  });

  it('the recovery watchdog still shares the finish path key format', () => {
    // If these two ever diverge the credit stops deduping and the double
    // PAYMENT of 2026-07-28 comes back — which is worse than the double entry.
    //
    // UPDATED 2026-08-28: the shared format is now PLACE-scoped,
    // `tourney:{id}:prize:place:{position}`. It used to carry the user, which
    // meant it deduped a repeated USER and not a repeated PLACE — so two
    // different players stamped with the same place produced two different keys
    // and both were paid. That is not hypothetical: Union PKO Afternoon (PLO4)
    // 4f42d847 credited "Tournament prize: position 2" twice, an hour apart, to
    // two players, and disbursed 720.00 against a 600.00 pool. Neither payment
    // was mispriced — a late arrival shifted the field, the first player was
    // renumbered 2nd -> 3rd, and the new 2nd place was paid place 2 again.
    // This assertion pins the fix: no prize key may name a player.
    const recovery = tsCode(read('server/src/tournament/tournamentRecovery.ts'));
    const eliminations = tsCode(read('server/src/tournament/TournamentManagerEliminations.ts'));
    expect(recovery).toMatch(/`tourney:\$\{t\.id\}:prize:place:\$\{[^}]+\}`/);
    expect(eliminations).toMatch(/`tourney:\$\{this\.tournamentId\}:prize:place:\$\{position\}`/);
    expect(eliminations).toMatch(/`tourney:\$\{this\.tournamentId\}:prize:place:1`/);

    // And neither path may reintroduce a user-scoped key.
    for (const [name, src] of [
      ['recovery', recovery],
      ['eliminations', eliminations],
    ] as const) {
      for (const key of src.match(/`tourney:[^`]*:prize:[^`]*`/g) ?? []) {
        if (!key.includes('${')) continue; // prose in comments, not a real key
        expect(key, `${name}: user-scoped prize key`).toContain(':prize:place:');
      }
    }
  });
});

describe('prize ledger idempotency — the database side', () => {
  const migration = sqlCode(read(MIGRATION));

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
    const start = migration.indexOf('FUNCTION public.fn_credit_and_log(');
    expect(start).toBeGreaterThan(-1);
    const body = migration.slice(start);
    const guard = body.indexOf('IF NOT v_credited THEN');
    const log = body.indexOf('PERFORM public.log_wallet_transaction');
    expect(guard, 'fn_credit_and_log must check whether it credited').toBeGreaterThan(-1);
    expect(log, 'fn_credit_and_log must write the ledger row').toBeGreaterThan(-1);
    // The early return has to come FIRST, or the guard is decoration.
    expect(guard).toBeLessThan(log);
  });

  it('fn_credit_and_log refuses to run without an idempotency key', () => {
    expect(migration).toMatch(/fn_credit_and_log requires an idempotency key/);
  });

  it('neither new function is reachable by a player role', () => {
    for (const fn of ['fn_credit_player_wallet_once', 'fn_credit_and_log']) {
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM anon`)
      );
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM authenticated`)
      );
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`)
      );
    }
  });
});
