/**
 * A READ THAT NEVER HAPPENED IS NOT A BALANCE OF ZERO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The 2026-08-25 audit established this rule and fixed ONE call site (the
 * tournament sign-up gate), but left `WalletService.getPlayerBalance` in
 * place - a helper whose entire body was `return r.balance ?? 0`. Five more
 * sites kept the defect, and it got worse on 2026-08-27 when
 * `readPlayerBalance` stopped falling back to the retired wallet pool: an
 * unreachable RPC used to answer with a stale number and now honestly
 * answers null, so the `?? 0` fires far more often.
 *
 * What a false zero actually did:
 *   useGlobalBalanceSync  wrote it into useUserStore.totalChips, the GLOBAL
 *                         figure the whole app renders - one refused read
 *                         blanked a funded player everywhere at once
 *   ChipTransferModal     senderBalance gates the send, so it BLOCKED AN
 *                         AGENT FROM SENDING CHIPS THEY ACTUALLY HELD
 *   TablePage x3          buy-in sheet, add-on affordability, balance resync
 *
 * These are source pins rather than render tests on purpose: the property is
 * "no call site collapses unknown into a number", which is a statement about
 * every site at once, and a render test would only ever cover the one screen
 * somebody remembered to write.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** Strip comments so the prose ABOUT the old bug cannot satisfy a pin. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the collapsing balance helper is gone', () => {
  it('WalletService no longer exposes getPlayerBalance', () => {
    const wallet = code(read('src/services/WalletService.ts'));
    expect(wallet).not.toMatch(/async getPlayerBalance\(/);
  });

  it('readPlayerBalance still exists and can still answer "unknown"', () => {
    // The replacement has to be able to express the thing the helper could not.
    const wallet = code(read('src/services/WalletService.ts'));
    expect(wallet).toMatch(/async readPlayerBalance\(/);
    expect(wallet).toMatch(/return \{ balance: null, source: 'failed' \}/);
  });

  it('no source file calls the deleted helper', () => {
    for (const f of [
      'src/core/useGlobalBalanceSync.ts',
      'src/components/agent/ChipTransferModal.tsx',
      'src/pages/TablePage.tsx',
      'src/components/tournament/signUpDialog.tsx',
    ]) {
      expect(code(read(f)), `${f} still calls getPlayerBalance`).not.toMatch(/getPlayerBalance\(/);
    }
  });
});

describe('the five recovered call sites guard on null', () => {
  it('the global chip figure is not blanked by a refused read', () => {
    const src = code(read('src/core/useGlobalBalanceSync.ts'));
    expect(src).toMatch(/readPlayerBalance\(/);
    // The store write must be behind a null check, not unconditional.
    expect(src).toMatch(/if \(r\.balance !== null\)[\s\S]{0,120}updateTotalChips/);
  });

  /**
   * MOVED, NOT DROPPED (phase 3 of 7, 2026-08-31).
   *
   * This pin used to require ChipTransferModal to call
   * WalletService.readPlayerBalance and null-guard the result. The modal no
   * longer calls it, because reading the GLOBAL player wallet was itself the
   * larger bug: that is not the account either of its sends debits. It now
   * reads clubs.chip_treasury for a bank role and agents.agent_wallet_balance
   * for an agent, which is the account that actually moves.
   *
   * The RULE this pin exists for is unchanged and still enforced here: an
   * unreadable balance must stay UNKNOWN and must never harden into a zero
   * that refuses a send the server would have allowed. The mechanism is now a
   * `number | null` that only the error-free branch writes, and a guard that
   * refuses only on a number it actually has.
   */
  it('an agent is never told they have nothing to send', () => {
    const src = code(read('src/components/agent/ChipTransferModal.tsx'));
    // Unknown is representable, and is where it starts.
    expect(src).toMatch(/useState<number \| null>\(null\)/);
    // Only a read that did NOT error may write a number.
    expect(src).toMatch(/if \(!bankErr\) setSenderBalance\(/);
    expect(src).toMatch(/if \(!floatErr\) setSenderBalance\(/);
    // And the send guard refuses only on a number it has.
    expect(src).toMatch(/senderBalance !== null && transferAmount > senderBalance/);
    // The global wallet is not consulted for a club-scoped send any more.
    expect(src).not.toMatch(/readPlayerBalance\(/);
  });

  it('the table balance is not zeroed by a failed buy-in or resync read', () => {
    const src = code(read('src/pages/TablePage.tsx'));
    // Both the buy-in read and the realtime resync guard before setting.
    const guarded = src.match(
      /if \(rb\.balance !== null\) setBalanceIfCurrent\(\w+, rb\.balance\)/g
    );
    expect(guarded, 'expected both TablePage balance writes to be null-guarded').toHaveLength(2);
    expect(src).not.toMatch(/\.then\(setBalanceIfCurrent\)/);
  });
});
