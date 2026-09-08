/**
 * A REPRICED RESULT IS AN ENTITLEMENT, NOT A SECOND PAYMENT PATH.
 *
 * Late-registration finishers can be priced before the final pool is known.
 * Once entry closes, the engine rewrites those result rows to the final
 * structure. The database then freezes that complete result set and pays every
 * place plus the COMPLETED transition in one transaction.
 *
 * The former guard in this file executed the retired per-player top-up branch
 * and required a `fully_settled` receipt before writing `prize`. That shape is
 * incompatible with the atomic batch: the batch must read the corrected
 * entitlement before it can freeze and settle it. These laws pin the actual
 * safety boundary instead.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', '..', '..', 'supabase', 'migrations');
const atomicMigration = readdirSync(migrations).find((name) =>
  name.includes('tournament_places_settle_and_complete_atomically')
);
if (!atomicMigration) throw new Error('atomic tournament place settlement migration is missing');

// Keep string literals for wiring assertions, but ensure comments cannot make
// a positive or negative source law pass.
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (comment) => ' '.repeat(comment.length));
const sql = (source: string) => source.replace(/^\s*--.*$/gm, '');

const ELIMINATIONS = code(readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8'));
const ATOMIC_SQL = sql(readFileSync(join(migrations, atomicMigration), 'utf8'));
const REPRICE = sliceMethod(
  ELIMINATIONS,
  'recalculateEliminatedPrizes(finalPrizePool: number): Promise<boolean>'
);
const FINISH = sliceMethod(ELIMINATIONS, 'finishTournament(winnerId: string): Promise<void>');

function sqlFunction(name: string): string {
  const start = ATOMIC_SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  if (start < 0) throw new Error(`SQL function ${name} is missing`);
  const bodyStart = ATOMIC_SQL.indexOf('AS $function$', start);
  const end = ATOMIC_SQL.indexOf('$function$;', bodyStart);
  if (bodyStart < 0 || end < 0) throw new Error(`SQL function ${name} has no complete body`);
  return ATOMIC_SQL.slice(start, end + '$function$;'.length);
}

describe('late-reg repricing is settled only by the atomic place batch', () => {
  it('records the corrected entitlement without moving money itself', () => {
    expect(REPRICE).toMatch(
      /\.from\('tournament_players'\)[\s\S]*?\.update\(\{ prize: correctPrize \}\)[\s\S]*?\.eq\('tournament_id', this\.tournamentId\)[\s\S]*?\.eq\('user_id', player\.user_id\)/
    );
    expect(REPRICE).not.toMatch(
      /settleTournamentObligation|creditTournamentPrize|credit_player_wallet|wallet_transactions|tournament_payouts/
    );
  });

  it('keeps the finish retryable when any corrected entitlement is not durably recorded', () => {
    expect(REPRICE).toMatch(/if \(recordErr\) \{[\s\S]*?complete = false;[\s\S]*?reportError\(/);
    expect(REPRICE).toMatch(
      /if \(!complete\) \{[\s\S]*?requestUrgentEliminationSweepAfter\([\s\S]*?\);[\s\S]*?\}[\s\S]*?return complete;/
    );

    const reprice = FINISH.indexOf('await this.recalculateEliminatedPrizes(refreshedPool)');
    const settlement = FINISH.indexOf('settleTournamentPlacesAtomically(');
    expect(reprice).toBeGreaterThanOrEqual(0);
    expect(settlement).toBeGreaterThan(reprice);
    expect(FINISH).toMatch(
      /if \(!\(await this\.recalculateEliminatedPrizes\(refreshedPool\)\)\) \{\s*this\.tournamentFinished = false;\s*return;\s*\}/
    );
  });

  it('refuses to freeze a place plan whose recorded prizes disagree with the final structure', () => {
    const prepare = sqlFunction('fn_prepare_tournament_place_obligations(');
    const compare = prepare.indexOf('IF v_player_prize_cents <> v_expected_cents THEN');
    const refusal = prepare.indexOf("'reason', 'recorded_prize_disagrees_with_structure'", compare);
    const plan = prepare.indexOf('v_plan := v_plan ||', compare);

    expect(compare).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThan(compare);
    expect(plan).toBeGreaterThan(refusal);
  });

  it('pays every frozen place before the same transaction marks the tournament completed', () => {
    const settle = sqlFunction('fn_settle_tournament_places_atomic(');
    const pay = settle.indexOf('FOR r IN');
    const fullyPaid = settle.indexOf('IF v_open_count > 0 THEN', pay);
    const completed = settle.indexOf("SET status = 'COMPLETED'", fullyPaid);

    expect(pay).toBeGreaterThanOrEqual(0);
    expect(fullyPaid).toBeGreaterThan(pay);
    expect(completed).toBeGreaterThan(fullyPaid);
    expect(settle.slice(fullyPaid, completed)).toMatch(/RAISE EXCEPTION/);

    const atomicCall = FINISH.indexOf('settleTournamentPlacesAtomically(');
    const receiptGate = FINISH.indexOf('if (!settlement.ok || !settlement.completed)', atomicCall);
    const successCleanup = FINISH.lastIndexOf('cleanupCommittedTournament()');
    expect(receiptGate).toBeGreaterThan(atomicCall);
    expect(successCleanup).toBeGreaterThan(receiptGate);
  });
});
