import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SeatSlot, { type SeatPlayer } from '../src/components/table/SeatSlot';
import { CashierModal } from '../src/components/table/CashierModal';
import LeaveTableConfirm from '../src/components/table/LeaveTableConfirm';

const hero = {
  id: 'hero',
  name: 'Hero',
  stack: 0,
  status: 'active',
  showCards: false,
  isHero: true,
} as const;
const chair = (player: SeatPlayer) => (
  <SeatSlot
    seatNumber={1}
    bigBlind={2}
    player={player}
    position={null}
    isActive={false}
    lastAction={null}
  />
);

describe('a Lightning balance with no authoritative figure yet', () => {
  it('does not print or announce the numeric placeholder as a zero balance', () => {
    const player = { ...hero, stackPending: true };
    const { container } = render(chair(player));
    expect(container.querySelector('.seat__stack')?.textContent).toBe('...');
    expect(container.querySelector('.seat__stack')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('region').getAttribute('aria-label')).not.toContain('Stack 0');
    expect(container.textContent).not.toMatch(/Sitting Out|0\.00/i);
  });

  it('repaints a confirmed real zero even when the number itself did not change', () => {
    const { container, rerender } = render(chair({ ...hero, stackPending: true }));
    rerender(chair({ ...hero, stackPending: false }));
    expect(container.querySelector('.seat__stack')?.textContent).toBe('0.00');
    expect(container.querySelector('.seat__stack')?.getAttribute('aria-busy')).toBe('false');
  });

  it('adopts a known balance without inventing a win from the placeholder', () => {
    const { container, rerender } = render(chair({ ...hero, stackPending: true }));
    rerender(chair({ ...hero, stack: 187.5, stackPending: false }));
    expect(container.querySelector('.seat__stack')?.textContent).toBe('188');
    expect(container.querySelector('.seat__stack-delta')).toBeNull();
  });

  it('keeps the short-stack warning for known stacks and never invents one for pending data', () => {
    const { container, rerender } = render(chair({ ...hero, stackPending: true }));
    expect(container.querySelector('.seat__stack--critical')).toBeNull();
    rerender(chair({ ...hero, stack: 10, stackPending: false }));
    expect(container.querySelector('.seat__stack--critical')).not.toBeNull();
  });

  it('keeps the owed animation when a known stack actually grows', () => {
    const { container, rerender } = render(chair({ ...hero, stack: 100, stackPending: false }));
    rerender(chair({ ...hero, stack: 150, stackPending: false }));
    expect(container.querySelector('.seat__stack--up')).not.toBeNull();
  });

  it('the cashier asks for a fresh read without quoting a false zero or accepting a top-up', () => {
    const retry = vi.fn();
    const add = vi.fn(async () => true);
    render(
      <CashierModal
        isOpen
        onClose={vi.fn()}
        onAddChips={add}
        currentStack={0}
        currentStackPending
        accountBalance={500}
        maxBuyIn={200}
        maxStack={200}
        onRetryBalance={retry}
      />
    );
    expect(screen.getByText('Stack Unavailable')).toBeTruthy();
    expect(screen.queryByText('At Table: 0 Chips')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
  });

  it('the leave confirmation does not invent a stack or prevent the authoritative leave', () => {
    const leave = vi.fn();
    render(
      <LeaveTableConfirm
        isOpen
        currentStack={0}
        currentStackPending
        tableName="Lightning"
        onConfirm={leave}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/Current Balance Unavailable/)).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Leave Table' }));
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
