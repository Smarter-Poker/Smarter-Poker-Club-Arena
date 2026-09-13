import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandController } from '../engine/HandController.js';
import { bindHorseObservationIdentity } from '../engine/HorseObservationIdentity.js';
import { captureHandSeatGenerations } from '../engine/handSeatGeneration.js';
import { qualifyAdaptiveHand } from '../engine/HorseAdaptiveObservation.js';
import type { CompletedHandObservation } from '../engine/horseDecision/protocol.js';
import type { CommittedObservationSnapshot } from './HorseCommittedObservationSnapshot.js';
import {
  prepareAdaptiveJournalBatch as prepare,
  persistAdaptiveJournalSnapshot as persist,
  readAdaptiveJournalSnapshot as read,
} from './HorseAdaptiveObservationJournal.js';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), abort: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));
const NOW = Date.UTC(2026, 8, 13, 17),
  actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const handId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
type Snapshot = Extract<CommittedObservationSnapshot, { status: 'snapshot' }>;

function fixture(): Snapshot {
  const tableId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const actions: NonNullable<CompletedHandObservation['actions']> = [];
  const seats = [actor, other].map((user_id, index) => ({
    seat: index + 1,
    user_id,
    username: 'private-name',
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const generations = captureHandSeatGenerations(
    [actor, other].map((user_id) => ({
      user_id,
      seat_id: user_id,
      seat_joined_at: new Date(NOW - 3_600_000).toISOString(),
    }))
  );
  const controller = new HandController(
    {
      tableId,
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
    },
    seats,
    1
  );
  let completed = false;
  controller.onEvent((event) => {
    if (event.type === 'HAND_COMPLETE') completed = true;
    if (event.type === 'PLAYER_ACTION' && event.record) {
      const a = { ...event.record, publicNode: event.publicNode, origin: event.origin };
      actions.push({
        ...a,
        observationIdentity: bindHorseObservationIdentity(a, actions.length, {
          handId,
          tableId,
          seatGenerations: generations,
        }),
      });
    }
  });
  controller.start();
  const state = controller.getState();
  expect(controller.performAction(state.currentPlayerSeat, 'fold', undefined, 'player')).toBe(true);
  expect(completed).toBe(true);
  const qualified = qualifyAdaptiveHand({ committedHandId: handId, actions }, NOW);
  expect(qualified.observations).toHaveLength(1);
  return {
    status: 'snapshot',
    version: 1,
    actorKey: qualified.observations[0].actorKey,
    source: {
      coverage: 'retained_committed_roster_rows',
      fromMs: NOW - 3_600_000,
      throughMs: NOW,
      readAtMs: NOW,
      snapshotId: '1:3:2',
      hands: 1,
      sourceBytes: 1000,
      sourceDigest: hash('fixture-source'),
    },
    observations: qualified.observations,
    rejected: qualified.rejected,
  };
}
function prepared(snapshot = fixture()) {
  const batch = prepare(snapshot);
  if (batch.status !== 'prepared') throw Error(batch.reason);
  return batch;
}
function reply(data: unknown, error: unknown = null) {
  mocks.abort.mockResolvedValue({ data, error });
}
function readFixture(snapshot = fixture()) {
  const o = snapshot.observations[0],
    rows = JSON.parse(prepared(snapshot).payload)[7];
  const request = {
    actorKey: o.actorKey,
    scopeKey: o.scopeKey,
    partition: o.partition,
    cohort: 'human' as const,
    fromMs: NOW - 3_600_000,
    toMs: NOW,
  };
  return {
    request,
    data: {
      version: 1,
      status: 'snapshot',
      reason: null,
      coverage: 'journaled_qualified_observations',
      ...request,
      readAtMs: NOW,
      snapshotId: '1:3:2',
      observations: rows.length,
      bytes: rows.reduce((n: number, row: string) => n + Buffer.byteLength(row), 0),
      rows,
    },
  };
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW - 1000);
  mocks.rpc.mockReturnValue({ abortSignal: mocks.abort });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('immutable adaptive observation journal boundary', () => {
  it('prepares actual completed-controller evidence without private player data or a database call', () => {
    const snapshot = fixture(),
      before = JSON.stringify(snapshot),
      batch = prepared(snapshot);
    expect(batch.observations).toBe(1);
    expect(batch.batchDigest).toBe(hash(batch.payload));
    expect(batch.payload).not.toContain('private-name');
    expect(batch.payload).not.toContain(actor);
    expect(batch.payload).not.toContain('cards');
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(Object.isFrozen(batch)).toBe(true);
  });

  it('canonicalizes order while retaining one source identity and every distinct observation', () => {
    const s = fixture(),
      o = s.observations[0];
    const second = { ...o, observationId: handId + ':1' };
    const a = prepared({ ...s, observations: [o, second] });
    const b = prepared({ ...s, observations: [second, o] });
    expect(a).toEqual(b);
    const changed = prepared({ ...s, observations: [{ ...o, action: 'call' }] });
    expect(changed.batchKey).toBe(a.batchKey);
    expect(changed.batchDigest).not.toBe(a.batchDigest);
  });

  it.each([
    'duplicate',
    'different-actor',
    'scope-hash',
    'scope-object',
    'partition',
    'future',
    'oversized',
  ])('refuses %s evidence before writing', async (kind) => {
    const s = clone(fixture()) as any;
    if (kind === 'duplicate') s.observations.push(s.observations[0]);
    if (kind === 'different-actor') s.observations[0].actorKey = '0'.repeat(64);
    if (kind === 'scope-hash') s.observations[0].scopeKey = '0'.repeat(64);
    if (kind === 'scope-object') {
      s.observations[0].scope[1] = { private: 'cards' };
      s.observations[0].scopeKey = hash(JSON.stringify(s.observations[0].scope));
    }
    if (kind === 'partition')
      s.observations[0].partition =
        s.observations[0].partition === 'holdout' ? 'training' : 'holdout';
    if (kind === 'future') s.observations[0].observedAtMs = NOW + 1;
    if (kind === 'oversized') s.observations = Array(20_001).fill(s.observations[0]);
    expect((await persist(s)).status).toBe('unavailable');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('accepts only the exact durable receipt and retries identical bytes after a lost response', async () => {
    const s = fixture(),
      b = prepared(s);
    reply(null, { message: 'response lost' });
    expect((await persist(s)).status).toBe('unknown');
    reply({
      version: 1,
      status: 'recorded',
      batchKey: b.batchKey,
      batchDigest: b.batchDigest,
      observations: b.observations,
    });
    expect((await persist(s)).status).toBe('recorded');
    expect(mocks.rpc.mock.calls[0]).toEqual(mocks.rpc.mock.calls[1]);
    expect(mocks.abort.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_append_horse_adaptive_observations', {
      p_batch: b.payload,
    });
  });

  it.each(['batchKey', 'batchDigest', 'observations'])(
    'treats a mismatched %s receipt as unknown',
    async (key) => {
      const s = fixture(),
        b = prepared(s);
      reply({
        version: 1,
        status: 'recorded',
        batchKey: b.batchKey,
        batchDigest: b.batchDigest,
        observations: b.observations,
        [key]: 'wrong',
      });
      expect((await persist(s)).status).toBe('unknown');
    }
  );

  it('distinguishes a database conflict from an unobserved transport outcome', async () => {
    const s = fixture();
    reply(null, { code: 'P0001', message: 'ADAPTIVE_JOURNAL_OBSERVATION_CONFLICT' });
    expect((await persist(s)).status).toBe('rejected');
    mocks.abort.mockRejectedValueOnce(new Error('lost socket'));
    expect((await persist(s)).status).toBe('unknown');
  });

  it('reads a frozen scoped journal population without inventing a complete learning window', async () => {
    const s = fixture(),
      f = readFixture(s);
    reply(f.data);
    const result = await read(f.request);
    expect(result.status).toBe('snapshot');
    if (result.status !== 'snapshot') return;
    expect(result.observations).toEqual(s.observations);
    expect(result.coverage).toBe('journaled_qualified_observations');
    expect(result).not.toHaveProperty('complete');
    expect(Object.isFrozen(result.observations[0].scope)).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_horse_adaptive_journal_snapshot', {
      p_actor_key: f.request.actorKey,
      p_scope_key: f.request.scopeKey,
      p_partition: f.request.partition,
      p_cohort: 'human',
      p_from_ms: f.request.fromMs,
      p_to_ms: f.request.toMs,
    });
  });

  it.each(['actorKey', 'scopeKey', 'partition', 'cohort', 'fromMs', 'toMs', 'bytes', 'snapshotId'])(
    'refuses a source with mismatched %s',
    async (key) => {
      const f = readFixture();
      reply({ ...f.data, [key]: 'wrong' });
      expect((await read(f.request)).status).toBe('unavailable');
    }
  );

  it('refuses duplicate, out-of-window and noncanonical observation rows without a partial result', async () => {
    const f = readFixture();
    reply({
      ...f.data,
      observations: 2,
      bytes: f.data.bytes * 2,
      rows: [...f.data.rows, ...f.data.rows],
    });
    expect((await read(f.request)).status).toBe('unavailable');
    const tuple = JSON.parse(f.data.rows[0]);
    tuple[5] = f.request.toMs;
    let row = JSON.stringify(tuple);
    reply({ ...f.data, rows: [row], bytes: Buffer.byteLength(row) });
    expect((await read(f.request)).status).toBe('unavailable');
    row = ' ' + f.data.rows[0];
    reply({ ...f.data, rows: [row], bytes: Buffer.byteLength(row) });
    expect((await read(f.request)).status).toBe('unavailable');
  });

  it('captures the request before awaiting the database', async () => {
    const f = readFixture();
    let done!: (value: unknown) => void;
    mocks.abort.mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve;
      })
    );
    const pending = read(f.request);
    f.request.actorKey = '0'.repeat(64);
    done({ data: f.data, error: null });
    const result = await pending;
    expect(result.status).toBe('snapshot');
    if (result.status === 'snapshot') expect(result.request.actorKey).toBe(f.data.actorKey);
  });
});
