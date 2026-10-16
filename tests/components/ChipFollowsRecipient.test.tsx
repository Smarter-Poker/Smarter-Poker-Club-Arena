import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import ChipAnimation from '../../src/components/table/ChipAnimation';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('payout tracks the rendered recipient through its full flight', () => {
  it('lands on a plate moved after launch without restarting the flight', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as any);
    let recipient = { x: 100, y: 100 };
    const liveTarget = { resolveTarget: () => recipient };
    const { container, rerender } = render(
      <ChipAnimation
        {...liveTarget}
        flightId="award"
        recipientId="winner"
        from={{ x: 0, y: 0 }}
        to={{ x: 100, y: 100 }}
        amount={20}
        duration={600}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    recipient = { x: 100, y: 108 };
    // A viewport fit updates frame coordinates too; it must not restart time.
    rerender(
      <ChipAnimation
        {...liveTarget}
        flightId="award"
        recipientId="winner"
        from={{ x: 1, y: 1 }}
        to={{ x: 101, y: 101 }}
        amount={20}
        duration={600}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(510);
    });
    const chip = container.querySelector<HTMLElement>('[data-chip-recipient="winner"]')!;
    expect(chip.style.transform).toMatch(/^translate\(100px, 108px\)/);
    expect(chip.dataset.chipPhase).toBe('landed');
  });
  it('repositions a settled background-table flight when its recipient becomes visible', () => {
    vi.useFakeTimers();
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([] as any);
    let recipient = { x: 100, y: 100 };
    const props = {
      flightId: 'background-award',
      recipientId: 'winner',
      from: { x: 0, y: 0 },
      to: { x: 100, y: 100 },
      amount: 20,
      resolveTarget: () => recipient,
    };
    const { container, rerender } = render(<ChipAnimation {...props} />);
    recipient = { x: 100, y: 108 };
    rects.mockReturnValue([{}] as any);
    rerender(<ChipAnimation {...props} resolveTarget={() => recipient} />);
    expect(
      container.querySelector<HTMLElement>('[data-chip-recipient="winner"]')!.style.transform
    ).toMatch(/^translate\(100px, 108px\)/);
  });
});
