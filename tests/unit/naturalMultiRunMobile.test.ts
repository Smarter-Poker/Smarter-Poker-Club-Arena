import { afterEach, expect, it, vi } from 'vitest';
import {
  completedNaturalRuns,
  installNaturalMultiRunWitness,
} from '../e2e/support/naturalMultiRunMobile';

const packet = { hand: 41, runs: 3, at: 100, recipients: ['winner'] };
const lane = { pendingAt: 110, winnerAt: 220 };
const witness = () => ({
  hands: [{ hand: 41, runs: 3, lanes: [lane, lane, lane] }],
  flights: [{ hand: 41, recipient: 'winner', landedAt: 300, distance: 0.2 }],
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  delete (window as any).__naturalMultiRunWitness;
});

it('requires all three actual pending-to-river transitions and a matching winner landing', () => {
  expect(completedNaturalRuns([packet], witness())).toEqual([packet]);
});
it('refuses a joined final board without an observed pending river', () => {
  const w = witness();
  w.hands[0].lanes = [lane, lane, { pendingAt: null, winnerAt: 220 } as any];
  expect(completedNaturalRuns([packet], w)).toEqual([]);
});
it('does not substitute a two-run hand for three-run coverage', () => {
  const w = witness();
  w.hands[0].runs = 2;
  expect(completedNaturalRuns([packet], w)).toEqual([]);
});
it.each(['wrong recipient', 'off target', 'prior hand', 'before packet'])(
  'refuses %s payout evidence',
  (kind) => {
    const w = witness();
    if (kind === 'wrong recipient') w.flights[0].recipient = 'other';
    if (kind === 'off target') w.flights[0].distance = 3;
    if (kind === 'prior hand') w.flights[0].hand = 40;
    if (kind === 'before packet') w.flights[0].landedAt = 99;
    expect(completedNaturalRuns([packet], w)).toEqual([]);
  }
);
it.each([2, 3])('the actual DOM observer rejects a %i-run award before its river', async (runs) => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 393, 852));
  let tick!: FrameRequestCallback;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    tick = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  await installNaturalMultiRunWitness({
    addInitScript: async (callback: () => void) => callback(),
  } as any);
  document.body.innerHTML = `<div class="table-page"><span class="table-brand__hand">Hand #41</span>${Array.from({ length: runs }, () => `<div class="community-area__run"><span class="community-area__run-winner">Winner</span>${'<i class="community-cards__card"></i>'.repeat(4)}</div>`).join('')}</div>`;
  tick(1);
  expect((window as any).__naturalMultiRunWitness.read().violations).toHaveLength(runs);
});

it('observes the visible table rather than a retained hidden table', async () => {
  let tick!: FrameRequestCallback;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.style.display === 'none' ? new DOMRect() : new DOMRect(0, 0, 393, 852);
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    tick = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  await installNaturalMultiRunWitness({
    addInitScript: async (callback: () => void) => callback(),
  } as any);
  const lane =
    '<div class="community-area__run"><span class="community-area__run-winner">Winner</span></div>';
  document.body.innerHTML = `<div class="table-page" style="display:none"><span class="table-brand__hand">Hand #40</span>${lane.repeat(3)}</div><div class="table-page"><span class="table-brand__hand">Hand #41</span></div>`;
  tick(1);
  expect((window as any).__naturalMultiRunWitness.read()).toMatchObject({
    hands: [],
    violations: [],
  });
});
