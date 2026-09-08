/**
 * A durable COMPLETED re-read proves that a lost atomic receipt committed, but
 * it cannot recover the receipt's per-call place and payment counts. Recovery
 * must describe the durable proof instead of printing the failed receipt's
 * zero-valued fallback fields as if they were the committed settlement.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

const recovery = fs.readFileSync(
  path.join(process.cwd(), 'src/tournament/tournamentRecovery.ts'),
  'utf8'
);
const recover = sliceMethod(recovery, 'export async function recoverStuckCompletingTournaments(');

describe('stuck-tournament recovery logs only receipt-backed settlement counts', () => {
  it('marks a failed atomic receipt as lost only after durable COMPLETED is proven', () => {
    const failedReceipt = sliceMethod(recover, 'if (!settlement.ok || !settlement.completed)');
    const durableProof = failedReceipt.indexOf("committed?.status !== 'COMPLETED'");
    const accepted = failedReceipt.indexOf('durableCompletionAcceptedAfterLostReceipt = true');

    expect(durableProof).toBeGreaterThanOrEqual(0);
    expect(accepted).toBeGreaterThan(durableProof);
  });

  it('logs durable completion and cleanup with settlement counts unavailable', () => {
    const cleanup = recover.indexOf('if (!cleanupComplete)');
    const durableLog = recover.indexOf('place/payment counts unavailable');
    const lostReceiptLogBlock = sliceEnclosingBlock(recover, 'place/payment counts unavailable');

    expect(durableLog).toBeGreaterThan(cleanup);
    expect(lostReceiptLogBlock).toMatch(/durable COMPLETED/);
    expect(lostReceiptLogBlock).toMatch(/table\/seat cleanup proven/);
    expect(lostReceiptLogBlock).not.toMatch(/settlement\.places|settlement\.paid/);
  });

  it('preserves exact place and payment counts for a genuinely successful receipt', () => {
    const receiptLogBlock = sliceEnclosingBlock(
      recover,
      'atomically settled ${settlement.places} place(s)'
    );

    expect(receiptLogBlock).toMatch(/settlement\.places/);
    expect(receiptLogBlock).toMatch(/settlement\.paid/);
    expect(receiptLogBlock).not.toMatch(/counts unavailable/);
  });
});
