/**
 * A winner is not priced or paid by the game process. Live play submits one
 * observed identity to the database terminal authority and will present an
 * outcome only from the authority's verified, immutable receipt.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', '..', '..', 'supabase', 'migrations');
const read = (name: string) => readFileSync(join(here, name), 'utf8');
const finish = sliceMethod(
  read('TournamentManagerEliminations.ts'),
  'finishTournament(winnerId: string): Promise<void>'
);
const terminalRpc = read('terminalSettlementRpc.ts');
const receiptVerifier = read('completionSettlementReceipt.ts');

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
      const end = source.indexOf(`${tag};`, bodyStart);
      if (end < 0) throw new Error(`${filename}: ${name} has an incomplete body`);
      const definition = source.slice(start, end + tag.length + 1);
      if (!requiredFragment || definition.includes(requiredFragment)) newest = definition;
      start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, end + tag.length + 1);
    }
  }
  if (!newest) throw new Error(`${name} is missing`);
  return newest;
}

const settlePlaces = newestFunction('fn_settle_tournament_places');
const terminalAuthority = newestFunction(
  'fn_complete_tournament_terminal',
  'public.fn_settle_tournament_places('
);

describe('winner funding has one atomic authority', () => {
  it('the process supplies identity only and never prices, funds, or pays a winner', () => {
    expect(finish).toContain(
      "requestTournamentTerminalReceipt(this.tournamentId, 'places', winnerId)"
    );
    const source = blankNonCode(finish);
    expect(source.match(/requestTournamentTerminalReceipt\(/g)).toHaveLength(1);
    expect(source).not.toMatch(
      /applyPrizeGuarantee|fn_apply_prize_guarantee|resolvePayoutStructure|computePlacePrize|settleTournamentObligation|credit_player_wallet|wallet_transactions/
    );
    expect(source).not.toMatch(/\.from\(['"](?:tournaments|tournament_players)['"]\)/);
  });

  it('funds and proves the advertised guarantee before the database derives a place', () => {
    const funding = settlePlaces.indexOf('public.fn_apply_prize_guarantee(');
    const journal = settlePlaces.indexOf("v_guarantee_result->>'overlay_journaled'", funding);
    const refresh = settlePlaces.indexOf('INTO v_t FROM public.tournaments', journal);
    const finalized = settlePlaces.indexOf('prize_pool_finalized', refresh);
    const floor = settlePlaces.indexOf('guaranteed_prize', finalized);
    const ladder = settlePlaces.indexOf('fn_ca_tournament_place_amounts', floor);

    expect(funding).toBeGreaterThanOrEqual(0);
    expect(journal).toBeGreaterThan(funding);
    expect(refresh).toBeGreaterThan(journal);
    expect(finalized).toBeGreaterThan(refresh);
    expect(floor).toBeGreaterThan(finalized);
    expect(ladder).toBeGreaterThan(floor);
    expect(settlePlaces.slice(funding, ladder)).toMatch(/RAISE EXCEPTION/);
  });

  it('keeps guarantee, places, bounty, rake, closure, COMPLETED, and receipt in one call', () => {
    const cash = terminalAuthority.indexOf('public.fn_settle_tournament_places(');
    const bounty = terminalAuthority.indexOf('public.fn_finalize_bounty_pool(', cash);
    const rake = terminalAuthority.indexOf('public.fn_settle_tournament_rake(', cash);
    const seatClose = terminalAuthority.indexOf('UPDATE public.table_seats', cash);
    const complete = terminalAuthority.indexOf("SET status = 'COMPLETED'", seatClose);
    const tableClose = terminalAuthority.indexOf('UPDATE public.tables', complete);
    const receipt = terminalAuthority.indexOf(
      'INSERT INTO public.tournament_terminal_settlements',
      complete
    );

    expect(cash).toBeGreaterThanOrEqual(0);
    expect(bounty).toBeGreaterThan(cash);
    expect(rake).toBeGreaterThan(cash);
    expect(seatClose).toBeGreaterThan(Math.max(bounty, rake));
    expect(complete).toBeGreaterThan(seatClose);
    expect(tableClose).toBeGreaterThan(complete);
    expect(receipt).toBeGreaterThan(complete);
    expect(terminalAuthority).not.toMatch(/EXCEPTION WHEN OTHERS/);
  });
});

describe('live finish accepts only a verified immutable receipt', () => {
  it('fails closed when tournament identity is unavailable', () => {
    const start = finish.indexOf('if (!tournament)');
    const end = finish.indexOf('this.tournamentFinished = true', start);
    const refusal = finish.slice(start, end);
    expect(refusal).toContain("'Tournament.finish_identity_unavailable'");
    expect(refusal).toMatch(/return;/);
    expect(blankNonCode(refusal)).not.toMatch(
      /requestTournamentTerminalReceipt|processSatelliteAwards/
    );
  });

  it('separates every satellite identity from the ordinary cash door', () => {
    const identity = finish.indexOf('const isSatelliteFinish');
    const satellite = finish.indexOf('if (isSatelliteFinish)', identity);
    const cash = finish.indexOf('requestTournamentTerminalReceipt(', satellite);
    const identityWindow = finish.slice(identity, satellite);
    const satelliteWindow = finish.slice(satellite, cash);

    expect(identityWindow).toContain("variant ?? '').toLowerCase() === 'satellite'");
    expect(identityWindow).toContain("tournament_type ?? '').toUpperCase() === 'SATELLITE'");
    expect(identityWindow).toContain('satellite_target_id || tournament.satellite_target');
    expect(satelliteWindow).toContain('processSatelliteAwards(tournament, winnerId)');
    expect(satelliteWindow).not.toContain('requestTournamentTerminalReceipt(');
    expect(cash).toBeGreaterThan(satellite);
  });

  it('releases only a proven refusal and stops on an ambiguous outcome', () => {
    const ordinary = finish.slice(
      finish.indexOf('let receipt: VerifiedTournamentCompletionReceipt')
    );
    const refusal = ordinary.indexOf('settlementErr instanceof TerminalSettlementRefusedError');
    const unknown = ordinary.indexOf(
      'settlementErr instanceof TerminalSettlementOutcomeUnknownError',
      refusal
    );
    const release = ordinary.indexOf('if (provenRefusal) releaseFinishGuard()', unknown);
    const stop = ordinary.indexOf(
      "this.fenceUnknownTerminalOutcome('Tournament.atomic_finish_manager_stop_failed')",
      release
    );
    const cleanup = ordinary.indexOf('await this.cleanupCommittedTournament(receipt)', stop);

    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(unknown).toBeGreaterThan(refusal);
    expect(release).toBeGreaterThan(unknown);
    expect(stop).toBeGreaterThan(release);
    expect(cleanup).toBeGreaterThan(stop);
  });

  it('presents the winner and amount from the receipt, never the candidate', () => {
    const cleanup = sliceMethod(
      read('TournamentManagerEliminations.ts'),
      'private async cleanupCommittedTournament('
    );
    expect(cleanup).toContain('receipt.winnerAmount');
    expect(cleanup).toContain('userId: receipt.winnerId');
    expect(cleanup).toContain('this.committedFinishReceipt = receipt');
    expect(blankNonCode(cleanup)).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
  });
});

describe('lost responses are resolved by the same immutable request', () => {
  it('replays one exact request, then serializes behind the terminal transaction', () => {
    const request = terminalRpc.indexOf('const request = {');
    const loop = terminalRpc.indexOf('for (let attempt = 1;', request);
    const invoke = terminalRpc.indexOf(
      "supabase.rpc('fn_complete_tournament_terminal', request)",
      loop
    );
    const resolver = terminalRpc.indexOf(
      "supabase.rpc('fn_resolve_tournament_terminal_outcome'",
      invoke
    );
    expect(request).toBeGreaterThanOrEqual(0);
    expect(loop).toBeGreaterThan(request);
    expect(invoke).toBeGreaterThan(loop);
    expect(resolver).toBeGreaterThan(invoke);
    expect(terminalRpc).toContain('verifyTournamentCompletionReceipt(');
  });

  it('calls a miss a refusal only when the serialized result proves no receipt', () => {
    expect(terminalRpc).toMatch(
      /terminal_committed === false[\s\S]*?definitively_not_committed === true[\s\S]*?outcome\.receipt === null[\s\S]*?throw new TerminalSettlementRefusedError/
    );
    expect(terminalRpc).toMatch(/throw new TerminalSettlementOutcomeUnknownError\(/);
    expect(terminalRpc).toContain('Terminal settlement outcome is unknown after');
  });

  it('rejects partial, duplicated, mismatched, or unfunded receipt evidence', () => {
    expect(receiptVerifier).toMatch(/receipt\.fully_settled !== true/);
    expect(receiptVerifier).toMatch(/receipt\.status !== 'COMPLETED'/);
    expect(receiptVerifier).toMatch(/tournamentId !== expectedTournamentId/);
    expect(receiptVerifier).toMatch(/receipt\.mode !== expectedMode/);
    expect(receiptVerifier).toMatch(/users\.has\(userId\) \|\|[\s\S]*?places\.has\(place\)/);
    expect(receiptVerifier).toMatch(
      /prizeBalance !== 0[\s\S]*?bountyBalance !== 0[\s\S]*?feeBalance !== 0/
    );
    expect(receiptVerifier).toMatch(/payoutCents !== Math\.round\(cashPayoutTotal \* 100\)/);
    expect(receiptVerifier).toMatch(/rake\.attributed !== true/);
  });
});
