/**
 * A STUCK SATELLITE REPLAYS THE SAME WHOLE-EVENT AUTHORITY.
 *
 * Recovery used to infer success from any payout row or target seat, then
 * close the tournament even when the rest of the locked pool was missing.
 * New satellite finishes are atomic, so recovery has no second calculator or
 * observer: it may repair a historical undecided status, or replay the exact
 * database authority from one durable winner and validate its v2 receipt.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RECOVERY = fs.readFileSync(path.join(HERE, 'tournamentRecovery.ts'), 'utf8');

function executable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const branchStart = RECOVERY.indexOf(
  "String((t as { variant?: string }).variant ?? '').toLowerCase() === 'satellite'"
);
const branchEnd = RECOVERY.indexOf('// A COMPLETING cash event is resumable', branchStart);
const BRANCH = executable(RECOVERY.slice(branchStart, branchEnd));

describe('a stuck satellite has no observer-based completion path', () => {
  it('finds the satellite branch and keeps it outside cash-place recovery', () => {
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(BRANCH).not.toMatch(/fn_settle_tournament_places|computePlacePrize/);
    expect(BRANCH).toMatch(/continue;/);
  });

  it('never treats one payout or target seat as proof the whole pool settled', () => {
    expect(BRANCH).not.toMatch(/from\('tournament_payouts'\)/);
    expect(BRANCH).not.toMatch(/\.eq\('source_satellite_id'|alreadyAwarded|recordCount/);
    expect(BRANCH).not.toMatch(/status:\s*'COMPLETED'/);
  });
});

describe('only durable roster evidence can select the observed winner', () => {
  it('fails closed when the roster read is unknown', () => {
    expect(BRANCH).toMatch(/from\('tournament_players'\)/);
    expect(BRANCH).toMatch(/select\(['"]user_id, status, position['"]\)/);
    expect(BRANCH).toMatch(/satellitePlayersErr|rosterErr/);
    expect(BRANCH).toMatch(/Array\.isArray/);
  });

  it('does not rank a replacement from chips, timestamps, or array order', () => {
    expect(BRANCH).not.toMatch(/\.chips|created_at|updated_at|elimination_sequence|\.sort\(/);
    expect(BRANCH).toMatch(/position\) === 1|position === 1/);
    expect(BRANCH).toMatch(/\.length !== 1|\.length === 1/);
  });

  it('alerts and changes nothing when no single durable winner exists', () => {
    expect(BRANCH).toMatch(/Satellite\.stuck_completing_winner_absent/);
    expect(BRANCH).toMatch(/await raiseFinancialAlert\(\s*['"]critical['"]/);
  });
});

describe('the only historical state repair is an exact undecided CAS', () => {
  it('returns registered or multi-live legacy rows to RUNNING with one-row proof', () => {
    expect(BRANCH).toContain("'registered'");
    expect(BRANCH).toMatch(/\.length >= 2/);
    expect(BRANCH).toMatch(/\.update\(\{ status: 'RUNNING' \}/);
    expect(BRANCH).toMatch(/\{ count: 'exact' \}/);
    expect(BRANCH).toMatch(/\.eq\('status', 'COMPLETING'\)/);
    expect(BRANCH).toMatch(/count !== 1/);
  });
});

describe('decided recovery replays one atomic satellite receipt', () => {
  it('requests the whole-event receipt with the durable winner', () => {
    expect(BRANCH).toContain('requestSatelliteSettlementReceipt(t.id, winnerId)');
    expect(RECOVERY).toMatch(
      /import \{ requestSatelliteSettlementReceipt \} from '\.\/satelliteSettlementRpc\.js'/
    );
  });

  it('awaits a critical outcome-unconfirmed alert on transport or receipt ambiguity', () => {
    expect(BRANCH).toContain('Satellite.seat_outcome_unconfirmed');
    expect(BRANCH).toMatch(/await raiseFinancialAlert\(\s*['"]critical['"]/);
    expect(BRANCH).not.toMatch(/fn_settle_tournament_rake|fn_credit_and_log/);
  });
});
