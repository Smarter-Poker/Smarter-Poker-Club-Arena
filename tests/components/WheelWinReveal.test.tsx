import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WheelWinReveal } from '../../src/components/wheel/WheelWinReveal';

vi.mock('../../src/components/common/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, eyebrow }: { children: React.ReactNode; eyebrow?: string }) => (
    <div>
      <p data-eyebrow>{eyebrow}</p>
      {children}
    </div>
  ),
}));
vi.mock('../../src/utils/animationSpeed', () => ({ getAnimationSpeed: () => 1 }));

describe('the winning sector opens the awarded experience', () => {
  it('pauses the reveal while the player is in another tab', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    const { container, unmount } = render(
      <WheelWinReveal
        prize={{ kind: 'bonus', game: 'crash' }}
        title="Diamond Crash"
        detail="Your Bonus"
        onOpen={vi.fn()}
      />
    );
    const opening = container.querySelector('[data-motion="keep"]') as HTMLElement;
    expect(opening.style.animationPlayState).toBe('running');
    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(opening.style.animationPlayState).toBe('paused');
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(opening.style.animationPlayState).toBe('running');
    unmount();
    visibility.mockRestore();
  });
  it('opens a bonus exactly once when its complete reveal finishes', () => {
    const opened = vi.fn();
    const { container } = render(
      <WheelWinReveal
        prize={{ kind: 'bonus', game: 'mines' }}
        title="Diamond Mines"
        detail="Your Bonus"
        onOpen={opened}
      />
    );
    const opening = container.querySelector('[data-motion="keep"]')!;
    fireEvent.animationEnd(screen.getByRole('status'));
    expect(opened).not.toHaveBeenCalled();
    fireEvent.animationEnd(opening);
    fireEvent.animationEnd(opening);
    expect(opened).toHaveBeenCalledTimes(1);
  });
  it('keeps an instant prize open for the player to read before continuing', () => {
    const opened = vi.fn();
    const { container } = render(
      <WheelWinReveal
        prize={{ kind: 'chips' }}
        title="3 Chips"
        detail="Paid To Your Account"
        onOpen={opened}
      />
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.animationEnd(container.querySelector('[data-motion="keep"]')!);
    expect(opened).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

/**
 * A RECEIPT SAYS WHAT IT IS (2026-09-22). Every chips receipt was headed "You
 * Won", including the one a Donkey Cross hit or a Crash crash pays out of the
 * guaranteed minimum. The wheel's own prizes are always won and keep it.
 */
describe('a receipt that is not a win says so', () => {
  const eyebrow = () => document.querySelector('[data-eyebrow]')?.textContent;
  it('heads the receipt with what the round was, when it was not a win', () => {
    render(
      <WheelWinReveal
        prize={{ kind: 'chips' }}
        title="0.10 Chips"
        detail="Hit At Street 3."
        eyebrow="Guarantee Paid"
        onOpen={vi.fn()}
      />
    );
    expect(eyebrow()).toBe('Guarantee Paid');
  });
  it('keeps You Won, and the wheel upgrade, when nothing overrides it', () => {
    const { unmount } = render(
      <WheelWinReveal
        prize={{ kind: 'chips' }}
        title="3 Chips"
        detail="Paid To Your Account"
        onOpen={vi.fn()}
      />
    );
    expect(eyebrow()).toBe('You Won');
    unmount();
    render(
      <WheelWinReveal
        prize={{ kind: 'upgrade' }}
        title="Super Spin"
        detail="Your Next Spin Is Doubled"
        onOpen={vi.fn()}
      />
    );
    expect(eyebrow()).toBe('Wheel Upgrade');
  });
});
