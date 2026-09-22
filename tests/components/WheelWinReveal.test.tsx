import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WheelWinReveal } from '../../src/components/wheel/WheelWinReveal';

vi.mock('../../src/components/common/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  /* Owner ruling 2026-09-21, R1 and R9: a won game is opened by Play Game and
     by nothing else. The reveal used to open it at the end of its own pop
     animation; that pin moved here with the ruling. */
  it('keeps a won bonus game on screen until Play Game is tapped, then opens it once', () => {
    vi.useFakeTimers();
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
    const play = screen.getByRole('button', { name: 'Play Game' });
    expect(play).toBeDisabled();
    fireEvent.animationEnd(screen.getByRole('status'));
    expect(opened).not.toHaveBeenCalled();
    fireEvent.animationEnd(opening);
    fireEvent.animationEnd(opening);
    expect(play).toBeEnabled();
    expect(play).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(opened).not.toHaveBeenCalled();
    fireEvent.click(play);
    fireEvent.click(play);
    expect(opened).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it('labels an upgrade Open Upgrade Wheel and waits for that tap as well', () => {
    const opened = vi.fn();
    const { container } = render(
      <WheelWinReveal
        prize={{ kind: 'upgrade' }}
        title="Bonus Upgrade"
        detail="Your Upgrade"
        onOpen={opened}
      />
    );
    fireEvent.animationEnd(container.querySelector('[data-motion="keep"]')!);
    expect(opened).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Upgrade Wheel' }));
    expect(opened).toHaveBeenCalledTimes(1);
  });
  it('a timed continue is honoured only for an instant prize, never for a game', () => {
    vi.useFakeTimers();
    const chips = vi.fn();
    const game = vi.fn();
    render(
      <WheelWinReveal
        prize={{ kind: 'chips' }}
        title="12 Chips"
        detail="Returning"
        autoContinue
        autoContinueAfterMs={5000}
        onOpen={chips}
      />
    );
    render(
      <WheelWinReveal
        prize={{ kind: 'bonus', game: 'plinko' }}
        title="Diamond Plinko"
        detail="Your Bonus"
        autoContinue
        autoContinueAfterMs={5000}
        onOpen={game}
      />
    );
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(chips).toHaveBeenCalledTimes(1);
    expect(game).not.toHaveBeenCalled();
    vi.useRealTimers();
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
