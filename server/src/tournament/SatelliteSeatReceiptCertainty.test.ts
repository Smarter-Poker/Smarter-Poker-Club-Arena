/**
 * A satellite result is accepted only from its verified immutable receipt.
 * Process code never reconstructs awards and never treats a status read as a
 * substitute for a response whose commit outcome is still unknown.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const manager = readFileSync(join(__dirname, 'TournamentManager.ts'), 'utf8');
const eliminations = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
const request = readFileSync(join(__dirname, 'satelliteSettlementRpc.ts'), 'utf8');

describe('only an exact atomic satellite receipt confirms settlement', () => {
  it('keeps the manager adapter arithmetic-free and returns the certified winner value', () => {
    const adapter = sliceMethod(
      manager,
      'processSatelliteAwards(_tournament: any, winnerId: string): Promise<number>'
    );

    expect(adapter).toContain('requestSatelliteSettlementReceipt(this.tournamentId, winnerId)');
    expect(adapter).toContain('verified.ticketAwardCount');
    expect(adapter).toContain('verified.cashTicketCount');
    expect(adapter).toContain('return verified.winnerAmount');
    expect(adapter).not.toMatch(/supabase|\.from\(|\.rpc\(|Math\.|prize_pool|satellite_seats/);
  });

  it('serializes every lost-response outcome through the durable resolver', () => {
    expect(request).toContain('for (let attempt = 1; attempt <= attempts; attempt++)');
    expect(request).toContain("rpc('fn_resolve_satellite_settlement_outcome'");
    expect(request).toContain('verifySatelliteSettlementReceipt(');
    expect(request).toContain('throw new SatelliteSettlementRefusedError(lastFailure)');
    expect(request).toContain('throw new SatelliteSettlementOutcomeUnknownError(');
  });
});

describe('an unresolved satellite commit stops process ownership', () => {
  it('branches before shared rake, bounty, standings, or cash-place work', () => {
    const finish = sliceMethod(eliminations, 'finishTournament(winnerId: string): Promise<void>');
    const start = finish.indexOf('if (isSatelliteFinish) {');
    const end = finish.indexOf('let refreshedPool', start);
    const satellite = finish.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(satellite).toContain('await this.processSatelliteAwards(tournament, winnerId)');
    expect(satellite).toContain('satErr instanceof SatelliteSettlementOutcomeUnknownError');
    expect(satellite).toContain('satErr instanceof SatelliteSettlementRefusedError');
    expect(satellite).toContain('if (provenRefusal) releaseFinishGuard()');
    expect(satellite).toContain('if (!provenRefusal) await this.stopAndWait()');
    expect(satellite).not.toMatch(
      /readDurableTournamentStatus|settleTournamentRake|fn_finalize_bounty_pool|settleTournamentPlacesAtomically|status:\s*'COMPLETED'/
    );
  });
});
