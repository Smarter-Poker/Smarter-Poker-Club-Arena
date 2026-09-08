// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TournamentWinnerOverlay from '../../src/components/table/TournamentWinnerOverlay';

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
  const first = frames.entries().next().value;
  expect(first).toBeDefined();
  const [id, callback] = first!;
  frames.delete(id);
  act(() => {
    vi.setSystemTime(time);
    callback(time);
  });
}
const props = { isWinner: true, prize: 100, tournamentName: 'Test Event', onDismiss: vi.fn() };

describe('winner prize animation ownership', () => {
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
