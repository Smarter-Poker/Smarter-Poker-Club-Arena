/**
 * A LIGHTNING NEAR MISS IS WRITTEN DOWN (2026-10-12)
 *
 * A physical table records every main and mini near miss to
 * `bbj_near_misses` and toasts the table. A Lightning hand ran only the hit
 * detectors, so a qualifying hand refused by one gate left no row at all and
 * the near-miss log could not tell "nothing qualified" from "a gate refused
 * it" for any Lightning hand. These pin the physical order (main near miss,
 * the mini's only when the main said nothing), the same writer, and that a
 * failing writer never breaks the hand.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning near-miss fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning near-miss fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String((e as Error)?.message ?? e),
}));
const { detectLightningJackpot, settleLightningJackpot } = await import('./LightningJackpot.js');

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const c = (rank: string, suit: string) => ({ rank, suit });

/** Board A A J 9 2: L's A J is aces full of jacks, both cards playing. */
function hand(winner: Record<string, unknown>, loser: Record<string, unknown>, extra = {}) {
  return {
    hostTableId: 'host-table',
    clubId: 'club-1',
    asset: 'chips',
    bbjPercent: 100,
    handNumber: 77,
    variant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    showdown: [
      { userId: 'W', ...winner },
      { userId: 'L', ...loser },
    ],
    winnerIds: ['W'],
    potSize: 500,
    dealtInPlayerIds: ['W', 'L', 'X'],
    board: ['Aclubs', 'Adiamonds', 'Jdiamonds', '9spades', '2clubs'],
    rooms: [
      ['W', 'room-w'],
      ['L', 'room-l'],
      ['X', 'room-x'],
    ] as Array<[string, string]>,
    stacks: [],
    ...extra,
  };
}

const ACES_FULL_OF_JACKS = {
  handRanking: 7,
  handName: 'Full House',
  kickers: [14, 14, 14, 11, 11],
  holeCards: [c('A', 'hearts'), c('J', 'hearts')],
};
const ACES_FULL_OF_KINGS = {
  handRanking: 7,
  handName: 'Full House',
  kickers: [14, 14, 14, 13, 13],
  holeCards: [c('A', 'spades'), c('K', 'spades')],
};

describe('a Lightning hand records its near misses like a physical table', () => {
  it('a main near miss is written through recordBBJNearMiss and toasted to every room', async () => {
    const h = hand(ACES_FULL_OF_KINGS, ACES_FULL_OF_JACKS);
    expect(detectLightningJackpot(h as any).nearMiss?.reason).toBe('winner_not_quads');
    const recordNearMiss = vi.fn(async () => undefined);
    const emitted: Array<{ room: string; payload: any }> = [];
    const verdict = await settleLightningJackpot(h as any, {
      emit: (room, payload) => emitted.push({ room, payload }),
      logger: quiet,
      payMain: vi.fn() as any,
      payMini: vi.fn() as any,
      recordNearMiss,
    });
    expect(verdict).toBe('none');
    expect(recordNearMiss).toHaveBeenCalledTimes(1);
    expect(recordNearMiss).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'host-table',
        clubId: 'club-1',
        handNumber: 77,
        variant: 'nlh',
        bigBlind: 10,
        potSize: 500,
        playersDealt: 3,
        userId: 'L',
        reason: 'winner_not_quads',
      })
    );
    for (const room of ['room-w', 'room-l', 'room-x']) {
      const events = emitted.filter((e) => e.room === room).map((e) => e.payload);
      expect(events.map((e) => e.type)).toEqual(['bbj_near_miss']);
      expect(events[0]).toMatchObject({
        table_id: room,
        hand_number: 77,
        user_id: 'L',
        reason: 'winner_not_quads',
      });
    }
  });

  it("the mini's near miss is recorded only when the main said nothing", async () => {
    // Aces full of SIXES is below the main bar and above the mini's.
    const acesFullOfSixes = {
      handRanking: 7,
      handName: 'Full House',
      kickers: [14, 14, 14, 6, 6],
      holeCards: [c('A', 'hearts'), c('6', 'hearts')],
    };
    const h = hand(ACES_FULL_OF_KINGS, acesFullOfSixes);
    const recordNearMiss = vi.fn(async () => undefined);
    await settleLightningJackpot(h as any, {
      emit: () => undefined,
      logger: quiet,
      recordNearMiss,
    });
    expect(recordNearMiss).toHaveBeenCalledTimes(1);
    expect(recordNearMiss).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'L', reason: 'mini_winner_not_quads' })
    );
  });

  it('an ordinary hand records nothing', async () => {
    const pair = {
      handRanking: 1,
      handName: 'Pair',
      kickers: [14, 14, 11, 9, 2],
      holeCards: [c('4', 'hearts'), c('5', 'hearts')],
    };
    const recordNearMiss = vi.fn(async () => undefined);
    const emit = vi.fn();
    await settleLightningJackpot(hand(ACES_FULL_OF_KINGS, pair) as any, {
      emit,
      logger: quiet,
      recordNearMiss,
    });
    expect(recordNearMiss).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('a writer that throws or rejects never breaks the hand', async () => {
    const h = hand(ACES_FULL_OF_KINGS, ACES_FULL_OF_JACKS);
    await expect(
      settleLightningJackpot(h as any, {
        emit: () => undefined,
        logger: quiet,
        recordNearMiss: (() => {
          throw new Error('boom');
        }) as any,
      })
    ).resolves.toBe('none');
    await expect(
      settleLightningJackpot(h as any, {
        emit: () => undefined,
        logger: quiet,
        recordNearMiss: (async () => {
          throw new Error('boom');
        }) as any,
      })
    ).resolves.toBe('none');
  });
});
