/**
 * LAW: A TOP-UP IS CHARGED ONCE (Realtime Phase 3 audit, 2026-09-05)
 *
 * `/addchips` is the one money route on this engine where a repeat is
 * indistinguishable from a genuine second request. Every other paid route is
 * idempotent by STATE - you cannot post the big blind twice, respond to one
 * insurance offer twice, or buy the same rabbit hunt twice, because the second
 * call finds the hand already changed. A top-up has no such state: topping up
 * twice is a thing a player may legitimately do.
 *
 * So the Cashier audit (2026-08-27, P0-1) built a key for it. `/addchips`
 * takes an `opId` and the engine keys the debit on
 * `addon:<table>:<user>:<opId || randomUUID()>` - which means a caller that
 * sends NOTHING gets a fresh key every attempt and no de-duplication at all.
 * The window that costs money is not a double tap (guarded) and not a 401
 * retry (refused before the debit): it is **the debit committed and the
 * response was lost**, after which the client still sees a short stack and
 * asks again.
 *
 * On 2026-09-05 the MANUAL cashier held a key and the AUTOMATIC top-up did
 * not, so the one path that retries without a human deciding to was the one
 * path with no protection.
 *
 * PINS
 *   1. Every caller of addChips passes an opId.
 *   2. Each holds it across retries and keys it by amount - a retry for the
 *      same shortfall is the same purchase; a different amount is a new one.
 *   3. The key is released once it has been spent, so a later top-up cannot
 *      replay an earlier one's answer.
 *   4. The prop type carries `opId` all the way down. It did not, and the key
 *      survived only because the layer forwards the function object instead of
 *      wrapping it.
 *   5. The transport-failure path still refuses to claim the wallet was not
 *      charged - the claim this key exists because nobody can make.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceEnclosingBlock, sliceMethod, blankNonCode } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const TABLE_PAGE = read('src', 'pages', 'TablePage.tsx');
const CASHIER = read('src', 'components', 'table', 'CashierModal.tsx');
const LAYER = read('src', 'components', 'table', 'TableModalsLayer.tsx');
const API = read('src', 'services', 'GameServerAPI.ts');
const HANDLER = read('server', 'src', 'handlers', 'addchips.ts');

describe('LAW 1 - every caller passes a key', () => {
  it('no call to addChips or handleAddChips is made with the amount alone', () => {
    const src = blankNonCode(TABLE_PAGE);
    /* The whole defect in one regex: `handleAddChips(x)` with a single
       argument. Both call sites must carry a second. */
    const bare = src.match(/\bhandleAddChips\(\s*[A-Za-z0-9_.]+\s*\)/g) ?? [];
    expect(bare, `these calls send no opId: ${bare.join(', ')}`).toEqual([]);
    const bareApi =
      src.match(/GameServerAPI\.addChips\(\s*[A-Za-z0-9_.]+\s*,\s*[A-Za-z0-9_.]+\s*\)/g) ?? [];
    expect(bareApi, `these calls send no opId: ${bareApi.join(', ')}`).toEqual([]);
  });

  it('the automatic top-up mints and sends one', () => {
    const block = sliceEnclosingBlock(TABLE_PAGE, 'autoTopUpInFlightRef.current = true');
    expect(block).toContain('autoTopUpKeyRef.current');
    expect(block).toMatch(/handleAddChips\(topUpAmount,\s*autoTopUpKeyRef\.current\.key\)/);
  });

  it('the manual cashier mints and sends one', () => {
    const fn = sliceMethod(CASHIER, 'const handleConfirm = useCallback(async () => {');
    expect(fn).toContain('opIdRef.current = uuid()');
    expect(fn).toContain('onAddChips(amount, opIdRef.current)');
  });
});

describe('LAW 2/3 - held across retries, keyed by amount, released when spent', () => {
  it('the automatic key is reused unless the amount changed', () => {
    const block = sliceEnclosingBlock(TABLE_PAGE, 'autoTopUpInFlightRef.current = true');
    expect(block).toMatch(
      /if \(!autoTopUpKeyRef\.current \|\| autoTopUpKeyRef\.current\.amount !== topUpAmount\)/
    );
    expect(block).toContain('crypto.randomUUID()');
  });

  it('the automatic key is cleared only after the chips actually moved', () => {
    const block = sliceEnclosingBlock(TABLE_PAGE, 'autoTopUpInFlightRef.current = true');
    const cleared = block.indexOf('autoTopUpKeyRef.current = null');
    expect(cleared, 'the key is never released, so a later top-up replays it').toBeGreaterThan(-1);
    // Inside the success branch, not the finally: releasing on failure would
    // hand the next attempt a fresh key and undo the whole mechanism.
    const success = block.indexOf('.then((res) => {');
    const finallyAt = block.indexOf('.finally(');
    expect(cleared).toBeGreaterThan(success);
    expect(cleared).toBeLessThan(finallyAt);
  });

  it('the manual key is reset when the amount changes, and only then', () => {
    // CashierModal drops its held id in an effect on [amount].
    const effect = sliceEnclosingBlock(CASHIER, 'opIdRef.current = null');
    expect(effect).toContain('opIdRef.current = null');
    expect(CASHIER).toMatch(/\}, \[amount\]\);/);
  });
});

describe('LAW 4 - the key survives every hop of the prop chain', () => {
  it('TableModalsLayer declares opId rather than dropping it', () => {
    expect(LAYER).toMatch(/onAddChips: \(amount: number, opId\?: string\) => Promise<boolean>/);
  });

  it('CashierModal declares it too, and the two agree', () => {
    expect(CASHIER).toMatch(/onAddChips: \(amount: number, opId\?: string\) => Promise<boolean>/);
  });

  it('the layer forwards the function, it does not wrap and narrow it', () => {
    // `onAddChips={onAddChips}` keeps the second argument. A lambda taking one
    // parameter would silently eat the key - which is exactly what the type
    // above now makes impossible to write.
    expect(LAYER).toContain('onAddChips={onAddChips}');
  });

  it('the API and the handler both still speak opId', () => {
    expect(API).toMatch(/opId \? \{ tableId, amount, opId \} : \{ tableId, amount \}/);
    expect(HANDLER).toContain('const rawOpId = body.opId');
    expect(HANDLER).toContain('engine.addChips(userId, amount, opId)');
  });
});

describe('LAW 5 - a lost response never claims the wallet was not charged', () => {
  it('the transport case says the outcome is unknown', () => {
    expect(TABLE_PAGE).toContain("res.code === 'TRANSPORT'");
    expect(TABLE_PAGE).toContain('Your Chips May Have Been Added');
  });
});
