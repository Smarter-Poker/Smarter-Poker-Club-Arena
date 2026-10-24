/**
 * MATCH_TO_HAND: THE PARTICIPANT READ IS NOT THREE ROUND TRIPS IN A ROW
 * (2026-10-23).
 *
 * Measured on the Action pilot Cluster: the hand formed at 14:31:01.508 read
 * its participants (713 ms origin), then their pool slots (996 ms), then their
 * profiles (2219 ms) one after another: a 3978 ms match_to_hand and a 5763 ms
 * fast_fold_to_next_hand (ceiling 5000). The slot now rides on the
 * participant read and the profiles go out with it, for the matcher's own
 * player list; the participant rows stay authoritative.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Pending = { table: string; select: string; filter: unknown; resolve: (v: unknown) => void };
const calls: Pending[] = [];

vi.mock('../services/supabase/client.js', () => {
  const from = (table: string) => {
    let select = '';
    const run = (filter: unknown) =>
      new Promise((resolve) => calls.push({ table, select, filter, resolve }));
    const b = {
      select(s: string) {
        select = s;
        return b;
      },
      eq: (_c: string, v: unknown) => run(v),
      in: (_c: string, v: unknown) => run(v),
    };
    return b;
  };
  return { supabase: { from, rpc: vi.fn() } };
});

const { createSupabaseLightningHandBackend } = await import('./LightningHandBackend.js');

const HAND = '00008000-0000-4000-8000-000000000001';
const A = '00002000-0000-4000-8000-00000000000a';
const B = '00002000-0000-4000-8000-00000000000b';
const SLOT_A = '00005000-0000-4000-8000-00000000000a';
const SLOT_B = '00005000-0000-4000-8000-00000000000b';
const ROOM_A = '00003000-0000-4000-8000-00000000000a';
const ROOM_B = '00003000-0000-4000-8000-00000000000b';

const tick = () => new Promise((r) => setTimeout(r, 0));
const answer = (table: string, data: unknown) => {
  const c = calls.find((x) => x.table === table && (x as { done?: boolean }).done !== true);
  if (!c) throw new Error(`no pending ${table} read`);
  (c as { done?: boolean }).done = true;
  c.resolve({ data, error: null });
};

const rows = [
  {
    player_id: A,
    pool_slot_id: SLOT_A,
    seat: 1,
    position: 'bb',
    blind_role: 'bb',
    stack_before: 100,
    slot: { id: SLOT_A, pool_session_id: ROOM_A },
  },
  {
    player_id: B,
    pool_slot_id: SLOT_B,
    seat: 2,
    position: 'btn',
    blind_role: 'sb',
    stack_before: 200,
    slot: { id: SLOT_B, pool_session_id: ROOM_B },
  },
];
const slots = [
  { id: SLOT_A, pool_session_id: ROOM_A, player_id: A },
  { id: SLOT_B, pool_session_id: ROOM_B, player_id: B },
];
const profiles = [
  { id: A, username: 'alpha', is_horse: false },
  { id: B, username: 'bravo', is_horse: true },
];

/** Answers every read as it arrives; returns the tables of each wave of concurrent reads. */
async function drive(p: Promise<unknown>): Promise<string[][]> {
  const waves: string[][] = [];
  for (let i = 0; i < 10; i++) {
    await tick();
    const open = calls.filter((c) => (c as { done?: boolean }).done !== true);
    if (open.length === 0) break;
    waves.push(open.map((c) => c.table));
    for (const c of open) {
      (c as { done?: boolean }).done = true;
      const data =
        c.table === 'lightning_hand_player'
          ? rows
          : c.table === 'profiles'
            ? profiles.filter((x) => (c.filter as string[]).includes(x.id))
            : slots;
      c.resolve({ data, error: null });
    }
  }
  await p;
  return waves;
}

beforeEach(() => {
  calls.length = 0;
});

describe('match_to_hand: the formed hand reads its participants in one wave', () => {
  it('reads the participants, their rooms and their profiles in one round trip, not three', async () => {
    const backend = createSupabaseLightningHandBackend();
    const p = backend.loadParticipants(HAND, [A, B]);
    const waves = await drive(p);
    expect(waves.length).toBe(1);
    expect([...waves[0]].sort()).toEqual(['lightning_hand_player', 'profiles']);
    expect(calls.some((c) => c.table === 'lightning_pool_slot')).toBe(false);
    const out = await p;
    expect(out.map((x) => [x.playerId, x.poolSessionId, x.isHorse])).toEqual([
      [A, ROOM_A, false],
      [B, ROOM_B, true],
    ]);
  });

  it('the participant rows decide: a player the hint missed still gets their profile', async () => {
    const backend = createSupabaseLightningHandBackend();
    const p = backend.loadParticipants(HAND, [A]);
    const waves = await drive(p);
    expect(waves.length).toBe(2);
    expect(waves[1]).toEqual(['profiles']);
    expect(calls.filter((c) => c.table === 'profiles').map((c) => c.filter)).toEqual([[A], [B]]);
    const out = await p;
    expect(out.map((x) => x.isHorse)).toEqual([false, true]);
  });

  it('a participant without its own pool session is refused, as before', async () => {
    const backend = createSupabaseLightningHandBackend();
    const p = backend.loadParticipants(HAND, [A, B]);
    p.catch(() => undefined);
    await tick();
    answer('profiles', profiles);
    answer('lightning_hand_player', [rows[0], { ...rows[1], slot: null }]);
    await expect(p).rejects.toThrow('participant has no pool session');
  });
});
