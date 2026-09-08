/**
 * Recovery is allowed to publish success only from readable evidence and
 * confirmed database writes. Normal place money and COMPLETED now belong to
 * one atomic database function, so this guard pins the current architecture
 * instead of recreating the retired per-player payment loop in a fake client.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { sliceMethod } from '../testHelpers/sourceWindow.js';

const SOURCE = readFileSync('src/tournament/tournamentRecovery.ts', 'utf8');
const RECOVERY = sliceMethod(SOURCE, 'export async function recoverStuckCompletingTournaments(');
const CLEANUP = SOURCE.slice(
  SOURCE.indexOf('async function closeRecoveredTournamentTablesAndSeats('),
  SOURCE.indexOf('export async function recoverStuckCompletingTournaments(')
);

describe('recovery proves every read that can authorize money', () => {
  it('treats either final-table-deal evidence query as unknown unless it returns an array', () => {
    expect(RECOVERY).toMatch(
      /const \[dealPayouts, dealObligations\] = await Promise\.all\([\s\S]*?!Array\.isArray\(dealPayouts\.data\)[\s\S]*?!Array\.isArray\(dealObligations\.data\)/
    );
    const refusal = RECOVERY.indexOf('GameServer.recoverStuckCompleting_deal_check_failed');
    const evidenceUse = RECOVERY.indexOf('dealPayouts.data?.length');
    expect(refusal).toBeGreaterThan(-1);
    expect(evidenceUse).toBeGreaterThan(refusal);
  });

  it('uses one checked player-field result for both roster and field size', () => {
    expect(RECOVERY).toMatch(
      /const \{ data: players, error: playersErr \}[\s\S]*?if \(playersErr \|\| !Array\.isArray\(players\)\)[\s\S]*?const rows = players \?\? \[\];[\s\S]*?const fieldCount = rows\.length/
    );
  });
});

describe('recovery confirms every result write before atomic settlement', () => {
  it('reads back the survivor stamp and the normalized entitlement update', () => {
    expect(RECOVERY).toMatch(
      /\.update\(\{[\s\S]*?status: place === 1 \? 'winner' : 'eliminated'[\s\S]*?prize: 0,[\s\S]*?\.select\('id'\)[\s\S]*?\.maybeSingle\(\)[\s\S]*?if \(stampErr \|\| !stamped\)/
    );
    expect(RECOVERY).toMatch(
      /\.update\(\{ prize: owed \}\)[\s\S]*?\.select\('id'\)[\s\S]*?\.maybeSingle\(\)[\s\S]*?if \(entitlementErr \|\| !updated\)/
    );
  });

  it('never pays a place or marks COMPLETED through a client-side loop', () => {
    expect(RECOVERY).toContain('await settleTournamentPlacesAtomically(');
    expect(RECOVERY).not.toContain('settleTournamentObligation(');
    expect(RECOVERY).not.toMatch(/\.update\(\{\s*status:\s*'COMPLETED'/);
  });

  it('accepts a lost atomic response only after durable COMPLETED is read back', () => {
    expect(RECOVERY).toMatch(
      /if \(!settlement\.ok \|\| !settlement\.completed\)[\s\S]*?\.select\('status'\)[\s\S]*?committed\?\.status !== 'COMPLETED'[\s\S]*?durableCompletionAcceptedAfterLostReceipt = true/
    );
  });
});

describe('terminal cleanup is itself proven', () => {
  it('checks seat release and table closure before returning success', () => {
    expect(CLEANUP).toMatch(
      /\.from\('table_seats'\)[\s\S]*?\.update\(\{ left_at: leftAt \}\)[\s\S]*?if \(error\)[\s\S]*?return false/
    );
    expect(CLEANUP).toMatch(
      /\.from\('tables'\)[\s\S]*?\.update\(\{ status: 'closed', current_players: 0 \}\)[\s\S]*?terminalTables[\s\S]*?seatProof\.count !== 0[\s\S]*?return false/
    );
  });

  it('logs recovery only after the cleanup proof succeeds', () => {
    const cleanup = RECOVERY.lastIndexOf('closeRecoveredTournamentTablesAndSeats(t.id)');
    const success = RECOVERY.lastIndexOf('[GameServer] Recovered stuck COMPLETING tournament');
    expect(cleanup).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(cleanup);
  });
});
