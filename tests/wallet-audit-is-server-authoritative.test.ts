/**
 * THE BROWSER MUST NOT WRITE THE FINANCIAL LEDGER.
 *
 * `WalletService.logTransaction` used to call the `log_wallet_transaction` RPC
 * and INSERT into `chip_ledger` directly from the client. Both are refused by
 * the database for the `authenticated` role, deliberately: granting either
 * would let any logged-in user forge ledger rows for any user with an arbitrary
 * amount. Production logs for one 3-hour window on 2026-08-24 recorded 125 and
 * 124 permission denials respectively - a 100% failure rate.
 *
 * It was not merely useless. The RPC was wrapped in retryAsync(..., 3), so every
 * call retried a PERMANENT authorization error three times, the chip_ledger
 * insert failed alongside it, and each failure then awaited
 * FinancialAlertService.logCritical() - itself another database write. One
 * doomed audit log cost roughly six round trips and raised a false "audit trail
 * gap" CRITICAL, on a database already cancelling ~20 statements a minute.
 *
 * The real audit row is written server-side, in the same transaction as the
 * money movement, by the SECURITY DEFINER atomic_* RPC that performs it.
 *
 * This spec pins the fix at the source level rather than by mocking supabase,
 * because the failure mode being guarded is "somebody re-adds the client write",
 * which is a property of the code, not of one call's return value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = readFileSync(resolve(__dirname, '../src/services/WalletService.ts'), 'utf8');

describe('client-side wallet audit writes stay removed', () => {
  it('never calls the log_wallet_transaction RPC from the browser', () => {
    // service_role-only and NOT security definer - always 42501 from the client.
    expect(SRC).not.toMatch(/rpc\(\s*['"]log_wallet_transaction['"]/);
  });

  it('never INSERTs into chip_ledger from the browser', () => {
    // `authenticated` has SELECT but not INSERT on chip_ledger, by design.
    const chipLedgerInsert = /from\(\s*['"]chip_ledger['"]\s*\)[\s\S]{0,200}?\.insert\(/;
    expect(SRC).not.toMatch(chipLedgerInsert);
  });

  it('still exposes logTransaction, so the ~11 call sites keep compiling', () => {
    // Deleted rather than no-op'd would mean touching every caller; the seam is
    // kept deliberately for the service-role route that will carry the
    // non-monetary audit notes.
    expect(SRC).toMatch(/async logTransaction\(/);
  });

  it('does not raise a CRITICAL financial alert from that path any more', () => {
    // The alert fired on every single call and was always false, which buried
    // real criticals. It must not come back with the client write.
    const logTxBody = SRC.slice(
      SRC.indexOf('async logTransaction('),
      SRC.indexOf('async logTransaction(') + 1600
    );
    expect(logTxBody).not.toMatch(/logCritical\(/);
  });
});
