/**
 * A dialog that moves money or a seat owns the keyboard (launch audit 2026-10-05).
 *
 * `useTableKeyboard` ignores the action keys while `isModalOpen` is true. The
 * expression TablePage passes for it listed eight dialogs and omitted the
 * cashier, the Diamond wallet, the leave confirmation, both rebuy prompts and
 * the post-or-wait dialog, so with any of those open F still folded the hand
 * behind it and Space still called.
 *
 * TablePage cannot be mounted in a unit test, so this pins the two halves: the
 * hook really does gate the action keys on the flag, and the flag names every
 * dialog below.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBetween } from '../helpers/sourceWindow';

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const PAGE = read('src/pages/TablePage.tsx');
const HOOK = read('src/hooks/useTableKeyboard.ts');

describe('the action keys stand down while a money or seat dialog is open', () => {
  it('the hook gates fold, call and raise on isModalOpen', () => {
    expect(HOOK).toContain('opts.isHeroTurn && !opts.isSpectator && !opts.isModalOpen');
  });

  const flag = sliceBetween(PAGE, 'isModalOpen:', 'onFold:');

  it.each([
    'showCashier',
    'showDiamondWallet',
    'showLeaveConfirm',
    'bustRebuyOpen',
    'showRebuyModal',
    'postOrWaitOpen',
  ])('%s is one of the dialogs that own the keyboard', (dialog) => {
    expect(flag, `${dialog} no longer blocks the action hotkeys`).toMatch(
      new RegExp(`\\b${dialog}\\b`)
    );
  });

  it.each([
    'showMustMoveLobby',
    'showSettings',
    'showInsurance',
    'showRIT',
    'showBuyInModal',
    'showHandHistory',
    'showPlayerNotes',
    'showWaitList',
  ])('%s still does', (dialog) => {
    expect(flag).toMatch(new RegExp(`\\b${dialog}\\b`));
  });
});
