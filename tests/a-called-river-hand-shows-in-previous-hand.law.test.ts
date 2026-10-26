/**
 * LAW - A HAND THAT CALLED THE RIVER SHOWS IN PREVIOUS HAND (Dan 2026-10-25)
 *
 * "WHEN A PLAYER CALLS A BET ON THE RIVER AND HIS HAND IS MUCKED, USERS SHOULD
 * STILL BE ABLE TO SEE THE HAND 'THEY FOLDED' INSIDE THE PREVIOUS HAND. BUT
 * ONLY IF THE HAND WAS 'CALLED' ON THE RIVER, IF THEY MUCK THE HAND SHOULDN'T
 * BE SHOWN."
 *
 * Pins both halves:
 *   - the database door (`fn_ca_called_river_mucked_cards`) applies all three
 *     conditions - reader dealt in, hand ruled mucked, last river decision a
 *     CALL - and is open to signed-in players only;
 *   - the client folds those holdings into the hand it renders, never over a
 *     shown hand, never for a seat that was not mucked, and keeps the record
 *     saying the hand was mucked.
 *
 * The fixture is production hand 395c8e5b (2026-10-26): seat 4 bet the river,
 * seat 6 called and was auto-mucked, seat 7 folded the river.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BETTOR = 'a6cd08f3-d81f-4d69-a4bb-42e869393a9d';
const CALLER = 'a7d90ad1-1f5f-49dc-958a-051ad859d20d';
const FOLDER = 'c73bc8f4-5cb7-462f-8405-7b4716b35d5d';
const HAND = '395c8e5b-06b1-440f-bafe-3172ca132f55';

const mocks = vi.hoisted(() => ({
  row: null as any,
  rpc: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => {
  /* Every table read resolves empty except the hand itself; the chain shape
     does not matter to this law, only what the service does with the result. */
  const chain = (table: string): any => {
    const empty = { data: [], error: null };
    const proxy: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(empty);
          if (prop === 'maybeSingle')
            return () =>
              Promise.resolve(
                table === 'hand_history'
                  ? { data: mocks.row, error: null }
                  : { data: null, error: null }
              );
          return () => proxy;
        },
      }
    );
    return proxy;
  };
  return { supabase: { from: (t: string) => chain(t), rpc: mocks.rpc } };
});
vi.mock('../src/lib/authUtils', async (original) => ({
  ...(await original<typeof import('../src/lib/authUtils')>()),
  readLocalSession: () => ({ userId: BETTOR }),
}));

import {
  CALLED_RIVER_RPC,
  handHistoryService,
  withCalledRiverMucks,
} from '../src/services/HandHistoryService';

const KhQc = [
  { rank: 'K', suit: 'hearts' },
  { rank: 'Q', suit: 'clubs' },
];
const AdJh = [
  { rank: 'A', suit: 'diamonds' },
  { rank: 'J', suit: 'hearts' },
];

function handRow() {
  const act = (userId: string, seat: number, stage: string, action: string, amount = 0) => ({
    userId,
    seat,
    stage,
    action,
    amount,
    timestamp: 1,
  });
  return {
    id: HAND,
    table_id: 'table',
    hand_number: 1,
    game_variant: 'nlh',
    small_blind: 0.25,
    big_blind: 0.5,
    pot_size: 8,
    button_seat: 5,
    community_cards: ['5d', '7h', '3s', 'Ah', 'Qh'],
    players: [
      { userId: BETTOR, seat: 4, stack: 39.21 },
      { userId: CALLER, seat: 6, stack: 29.69 },
      { userId: FOLDER, seat: 7, stack: 48.69 },
    ],
    winners: [{ userId: BETTOR, amount: 8, hand: { name: 'Pair' } }],
    actions: [
      act(CALLER, 6, 'preflop', 'sb', 0.25),
      act(FOLDER, 7, 'preflop', 'bb', 0.5),
      act(BETTOR, 4, 'preflop', 'raise', 1),
      act(CALLER, 6, 'preflop', 'call', 0.75),
      act(FOLDER, 7, 'preflop', 'call', 0.5),
      act(CALLER, 6, 'river', 'check'),
      act(FOLDER, 7, 'river', 'check'),
      act(BETTOR, 4, 'river', 'bet', 1),
      act(CALLER, 6, 'river', 'call', 1),
      act(FOLDER, 7, 'river', 'fold'),
    ],
    hole_cards: { [BETTOR]: AdJh },
    showdown: [
      {
        user_id: BETTOR,
        seat: 4,
        reveal_order: 0,
        mucked: false,
        hand_name: 'Pair',
        hand_description: 'Aces',
      },
      { user_id: CALLER, seat: 6, reveal_order: 1, mucked: true },
    ],
  };
}

describe('the client folds a called river hand into the rundown', () => {
  it('adds the holding of a mucked seat and nothing else', () => {
    const row = handRow();
    const out = withCalledRiverMucks(
      row,
      new Map([
        [CALLER, KhQc as any],
        // The folder is never mucked at showdown; a stray holding is ignored.
        [FOLDER, AdJh as any],
        // A shown hand is never replaced.
        [BETTOR, KhQc as any],
      ])
    );
    expect(out.hole_cards).toEqual({ [BETTOR]: AdJh, [CALLER]: KhQc });
    // The record still says what happened at the table.
    expect(out.showdown.find((e: any) => e.user_id === CALLER).mucked).toBe(true);
    // The source row is not mutated.
    expect(row.hole_cards).toEqual({ [BETTOR]: AdJh });
  });

  it('returns the same row when there is nothing to add', () => {
    const row = handRow();
    expect(withCalledRiverMucks(row, undefined)).toBe(row);
    expect(withCalledRiverMucks(row, new Map())).toBe(row);
  });
});

describe('Previous Hand draws the called hand face up', () => {
  beforeEach(() => {
    mocks.row = handRow();
    mocks.rpc.mockReset();
  });

  it('asks the database door for this hand and shows the caller cards', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ hand_id: HAND, user_id: CALLER, hole_cards: KhQc }],
      error: null,
    });
    const hand = await handHistoryService.getHand(HAND);
    expect(mocks.rpc).toHaveBeenCalledWith(CALLED_RIVER_RPC, { p_hand_ids: [HAND] });
    const caller = hand!.players.find((p) => p.user_id === CALLER)!;
    expect(caller.hole_cards).toEqual(KhQc);
    expect(caller.showdown_reveal?.mucked).toBe(true);
    const sd = hand!.replay.showdown.find((r) => r.userId === CALLER)!;
    expect(sd.hole?.length).toBe(2);
    expect(sd.holePrivate).toBe(false);
    // The river folder stays out of the showdown entirely.
    expect(hand!.replay.showdown.some((r) => r.userId === FOLDER)).toBe(false);
    expect(hand!.players.find((p) => p.user_id === FOLDER)!.hole_cards).toEqual([]);
  });

  it('keeps "Mucked" when the door returns nothing or fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    const hand = await handHistoryService.getHand(HAND);
    const caller = hand!.players.find((p) => p.user_id === CALLER)!;
    expect(caller.hole_cards).toEqual([]);
    expect(caller.showdown_reveal?.mucked).toBe(true);
  });

  it('does not ask at all for a hand with no muck', async () => {
    mocks.row = { ...handRow(), showdown: [handRow().showdown[0]] };
    await handHistoryService.getHand(HAND);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('the database door applies the whole rule', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      'supabase',
      'migrations',
      '20261026004819_a_called_river_hand_shows_in_previous_hand.sql'
    ),
    'utf8'
  );
  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf('$$;'));

  it('only for a reader dealt into the hand', () => {
    expect(body).toMatch(/auth\.uid\(\)/);
    expect(body).toMatch(
      /h\.players\s*@>\s*jsonb_build_array\(jsonb_build_object\('userId',\s*v\.uid::text\)\)/
    );
  });

  it('only for a hand the engine ruled mucked', () => {
    expect(body).toMatch(/e->>'mucked'\s*=\s*'true'/);
  });

  it('only when the last river decision was a call', () => {
    expect(body).toMatch(/a->>'stage'\s*=\s*'river'/);
    expect(body).toMatch(/ORDER BY ord DESC\s+LIMIT 1\s*\)\s*=\s*'call'/);
  });

  it('is read-only and open to signed-in players only', () => {
    expect(body).toMatch(/\bSTABLE\b/);
    expect(body).toMatch(/SET search_path = public/);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_called_river_mucked_cards\(uuid\[\]\) FROM PUBLIC, anon;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_called_river_mucked_cards\(uuid\[\]\) TO authenticated;/
    );
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });
});
