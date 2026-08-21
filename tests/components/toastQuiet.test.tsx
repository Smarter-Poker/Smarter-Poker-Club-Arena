/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TOAST DOOR STAYS SHUT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * safeErrorMessage's rules are unit-tested next door. This tests the WIRING:
 * that the provider actually applies them, and that the cooldown actually
 * stops a retry loop from pumping the same message onto the screen.
 *
 * Dan 2026-08-21, with two screenshots taken mid-game: "you need to stop these
 * pop ups to users... and it shouldn't just keep popping it up over and over
 * and over."
 */
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToastProvider, useToast } from '../../src/components/common/Toast';

function Harness({ onReady }: { onReady: (t: ReturnType<typeof useToast>) => void }) {
  const toast = useToast();
  onReady(toast);
  return null;
}

function mount() {
  let api!: ReturnType<typeof useToast>;
  render(
    <ToastProvider>
      <Harness onReady={(t) => (api = t)} />
    </ToastProvider>
  );
  return () => api;
}

const visible = () => document.querySelectorAll('.toast').length;

describe('error popups', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never shows the two messages from the screenshots', () => {
    const toast = mount();
    act(() => {
      toast().error('The table is busy - please try again');
      toast().error('TypeError: Failed to fetch');
    });
    expect(visible(), 'an infrastructure error reached the player').toBe(0);
  });

  it('never shows anything the client is already recovering from', () => {
    const toast = mount();
    act(() => {
      toast().error('Server unreachable');
      toast().error('Table not ready - reconnecting');
      toast().error('Your seat is out of sync with the table - resyncing');
      toast().error('Server error (503)');
    });
    expect(visible()).toBe(0);
  });

  it('STILL shows an error the player can act on', () => {
    // The limit on all of the above. Swallowing this means a player taps Buy
    // In with no chips and the app does nothing at all.
    const toast = mount();
    act(() => toast().error('Not enough chips'));
    expect(visible()).toBe(1);
    expect(screen.getByText(/Not Enough Chips/i)).toBeInTheDocument();
  });

  it('does not let a retry loop re-post the same message after it expires', () => {
    /* THE "OVER AND OVER". The old dedupe only blocked a twin that was still
       on screen; a toast lives 4s and the retry cycles are shorter, so the
       same message came straight back when its predecessor expired. */
    const toast = mount();
    act(() => toast().error('Not enough chips'));
    expect(visible()).toBe(1);

    // Let it expire and be removed.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // The loop tries again.
    act(() => toast().error('Not enough chips'));
    expect(visible(), 'the same popup came back').toBe(0);
  });

  it('lets the same message through again once the cooldown has passed', () => {
    // Suppression must not be permanent: an hour later, this is news again.
    const toast = mount();
    act(() => toast().error('Not enough chips'));
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    act(() => toast().error('Not enough chips'));
    expect(visible()).toBe(1);
  });

  it('does not suppress a DIFFERENT message', () => {
    const toast = mount();
    act(() => {
      toast().error('Not enough chips');
      toast().error('You do not have permission');
    });
    expect(visible()).toBe(2);
  });

  it('leaves success and info alone', () => {
    // Only the interrupting error class was ever the complaint.
    const toast = mount();
    act(() => {
      toast().success('Added To The Waitlist');
      toast().info('Seat Reserved');
    });
    expect(visible()).toBe(2);
  });
});
