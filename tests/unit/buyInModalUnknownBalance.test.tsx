/**
 * An unknown balance renders as unknown (Dan 2026-09-04): the bust rebuy read
 * INSUFFICIENT BALANCE on a player holding chips because a failed read was
 * collapsed to 0. Null must say "Unavailable", disable the confirm under an
 * honest label, and offer a Retry that calls back.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BuyInModal from '../../src/components/table/BuyInModal';

const base = {
  isOpen: true,
  onClose: () => {},
  onConfirm: async () => {},
  tableName: 'Test Table',
  minBuyIn: 40,
  maxBuyIn: 200,
  bigBlind: 2,
};

describe('BuyInModal with an unknown balance', () => {
  it('says Unavailable, disables the confirm honestly, and retries on request', () => {
    const onRetry = vi.fn();
    render(<BuyInModal {...base} accountBalance={null} onRetryBalance={onRetry} />);
    expect(screen.getByText('Unavailable')).toBeTruthy();
    const confirm = screen.getByText('Balance Unavailable') as HTMLButtonElement;
    expect(confirm.closest('button')?.disabled).toBe(true);
    expect(screen.queryByText('Insufficient Balance')).toBeNull();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a known balance still behaves as before', () => {
    render(<BuyInModal {...base} accountBalance={10} />);
    expect(screen.getByText('Insufficient Balance')).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
  });
});
