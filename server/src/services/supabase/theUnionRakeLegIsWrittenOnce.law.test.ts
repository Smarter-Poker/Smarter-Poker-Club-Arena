/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE UNION RAKE LEG IS WRITTEN ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `union_wallets.rake_wallet` holds the balance and
 * `union_wallet_transactions` is the domain journal that has to explain it.
 * `fn_union_treasury_selftest` reconciles one against the other, so if they
 * can ever disagree the platform pages a critical.
 *
 * logRakeCollection used to move the balance and write that journal row in
 * THREE separate requests: the RPC, then a read of the new balance, then an
 * INSERT. Both halves of the 2026-09-09 union rake drift are that shape:
 *
 *   -71.00 on 2026-08-19 16:22:46.719 (journal row b8399c84): the INSERT
 *   landed and the wallet update did not. It is the only row in the whole
 *   1.42M-row journal with a NULL balance_after, because the separate read
 *   that feeds balance_after found nothing.
 *
 *   +25.39 across 2026-07-19 to 2026-07-24, about fifteen steps: the wallet
 *   moved and the INSERT did not land.
 *
 * Neither write was error-checked, so neither failure was reported.
 *
 * `increment_union_wallet` writes the journal row itself, in the same
 * transaction as the balance change, with balance_after from the UPSERT's own
 * RETURNING clause - but only when the caller passes club or notes context.
 * These laws pin that it does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAKE = readFileSync(resolve(HERE, './rake.ts'), 'utf8');

/** The union branch of logRakeCollection, from the RPC call to the else. */
function unionBranch(): string {
  const start = RAKE.indexOf("supabase.rpc('increment_union_wallet'");
  expect(start, 'the union rake credit has moved').toBeGreaterThan(-1);
  const end = RAKE.indexOf('} else {', start);
  expect(end, 'the standalone-club branch has moved').toBeGreaterThan(start);
  return RAKE.slice(start, end);
}

describe('the union rake leg is written once', () => {
  it('passes the context that makes the journal row atomic', () => {
    const branch = unionBranch();
    // Without club/notes, increment_union_wallet takes the split path and
    // writes no journal row at all.
    expect(branch).toMatch(/p_club_id:/);
    expect(branch).toMatch(/p_notes:/);
  });

  it('does not write the journal row itself', () => {
    const branch = unionBranch();
    expect(branch).not.toMatch(/union_wallet_transactions'\)/);
    expect(branch).not.toMatch(/\.insert\(/);
  });

  it('does not read the balance back to describe it', () => {
    const branch = unionBranch();
    // A separately-read balance_after reports whatever balance another hand's
    // rake left behind. It belongs to the UPSERT's RETURNING clause.
    expect(branch).not.toMatch(/from\('union_wallets'\)/);
    expect(branch).not.toMatch(/balance_after:/);
  });

  it('checks the one write it makes', () => {
    const branch = unionBranch();
    expect(branch).toMatch(/if \(uwErr\)/);
    expect(branch).toMatch(/reportError\(/);
  });

  it('leaves the standalone-club path alone', () => {
    // Club money is journalled elsewhere; this law is about the union leg.
    expect(RAKE).toMatch(/credit_club_rake_to_treasury/);
  });
});
