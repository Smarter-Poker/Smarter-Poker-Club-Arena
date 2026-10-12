// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TournamentWinnerOverlay from '../../src/components/table/TournamentWinnerOverlay';
import { CHIP_UNIT_CENTS } from '../../server/src/tournament/tournamentUnit';

let frames: Map<number, FrameRequestCallback>;
let sequence: number;
beforeEach(() => {
  frames = new Map();
  sequence = 0;
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function tick(time: number) {
  const batch = [...frames.entries()];
  expect(batch.length).toBeGreaterThan(0);
  for (const [id] of batch) frames.delete(id);
  act(() => {
    vi.setSystemTime(time);
    for (const [, callback] of batch) callback(time);
  });
}
/* A chip event, stated (2026-09-21): the overlay now takes the unit the event
   paid in, and a chip unit is the contract these assertions were written for.
   The Diamond and unread halves live in
   tests/components/TournamentWinnerOverlayUnit.test.tsx. */
const props = {
  isWinner: true,
  prize: 100,
  unitCents: CHIP_UNIT_CENTS,
  tournamentName: 'Test Event',
  onDismiss: vi.fn(),
};

describe('winner prize animation ownership', () => {
  it('contains keyboard focus and closes with Escape, restoring the prior control', () => {
    const prior = document.createElement('button');
    document.body.appendChild(prior);
    prior.focus();
    const onDismiss = vi.fn();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<TournamentWinnerOverlay {...props} onDismiss={onDismiss} />);
    tick(0);
    const dialog = screen.getByRole('dialog');
    const continuation = screen.getByRole('button', { name: 'Continue' });
    expect(document.activeElement).toBe(continuation);
    const initialCall = focus.mock.calls[focus.mock.contexts.lastIndexOf(continuation)];
    expect(initialCall?.[0]?.preventScroll).not.toBe(true);
    focus.mockRestore();
    continuation.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(continuation);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(prior);
    act(() => vi.advanceTimersByTime(500));
    expect(onDismiss).toHaveBeenCalledOnce();
    prior.remove();
  });
  it('a background table cannot take focus or Escape from the active table', () => {
    const prior = document.createElement('button');
    document.body.appendChild(prior);
    prior.focus();
    const onDismiss = vi.fn();
    const view = render(
      <TournamentWinnerOverlay {...props} isActive={false} onDismiss={onDismiss} />
    );
    tick(200);
    expect(document.activeElement).toBe(prior);
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => vi.advanceTimersByTime(500));
    expect(onDismiss).not.toHaveBeenCalled();
    view.rerender(<TournamentWinnerOverlay {...props} isActive onDismiss={onDismiss} />);
    tick(750);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' }));
    view.unmount();
    expect(document.activeElement).toBe(prior);
    prior.remove();
  });
  it('retires a pending dismissal when the winner is withdrawn before continuation', () => {
    const onDismiss = vi.fn();
    const view = render(<TournamentWinnerOverlay {...props} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    view.rerender(<TournamentWinnerOverlay {...props} onDismiss={onDismiss} isWinner={false} />);
    view.rerender(<TournamentWinnerOverlay {...props} onDismiss={onDismiss} prize={50} />);
    act(() => vi.advanceTimersByTime(500));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('cancels the latest recursive frame on unmount and ignores a stale callback', () => {
    const view = render(<TournamentWinnerOverlay {...props} />);
    tick(200);
    const stale = frames.values().next().value!;
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
    act(() => stale(400));
    expect(frames.size).toBe(0);
  });
  it('stops when hidden while the component remains mounted', () => {
    const view = render(<TournamentWinnerOverlay {...props} />);
    tick(200);
    view.rerender(<TournamentWinnerOverlay {...props} isWinner={false} />);
    expect(frames.size).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps the earned amount on the glass throughout its dismissal fade', () => {
    const onDismiss = vi.fn();
    render(<TournamentWinnerOverlay {...props} onDismiss={onDismiss} />);
    tick(1500);
    expect(screen.getByText('Prize: 100')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Prize: 100')).toBeTruthy();
    act(() => vi.advanceTimersByTime(499));
    expect(screen.getByText('Prize: 100')).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
  it('stops on dismissal and calls its continuation once', () => {
    const onDismiss = vi.fn();
    render(<TournamentWinnerOverlay {...props} onDismiss={onDismiss} />);
    tick(200);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(frames.size).toBe(0);
    act(() => vi.advanceTimersByTime(500));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
  it('restarts from zero for a replacement prize and finishes at that exact value', () => {
    const view = render(<TournamentWinnerOverlay {...props} />);
    tick(200);
    view.rerender(<TournamentWinnerOverlay {...props} prize={50} />);
    expect(screen.getByText('Prize: 0')).toBeTruthy();
    expect(frames.size).toBe(1);
    tick(1700);
    expect(screen.getByText('Prize: 50')).toBeTruthy();
    expect(frames.size).toBe(0);
  });
});
