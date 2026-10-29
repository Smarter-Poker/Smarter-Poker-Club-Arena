import { afterEach, expect, it, vi } from 'vitest';
import {
  naturalSingleRunPackets,
  naturalSingleRunClockAligned,
  completedNaturalSingleRuns,
  installNaturalMultiRunWitness,
  naturalMultiRunRequiredRuns,
} from '../e2e/support/naturalMultiRunMobile';

const frame = () => ({
  at: 900,
  direction: 'received',
  message: {
    type: 'EVENT',
    payload: {
      type: 'rit_single_run',
      table_id: 'table',
      hand_number: 41,
      reason: 'chooser_chose_one',
      runs_dealt: 1,
    },
  },
});
const clock = { nodeBefore: 800, browserNow: 800, nodeAfter: 800 };
const packets = () => naturalSingleRunPackets([frame()], 'table', 800);
afterEach(() => {
  (window as any).__naturalMultiRunWitness?.stop();
  delete (window as any).__naturalMultiRunWitness;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
it('retains only real nonreplayed once decision identity and reason, never card payloads', () => {
  const event: any = frame();
  event.message.payload.cards = ['private'];
  expect(naturalSingleRunPackets([event], 'table', 800)).toEqual([
    { at: 900, hand: 41, runs: 1, reason: 'chooser_chose_one' },
  ]);
});
it.each([
  'replay',
  'envelope replay',
  'wrong table',
  'stale',
  'ordinary board',
  'missing reason',
  'invalid hand',
  'sent',
  'wrong runs',
])('refuses %s as once decision evidence', (kind) => {
  const f: any = frame();
  const p = f.message.payload;
  if (kind === 'replay') p.replayed = true;
  if (kind === 'envelope replay') f.message.replayed = true;
  if (kind === 'wrong table') p.table_id = 'other';
  if (kind === 'stale') f.at = 799;
  if (kind === 'ordinary board') p.type = 'community_cards_dealt';
  if (kind === 'missing reason') delete p.reason;
  if (kind === 'invalid hand') p.hand_number = 0;
  if (kind === 'sent') f.direction = 'sent';
  if (kind === 'wrong runs') p.runs_dealt = 3;
  expect(naturalSingleRunPackets([f], 'table', 800)).toEqual([]);
});
it.each([
  ['true', 'null'],
  ['null', 'true'],
])('refuses mixed once modes %s/%s', (horse, navigation) => {
  expect(() => naturalMultiRunRequiredRuns('1', 'true', 'null', horse, navigation)).toThrow(
    /mixed/
  );
});
async function install(cards = 4) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 100, 30)
  );
  document.body.innerHTML = `<div class="table-page"><span class="table-brand__hand">Hand #41</span><div class="community-area">${'<i class="community-cards__card"></i>'.repeat(cards)}</div></div>`;
  await installNaturalMultiRunWitness({ addInitScript: async (cb: () => void) => cb() } as any);
  return (window as any).__naturalMultiRunWitness;
}
async function sample(at: number) {
  vi.setSystemTime(at);
  document.querySelector('.community-area')!.setAttribute('style', `--sample:${at}`);
  await Promise.resolve();
  await Promise.resolve();
}
it('an ordinary board cannot certify once without a validated decision mark', async () => {
  const w = await install();
  await sample(1400);
  expect(w.read().singleRuns).toEqual([]);
  expect(completedNaturalSingleRuns(packets(), w.read(), clock)).toEqual([]);
});
it('actual DOM witness requires the same visible hand and two stable clear card samples', async () => {
  const w = await install();
  const packet = packets()[0];
  w.markSingleRunDecision(packet);
  expect(completedNaturalSingleRuns([packet], w.read(), clock)).toEqual([]);
  await sample(1300);
  expect(completedNaturalSingleRuns([packet], w.read(), clock)).toEqual([packet]);
  expect(w.read().singleRuns[0]).toMatchObject({
    hand: 41,
    reason: 'chooser_chose_one',
    markedAt: 1000,
    statusClearAt: 1000,
    boardCards: 4,
  });
  expect(w.read().violations).toEqual([]);
  expect(completedNaturalSingleRuns([{ ...packet, at: 901 }], w.read(), clock)).toEqual([]);
  expect(
    completedNaturalSingleRuns([{ ...packet, reason: 'player_declined' }], w.read(), clock)
  ).toEqual([]);
});
it('wrong-hand and stale decisions cannot pass after a new hand clears the table', async () => {
  const w = await install();
  const packet = packets()[0];
  w.markSingleRunDecision({ ...packet, hand: 40 });
  expect(w.read().singleRuns).toEqual([]);
  w.markSingleRunDecision(packet);
  document.querySelector('.table-brand__hand')!.textContent = 'Hand #42';
  await sample(1300);
  expect(completedNaturalSingleRuns([packet], w.read(), clock)).toEqual([]);
  expect(w.read().singleRuns[0].expired).toBe(true);
});
it('status must clear after the decision, even when the pending copy is unchanged', async () => {
  const w = await install();
  document
    .querySelector('.table-page')!
    .insertAdjacentHTML('beforeend', '<div class="rit-felt-banner">Waiting For Players.</div>');
  w.markSingleRunDecision(packets()[0]);
  await sample(2101);
  expect(completedNaturalSingleRuns(packets(), w.read(), clock)).toEqual([]);
  expect(w.read().violations).toContain('41: Run Choice Remains After Single Decision');
});
it('preflop status clearance does not wait for the natural flop animation', async () => {
  const w = await install(0);
  w.markSingleRunDecision(packets()[0]);
  await sample(2500);
  document.querySelector('.community-area')!.innerHTML =
    '<i class="community-cards__card"></i>'.repeat(3);
  await sample(2600);
  await sample(2900);
  expect(completedNaturalSingleRuns(packets(), w.read(), clock)).toHaveLength(1);
});
it('no cards and multirun lanes never substitute for a once decision rendering', async () => {
  const w = await install(0);
  w.markSingleRunDecision(packets()[0]);
  await sample(1300);
  expect(completedNaturalSingleRuns(packets(), w.read(), clock)).toEqual([]);
  document.querySelector('.community-area')!.innerHTML =
    '<div class="community-area__run"><i class="community-cards__card"></i></div>'.repeat(3);
  await sample(1600);
  expect(completedNaturalSingleRuns(packets(), w.read(), clock)).toEqual([]);
});

it.each([
  { markedAt: 2000, statusClearAt: 2000, firstClearAt: 2000, lastClearAt: 2300 },
  { markedAt: 1000, statusClearAt: 1901, firstClearAt: 1901, lastClearAt: 2201 },
])('cannot move the status deadline to a delayed Node marker: %j', (times) => {
  const packet = packets()[0];
  const witness = {
    singleRuns: [{ ...packet, ...times, clearSamples: 2, boardCards: 4, expired: false }],
  };
  expect(completedNaturalSingleRuns([packet], witness, clock)).toEqual([]);
});

it('requires a bounded independent browser/Node clock calibration', () => {
  expect(
    naturalSingleRunClockAligned({ nodeBefore: 1000, browserNow: 1010, nodeAfter: 1020 })
  ).toBe(true);
  expect(
    naturalSingleRunClockAligned({ nodeBefore: 1000, browserNow: 1400, nodeAfter: 1020 })
  ).toBe(false);
  expect(
    naturalSingleRunClockAligned({ nodeBefore: 1000, browserNow: 1010, nodeAfter: 1300 })
  ).toBe(false);
});

it('uses the conservative clock-offset bound, not a midpoint that can hide late clearance', () => {
  const packet = packets()[0];
  const witness = {
    singleRuns: [
      {
        ...packet,
        markedAt: 1000,
        statusClearAt: 1800,
        firstClearAt: 1800,
        lastClearAt: 2100,
        clearSamples: 2,
        boardCards: 4,
        expired: false,
      },
    ],
  };
  const uncertain = { nodeBefore: 1000, browserNow: 1000, nodeAfter: 1250 };
  expect(completedNaturalSingleRuns([packet], witness, uncertain)).toEqual([]);
});
