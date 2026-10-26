import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { freshExploitCounters } from '../engine/HorseOpponentExploit.js';
import type { LiveHorseDecisionSnapshot } from '../engine/horseDecision/protocol.js';
import type { DurableOpponentProfile } from '../engine/HorseOpponentMemory.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), report: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('./errorReporter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./errorReporter.js')>()),
  reportError: mocks.report,
}));
import { createDecisionOpponentProfilePacketReader } from './HorseOpponentMemory.js';
const uid = '91000000-0000-4000-8000-000000000001';
const row = (
  variant: DurableOpponentProfile['variant'],
  size: DurableOpponentProfile['size']
): DurableOpponentProfile => ({
  user_id: uid,
  variant,
  mode: 'cash',
  size,
  initialized: true,
  observed_hands: 60,
  counters: freshExploitCounters(),
});
const request = (variant = 'flh', count = 6): LiveHorseDecisionSnapshot =>
  ({
    fence: `table:${variant}:1:lease:turn`,
    gameState: {
      gameVariant: variant,
      players: [{ user_id: uid }],
      dealtSeatIds: Array.from({ length: count }, (_, i) => i + 1),
    },
  }) as unknown as LiveHorseDecisionSnapshot;
let donor: DurableOpponentProfile[];
let failure: { code: string } | null;
let finish: () => void;
let waiting = false;
let testClock = Date.now();
const query = { select: vi.fn(), in: vi.fn(), eq: vi.fn(), limit: vi.fn(), abortSignal: vi.fn() };
beforeEach(() => {
  vi.useFakeTimers();
  testClock += 10_000;
  vi.setSystemTime(testClock);
  mocks.rpc.mockReset();
  mocks.from.mockReset();
  mocks.report.mockReset();
  mocks.rpc.mockReturnValue({ abortSignal: async () => ({ data: [], error: null }) });
  for (const method of ['select', 'in', 'eq', 'limit'] as const)
    query[method].mockReset().mockReturnValue(query);
  query.abortSignal.mockReset().mockImplementation(async () => {
    if (waiting)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return { data: donor, error: failure };
  });
  mocks.from.mockReturnValue(query);
  donor = [];
  failure = null;
  waiting = false;
  finish = undefined as unknown as () => void;
});
afterEach(() => vi.useRealTimers());
it.each(['flh', 'flo8', 'short_deck'] as const)(
  'loads saved %s donor on first hand with one bounded SELECT and no donor initializer',
  async (variant) => {
    donor = [row(variant, 'short')];
    const read = createDecisionOpponentProfilePacketReader(async () => 'installed');
    const [first, same] = await Promise.all([read(request(variant)), read(request(variant))]);
    expect(first).toEqual({ profiles: [], donorProfiles: donor });
    expect(same).toEqual(first);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'fn_horse_exploit_profiles_read',
      expect.objectContaining({ p_variant: variant, p_size: 'full' })
    );
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(query.in).toHaveBeenCalledWith('user_id', [uid]);
    expect(query.eq.mock.calls).toEqual([
      ['variant', variant],
      ['mode', 'cash'],
      ['size', 'short'],
    ]);
    expect(query.limit).toHaveBeenCalledWith(10);
  }
);
it('heads-up never requests a donor', async () => {
  const read = createDecisionOpponentProfilePacketReader(async () => 'installed');
  expect(await read(request('flh', 2))).toEqual({ profiles: [], donorProfiles: [] });
  expect(mocks.from).not.toHaveBeenCalled();
});
it.each(['variant', 'mode', 'size', 'user_id'] as const)(
  'refuses a donor with foreign %s while retaining exact evidence',
  async (field) => {
    donor = [
      {
        ...row('flh', 'short'),
        [field]: { variant: 'nlh', mode: 'tournament', size: 'hu', user_id: 'foreign' }[field],
      } as DurableOpponentProfile,
    ];
    // Unique roster prevents known-cache evidence from earlier tests.
    const snap = request('flo8');
    snap.gameState.players[0].user_id = '91000000-0000-4000-8000-000000000099';
    const packet = await createDecisionOpponentProfilePacketReader(async () => 'installed')(snap);
    expect(packet).toEqual({ profiles: [], donorProfiles: [] });
    expect(mocks.report).toHaveBeenCalledWith(expect.any(Error), 'HorseOpponentMemory.donorRead');
  }
);
it('an unavailable donor keeps the exact receipt and is not retried on another street', async () => {
  failure = { code: '57014' };
  const snap = request('short_deck');
  snap.fence = 'failure:1:1:lease:turn';
  snap.gameState.players[0].user_id = '91000000-0000-4000-8000-000000000098';
  const exact = { ...row('short_deck', 'full'), user_id: snap.gameState.players[0].user_id };
  mocks.rpc.mockReturnValue({ abortSignal: async () => ({ data: [exact], error: null }) });
  const read = createDecisionOpponentProfilePacketReader(async () => 'installed');
  expect(await read(snap)).toEqual({ profiles: [exact], donorProfiles: [] });
  expect(await read(snap)).toEqual({ profiles: [exact], donorProfiles: [] });
  expect(mocks.from).toHaveBeenCalledTimes(1);
});
it('caller cancellation stops waiting for a donor and propagates without a decision receipt', async () => {
  waiting = true;
  const snap = request('flo8');
  snap.fence = 'cancel:1:1:lease:turn';
  const controller = new AbortController();
  const pending = createDecisionOpponentProfilePacketReader(async () => 'installed')(
    snap,
    controller.signal
  );
  const rejected = expect(pending).rejects.toThrow('cancel donor');
  for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
  controller.abort(new Error('cancel donor'));
  await rejected;
  finish();
});
