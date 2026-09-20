/**
 * A repriced result is presentation state, never a second payer. The terminal
 * database authority derives the final ladder from its locked roster and pool,
 * preflights the complete set, then pays and stamps every place in one commit.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', '..', '..', 'supabase', 'migrations');
const stripSqlComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

function newestFunction(name: string, requiredFragment?: string): string {
  let newest = '';
  for (const filename of readdirSync(migrations)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    const source = stripSqlComments(readFileSync(join(migrations, filename), 'utf8'));
    let start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    while (start >= 0) {
      const body = source.slice(start).match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/);
      if (!body || body.index == null) throw new Error(`${filename}: ${name} has no body`);
      const tag = body[1];
      const bodyStart = start + body.index + body[0].length;
      const end = source.indexOf(tag, bodyStart);
      const terminator = end < 0 ? null : source.slice(end + tag.length).match(/^\s*;/);
      if (!terminator) throw new Error(`${filename}: ${name} has an incomplete body`);
      const definitionEnd = end + tag.length + terminator[0].length;
      const definition = source.slice(start, definitionEnd);
      if (!requiredFragment || definition.includes(requiredFragment)) newest = definition;
      start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, definitionEnd);
    }
  }
  if (!newest) throw new Error(`${name} is missing`);
  return newest;
}

const eliminations = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
const reprice = sliceMethod(
  eliminations,
  'recalculateEliminatedPrizes(finalPrizePool: number): Promise<boolean>'
);
const finish = sliceMethod(eliminations, 'finishTournament(winnerId: string): Promise<void>');
const settlePlaces = newestFunction('fn_settle_tournament_places');
const terminal = newestFunction(
  'fn_complete_tournament_terminal',
  'public.fn_settle_tournament_places('
);

describe('late-reg repricing is not a second money path', () => {
  it('records the corrected cache without moving money itself', () => {
    expect(reprice).toContain("supabase.rpc(\n          'fn_ca_reprice_unpaid_tournament_place'");
    expect(reprice).toContain('p_expected_prize: expectedPrize');
    expect(reprice).toContain('p_new_prize: correctPrize');
    expect(reprice).toContain('record.tournament_id !== this.tournamentId');
    expect(reprice).toContain('record.user_id !== player.user_id');
    expect(reprice).not.toMatch(/\.from\('tournament_players'\)[\s\S]*?\.update\(/);
    expect(blankNonCode(reprice)).not.toMatch(
      /settleTournamentObligation|creditTournamentPrize|credit_player_wallet|wallet_transactions|tournament_payouts|requestTournamentTerminalReceipt/
    );
  });

  it('finish never trusts or rewrites that cache before requesting the terminal receipt', () => {
    expect(finish).toContain(
      "requestTournamentTerminalReceipt(this.tournamentId, 'places', winnerId)"
    );
    expect(blankNonCode(finish)).not.toMatch(
      /recalculateEliminatedPrizes|correctPrize|fn_ca_reprice_unpaid_tournament_place|settleTournamentObligation/
    );
  });
});

describe('the database freezes and settles the complete final ladder', () => {
  it('derives standings and amounts from locked durable evidence', () => {
    const rosterLock = settlePlaces.indexOf('FROM public.tournament_players tp');
    const ladder = settlePlaces.indexOf('fn_ca_tournament_place_amounts', rosterLock);
    const winnerProof = settlePlaces.indexOf(
      'v_winner.id IS NULL OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id',
      ladder
    );
    const sequenceProof = settlePlaces.indexOf(
      'v_sequenced_count <> v_eliminated_count',
      winnerProof
    );

    expect(rosterLock).toBeGreaterThanOrEqual(0);
    expect(ladder).toBeGreaterThan(rosterLock);
    expect(winnerProof).toBeGreaterThan(ladder);
    expect(sequenceProof).toBeGreaterThan(winnerProof);
    expect(settlePlaces).toMatch(/count\(DISTINCT tp\.elimination_sequence\)/);
  });

  it('preflights every place before the first obligation or wallet credit', () => {
    const preflight = settlePlaces.indexOf('FOR v_row IN');
    const missing = settlePlaces.indexOf('IF v_user_id IS NULL THEN', preflight);
    const malformed = settlePlaces.indexOf(
      "v_amount::text IN ('NaN','Infinity','-Infinity')",
      missing
    );
    const overpaid = settlePlaces.indexOf('IF v_evidence > v_amount THEN', malformed);
    const materialize = settlePlaces.indexOf("IF v_status <> 'COMPLETED' THEN", overpaid);
    const payer = settlePlaces.indexOf('public.fn_ca_settle_tournament_place_raw(', materialize);

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(missing).toBeGreaterThan(preflight);
    expect(malformed).toBeGreaterThan(missing);
    expect(overpaid).toBeGreaterThan(malformed);
    expect(materialize).toBeGreaterThan(overpaid);
    expect(payer).toBeGreaterThan(materialize);
  });

  it('pays, proves, and stamps all places before the outer transaction completes', () => {
    const payer = settlePlaces.indexOf('public.fn_ca_settle_tournament_place_raw(');
    const paidProof = settlePlaces.indexOf("v_result->>'fully_settled'", payer);
    const resetCache = settlePlaces.indexOf(
      'UPDATE public.tournament_players SET prize = 0',
      paidProof
    );
    const stampCache = settlePlaces.indexOf('SET prize = v_row.amount', resetCache);
    const postProof = settlePlaces.indexOf('post-settlement proof failed', stampCache);
    const cash = terminal.indexOf('public.fn_settle_tournament_places(');
    const cashProof = terminal.indexOf("v_cash->>'fully_settled'", cash);
    const complete = terminal.indexOf("SET status = 'COMPLETED'", cashProof);
    const receipt = terminal.indexOf(
      'INSERT INTO public.tournament_terminal_settlements',
      complete
    );

    expect(payer).toBeGreaterThanOrEqual(0);
    expect(paidProof).toBeGreaterThan(payer);
    expect(resetCache).toBeGreaterThan(paidProof);
    expect(stampCache).toBeGreaterThan(resetCache);
    expect(postProof).toBeGreaterThan(stampCache);
    expect(cash).toBeGreaterThanOrEqual(0);
    expect(cashProof).toBeGreaterThan(cash);
    expect(complete).toBeGreaterThan(cashProof);
    expect(receipt).toBeGreaterThan(complete);
    expect(terminal).not.toMatch(/EXCEPTION WHEN OTHERS/);
  });
});
