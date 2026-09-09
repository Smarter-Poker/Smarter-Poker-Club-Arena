/**
 * Recovery is a read-only evidence gate. The same domain RPC used by live
 * play owns every financial and terminal write and returns an immutable,
 * internally verified receipt before recovery may log success.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const source = readFileSync('src/tournament/tournamentRecovery.ts', 'utf8');
const recoveryRaw = sliceMethod(source, 'export async function recoverStuckCompletingTournaments(');
const recovery = blankNonCode(recoveryRaw);
const terminalRpc = readFileSync('src/tournament/terminalSettlementRpc.ts', 'utf8');
const satelliteRpc = readFileSync('src/tournament/satelliteSettlementRpc.ts', 'utf8');

describe('recovery proves every read that can authorize a receipt request', () => {
  it('fails closed on the candidate scan and player-field read', () => {
    expect(recovery).toMatch(
      /const \{ data: stuck, error: stuckError \}[\s\S]*?stuckError \|\| !Array\.isArray\(stuck\)[\s\S]*?return;/
    );
    expect(recovery).toMatch(
      /const field = await readRecoveryField\(tournament\.id\)[\s\S]*?!field\.rows \|\| field\.rows\.length < 1[\s\S]*?continue;/
    );
  });

  it('treats either final-table-deal evidence result as unknown unless it is an array', () => {
    const refusal = recoveryRaw.indexOf('GameServer.recoverStuckCompleting_deal_check_failed');
    const evidenceUse = recovery.indexOf('const hasDeal =');
    expect(recovery).toMatch(
      /dealPayouts\.error \|\|[\s\S]*?dealObligations\.error \|\|[\s\S]*?!Array\.isArray\(dealPayouts\.data\)[\s\S]*?!Array\.isArray\(dealObligations\.data\)/
    );
    expect(refusal).toBeGreaterThan(-1);
    expect(evidenceUse).toBeGreaterThan(refusal);
  });
});

describe('recovery owns no money, standings, lifecycle, or seat write', () => {
  it('contains no direct mutation and no retired fragment payer', () => {
    expect(recovery).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(recovery).not.toMatch(
      /settleTournamentObligation|settleTournamentPlacesAtomically|claimTournamentFinish|closeRecoveredTournamentTablesAndSeats/
    );
    expect(recovery).not.toMatch(
      /fn_apply_prize_guarantee|fn_finalize_bounty_pool|fn_settle_tournament_rake|fn_mystery_bounty_settle/
    );
  });

  it('has exactly one whole-domain receipt request for each tournament kind', () => {
    expect(recovery.match(/requestTournamentTerminalReceipt\(/g)).toHaveLength(1);
    expect(recovery.match(/requestSatelliteSettlementReceipt\(/g)).toHaveLength(1);
  });

  it('logs success only after the matching verified helper returns', () => {
    const satelliteRequest = recoveryRaw.indexOf('await requestSatelliteSettlementReceipt(');
    const satelliteLog = recoveryRaw.indexOf('[GameServer] Recovered satellite', satelliteRequest);
    const tournamentRequest = recoveryRaw.indexOf('await requestTournamentTerminalReceipt(');
    const tournamentLog = recoveryRaw.indexOf(
      '[GameServer] Recovered tournament',
      tournamentRequest
    );
    expect(satelliteRequest).toBeGreaterThan(-1);
    expect(satelliteLog).toBeGreaterThan(satelliteRequest);
    expect(tournamentRequest).toBeGreaterThan(-1);
    expect(tournamentLog).toBeGreaterThan(tournamentRequest);
  });
});

describe('lost responses are classified behind the same serialized authority', () => {
  it.each([
    [terminalRpc, 'fn_complete_tournament_terminal', 'fn_resolve_tournament_terminal_outcome'],
    [satelliteRpc, 'fn_settle_satellite_tournament', 'fn_resolve_satellite_settlement_outcome'],
  ])(
    'replays one idempotent request, then uses its lock-sharing resolver',
    (rpc, settle, resolve) => {
      expect(rpc).toContain(`rpc('${settle}'`);
      expect(rpc).toContain(`rpc('${resolve}'`);
      expect(rpc).toMatch(/terminal_committed|satellite_committed/);
      expect(rpc).toMatch(/definitively_not_committed/);
    }
  );
});
