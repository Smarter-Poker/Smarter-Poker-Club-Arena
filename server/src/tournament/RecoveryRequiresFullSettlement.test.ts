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
  it('has one domain receipt door per format and no fragment payer or writer', () => {
    expect(RECOVER_CODE.match(/requestTournamentTerminalReceipt\(/g)).toHaveLength(1);
    expect(RECOVER_CODE.match(/requestSatelliteSettlementReceipt\(/g)).toHaveLength(1);
    expect(RECOVER_CODE).not.toMatch(
      /settleTournamentPlacesAtomically|settleTournamentObligation|fn_settle_tournament_obligation/
    );
    expect(RECOVER_CODE).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
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

  it('delegates lost-response classification and terminal cleanup to the receipt helpers', () => {
    expect(RECOVER_CODE).toMatch(/await requestTournamentTerminalReceipt\(/);
    expect(RECOVER_CODE).toMatch(/await requestSatelliteSettlementReceipt\(/);
    expect(RECOVER_CODE).toMatch(/TerminalSettlementRefusedError/);
    expect(RECOVER_CODE).toMatch(/SatelliteSettlementRefusedError/);
    expect(RECOVER_CODE).toMatch(/reportUnknownRecoveryOutcome\(/);
    expect(RECOVER_CODE).not.toMatch(
      /closeRecoveredTournamentTablesAndSeats|status:\s*'COMPLETED'/
    );
  });
});
