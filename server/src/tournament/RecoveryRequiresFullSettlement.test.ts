/**
 * Recovery used to pay one place at a time in JavaScript and decide whether it
 * could continue from each child's `fully_settled` response. Place settlement
 * is now a database-owned batch: every place payment, the terminal status and
 * table closure commit together, or the exception subtransaction rolls all of
 * them back. These laws pin the current boundary instead of resurrecting the
 * deleted per-place client payer in a source-evaluation harness.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const RECOVERY = read('src/tournament/tournamentRecovery.ts');
const MIGRATIONS = join(process.cwd(), '..', 'supabase', 'migrations');

const stripSqlComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

/** Return the newest deployed definition so a later migration cannot bypass this law. */
function newestFunctionBody(name: string): string {
  let newest = '';
  for (const filename of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS, filename), 'utf8'));
    let start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    while (start >= 0) {
      const end = sql.indexOf('$function$;', start);
      if (end < 0) throw new Error(`${filename}: incomplete ${name} definition`);
      newest = sql.slice(start, end + '$function$;'.length);
      start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, end);
    }
  }
  if (!newest) throw new Error(`Actual ${name} function missing`);
  return newest;
}

const RECOVER = sliceMethod(RECOVERY, 'export async function recoverStuckCompletingTournaments(');
const RECOVER_CODE = blankNonCode(RECOVER);
const ATOMIC_SETTLEMENT = newestFunctionBody('fn_settle_tournament_places_atomic');

describe('recovery cannot finish a partially paid tournament', () => {
  it('has one batch settlement door and no post-batch per-player payer', () => {
    const boundary = RECOVER_CODE.indexOf('settleTournamentPlacesAtomically(');
    expect(boundary).toBeGreaterThanOrEqual(0);

    const completionTail = RECOVER_CODE.slice(boundary);
    expect(completionTail.match(/settleTournamentPlacesAtomically\(/g)).toHaveLength(1);
    expect(completionTail).not.toContain('settleTournamentObligation(');
  });

  it('rejects each short-paid place and then re-proves that no place remains open', () => {
    const childSettlement = ATOMIC_SETTLEMENT.indexOf(
      'fn_settle_tournament_obligation_before_atomic_batch_gate('
    );
    const childProof = ATOMIC_SETTLEMENT.indexOf(
      'IF v_after_paid + 0.005 < r.amount_owed THEN',
      childSettlement
    );
    const aggregateProof = ATOMIC_SETTLEMENT.indexOf('IF v_open_count > 0 THEN', childProof);
    const completion = ATOMIC_SETTLEMENT.indexOf("SET status = 'COMPLETED'", aggregateProof);
    const rollbackBoundary = ATOMIC_SETTLEMENT.indexOf('EXCEPTION WHEN OTHERS', completion);

    expect(childSettlement).toBeGreaterThanOrEqual(0);
    expect(childProof).toBeGreaterThan(childSettlement);
    expect(aggregateProof).toBeGreaterThan(childProof);
    expect(completion).toBeGreaterThan(aggregateProof);
    expect(rollbackBoundary).toBeGreaterThan(completion);
    expect(ATOMIC_SETTLEMENT).toContain("'reason', 'atomic_settlement_aborted'");
  });

  it('accepts a completed replay only when its batch and every place are fully settled', () => {
    expect(ATOMIC_SETTLEMENT).toMatch(
      /IF v_t\.status = 'COMPLETED' THEN[\s\S]*?v_batch\.settled_at IS NOT NULL AND v_open_count = 0[\s\S]*?'already_completed', true[\s\S]*?'completed_batch_is_not_fully_settled'/
    );
  });

  it('requires explicit atomic completion or a durable COMPLETED re-read before cleanup', () => {
    const refusal = RECOVER_CODE.indexOf('if (!settlement.ok || !settlement.completed)');
    const durableRead = RECOVER_CODE.indexOf('.from(', refusal);
    const durableProof = RECOVER_CODE.indexOf('committed?.status !==', durableRead);
    const failed = RECOVER_CODE.indexOf('throw new Error(', durableProof);
    const cleanup = RECOVER_CODE.indexOf('closeRecoveredTournamentTablesAndSeats(t.id)', refusal);

    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(durableRead).toBeGreaterThan(refusal);
    expect(durableProof).toBeGreaterThan(durableRead);
    expect(failed).toBeGreaterThan(durableProof);
    expect(cleanup).toBeGreaterThan(failed);
  });
});
