import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import BadBeatJackpot from '../src/components/table/BadBeatJackpot';

const props = { amount: 36802, qualifyingHand: 'Aces Full Or Better', miniAmount: 700 };

describe('BBJ banner close controls', () => {
  it('uses matching X buttons and hides each banner independently', () => {
    const open = vi.fn();
    const { container, rerender } = render(<BadBeatJackpot {...props} onOpenDetails={open} />);
    const main = screen.getByRole('button', { name: 'Hide Bad Beat Jackpot', exact: true });
    const mini = screen.getByRole('button', { name: 'Hide Mini Bad Beat Jackpot', exact: true });
    expect(main.className).toBe(mini.className);
    expect(main.textContent).toBe(mini.textContent);
    expect(main.textContent).toBe('\u00D7');
    expect(container.querySelector('button button')).toBeNull();
    fireEvent.click(main);
    expect(
      screen.queryByRole('button', { name: 'Bad Beat Jackpot - View Recent Jackpots', exact: true })
    ).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'Mini Bad Beat Jackpot - View Recent Jackpots',
        exact: true,
      })
    ).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    rerender(<BadBeatJackpot {...props} amount={40000} miniAmount={800} onOpenDetails={open} />);
    expect(screen.queryByRole('button', { name: 'Hide Bad Beat Jackpot', exact: true })).toBeNull();
    fireEvent.click(mini);
    expect(container.querySelector('.bbj-widget')).toBeNull();
    expect(container.querySelector('.bbj-mini-plate')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps the main banner and details action when only the mini is hidden', () => {
    const open = vi.fn();
    render(<BadBeatJackpot {...props} onOpenDetails={open} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Hide Mini Bad Beat Jackpot', exact: true })
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Bad Beat Jackpot - View Recent Jackpots', exact: true })
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'Hide Mini Bad Beat Jackpot', exact: true })
    ).toBeNull();
  });

  it('never hides a jackpot-hit celebration when the banners are dismissed', () => {
    const { container, rerender } = render(<BadBeatJackpot {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Bad Beat Jackpot', exact: true }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Hide Mini Bad Beat Jackpot', exact: true })
    );
    rerender(<BadBeatJackpot {...props} isHit />);
    expect(container.querySelector('.bbj-hit-overlay')).toBeInTheDocument();
    expect(screen.getByText('HIT!')).toBeInTheDocument();
  });

  it('keeps dismissal local to its mounted table view', () => {
    const first = render(<BadBeatJackpot {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Bad Beat Jackpot', exact: true }));
    first.unmount();
    render(<BadBeatJackpot {...props} />);
    expect(
      screen.getByRole('button', { name: 'Hide Bad Beat Jackpot', exact: true })
    ).toBeInTheDocument();
  });

  it.each(['{Enter}', ' '])('hides with native keyboard activation: %s', async (key) => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(<BadBeatJackpot {...props} onOpenDetails={open} />);
    screen.getByRole('button', { name: 'Hide Bad Beat Jackpot', exact: true }).focus();
    await user.keyboard(key);
    expect(screen.queryByRole('button', { name: 'Hide Bad Beat Jackpot', exact: true })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['{Enter}', ' '])(
    'opens mini details once with native keyboard activation: %s',
    async (key) => {
      const user = userEvent.setup();
      const open = vi.fn();
      render(<BadBeatJackpot {...props} onOpenDetails={open} />);
      screen
        .getByRole('button', { name: 'Mini Bad Beat Jackpot - View Recent Jackpots', exact: true })
        .focus();
      await user.keyboard(key);
      expect(open).toHaveBeenCalledTimes(1);
    }
  );

  it.each([null, 0, -1])(
    'does not offer a mini close control without a positive payable amount: %s',
    (miniAmount) => {
      render(<BadBeatJackpot {...props} miniAmount={miniAmount} />);
      expect(
        screen.queryByRole('button', { name: 'Hide Mini Bad Beat Jackpot', exact: true })
      ).toBeNull();
    }
  );
});
