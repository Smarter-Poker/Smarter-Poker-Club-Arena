import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMobileAwardJournal } from '../e2e/support/mobileLiveTableLayout';

const page = { evaluate: async (read: () => unknown) => read() } as any;
function rect(x: number, y: number) {
  return { left: x - 18, top: y - 18, width: 36, height: 36 } as DOMRect;
}
async function flight(phase = 'flying') {
  vi.useFakeTimers();
  document.body.innerHTML = '<div data-player-id="winner"><div class="seat__info"></div></div>';
  vi.spyOn(document.querySelector('.seat__info')!, 'getBoundingClientRect').mockReturnValue(
    rect(100, 100)
  );
  await installMobileAwardJournal(page);
  const chip = document.createElement('div');
  chip.dataset.chipRecipient = 'winner';
  chip.dataset.chipFlight = 'real-flight';
  chip.dataset.chipPhase = phase;
  const bounds = vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue(rect(0, 0));
  document.body.append(chip);
  await Promise.resolve();
  return { chip, bounds, evidence: () => (window as any).__mobileAwardJournal.stop() };
}
afterEach(() => {
  (window as any).__mobileAwardJournal?.stop();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('real mobile payout presentation evidence', () => {
  it('records the visible recipient endpoint even if a transient phase attribute was never committed', async () => {
    const f = await flight();
    f.bounds.mockReturnValue(rect(100, 100));
    await vi.advanceTimersByTimeAsync(32);
    f.chip.remove();
    await Promise.resolve();
    expect(f.evidence()).toMatchObject({
      landings: [{ recipient: 'winner', distance: 0 }],
      violations: [],
    });
  });
  it('refuses a flight that disappears before reaching its recipient', async () => {
    const f = await flight();
    f.chip.remove();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(32);
    expect(f.evidence()).toMatchObject({
      landings: [],
      violations: ['Payout Disappeared Before Reaching Its Recipient'],
    });
  });
  it('preserves an explicit landing when its recipient moves during the endpoint hold', async () => {
    const f = await flight();
    f.bounds.mockReturnValue(rect(100, 100));
    f.chip.dataset.chipPhase = 'landed';
    await Promise.resolve();
    // The recipient can reflow after the endpoint was visibly committed.
    // A later sample must not rewrite that completed flight as never landed.
    vi.mocked(document.querySelector('.seat__info')!.getBoundingClientRect).mockReturnValue(
      rect(100, 124)
    );
    await vi.advanceTimersByTimeAsync(32);
    f.chip.remove();
    await Promise.resolve();
    expect(f.evidence()).toMatchObject({
      landings: [{ recipient: 'winner', distance: 0 }],
      violations: [],
    });
  });
  it('refuses a flight that passes the recipient then ends elsewhere', async () => {
    const f = await flight();
    f.bounds.mockReturnValue(rect(100, 100));
    await vi.advanceTimersByTimeAsync(32);
    f.bounds.mockReturnValue(rect(140, 100));
    await vi.advanceTimersByTimeAsync(32);
    f.chip.remove();
    await Promise.resolve();
    expect(f.evidence()).toMatchObject({
      landings: [],
      violations: ['Payout Disappeared Before Reaching Its Recipient'],
    });
  });
  it('keeps the two-pixel recipient limit for an explicitly landed chip', async () => {
    const f = await flight('landed');
    expect(f.evidence().violations).toContain('Payout Missed Its Rendered Recipient');
  });
});
