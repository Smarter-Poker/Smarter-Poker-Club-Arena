import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCommittedObservationSnapshot as read } from './HorseCommittedObservationSnapshot.js';
import { buildScopedOpponentModel } from '../engine/HorseScopedOpponentModel.js';
import { COMMITTED_OBSERVATION_ACTION_KEYS } from '../engine/HorseAdaptiveObservation.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), abort: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));
const NOW = Date.UTC(2026, 8, 12, 19),
  actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const request = { actorId: actor, fromMs: NOW - 3_600_000, throughMs: NOW };
const node = {
  version: 1,
  status: 'captured',
  variant: 'nlh',
  mode: 'cash',
  asset: 'chips',
  chipUnit: 0.01,
  tournamentStage: { version: 1, status: 'not_applicable' },
  street: 'preflop',
  dealerSeat: 1,
  actorSeat: 1,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  anteType: 'per_player',
  allInOrFold: false,
  bombPot: false,
  boardCount: 1,
  boards: [''],
  pot: 4,
  currentBet: 2,
  toCall: 0,
  structure: 'no_limit',
  minRaiseTo: 4,
  maxRaiseTo: 200,
  fixedBetSize: null,
  wagersCapped: false,
  legalActions: ['check', 'raise', 'all_in'],
  seats: [
    [1, 198, 2, 2, 0, 0, 0],
    [2, 198, 2, 2, 0, 0, 0],
  ],
  deductions: {
    version: 1,
    status: 'captured',
    rules: 'controller-rake-bbj-v1',
    rake: { percent: 5, cap: 3, noFlopNoDrop: true, playerCountCaps: [] },
    bbj: null,
  },
};
// The projected shape the RPC returns: exactly COMMITTED_OBSERVATION_ACTION_KEYS,
// no seat column. A fixture that carried `seat` passed here for eight days while
// production qualified nothing (2026-09-16 to 2026-09-25).
const action = (userId = actor, ordinal = 0, handId = id) => ({
  userId,
  action: 'check',
  stage: 'preflop',
  timestamp: NOW - 500,
  origin: 'player',
  publicNode: node,
  observationIdentity: {
    version: 1,
    status: 'bound',
    observationId: handId + ':' + ordinal,
    handId,
    actionOrdinal: ordinal,
    sessionKey: '1'.repeat(64),
  },
});
const hand = (handId = id, at = '2026-09-12T18:59:59.123456Z') => ({
  id: handId,
  createdAt: at,
  acceptance: {
    kind: 'atomic_hand_receipt',
    tableId: other,
    handNumber: 1000001,
    payloadHash: 'a'.repeat(64),
  },
  actions: [action(actor, 0, handId)],
});
const snapshot = (hands: unknown[] = []) => ({
  version: 1,
  status: 'snapshot',
  reason: null,
  actor,
  fromMs: request.fromMs,
  throughMs: request.throughMs,
  readAtMs: NOW,
  snapshotId: '1:3:2',
  coverage: 'retained_committed_roster_rows',
  acceptance: 'atomic_hand_receipts',
  handCount: hands.length,
  sourceBytes: 1000 * hands.length,
  actionCount: hands.reduce<number>(
    (n, h) =>
      n +
      (Array.isArray((h as { actions?: unknown })?.actions)
        ? (h as { actions: unknown[] }).actions.length
        : 0),
    0
  ),
  hands,
});
function respond(data: unknown) {
  mocks.abort.mockResolvedValue({ data, error: null });
}
beforeEach(() => {
  mocks.rpc.mockReturnValue({ abortSignal: mocks.abort });
  respond(snapshot());
});
afterEach(() => vi.clearAllMocks());
describe('committed observation snapshot reader', () => {
  it('qualifies the shape the database returns, which carries no seat column', async () => {
    const data = hand();
    expect(Object.keys(data.actions[0]).sort()).toEqual(
      [...COMMITTED_OBSERVATION_ACTION_KEYS].sort()
    );
    respond(snapshot([data]));
    const result = await read(request);
    expect(result.status).toBe('snapshot');
    if (result.status !== 'snapshot') throw Error('missing snapshot');
    expect(result.rejected).toEqual({});
    expect(result.observations.map((o) => o.observationId)).toEqual([id + ':0']);
  });
  it('excludes a persisted action whose seat disagrees with its bound public node', async () => {
    const data = hand();
    (data.actions[0] as { seat?: number }).seat = 2;
    respond(snapshot([data]));
    const result = await read(request);
    expect(result.status).toBe('snapshot');
    if (result.status !== 'snapshot') throw Error('missing snapshot');
    expect(result.observations).toEqual([]);
    expect(result.rejected).toEqual({ unavailable_public_node: 1 });
    expect(result.source.hands).toBe(1);
  });
  it('refuses a legacy source envelope even when its history rows committed', async () => {
    const s = snapshot([hand()]);
    delete (s as Partial<typeof s>).acceptance;
    respond(s);
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'invalid_source' });
  });
  it.each([
    undefined,
    { kind: 'atomic_hand_receipt' },
    {
      kind: 'atomic_hand_receipt',
      tableId: other,
      handNumber: 999999,
      payloadHash: 'a'.repeat(64),
    },
    { kind: 'atomic_hand_receipt', tableId: other, handNumber: 1000001, payloadHash: 'invalid' },
  ])('refuses missing or malformed accepted-hand proof: %j', async (acceptance) => {
    respond(snapshot([{ ...hand(), acceptance }]));
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'invalid_source_hand' });
  });
  it('binds source identity to the exact atomic receipt and never exposes it as a model observation', async () => {
    respond(snapshot([hand()]));
    const first = await read(request);
    const changed = {
      ...hand(),
      acceptance: { ...hand().acceptance, payloadHash: 'b'.repeat(64) },
    };
    respond(snapshot([changed]));
    const second = await read(request);
    expect(first.status).toBe('snapshot');
    expect(second.status).toBe('snapshot');
    if (first.status === 'snapshot' && second.status === 'snapshot') {
      expect(first.source.sourceDigest).not.toBe(second.source.sourceDigest);
      expect(first.observations).toEqual(second.observations);
      expect(first.source.acceptance).toBe('atomic_hand_receipts');
    }
  });
  it('preserves a missing-atomic-receipt refusal without treating the visible subset as complete', async () => {
    respond({ version: 1, status: 'unavailable', reason: 'atomic_receipt_missing' });
    expect(await read(request)).toEqual({
      status: 'unavailable',
      reason: 'atomic_receipt_missing',
    });
  });
  it('keeps the original actor and interval when the caller changes its request in flight', async () => {
    const before = snapshot([hand()]);
    respond(before);
    const expected = await read(request);
    let reply!: (value: unknown) => void;
    mocks.abort.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
    const mutable = { ...request };
    const pending = read(mutable);
    Object.assign(mutable, { actorId: other, fromMs: 0, throughMs: NOW + 1 });
    reply({ data: before, error: null });
    expect(await pending).toEqual(expected);
  });
  it('rejects a response for a rewritten caller scope instead of adopting it after the await', async () => {
    let reply!: (value: unknown) => void;
    mocks.abort.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
    const mutable = { ...request };
    const pending = read(mutable);
    Object.assign(mutable, { actorId: other, fromMs: NOW - 2000, throughMs: NOW - 1 });
    reply({
      data: { ...snapshot(), actor: other, fromMs: mutable.fromMs, throughMs: mutable.throughMs },
      error: null,
    });
    expect(await pending).toEqual({ status: 'unavailable', reason: 'invalid_source' });
  });
  it('makes one scoped, timed request and preserves an empty snapshot without inventing evidence', async () => {
    const result = await read(request);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_horse_committed_observation_snapshot', {
      p_actor: actor,
      p_from_ms: request.fromMs,
      p_through_ms: NOW,
    });
    expect(mocks.abort.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      status: 'snapshot',
      observations: [],
      source: { hands: 0, coverage: 'retained_committed_roster_rows' },
    });
  });
  it('retains original ordinals and excludes other actors, forced money and private records', async () => {
    const h = hand();
    h.actions = [
      { action: 'bb' } as never,
      { action: 'discard', cards: ['As', 'Ah'] } as never,
      // The other player acts from the other seat: without a seat column, a
      // second actor on the same seat would be a contradiction, not evidence.
      { ...action(other, 2), publicNode: { ...node, actorSeat: 2 } },
      action(actor, 3),
    ];
    respond(snapshot([h]));
    const result = await read(request);
    expect(result.status).toBe('snapshot');
    if (result.status !== 'snapshot') throw Error('missing');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].observationId).toBe(id + ':3');
    expect(JSON.stringify(result)).not.toContain('As');
    expect(JSON.stringify(result)).not.toContain(actor);
    expect(result.rejected.non_betting_action).toBe(2);
    expect(Object.isFrozen(result.observations)).toBe(true);
    const model = buildScopedOpponentModel({
      observations: result.observations,
      scopeKey: result.observations[0].scopeKey,
      opponentKey: result.actorKey,
      observerKey: 'f'.repeat(64),
      cohort: 'human',
      partition: result.observations[0].partition,
      window: { fromMs: NOW - 3_600_000, toMs: NOW, complete: true },
      prior: {
        version: 'fixture',
        probabilities: { fold: 0, check: 0.5, call: 0, bet: 0, raise: 0.5 },
      },
    });
    expect(model.status).toBe('insufficient_evidence');
  });
  it('reconstructs the same source digest after restart and a new MVCC snapshot', async () => {
    const data = snapshot([hand()]);
    respond(data);
    const first = await read(request);
    respond(JSON.parse(JSON.stringify({ ...data, snapshotId: '10:10:' })));
    const second = await read(request);
    expect(first.status).toBe('snapshot');
    expect(second.status).toBe('snapshot');
    if (first.status === 'snapshot' && second.status === 'snapshot') {
      expect(first.source.sourceDigest).toBe(second.source.sourceDigest);
      expect(first.observations).toEqual(second.observations);
    }
  });
  it('changes the source digest on a later committed hand without incrementing old evidence', async () => {
    respond(snapshot([hand()]));
    const first = await read(request);
    respond(snapshot([hand(), hand('dddddddd-dddd-4ddd-8ddd-dddddddddddd')]));
    const second = await read(request);
    if (first.status !== 'snapshot' || second.status !== 'snapshot') throw Error('missing');
    expect(first.observations).toHaveLength(1);
    expect(second.observations).toHaveLength(2);
    expect(first.source.sourceDigest).not.toBe(second.source.sourceDigest);
  });
  it.each([
    { actorId: other.toUpperCase() },
    { actorId: 'invalid' },
    { fromMs: NaN },
    { throughMs: Infinity },
    { throughMs: request.fromMs },
    { fromMs: NOW - 21_600_001 },
  ])('refuses invalid requests before database access: %o', async (change) => {
    expect(await read({ ...request, ...change })).toEqual({
      status: 'unavailable',
      reason: 'invalid_request',
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    'hand_budget_exceeded',
    'byte_budget_exceeded',
    'invalid_or_oversized_hand',
    'invalid_window',
  ])('preserves database refusal %s without returning partial rows', async (reason) => {
    respond({ ...snapshot([hand()]), status: 'unavailable', reason });
    expect(await read(request)).toEqual({ status: 'unavailable', reason });
  });
  it.each([
    { version: 2 },
    { actor: other },
    { fromMs: 0 },
    { coverage: 'all_history' },
    { handCount: 2 },
    { sourceBytes: 8_388_609 },
    { readAtMs: NOW - 1 },
    { snapshotId: 'invalid' },
    { reason: 'unknown' },
  ])('refuses inconsistent source envelopes: %o', async (change) => {
    respond({ ...snapshot([hand()]), ...change });
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'invalid_source' });
  });
  it.each(
    [
      [hand(), hand()],
      [hand('dddddddd-dddd-4ddd-8ddd-dddddddddddd'), hand()],
      [{ ...hand(), id: 'bad' }],
      [{ ...hand(), createdAt: '2026-09-12T19:00:00.000001Z' }],
      [{ ...hand(), createdAt: '2026-09-12T18:00:00.000000Z' }],
      [{ ...hand(), actions: null }],
      [{ ...hand(), actions: Array(4097).fill({ action: 'bb' }) }],
    ].map((hands) => ({ hands }))
  )('rejects invalid, duplicate, out-of-order and out-of-window rows', async ({ hands }) => {
    respond(snapshot(hands));
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'invalid_source_hand' });
  });
  it('does not hide capture gaps in otherwise complete committed rows', async () => {
    respond(snapshot([{ ...hand(), actions: [{ action: 'call', stage: 'preflop' }] }]));
    expect(await read(request)).toMatchObject({
      status: 'snapshot',
      observations: [],
      source: { hands: 1 },
      rejected: { unavailable_public_node: 1 },
    });
  });
  it('refuses mismatched or oversized total action counts', async () => {
    respond({ ...snapshot([hand()]), actionCount: 0 });
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'invalid_source' });
    respond({ ...snapshot([hand()]), actionCount: 20001 });
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'invalid_source' });
    respond({ version: 1, status: 'unavailable', reason: 'action_budget_exceeded' });
    expect(await read(request)).toEqual({
      status: 'unavailable',
      reason: 'action_budget_exceeded',
    });
  });
  it('discards the whole response if returned JSON exceeds the byte bound', async () => {
    respond(snapshot([{ ...hand(), actions: [{ action: 'bb', unknown: 'x'.repeat(8_388_609) }] }]));
    expect(await read(request)).toEqual({
      status: 'unavailable',
      reason: 'response_budget_exceeded',
    });
  });
  it('does not return error details or a partial model on transport errors', async () => {
    mocks.abort.mockResolvedValue({
      data: snapshot([hand()]),
      error: { message: 'private credential' },
    });
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'source_unavailable' });
    mocks.abort.mockRejectedValue(Error('private credential'));
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'source_unavailable' });
  });
});
