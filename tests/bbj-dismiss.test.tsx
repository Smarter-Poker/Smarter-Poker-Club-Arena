import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import BadBeatJackpot from '../src/components/table/BadBeatJackpot';

const props = { amount: 36802, qualifyingHand: 'Aces Full Or Better', miniAmount: 700 };
const mainName = 'Bad Beat Jackpot - View Recent Jackpots';
const miniName = 'Mini Bad Beat Jackpot - View Recent Jackpots';

describe('BBJ corner banners without close controls', () => {
  it('keeps both plates visible and unobstructed after details and amount updates', () => {
    const open = vi.fn();
    const { container, rerender } = render(<BadBeatJackpot {...props} onOpenDetails={open} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Hide / })).toBeNull();
    expect(container.querySelector('button button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: mainName, exact: true }));
    fireEvent.click(screen.getByRole('button', { name: miniName, exact: true }));
    expect(open).toHaveBeenCalledTimes(2);
    rerender(<BadBeatJackpot {...props} amount={40000} miniAmount={800} onOpenDetails={open} />);
    expect(screen.getByRole('button', { name: mainName, exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: miniName, exact: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Hide / })).toBeNull();
  });

  it.each([mainName, miniName])('opens %s once per native keyboard activation', async (name) => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(<BadBeatJackpot {...props} onOpenDetails={open} />);
    screen.getByRole('button', { name, exact: true }).focus();
    await user.keyboard('{Enter}');
    expect(open).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('retains the jackpot-hit celebration alongside both plates', () => {
    const { container } = render(<BadBeatJackpot {...props} isHit />);
    expect(container.querySelector('.bbj-hit-overlay')).toBeInTheDocument();
    expect(screen.getByText('HIT!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: mainName, exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: miniName, exact: true })).toBeInTheDocument();
  });

  it.each([null, 0, -1])('only shows the mini when it can pay: %s', (miniAmount) => {
    render(<BadBeatJackpot {...props} miniAmount={miniAmount} />);
    expect(screen.queryByRole('button', { name: miniName, exact: true })).toBeNull();
    expect(screen.getByRole('button', { name: mainName, exact: true })).toBeInTheDocument();
  });
});
