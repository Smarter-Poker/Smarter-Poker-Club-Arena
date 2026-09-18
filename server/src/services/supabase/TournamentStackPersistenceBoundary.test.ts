import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  wakeProjection: vi.fn(async () => ({
    projected: 0,
    alreadyCompleted: 0,
    deferred: 0,
    failed: 0,
  })),
  reportError: vi.fn(),
  observeCompletedHand: vi.fn(async () => ({ type: 'ACK' as const })),
}));

vi.mock('./client.js', () => ({
  supabase: {
    rpc: mock.rpc,
    from: vi.fn(() => {
      throw new Error('the atomic tournament hand must not use a table writer');
    }),
  },
}));
vi.mock('./handProjection.js', () => ({ wakeHandProjection: mock.wakeProjection }));
vi.mock('../errorReporter.js', () => ({ reportError: mock.reportError }));
vi.mock('./handFacts.js', () => ({ writeHandFacts: vi.fn() }));
vi.mock('../HorseHandReview.js', () => ({ recordHorseHandReviews: vi.fn() }));
vi.mock('../../engine/HorseMind.js', () => ({ readScopeOf: vi.fn(() => 'holdem:hu') }));
vi.mock('../../engine/horseDecision/index.js', () => ({
  getLiveHorseDecisionWorker: () => ({ observeCompletedHand: mock.observeCompletedHand }),
}));

import { HAND_COMMIT_RETRY_DELAYS_MS, logHandHistory } from './handHistory.js';

const TABLE_ID = '00000000-0000-4000-8000-000000000001';
const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000002';
const PLAYER_A = '00000000-0000-4000-8000-000000000003';
const PLAYER_B = '00000000-0000-4000-8000-000000000004';
const HISTORY_ID = '00000000-0000-4000-8000-000000000005';
const LEASE_GENERATION = '00000000-0000-4000-8000-000000000006';
const SUBMISSION_HASH = 'b'.repeat(64);
const retainedReceipt = {
  retained: true,
  submission_id: HISTORY_ID,
  request_hash: SUBMISSION_HASH,
};

const stacks = [
  { user_id: PLAYER_A, stack: 0, stack_before: 1_000 },
  { user_id: PLAYER_B, stack: 3_000, stack_before: 2_000 },
];

const exactReceipt = {
  success: true,
  atomic_hand_commit: true,
  post_commit_obligations: true,
  submission_id: HISTORY_ID,
  submission_hash: SUBMISSION_HASH,
  snapshot_completed: true,
  history_id: HISTORY_ID,
  written: { [PLAYER_A]: 0, [PLAYER_B]: 3_000 },
  tournament_id: TOURNAMENT_ID,
  tournament_players_synced: true,
  tournament_player_count: 2,
  tournament_player_user_ids: [PLAYER_A, PLAYER_B],
  tournament_player_chips: [
    { user_id: PLAYER_A, chips: 0 },
    { user_id: PLAYER_B, chips: 3_000 },
  ],
};

const request = (handNumber: number) => ({
  tableId: TABLE_ID,
  tournamentId: TOURNAMENT_ID,
  handId: HISTORY_ID,
  handNumber,
  gameVariant: 'nlh',
  smallBlind: 50,
  bigBlind: 100,
  potSize: 3_000,
  rakeAmount: 0,
  bbjAmount: 0,
  communityCards: ['As', 'Kd', '7c', '2h', '3s'],
  winners: [{ userId: PLAYER_B, amount: 3_000 }],
  players: [
    { userId: PLAYER_A, username: 'A', seat: 1, stack: 0, cards: [] },
    { userId: PLAYER_B, username: 'B', seat: 2, stack: 3_000, cards: [] },
  ],
  actions: [],
  atomicCommit: {
    stacks,
    rake: 0,
    bbj: 0,
    inflow: 0,
    leaseInstanceId: 'engine-instance-1',
    leaseGeneration: LEASE_GENERATION,
    acceptedPostCommitFacts: {
      contributions: { [PLAYER_A]: 1_000, [PLAYER_B]: 2_000 },
      returned_uncalled: {},
      insurance: [],
    },
    postCommitObligations: {
      version: 1 as const,
      time_banks: [
        { user_id: PLAYER_A, uses_remaining: 0, seconds_remaining: 0 },
        { user_id: PLAYER_B, uses_remaining: 0, seconds_remaining: 0 },
      ],
      rake: null,
      bbj_contribution: null,
      promo_playthrough: [],
      insurance: [],
      pending_addons: null,
    },
    assertLeaseAuthority: vi.fn(),
  },
});

beforeEach(() => {
  vi.useRealTimers();
  mock.rpc.mockReset();
  mock.wakeProjection.mockClear();
  mock.reportError.mockReset();
  mock.observeCompletedHand.mockClear();
});

describe('the hand owns its exact tournament stack payload until one receipt is authoritative', () => {
  it.each(['retention', 'commit'] as const)(
    'replays only the identical atomic request after lost %s responses',
    async (lostPhase) => {
      vi.useFakeTimers();
      let lostResponses = 0;
      mock.rpc.mockImplementation(async (name: string) => {
        expect(['fn_ca_retain_hand_submission', 'fn_ca_commit_hand_submission']).toContain(name);
        const phase = name === 'fn_ca_retain_hand_submission' ? 'retention' : 'commit';
        if (phase === lostPhase && lostResponses++ < 4) {
          return { data: null, error: { message: 'response lost' } };
        }
        return { data: phase === 'retention' ? retainedReceipt : exactReceipt, error: null };
      });

      const pending = logHandHistory(request(7_001));
      const accepted = expect(pending).resolves.toMatchObject({
        handId: HISTORY_ID,
        settlementCommitted: true,
        stackResult: exactReceipt,
      });
      await vi.runAllTimersAsync();
      await accepted;

      expect(mock.rpc).toHaveBeenCalledTimes(6);
      expect(mock.observeCompletedHand).toHaveBeenCalledTimes(1);
      expect(mock.observeCompletedHand).toHaveBeenCalledWith(
        expect.objectContaining({
          committedHandId: HISTORY_ID,
          handKey: `${TABLE_ID}:7001`,
          generation: 7001,
          actions: [],
        })
      );
      const retained = mock.rpc.mock.calls.filter(
        ([name]) => name === 'fn_ca_retain_hand_submission'
      );
      const committed = mock.rpc.mock.calls.filter(
        ([name]) => name === 'fn_ca_commit_hand_submission'
      );
      expect(retained).toHaveLength(lostPhase === 'retention' ? 5 : 1);
      expect(committed).toHaveLength(lostPhase === 'commit' ? 5 : 1);
      const payloads = retained.map(([, payload]) => payload.p_request);
      expect(payloads.every((payload) => payload === payloads[0])).toBe(true);
      expect(payloads[0]).toMatchObject({
        p_table_id: TABLE_ID,
        p_hand_number: 7_001,
        p_stacks: stacks,
        p_rake: 0,
        p_bbj: 0,
        p_inflow: 0,
        p_post_commit_obligations: request(7_001).atomicCommit.postCommitObligations,
      });
      expect(committed.every(([, payload]) => payload === committed[0][1])).toBe(true);
      expect(committed[0][1]).toEqual({
        p_submission_id: HISTORY_ID,
        p_instance_id: 'engine-instance-1',
        p_lease_generation: LEASE_GENERATION,
      });
      expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual([
        ...retained.map(() => 'fn_ca_retain_hand_submission'),
        ...committed.map(() => 'fn_ca_commit_hand_submission'),
      ]);
    }
  );

  it('rejects a success-shaped response whose tournament mirror is incomplete', async () => {
    mock.rpc.mockResolvedValueOnce({ data: retainedReceipt, error: null }).mockResolvedValueOnce({
      data: {
        ...exactReceipt,
        tournament_player_count: 1,
        tournament_player_user_ids: [PLAYER_A],
        tournament_player_chips: [{ user_id: PLAYER_A, chips: 0 }],
      },
      error: null,
    });

    await expect(logHandHistory(request(7_002))).rejects.toThrow(
      'atomic hand commit refused (tournament_stack_proof_invalid)'
    );
    expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_ca_retain_hand_submission',
      'fn_ca_commit_hand_submission',
    ]);
    expect(mock.wakeProjection).not.toHaveBeenCalled();
    expect(mock.observeCompletedHand).not.toHaveBeenCalled();
  });

  it('fails the engine boundary after the bounded replay instead of handing money to a timer', async () => {
    vi.useFakeTimers();
    mock.rpc.mockResolvedValue({ data: null, error: { message: 'schema unavailable' } });

    const pending = logHandHistory(request(7_003));
    const rejected = expect(pending).rejects.toThrow(
      new RegExp(
        `authoritative hand commit failed.*after ${HAND_COMMIT_RETRY_DELAYS_MS.length + 1} identical attempts`
      )
    );
    await vi.runAllTimersAsync();
    await rejected;
    expect(mock.rpc).toHaveBeenCalledTimes(HAND_COMMIT_RETRY_DELAYS_MS.length + 1);
    expect(mock.observeCompletedHand).not.toHaveBeenCalled();
  });
});
