/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A RETRIED CLAIM BACK MUST NOT CHARGE TWICE (2026-08-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_cashier_claim_back moves chips off a player and onto the caller. It had no
 * replay protection, so the one shape that matters most was unhandled: a claim
 * that COMMITTED on the server and then failed on the way back - a dropped
 * connection, a proxy timeout. To the client that is indistinguishable from a
 * claim that never ran. It reports an error, the operator retries, and the
 * player is charged a second time. Every other money path on this platform
 * already carries an idempotency key.
 *
 * `busyRef` does NOT cover this. It stops a double-TAP inside one render; it
 * knows nothing about a request whose response was lost.
 *
 * The server half is enforced by the partial unique index
 * ux_chip_transactions_idempotency_key, which is what settles a true race
 * between two concurrent identical submissions - the pre-check alone loses it.
 * These tests pin the CLIENT half, which the server cannot enforce for itself:
 *
 *   1. a key is actually sent, or the server's guard is dead code;
 *   2. the key survives a failure, or the retry mints a fresh one and the
 *      double-charge comes straight back;
 *   3. the key varies by target and amount, or a legitimate second claim of a
 *      different size gets silently swallowed as a "replay".
 *
 * Source-level on purpose: the failure is a MISSING ARGUMENT on an RPC call,
 * which renders identically to the correct code until you read the payload.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../..', 'src/pages/CashierTradePage.tsx'), 'utf8');

/** The claim branch of runTransfers, isolated from send and ticket. */
const CLAIM_CALL = SRC.slice(
  SRC.indexOf("supabase.rpc('fn_cashier_claim_back'"),
  SRC.indexOf("supabase.rpc('fn_cashier_claim_back'") + 700
);

describe('the claim back RPC carries an idempotency key', () => {
  it('sends p_idempotency_key at all', () => {
    expect(SRC).toContain("supabase.rpc('fn_cashier_claim_back'");
    expect(CLAIM_CALL).toContain('p_idempotency_key');
  });

  it('derives the key from the submission, the target AND the amount', () => {
    // Target: two players in one batch must not collide onto one key, or the
    // second player is refused as a replay of the first.
    // Amount: claiming a different amount from the same player is a NEW
    // intent, and must not be swallowed as a replay of the earlier one.
    expect(CLAIM_CALL).toMatch(/p_idempotency_key:\s*`[^`]*\$\{submissionId\}/);
    expect(CLAIM_CALL).toMatch(/p_idempotency_key:\s*`[^`]*\$\{t\.userId\}/);
    expect(CLAIM_CALL).toMatch(/p_idempotency_key:\s*`[^`]*\$\{claim\}/);
  });
});

describe('the submission id survives a failure', () => {
  it('is held in a ref, not in component state', () => {
    // State would be reset by the re-render that follows the error toast.
    expect(SRC).toMatch(/submissionIdRef\s*=\s*useRef<string \| null>\(null\)/);
  });

  it('is minted only when absent, so a retry reuses it', () => {
    expect(SRC).toMatch(/if\s*\(!submissionIdRef\.current\)/);
  });

  it('is cleared ONLY when every target succeeded', () => {
    // The whole protection is that a FAILED batch keeps its id. Clearing it
    // unconditionally in `finally` would mint a fresh key on the retry and
    // reinstate the double-charge this exists to prevent.
    const fin = SRC.slice(SRC.indexOf('busyRef.current = false;'));
    expect(fin).toMatch(/skipped \+ ok === targets\.length.*submissionIdRef\.current = null/s);
    expect(fin).not.toMatch(/^\s*submissionIdRef\.current = null;\s*$/m);
  });
});
