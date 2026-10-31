import { afterEach, expect, it, vi } from 'vitest';
import {
  completedNaturalRuns,
  naturalMultiRunTiming,
  naturalMultiRunEngineIdentity,
  installNaturalMultiRunWitness,
  readNaturalMultiRunHistory,
  initializeNaturalMultiRunObserver,
  selectNaturalMultiRunSubject,
  naturalMultiRunCandidateQuery,
  eligibleNaturalMultiRunTable,
  naturalMultiRunTransportEvidence,
  naturalMultiRunRequiredRuns,
} from '../e2e/support/naturalMultiRunMobile';

const packet = { hand: 41, runs: 3, at: 100, recipients: ['winner'] };
it('snapshots physical control facts without retaining auth or state payloads', () => {
  const frames: any[] = [
    { at: 1, socketId: 2, direction: 'received', message: { type: 'PING', token: 'secret-ping' } },
    { at: 2, socketId: 2, direction: 'sent', message: { type: 'PONG', payload: 'secret-pong' } },
    { at: 3, socketId: 2, direction: 'sent', message: { type: 'AUTH', token: 'secret-auth' } },
    {
      at: 4,
      socketId: 2,
      direction: 'received',
      message: { type: 'SNAPSHOT', payload: 'private-state' },
    },
  ];
  const summary = vi.fn(() => ({ tableId: 'table', sockets: [{ id: 2, closedAt: null }] }));
  const evidence = naturalMultiRunTransportEvidence({ frames, summary }, 'table');
  frames[0].at = 99;
  frames.push({ at: 5, socketId: 2, direction: 'sent', message: { type: 'PONG' } });
  expect(summary).toHaveBeenCalledWith('table');
  expect(evidence.physicalControlFrames).toEqual([
    { at: 1, socketId: 2, direction: 'received', type: 'PING' },
    { at: 2, socketId: 2, direction: 'sent', type: 'PONG' },
  ]);
  expect(JSON.stringify(evidence)).not.toMatch(/secret|private-state/);
});
const lane = { pendingAt: 110, winnerAt: 220 };
const witness = () => ({
  hands: [{ hand: 41, runs: 3, lanes: [lane, lane, lane] }],
  flights: [{ hand: 41, recipient: 'winner', landedAt: 300, distance: 0.2 }],
});
afterEach(() => {
  (window as any).__naturalMultiRunWitness?.stop();
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
const naturalCashCandidate = {
  id: '00000000-0000-0000-0000-000000000001',
  current_players: 6,
  status: 'running',
  game_type: 'cash',
  tournament_id: null,
  max_players: 6,
  is_deleted: false,
  is_template: false,
  run_it_twice: true,
  allow_run_it_twice: true,
  run_it_twice_enabled: false,
  run_it_mode: 'none',
};
it('discovers occupied running cash games instead of waiting tournaments', () => {
  const query = naturalMultiRunCandidateQuery('club');
  expect(Object.fromEntries(query)).toMatchObject({
    club_id: 'eq.club',
    status: 'eq.running',
    game_type: 'eq.cash',
    tournament_id: 'is.null',
    max_players: 'gt.2',
    current_players: 'gte.2',
    is_deleted: 'eq.false',
    is_template: 'eq.false',
    order: 'current_players.desc,id.asc',
    limit: '32',
  });
  expect(query.has('run_it_twice')).toBe(false);
  for (const field of ['run_it_twice', 'allow_run_it_twice', 'run_it_twice_enabled'])
    expect(query.get('select')!.split(',')).toContain(field);
});
it.each([
  { status: 'waiting' },
  { game_type: 'tournament' },
  { tournament_id: 'tournament' },
  { max_players: 2 },
  { current_players: 1 },
  { is_deleted: true },
  { is_template: true },
  { run_it_twice: false },
  { allow_run_it_twice: false },
])('refuses an ineligible natural multirun subject: %j', (change) => {
  expect(eligibleNaturalMultiRunTable({ ...naturalCashCandidate, ...change })).toBe(false);
});
it('uses effective legacy RIT flags and does not mistake mode none for disabled', () => {
  expect(eligibleNaturalMultiRunTable(naturalCashCandidate)).toBe(true);
  expect(
    eligibleNaturalMultiRunTable({
      ...naturalCashCandidate,
      run_it_twice: null,
      allow_run_it_twice: null,
    })
  ).toBe(true);
  expect(
    eligibleNaturalMultiRunTable({
      ...naturalCashCandidate,
      run_it_twice: false,
      allow_run_it_twice: false,
      run_it_twice_enabled: true,
    })
  ).toBe(true);
});

const subject = (id: string, current_players = 4) => ({
  ...naturalCashCandidate,
  id,
  current_players,
});
const history = (id: string, two: number, three: number) => [
  ...Array.from({ length: two }, () => ({ table_id: id, rit_boards: [[]] })),
  ...Array.from({ length: three }, () => ({ table_id: id, rit_boards: [[], []] })),
];
it('uses one-format history to rank an eligible subject without inventing coverage', () => {
  expect(
    selectNaturalMultiRunSubject(
      [subject('two'), subject('three')],
      [...history('two', 20, 0), ...history('three', 0, 4)]
    ).id
  ).toBe('two');
  expect(
    selectNaturalMultiRunSubject(
      [subject('two'), subject('both')],
      [...history('two', 20, 0), ...history('both', 1, 1)]
    ).id
  ).toBe('both');
});
it('ranks eligible tables by population and id when recent history is missing or unusable', () => {
  const tables = [subject('z', 5), subject('a', 5), subject('smaller', 4)];
  for (const rows of [[], [{ table_id: 'cash', rit_boards: null }], history('other', 3, 3)]) {
    expect(selectNaturalMultiRunSubject(tables, rows as any).id).toBe('a');
  }
});
it('never admits an ineligible or undiscovered table even when it has the best history', () => {
  const ineligible = { ...subject('tournament', 9), game_type: 'tournament' };
  expect(
    selectNaturalMultiRunSubject(
      [ineligible, subject('cash')],
      [...history('tournament', 20, 20), ...history('other', 30, 30)]
    ).id
  ).toBe('cash');
  expect(() => selectNaturalMultiRunSubject([ineligible], history('tournament', 3, 3))).toThrow(
    /one eligible cash table/
  );
  expect(() => selectNaturalMultiRunSubject([], history('other', 3, 3))).toThrow(
    /one eligible cash table/
  );
});
it('does not choose a fixed mandatory run count for a proof that needs both formats', () => {
  for (const run_it_mode of ['mandatory_twice', 'mandatory_three', 'MANDATORY_THREE']) {
    const fixed = { ...subject('fixed', 9), run_it_mode };
    expect(
      selectNaturalMultiRunSubject([fixed, subject('choice')], history('fixed', 20, 20)).id
    ).toBe('choice');
    expect(() => selectNaturalMultiRunSubject([fixed], history('fixed', 20, 20))).toThrow(
      /one eligible cash table/
    );
  }
});
it('ranks balanced history before total, population and stable table id', () => {
  const candidates = [subject('unbalanced', 9), subject('balanced', 2)];
  expect(
    selectNaturalMultiRunSubject(candidates, [
      ...history('unbalanced', 20, 1),
      ...history('balanced', 2, 2),
    ]).id
  ).toBe('balanced');
  expect(
    selectNaturalMultiRunSubject(candidates, [
      ...history('unbalanced', 3, 2),
      ...history('balanced', 2, 2),
    ]).id
  ).toBe('unbalanced');
  const tied = [subject('z', 4), subject('a', 4), subject('populated', 5)];
  const rows = tied.flatMap((t) => history(t.id, 1, 1));
  expect(selectNaturalMultiRunSubject(tied, rows).id).toBe('populated');
  expect(selectNaturalMultiRunSubject(tied.slice(0, 2), rows).id).toBe('a');
  expect(selectNaturalMultiRunSubject(tied.slice(0, 2).reverse(), rows).id).toBe('a');
});
it('uses one foreground subject and the original remaining setup allocation exactly once', async () => {
  let now = 1_000;
  const initialize = vi.fn(async (table, budget, remainingSetup) => {
    expect(table).toBe('chosen');
    expect(budget).toBe(120_000);
    now += 13_000;
    expect(remainingSetup()).toBe(107_000);
  });
  await initializeNaturalMultiRunObserver('chosen', initialize, 1_000, () => now);
  expect(initialize).toHaveBeenCalledTimes(1);
});
it('propagates actual readiness failure without replacement or retry', async () => {
  const failure = new Error('authoritative snapshot unavailable');
  const initialize = vi.fn().mockRejectedValue(failure);
  await expect(
    initializeNaturalMultiRunObserver('chosen', initialize, 1_000, () => 1_000)
  ).rejects.toBe(failure);
  expect(initialize).toHaveBeenCalledTimes(1);
});
it('counts all startup work against the original 120-second setup ceiling', async () => {
  let now = 120_000;
  const initialize = vi.fn(async (_table, budget) => {
    expect(budget).toBe(1_000);
    now += 1_000;
  });
  await expect(
    initializeNaturalMultiRunObserver('chosen', initialize, 1_000, () => now)
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
      expect(query.get('created_at')).toBe('gte.2026-10-16T16:30:00.000Z');
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

// Run 39056430595: six observer tabs in one browser, only one in front. A
// frame-only sampler missed board 1's river, two-run board 1's winner and
// every chip landing. These run with animation frames that never fire.
const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));
const installMutationOnlyWitness = async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('seat__info'))
      return new DOMRect(Number(this.dataset.x ?? 100), 100, Number(this.dataset.width ?? 20), 20);
    if (this.dataset.chipFlight) return new DOMRect(Number(this.dataset.x ?? 0), 100, 20, 20);
    return new DOMRect(0, 0, 393, 852);
  });
  document.body.innerHTML = '';
  await installNaturalMultiRunWitness({
    addInitScript: async (callback: () => void) => callback(),
  } as any);
  return () => (window as any).__naturalMultiRunWitness;
};
const lanesHtml = (cards: number[], winners: boolean[]) =>
  cards
    .map(
      (count, index) =>
        `<div class="community-area__run">${winners[index] ? '<span class="community-area__run-winner">Winner</span>' : ''}${'<i class="community-cards__card"></i>'.repeat(count)}</div>`
    )
    .join('');
const tableHtml = (hand: number, body: string) =>
  `<div class="table-page"><span class="table-brand__hand">Hand #${hand}</span>${body}</div>`;

afterEach(() => {
  (window as any).__naturalMultiRunWitness?.stop?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('records every board waiting for its river and then naming its winner from DOM changes alone', async () => {
  const witness = await installMutationOnlyWitness();
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
  document.body.innerHTML = tableHtml(41, lanesHtml([3, 3], [false, false]));
  await flushMutations();
  document.querySelector('.table-page')!.innerHTML =
    `<span class="table-brand__hand">Hand #41</span>${lanesHtml([5, 5], [true, true])}`;
  await flushMutations();
  const [hand] = witness().read().hands;
  expect(hand.lanes).toHaveLength(2);
  for (const lane of hand.lanes) {
    expect(lane.pendingAt).not.toBeNull();
    expect(lane.winnerAt).toBeGreaterThan(lane.pendingAt);
  }
  expect(witness().read().violations).toEqual([]);
  expect(witness().read().visibility.visibleSamples).toBeGreaterThan(0);
});

it('fails a hand whose board never named its winner once the next hand is dealt', async () => {
  const witness = await installMutationOnlyWitness();
  document.body.innerHTML = tableHtml(41, lanesHtml([3, 3], [false, false]));
  await flushMutations();
  document.querySelector('.table-page')!.innerHTML =
    `<span class="table-brand__hand">Hand #41</span>${lanesHtml([5, 5], [false, true])}`;
  await flushMutations();
  // A lane re-render inside the same hand does not end it.
  document.querySelector('.table-page')!.innerHTML =
    `<span class="table-brand__hand">Hand #41</span>`;
  await flushMutations();
  expect(witness().read().violations).toEqual([]);
  document.querySelector('.table-page')!.innerHTML =
    `<span class="table-brand__hand">Hand #42</span>`;
  await flushMutations();
  expect(witness().read().violations).toEqual(['41:2: Run 1 Never Named Its Winner']);
});

it('counts a chip removed at its recipient as a landing and one removed elsewhere as a miss', async () => {
  const witness = await installMutationOnlyWitness();
  const seat = '<div data-player-id="winner"><div class="seat__info"></div></div>';
  const chip = (id: string, x: number) =>
    `<div data-chip-recipient="winner" data-chip-flight="${id}" data-chip-phase="flying" data-x="${x}"></div>`;
  document.body.innerHTML = tableHtml(41, seat + chip('at-seat', 100) + chip('far', 300));
  await flushMutations();
  for (const node of document.querySelectorAll('[data-chip-flight]')) node.remove();
  await flushMutations();
  const read = witness().read();
  expect(read.flights).toEqual([
    expect.objectContaining({ recipient: 'winner', distance: 0, landedAt: expect.any(Number) }),
  ]);
  expect(read.violations).toEqual(['41: Payout Disappeared Before Reaching Its Recipient']);
});

const payoutSeat = (x = 100) =>
  `<div data-player-id="winner"><div class="seat__info" data-x="${x}"></div></div>`;
const payoutChip =
  '<div data-chip-recipient="winner" data-chip-flight="departure-flight" data-chip-phase="flying" data-x="0"></div>';
const setupDeparture = async (withSeat = true) => {
  const witness = await installMutationOnlyWitness();
  document.body.innerHTML = tableHtml(41, (withSeat ? payoutSeat() : '') + payoutChip);
  await flushMutations();
  return { witness, chip: document.querySelector<HTMLElement>('[data-chip-flight]')! };
};
const landChip = async (chip: HTMLElement, x: number) => {
  chip.dataset.x = String(x);
  chip.dataset.chipPhase = 'landed';
  await flushMutations();
};
it('measures an explicit landing against the same flight recipient geometry observed before departure', async () => {
  const { witness, chip } = await setupDeparture();
  document.querySelector('[data-player-id]')!.remove();
  await flushMutations();
  await landChip(chip, 100);
  chip.remove();
  await flushMutations();
  const read = witness().read();
  expect(read.violations).toEqual([]);
  expect(read.flights).toEqual([
    expect.objectContaining({
      id: 'departure-flight',
      recipient: 'winner',
      distance: 0,
      targetProvenance: 'departed-recipient',
      recipientDepartedAt: expect.any(Number),
      targetRect: { x: 100, y: 100, width: 20, height: 20 },
    }),
  ]);
});
it('does not waive the 2px limit for a departed recipient', async () => {
  const { witness, chip } = await setupDeparture();
  document.querySelector('[data-player-id]')!.remove();
  await flushMutations();
  await landChip(chip, 103);
  expect(witness().read().flights[0]).toMatchObject({
    distance: 3,
    targetProvenance: 'departed-recipient',
  });
  expect(witness().read().violations).toEqual(['41: Payout Missed Its Recipient']);
});
it('keeps unknown first targets unverified and retains failed flight diagnostics', async () => {
  const { witness, chip } = await setupDeparture(false);
  await landChip(chip, 100);
  chip.remove();
  await flushMutations();
  const read = witness().read();
  expect(read.flights).toEqual([]);
  expect(read.violations).toEqual(['41: Payout Disappeared Before Reaching Its Recipient']);
  expect(read.unlandedFlights).toEqual([
    expect.objectContaining({
      id: 'departure-flight',
      lastDistance: null,
      targetProvenance: 'unavailable',
      recipientDepartedAt: null,
    }),
  ]);
});
it('does not reuse geometry when a connected recipient becomes unmeasurable', async () => {
  const { witness, chip } = await setupDeparture();
  const info = document.querySelector<HTMLElement>('.seat__info')!;
  info.dataset.width = '0';
  info.style.display = 'none';
  await landChip(chip, 100);
  chip.remove();
  await flushMutations();
  expect(witness().read().flights).toEqual([]);
  expect(witness().read().violations).toEqual([
    '41: Payout Disappeared Before Reaching Its Recipient',
  ]);
});
it('uses fresh replacement-recipient geometry instead of a disconnected predecessor', async () => {
  const { witness, chip } = await setupDeparture();
  document.querySelector('[data-player-id]')!.remove();
  document.querySelector('.table-page')!.insertAdjacentHTML('beforeend', payoutSeat(200));
  await landChip(chip, 100);
  expect(witness().read().flights[0]).toMatchObject({
    distance: 100,
    targetProvenance: 'live-recipient',
  });
  expect(witness().read().violations).toEqual(['41: Payout Missed Its Recipient']);
});
it('requires explicit landed phase before using departed geometry, never a flying removal', async () => {
  const { witness, chip } = await setupDeparture();
  document.querySelector('[data-player-id]')!.remove();
  chip.dataset.x = '100';
  chip.style.transform = 'translateX(100px)';
  await flushMutations();
  chip.remove();
  await flushMutations();
  expect(witness().read().flights).toEqual([]);
  expect(witness().read().violations).toEqual([
    '41: Payout Disappeared Before Reaching Its Recipient',
  ]);
});

it.each([undefined, 'null'])('keeps default BOTH natural coverage for target %s', (target) => {
  expect(naturalMultiRunRequiredRuns(target, 'true', 'null')).toEqual([2, 3]);
});
it('admits explicit numeric one and three for client observations', () => {
  expect(naturalMultiRunRequiredRuns('1', 'true', 'null')).toEqual([1]);
  expect(naturalMultiRunRequiredRuns('3', 'true', 'null')).toEqual([3]);
});
it.each(['"1"', '"3"', '2', 'true', '[]', '{}', '[3]', 'false', '""', 'invalid'])(
  'refuses malformed or unsupported target %s',
  (target) => {
    expect(() => naturalMultiRunRequiredRuns(target, 'true', 'null')).toThrow(/target/);
  }
);
it.each([
  ['false', 'null'],
  ['"true"', 'null'],
  ['true', '"' + engineSha + '"'],
])('refuses targeted mode without literal mobile true and absent engine pin', (mobile, engine) => {
  expect(() => naturalMultiRunRequiredRuns('3', mobile, engine)).toThrow(/target/);
});
it('targets three-run history and permits mandatory three while refusing mandatory twice', () => {
  const tables = [
    { ...subject('two', 9), run_it_mode: 'mandatory_twice' },
    { ...subject('three', 4), run_it_mode: 'mandatory_three' },
    subject('choice', 6),
  ];
  const rows = [...history('two', 20, 20), ...history('three', 0, 3), ...history('choice', 10, 1)];
  expect(selectNaturalMultiRunSubject(tables, rows, [3]).id).toBe('three');
  expect(() => selectNaturalMultiRunSubject([tables[0]], rows, [3])).toThrow(/eligible/);
  expect(selectNaturalMultiRunSubject(tables, rows).id).toBe('choice');
});

it('natural timing forbids settled-choice overlays and keeps the full 4100ms winning-card results', () => {
  const w: any = {
    confirmations: {},
    hands: [
      {
        hand: 41,
        runs: 3,
        lanes: [10000, 14100, 18200].map((winnerAt) => ({ winnerAt })),
        resultEndedAt: 22300,
      },
    ],
  };
  expect(naturalMultiRunTiming(packet, w)).toMatchObject({
    ready: true,
    violations: [],
    confirmationMs: 0,
    resultGapsMs: [4100, 4100],
    lastResultMs: 4100,
  });
  w.confirmations['41'] = [{ shownAt: 0, hiddenAt: 1500 }];
  expect(naturalMultiRunTiming(packet, w).violations).toContain(
    'Settled Run Choice Still Covers The Table'
  );
  w.confirmations['41'].push({ shownAt: 6000, hiddenAt: 7500 });
  expect(naturalMultiRunTiming(packet, w).violations).toContain('Run Confirmation Repeated');
  w.hands[0].lanes[1].winnerAt = 12600;
  expect(naturalMultiRunTiming(packet, w).violations).toContain(
    'Winning Card Result Did Not Receive Its Additional 1500ms'
  );
  w.hands[0].resultEndedAt = 20800;
  expect(naturalMultiRunTiming(packet, w).violations).toContain(
    'Final Winning Cards Cleared Early'
  );
  w.hands[0].resultEndedAt = null;
  expect(naturalMultiRunTiming(packet, w).ready).toBe(false);
});

it('the actual passive DOM witness rejects a settled strip and preserves both winner windows', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
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
  document.body.innerHTML = `<div class="table-page"><span class="table-brand__hand">Hand #41</span>${'<div class="community-area__run">' + '<i class="community-cards__card"></i>'.repeat(5) + '</div>'}${'<div class="community-area__run">' + '<i class="community-cards__card"></i>'.repeat(5) + '</div>'}</div>`;
  tick(1);
  now = 2500;
  tick(2);
  const lanes = document.querySelectorAll('.community-area__run');
  now = 10000;
  lanes[0].insertAdjacentHTML(
    'beforeend',
    '<span class="community-area__run-winner">Winner</span>'
  );
  tick(3);
  now = 14100;
  lanes[1].insertAdjacentHTML(
    'beforeend',
    '<span class="community-area__run-winner">Winner</span>'
  );
  tick(4);
  now = 18200;
  lanes.forEach((lane) => lane.remove());
  tick(5);
  const read = () => (window as any).__naturalMultiRunWitness.read();
  expect(naturalMultiRunTiming({ ...packet, runs: 2 }, read())).toEqual({
    ready: true,
    violations: [],
    confirmationMs: 0,
    resultGapsMs: [4100],
    lastResultMs: 4100,
  });
  document
    .querySelector('.table-page')!
    .insertAdjacentHTML(
      'beforeend',
      '<div class="rit-felt-banner">Players Have Accepted Running It Twice.</div>'
    );
  tick(6);
  expect(naturalMultiRunTiming({ ...packet, runs: 2 }, read()).violations).toContain(
    'Settled Run Choice Still Covers The Table'
  );
  expect(read().violations).toContain('41: Settled Run Choice Still Covers The Table');
});

it('refuses a target-three observation without actual three-run history', () => {
  const tables = [subject('quiet', 9), { ...subject('fixed', 6), run_it_mode: 'mandatory_three' }];
  for (const rows of [[], history('quiet', 4, 0), history('undiscovered', 0, 3)]) {
    expect(() => selectNaturalMultiRunSubject(tables, rows, [3])).toThrow(
      /positive three-run history/
    );
  }
});

it('retains a natural three-run opportunity across provider queue time within the bounded lookback', async () => {
  const quiet = '00000000-0000-0000-0000-000000000001';
  const active = '00000000-0000-0000-0000-000000000002';
  const now = Date.parse('2026-10-29T00:15:47Z');
  const opportunityAt = Date.parse('2026-10-28T23:20:48Z');
  const queries: URLSearchParams[] = [];
  const rows = await readNaturalMultiRunHistory(
    [quiet, active],
    async (query) => {
      queries.push(query);
      const floor = Date.parse(query.get('created_at')!.slice(4));
      return query.get('table_id') === `eq.${active}` && opportunityAt >= floor
        ? history(active, 0, 1)
        : [];
    },
    now
  );
  expect(selectNaturalMultiRunSubject([subject(quiet, 9), subject(active, 6)], rows, [3]).id).toBe(
    active
  );
  expect(queries).toHaveLength(2);
  for (const query of queries) {
    expect(query.get('select')).toBe('table_id,rit_boards');
    expect(query.get('limit')).toBe('500');
    expect(query.get('created_at')).toBe('gte.2026-10-28T22:15:47.000Z');
  }
});

it('selects once only from player-choice tables with actual recent RIT activity', () => {
  const tables = ['mandatory_twice', 'mandatory_three', 'player_choice'].map((run_it_mode) => ({
    ...subject(run_it_mode),
    run_it_mode,
  }));
  expect(
    selectNaturalMultiRunSubject(
      tables,
      tables.flatMap((t) => history(t.id, 2, 2)),
      [1]
    ).id
  ).toBe('player_choice');
  expect(() =>
    selectNaturalMultiRunSubject(tables.slice(0, 2), history('mandatory_three', 2, 2), [1])
  ).toThrow(/player-choice.*history/);
  expect(() => selectNaturalMultiRunSubject([tables[2]], [], [1])).toThrow(/history/);
});
