/** A COMPLETING satellite may only resume the canonical receipt transaction. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const recoverySource = readFileSync('src/tournament/tournamentRecovery.ts', 'utf8');
const recovery = blankNonCode(
  sliceMethod(recoverySource, 'export async function recoverStuckCompletingTournaments(')
);
const recoveryRaw = sliceMethod(
  recoverySource,
  'export async function recoverStuckCompletingTournaments('
);
const winner = blankNonCode(sliceMethod(recoverySource, 'function canonicalWinner('));
const receiptRpc = readFileSync('src/tournament/satelliteSettlementRpc.ts', 'utf8');

describe('a COMPLETING satellite never loses its immutable finish owner', () => {
  it('recognizes every durable satellite discriminator', () => {
    const classifier = sliceMethod(recoverySource, 'function satellite(');
    expect(classifier).toMatch(/variant[\s\S]*?satellite/);
    expect(classifier).toMatch(/tournament_type[\s\S]*?SATELLITE/);
    expect(classifier).toContain('satellite_target_id');
  });

  it('leaves an undecided live field unchanged', () => {
    const start = recoveryRaw.indexOf('if (live.length > 1)');
    const request = recoveryRaw.indexOf('requestSatelliteSettlementReceipt(', start);
    const branch = recoveryRaw.slice(start, request);
    expect(start).toBeGreaterThan(-1);
    expect(branch).toMatch(/recoverStuckCompleting_satellite_live_field_conflict/);
    expect(branch).toMatch(/continue;/);
    expect(branch).not.toMatch(/\.update\(|\.insert\(|\.delete\(|\.rpc\(/);
  });

  it('will not promote a registered player who was never dealt in', () => {
    const start = recoveryRaw.indexOf("live.length === 1 && live[0].status !== 'playing'");
    const request = recoveryRaw.indexOf('requestSatelliteSettlementReceipt(', start);
    expect(start).toBeGreaterThan(-1);
    expect(recoveryRaw.slice(start, request)).toMatch(
      /satellite_survivor_never_played[\s\S]*?continue;/
    );
  });
});

describe('one proven result reaches one terminal money door', () => {
  it('requires real hand evidence before the receipt request', () => {
    const hand = recoveryRaw.indexOf('const hand = await hasHandEvidence(tournament)');
    const refusal = recoveryRaw.indexOf('satellite_no_hand_ever_dealt', hand);
    const request = recoveryRaw.indexOf('requestSatelliteSettlementReceipt(', refusal);
    expect(hand).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(hand);
    expect(request).toBeGreaterThan(refusal);
  });

  it('accepts only a sole live player or one durable canonical witness', () => {
    expect(recovery).toMatch(
      /const winnerId = live\.length === 1 \? live\[0\]\.user_id : canonicalWinner\(rows\)/
    );
    expect(winner).toMatch(/winners\.length === 1/);
    expect(winner).toMatch(/winners\.length > 1[\s\S]*?return null/);
    expect(winner).toMatch(/eliminated\.length !== rows\.length[\s\S]*?return null/);
    expect(winner).toMatch(/new Set\(sequenced\.map[\s\S]*?size !== sequenced\.length/);
  });

  it('uses the verified receipt helper exactly once and has no fallback payer', () => {
    expect(recovery.match(/requestSatelliteSettlementReceipt\(/g)).toHaveLength(1);
    expect(recovery).not.toMatch(
      /fn_settle_satellite_finish_atomic|settleTournamentObligation|claimTournamentFinish/
    );
    expect(recovery).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });

  it('separates a proven refusal from a serialized outcome that stayed unknown', () => {
    expect(recovery).toMatch(/error instanceof SatelliteSettlementRefusedError/);
    const unknownReporter = sliceMethod(
      recoverySource,
      'async function reportUnknownRecoveryOutcome('
    );
    expect(unknownReporter).toContain("kind === 'satellite' ? 'Satellite' : 'Tournament'");
    expect(unknownReporter).toContain('GameServer.recoverStuckCompleting_${kind}_outcome_unknown');
    expect(recoveryRaw).toMatch(
      /reportUnknownRecoveryOutcome\(tournament, winnerId, reason, 'satellite', error\)/
    );
  });

  it('cannot fall through from the satellite branch into cash settlement', () => {
    const satelliteRequest = recovery.indexOf('requestSatelliteSettlementReceipt(');
    const ordinaryEvidence = recovery.indexOf(
      'const [dealPayouts, dealObligations]',
      satelliteRequest
    );
    expect(recovery.slice(satelliteRequest, ordinaryEvidence)).toMatch(/continue;/);
  });
});

describe('the helper resolves only through serialized immutable evidence', () => {
  it('replays the same request and validates both direct and resolver receipts', () => {
    expect(receiptRpc.match(/verifySatelliteSettlementReceipt\(/g)).toHaveLength(2);
    expect(receiptRpc).toContain("rpc('fn_settle_satellite_tournament'");
    expect(receiptRpc).toContain("rpc('fn_resolve_satellite_settlement_outcome'");
    expect(receiptRpc).toMatch(/satellite_committed === true/);
    expect(receiptRpc).toMatch(/definitively_not_committed === true/);
  });
});
