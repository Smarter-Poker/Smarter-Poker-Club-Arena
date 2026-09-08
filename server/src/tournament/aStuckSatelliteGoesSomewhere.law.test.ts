/**
 * A COMPLETING satellite has one immutable finish owner.
 *
 * Recovery used to relabel both undecided and one-survivor satellites RUNNING.
 * That became corrupting once fn_claim_tournament_finish persisted an immutable
 * winner receipt: the receipt survived the relabel, discovery dealt again, and
 * the next finish correctly refused the impossible receipt + RUNNING pair.
 *
 * These source laws pin the recovery boundary. Multi-survivor fields fail
 * closed without a lifecycle write. A sole survivor is accepted only with hand
 * evidence and an exact already-eliminated 2..N field, resumes the database
 * claim, and reaches only the format-owned atomic finalizer.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RECOVERY = fs.readFileSync(path.join(HERE, 'tournamentRecovery.ts'), 'utf8');
const SATELLITE_START = RECOVERY.indexOf(
  "String((t as { variant?: string }).variant ?? '').toLowerCase() === 'satellite'"
);
const NEXT_BRANCH_COMMENT = RECOVERY.indexOf(
  'A CHOPPED EVENT HAS ALREADY AGREED ITS OWN PAYOUTS',
  SATELLITE_START
);
const SATELLITE_END = RECOVERY.lastIndexOf('/**', NEXT_BRANCH_COMMENT);

/** Remove prose so comments cannot satisfy a behavioral assertion. */
function executable(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const CODE = executable(RECOVERY.slice(SATELLITE_START, SATELLITE_END));

describe('a COMPLETING satellite never loses its immutable finish owner', () => {
  it('reads the finish receipt and never relabels the tournament RUNNING', () => {
    expect(CODE).toContain("from('tournament_finish_receipts')");
    expect(CODE).not.toMatch(
      /\.from\('tournaments'\)[\s\S]{0,240}\.update\(\{ status: 'RUNNING' \}\)/
    );
    expect(CODE).not.toContain('recoverStuckCompleting_satellite_revived');
  });

  it('leaves an undecided live field unchanged and raises the invariant breach', () => {
    const start = CODE.indexOf('if (liveRows.length >= 2)');
    const end = CODE.indexOf('let proposedWinnerId', start);
    const branch = CODE.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(branch).toContain('Satellite.completing_with_live_field');
    expect(branch).toContain('recoverStuckCompleting_satellite_live_field_conflict');
    expect(branch).toContain('continue;');
    expect(branch).not.toMatch(/\.update\(/);
    expect(branch).not.toMatch(/\.rpc\(/);
  });

  it('refuses a receipt whose champion conflicts with the durable field', () => {
    const conflict = CODE.slice(
      CODE.indexOf('finishReceipt?.winner_user_id &&'),
      CODE.indexOf('const satClaim = await claimTournamentFinish')
    );
    expect(conflict).toContain('Satellite.finish_receipt_winner_conflict');
    expect(conflict).toContain('recoverStuckCompleting_satellite_winner_claim_conflict');
    expect(conflict).toContain('continue;');
  });
});

describe('one survivor resumes the same proven atomic finish', () => {
  it('requires a playing survivor, real hand evidence, and exact eliminated places 2..N', () => {
    const start = CODE.indexOf('if (liveRows.length === 1)');
    const end = CODE.indexOf('} else {', start);
    const branch = CODE.slice(start, end);

    expect(branch).toContain("survivor.status !== 'playing'");
    expect(branch).toContain("from('hand_history')");
    expect(branch).toContain('noHandWasEverDealt({');
    expect(branch).toContain("row.status === 'eliminated'");
    expect(branch).toContain('row.eliminated_at');
    expect(branch).toContain('index + 2');
    expect(branch).toContain('recoverStuckCompleting_satellite_standings_unproved');
  });

  it('claims before stamping and compare-and-sets only the proven survivor', () => {
    const claim = CODE.indexOf('const satClaim = await claimTournamentFinish');
    const stamp = CODE.indexOf(".update({ status: 'winner', position: 1 })");
    const stampWindow = CODE.slice(stamp, CODE.indexOf('const { data: terminalRows', stamp));

    expect(claim).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(claim);
    expect(stampWindow).toContain(".eq('id', survivorToStamp.id)");
    expect(stampWindow).toContain(".eq('user_id', proposedWinnerId)");
    expect(stampWindow).toContain(".eq('status', 'playing')");
    expect(stampWindow).toContain(".eq('status', 'winner')");
    expect(stampWindow).toContain(".eq('position', 1)");
    expect(stampWindow).toContain('exactWinnerPersisted');
  });

  it('re-proves a unique, contiguous terminal field before any money RPC', () => {
    const proof = CODE.indexOf('const exactTerminalField');
    const bounty = CODE.indexOf('drainTournamentBountyObligations', proof);
    const rake = CODE.indexOf("supabase.rpc('fn_settle_tournament_rake'", proof);
    const settle = CODE.indexOf("'fn_settle_satellite_finish_atomic'", proof);

    expect(proof).toBeGreaterThan(-1);
    expect(bounty).toBeGreaterThan(proof);
    expect(rake).toBeGreaterThan(bounty);
    expect(settle).toBeGreaterThan(rake);
    expect(CODE.slice(proof, bounty)).toContain('position === index + 1');
    expect(CODE.slice(proof, bounty)).toContain('proposedWinnerId');
  });
});

describe('zero survivors never authorizes a guessed champion', () => {
  it('accepts only an existing unique winner at position one', () => {
    const start = CODE.indexOf('const { data: canonicalWinner, error: winnerErr }');
    const end = CODE.indexOf('if (!proposedWinnerId)', start);
    const branch = CODE.slice(start, end);

    expect(branch).toContain(".eq('status', 'winner')");
    expect(branch).toContain(".eq('position', 1)");
    expect(branch).toContain('.maybeSingle()');
    expect(branch).not.toMatch(/lastEliminated|eliminated_at.*desc/i);
  });

  it('raises a critical alert and enters no payout path without that winner', () => {
    const start = CODE.indexOf('if (!proposedWinnerId)');
    const end = CODE.indexOf('finishReceipt?.winner_user_id &&', start);
    const branch = CODE.slice(start, end);

    expect(branch).toContain('Satellite.stuck_completing_unawarded');
    expect(branch).toContain("'critical'");
    expect(branch).toContain('recoverStuckCompleting_satellite_skipped');
    expect(branch).toContain('continue;');
    expect(branch).not.toMatch(/fn_credit_and_log|fn_settle_satellite_finish_atomic/);
  });
});

describe('the satellite branch has one terminal money door', () => {
  it('uses the atomic satellite finalizer and accepts a lost receipt only from COMPLETED', () => {
    expect(CODE).toContain("'fn_settle_satellite_finish_atomic'");
    const failed = CODE.slice(
      CODE.indexOf('satelliteSettlement?.ok !== true'),
      CODE.indexOf('acceptedDurableCompletion = true')
    );
    expect(failed).toContain("committed?.status !== 'COMPLETED'");
    expect(failed).toContain('satellite_completion_failed');
  });

  it('does not certify, directly complete, or fall through to structure cash', () => {
    expect(CODE).not.toContain('certifyTournamentFinish(');
    expect(CODE).not.toMatch(/\.from\('tournaments'\)[\s\S]{0,240}\.update\(/);
    expect(CODE).not.toContain('computePlacePrize');
    expect(CODE.trimEnd()).toMatch(/continue;\s*}\s*$/);
  });
});
