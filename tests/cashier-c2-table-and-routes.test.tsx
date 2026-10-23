/**
 * Audit C2, the table top-up sheet and the two table controls that open it
 * (2026-10-09; ported onto the redesigned main 2026-10-11). Each test names the
 * finding it pins; every one of them fails against the code as it stood
 * before the fix.
 */
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { sliceBetween, sliceStatement } from './helpers/sourceWindow';
import { CashierModal } from '../src/components/table/CashierModal';

const TABLE_PAGE = readFileSync('src/pages/TablePage.tsx', 'utf8');

/* UPDATED 2026-10-09 (merged with launch audit R-05 / R-14): the sheet prints
   nothing below its painted frame any more. What these two cases pin is
   unchanged - no negative figure and a stated reason at the table maximum; an
   unread balance that is Unavailable everywhere, with a Retry - but the words
   are on the status line INSIDE the frame and the Retry is the painted money
   plate, so the cases read them there. */
describe('C2-17: the table top-up sheet', () => {
  const timer = () => document.querySelector('.addon-console__timer') as HTMLElement;

  it('never offers a negative amount when the stack is already over the maximum', () => {
    render(
      <CashierModal
        isOpen
        onClose={vi.fn()}
        onAddChips={vi.fn()}
        currentStack={1200}
        accountBalance={500}
        maxBuyIn={1000}
        maxStack={1000}
      />
    );
    expect(timer().textContent).toContain(
      'Your Stack Is At The Table Maximum, So There Is Nothing To Add.'
    );
    // 1,000 - 1,200 is -200: no figure on the sheet may say so.
    expect(document.body.textContent).not.toMatch(/-\s?200/);
    for (const preset of ['25%', '50%', '75%', 'MAX']) {
      expect((screen.getByText(preset) as HTMLButtonElement).disabled, preset).toBe(true);
    }
    expect(screen.getByRole('button', { name: 'Add 0' })).toBeDisabled();
    expect(document.querySelector('.addon-console__messages')).toBeNull();
  });

  it('an unread balance is Unavailable everywhere, with a Retry', () => {
    const retry = vi.fn();
    render(
      <CashierModal
        isOpen
        onClose={vi.fn()}
        onAddChips={vi.fn()}
        currentStack={100}
        accountBalance={null}
        onRetryBalance={retry}
        maxBuyIn={1000}
        maxStack={1000}
      />
    );
    expect(timer().textContent).toContain('Balance Unavailable');
    expect(document.body.textContent).not.toContain('Available To Add');
    expect(
      screen.getByText('Wallet Balance').parentElement?.querySelector('strong')?.textContent
    ).toBe('Unavailable');
    expect(document.querySelector('.addon-console__messages')).toBeNull();
    const plate = screen.getByRole('button', { name: 'Retry' });
    expect(plate.classList.contains('addon-console__plate--primary')).toBe(true);
    fireEvent.click(plate);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('C2-17: a spectator cannot open Top Up', () => {
  it('the tab bar Top Up case asks for a seat before it opens the sheet', () => {
    const branch = sliceBetween(TABLE_PAGE, "case 'REBUY':", "case 'LEADERBOARD':");
    const seated = branch.indexOf('if (tableState.heroSeat <= 0)');
    expect(seated, 'the case never asks whether the hero is seated').toBeGreaterThan(-1);
    expect(seated).toBeLessThan(branch.indexOf('setShowCashier(true)'));
    expect(seated).toBeLessThan(branch.indexOf('handleTournamentRebuy()'));
  });

  it('the table menu offers its Top Up items to a seated hero only', () => {
    const items = sliceBetween(
      TABLE_PAGE,
      "...(tableState.arenaAsset === 'diamonds'",
      "id: 'auto-top-up'"
    );
    // The Diamond cash item and the chip cash item.
    expect(items).toContain('!canTopUpSeat || tableState.heroSeat <= 0');
    expect(items).toMatch(
      /: tableState\.heroSeat > 0\s*\?\s*\[\s*\{\s*id: 'rebuy',\s*label: 'Top Up'/
    );
  });
});

describe('C2-17: the mid-hand queued top-up names chips the house way', () => {
  it('prints compactChips with its unit, never a two-decimal bare number', () => {
    const handler = sliceStatement(TABLE_PAGE, 'const handleAddChips =');
    expect(handler).toContain('Your Top-Up Of ${compactChips(applied)} ${topUpUnits} Lands');
    expect(handler).not.toContain('applied.toFixed(2)');
  });
});
