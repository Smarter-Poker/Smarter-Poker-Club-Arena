import { afterEach, expect, it, vi } from 'vitest';
import {
  completedNaturalRuns,
  naturalMultiRunEngineIdentity,
  installNaturalMultiRunWitness,
  readNaturalMultiRunHistory,
  initializeNaturalMultiRunObservers,
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
it('requires both winners of a split hand to receive their chips', () => {
  const split = { ...packet, recipients: ['winner', 'second'] };
  const w = witness();
  expect(completedNaturalRuns([split], w)).toEqual([]);
  w.flights.push({ hand: 41, recipient: 'second', landedAt: 310, distance: 0.4 });
  expect(completedNaturalRuns([split], w)).toEqual([split]);
});
it.each(['unexpected recipient', 'off-target extra chip'])(
  'rejects %s even when the winner also receives a chip',
  (kind) => {
    const w = witness();
    w.flights.push({
      hand: 41,
      recipient: kind === 'unexpected recipient' ? 'other' : 'winner',
      landedAt: 310,
      distance: kind === 'unexpected recipient' ? 0 : 4,
    });
    expect(completedNaturalRuns([packet], w)).toEqual([]);
  }
);
it('refuses an empty engine recipient set', () => {
  expect(completedNaturalRuns([{ ...packet, recipients: [] }], witness())).toEqual([]);
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

const engineSha = '5780828e02d0f9c076f08bb503a4507599465928';
it('keeps the baseline navigation budget separate from the single remaining media setup budget', async () => {
  let now = 1_000;
  await initializeNaturalMultiRunObservers(
    [1, 2, 3, 4, 5, 6],
    async (_table, navigationBudget, remainingSetup) => {
      expect(navigationBudget).toBe(12_000);
      const beforeMedia = remainingSetup();
      now += 13_000; // Actual decoded art may finish after protocol admission.
      expect(remainingSetup()).toBe(beforeMedia - 13_000);
    },
    1_000,
    () => now
  );
  expect(now).toBe(79_000);
});

it('finishes each cold observer admission before starting the next, retaining all six', async () => {
  const events: string[] = [];
  let active = 0;
  await initializeNaturalMultiRunObservers(
    [1, 2, 3, 4, 5, 6],
    async (table, budget) => {
      expect(++active).toBe(1);
      expect(budget).toBe(12_000);
      events.push(`start${table}`);
      await Promise.resolve();
      events.push(`ready${table}`);
      active--;
    },
    1_000,
    () => 1_000
  );
  expect(events).toEqual([1, 2, 3, 4, 5, 6].flatMap((id) => [`start${id}`, `ready${id}`]));
});

it('refuses incomplete observer selection before starting any page', async () => {
  const initialize = vi.fn();
  await expect(
    initializeNaturalMultiRunObservers([1, 2, 3, 4, 5], initialize, 1_000, () => 1_000)
  ).rejects.toThrow(/all six observers/);
  expect(initialize).not.toHaveBeenCalled();
});

it('propagates actual readiness failure without starting replacement observers', async () => {
  const failure = new Error('authoritative snapshot unavailable');
  const initialize = vi.fn().mockRejectedValue(failure);
  await expect(
    initializeNaturalMultiRunObservers([1, 2, 3, 4, 5, 6], initialize, 1_000, () => 1_000)
  ).rejects.toBe(failure);
  expect(initialize).toHaveBeenCalledTimes(1);
});

it('shares the original 120-second setup ceiling rather than granting every observer a fresh setup', async () => {
  let now = 120_000;
  const initialize = vi.fn(async (_table, budget) => {
    expect(budget).toBe(1_000);
    now += 1_000;
  });
  await expect(
    initializeNaturalMultiRunObservers([1, 2, 3, 4, 5, 6], initialize, 1_000, () => now)
  ).rejects.toThrow(/navigation deadline/);
  expect(initialize).toHaveBeenCalledTimes(1);
});

it('reads recent multirun history only through bounded candidate-table lookups', async () => {
  const ids = Array.from(
    { length: 6 },
    (_, index) => `00000000-0000-0000-0000-00000000000${index + 1}`
  );
  const queries: URLSearchParams[] = [];
  const now = Date.parse('2026-10-16T18:30:00Z');
  const rows = await readNaturalMultiRunHistory(
    ids,
    async (query) => {
      // Reproduce the production failure boundary: a global recent-history read
      // is refused; equality on the existing table/created index is required.
      expect(ids.map((id) => `eq.${id}`)).toContain(query.get('table_id'));
      expect(query.get('created_at')).toBe('gte.2026-10-16T18:00:00.000Z');
      expect(query.get('order')).toBe('created_at.desc');
      expect(query.get('limit')).toBe('500');
      expect(query.get('rit_boards')).toBe('not.is.null');
      queries.push(query);
      return [
        {
          table_id: query.get('table_id')!.slice(3),
          rit_boards: queries.length % 2 ? [[]] : [[], []],
        },
      ];
    },
    now
  );
  expect(queries).toHaveLength(ids.length);
  expect(new Set(rows.map((row) => row.table_id))).toEqual(new Set(ids));
  expect(new Set(rows.map((row) => row.rit_boards.length))).toEqual(new Set([1, 2]));
});

it.each(
  [[], ['not-a-table-id'], Array(33).fill('00000000-0000-0000-0000-000000000001')].map((ids) => ({
    ids,
  }))
)('refuses missing, malformed or excessive candidates before any history read', async ({ ids }) => {
  const readRows = vi.fn();
  await expect(readNaturalMultiRunHistory(ids, readRows)).rejects.toThrow(/candidate table IDs/);
  expect(readRows).not.toHaveBeenCalled();
});

it('propagates an indexed history read failure without retry or an empty-success fallback', async () => {
  const failure = new Error('database read failed');
  const readRows = vi.fn().mockRejectedValue(failure);
  await expect(
    readNaturalMultiRunHistory(['00000000-0000-0000-0000-000000000001'], readRows)
  ).rejects.toBe(failure);
  expect(readRows).toHaveBeenCalledTimes(1);
});

it('binds actual health with a short display version to its full immutable release', () => {
  expect(
    naturalMultiRunEngineIdentity(
      { version: engineSha.slice(0, 8), releaseSha: engineSha },
      engineSha
    )
  ).toBe(engineSha);
});
it.each([
  { version: engineSha },
  { version: engineSha, releaseSha: engineSha.slice(0, 8) },
  { version: engineSha, releaseSha: '0'.repeat(40) },
])('refuses missing, abbreviated or different immutable engine identity: %j', (health) => {
  expect(() => naturalMultiRunEngineIdentity(health, engineSha)).toThrow(
    /exact serving engine releaseSha/
  );
});
