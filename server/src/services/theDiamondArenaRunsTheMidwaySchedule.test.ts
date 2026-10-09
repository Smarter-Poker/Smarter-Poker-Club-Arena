/**
 * THE DIAMOND ARENA RUNS THE MIDWAY UNION'S SCHEDULE (Dan, 2026-10-06 13:09 CT:
 * "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY UNION FOR NOW").
 *
 * Behavioural pins for the engine half:
 *   - a schedule hung off the arena is created through
 *     fn_poker_diamond_spawn_scheduled_tournament with whole-Diamond prices,
 *     the snapped ladder total and its guarantee - never a direct insert;
 *   - a refusal ({ok:false}) inserts nothing, links nothing, seeds nothing and
 *     releases its claim (fail closed, no faked spawn);
 *   - a chip schedule still inserts exactly the row it always built;
 *   - the arena's events draw entrants from Deep Stack Society as well as the
 *     arena's own members (horses are players, CLAUDE.md 10.5), and a chip
 *     club's draw is unchanged;
 *   - the bankroll gate judges a Diamond entry on the horse's Diamonds;
 *   - the overlay guard covers the arena while its tournaments are on.
 *
 * The database door is mocked here: its contract is
 * `(p_schedule_id uuid, p_scheduled_start timestamptz, p_config jsonb)
 *  -> {ok:true, tournament_id, replayed} | {ok:false, reason}`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTournamentService } from './ScheduledTournamentService.js';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import { DIAMOND_ARENA_HORSE_CLUBS } from './HorseFleetFundingBoundary.js';
import {
  DIAMOND_SPAWN_RPC,
  diamondSpawnConfig,
  isDiamondArenaClubRow,
  readDiamondSpawnAnswer,
} from './diamondScheduledSpawn.js';
import { MIDWAY_UNION_ID, overlayHostsFrom } from './HorseOverlayGuard.js';
import { gameLaneFor } from './HorseBehavior.js';

vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

const ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81';
const CHIP_CLUB = 'c0c0c0c0-0000-4000-8000-000000000001';
const SCHEDULE = '5c4ed01e-0000-4000-8000-000000000001';
const TID = '7070e000-0000-4000-8000-000000000001';

const arenaClub = {
  id: ARENA,
  chip_treasury: 0,
  union_id: null,
  asset: 'diamonds',
  is_platform: true,
};
const chipClub = {
  id: CHIP_CLUB,
  chip_treasury: 50_000,
  union_id: null,
  asset: 'chips',
  is_platform: false,
};

/** A Midway schedule config, verbatim in shape (Monday Knockout / Midweek Bounty). */
const midwayBounty = (): Record<string, unknown> => ({
  name: 'Five-Card Bounty',
  type: 'bounty',
  buyIn: 16.5,
  tableSize: 9,
  maxPlayers: 500,
  minPlayers: 4,
  blindPreset: 'STANDARD',
  gameVariant: 'plo5',
  bigBlindAnte: false,
  bountyAmount: 3.75,
  payoutPreset: 'NINE',
  startingStack: 18000,
  guaranteedPrize: 500,
  horsesToRegister: 0,
  shortDescription: '25% Of Each Entry Contribution Funds A Fixed Knockout Bounty.',
  lateRegistrationLevels: 8,
});

const midwayRebuy = (): Record<string, unknown> => ({
  name: 'Friday Rebuy Rush',
  type: 'mtt',
  buyIn: 8.8,
  isRebuy: true,
  addonCost: 8.8,
  rebuyCost: 8.8,
  tableSize: 9,
  addonChips: 20000,
  maxPlayers: 500,
  minPlayers: 4,
  rebuyChips: 10000,
  blindPreset: 'STANDARD',
  gameVariant: 'nlh',
  bigBlindAnte: true,
  payoutPreset: 'NINE',
  startingStack: 10000,
  addOnAvailable: true,
  guaranteedPrize: 400,
  horsesToRegister: 0,
  lateRegistrationLevels: 7,
});

const schedule = (
  clubId: string,
  config: Record<string, unknown>,
  unionId: string | null = null
) => ({
  id: SCHEDULE,
  union_id: unionId,
  club_id: clubId,
  name: String(config.name),
  active: true,
  days_of_week: [0, 1, 2, 3, 4, 5, 6],
  start_times_utc: ['20:00'],
  interval_minutes: null,
  config,
});

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

/** A table-aware PostgREST fake that records every write. */
function fakeDb(opts: {
  club: Record<string, unknown> | null;
  spawnAnswer?: { data: unknown; error: unknown };
  houseAvailable?: number;
}) {
  const calls: Call[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
    let op = 'select';
    const b: Record<string, any> = {};
    for (const m of [
      'select',
      'eq',
      'in',
      'is',
      'gt',
      'gte',
      'lt',
      'order',
      'limit',
      'range',
      'ilike',
      'or',
    ])
      b[m] = (...args: unknown[]) => {
        calls.push({ table, op: m, args });
        return b;
      };
    for (const m of ['insert', 'update', 'delete'])
      b[m] = (...args: unknown[]) => {
        op = m;
        calls.push({ table, op: m, args });
        return b;
      };
    const answer = () => {
      if (table === 'clubs') return { data: opts.club, error: null };
      if (table === 'tournaments' && op === 'insert')
        return { data: { id: 'chip-tournament' }, error: null };
      if (table === 'tournament_schedule_spawns') return { data: [], error: null };
      return { data: null, error: null };
    };
    b.maybeSingle = async () => answer();
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(resolve, reject);
    return b as never;
  }) as never);
  vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string, args?: unknown) => {
    rpcCalls.push({ name, args });
    if (name === DIAMOND_SPAWN_RPC)
      return (
        opts.spawnAnswer ?? { data: { ok: true, tournament_id: TID, replayed: false }, error: null }
      );
    if (name === 'fn_ca_diamond_house_available')
      return { data: opts.houseAvailable ?? 0, error: null };
    return { data: null, error: null };
  }) as never);
  const writes = (table: string, op: string) =>
    calls.filter((c) => c.table === table && c.op === op).map((c) => c.args[0]);
  return { calls, rpcCalls, writes };
}

async function built(cfg: Record<string, unknown>, start: Date, clubId = ARENA) {
  const svc = new ScheduledTournamentService() as any;
  return svc.buildInsertRow(schedule(clubId, cfg), cfg, start) as Promise<Record<string, unknown>>;
}

const START = new Date(Date.now() + 26 * 60 * 60 * 1000); // outside the horse-seed window

beforeEach(() => vi.mocked(reportError).mockClear());
afterEach(() => vi.restoreAllMocks());

describe('the arena is recognised by its identity, not by its id', () => {
  it('reads the arena contract (diamonds, platform, no union)', () => {
    expect(isDiamondArenaClubRow(arenaClub)).toBe(true);
    expect(isDiamondArenaClubRow(chipClub)).toBe(false);
    expect(isDiamondArenaClubRow({ ...arenaClub, union_id: MIDWAY_UNION_ID })).toBe(false);
    expect(isDiamondArenaClubRow({ ...arenaClub, is_platform: null })).toBe(false);
    expect(isDiamondArenaClubRow(null)).toBe(false);
  });
});

describe('the p_config a Diamond schedule sends is whole Diamonds', () => {
  it('a Midway bounty: snapped total, guarantee carried, bounty floored', async () => {
    vi.spyOn(supabase, 'from');
    const row = await built(midwayBounty(), START);
    const mapped = diamondSpawnConfig(row, midwayBounty(), START);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const c = mapped.config;
    // 16.5 -> whole 17 -> ladder 15: the same price a chip event of this schedule charges.
    expect(c.buyIn).toBe(15);
    expect(row.buy_in_amount as number).toBeCloseTo(13.5);
    expect((row.buy_in_amount as number) + (row.buy_in_fee as number)).toBe(15);
    expect(c.guaranteedPrize).toBe(500);
    expect(c.type).toBe('bounty');
    expect(c.gameVariant).toBe('PLO5');
    // 3.75 on the chip row; a Diamond does not divide, and it is never rounded up.
    expect(c.bountyAmount).toBe(3);
    expect(c.startTime).toBe(START.toISOString());
    expect(c.startingStack).toBe(18000);
    expect(Array.isArray(c.blindStructure) && (c.blindStructure as unknown[]).length).toBeTruthy();
    expect(
      Array.isArray(c.payoutStructure) && (c.payoutStructure as unknown[]).length
    ).toBeTruthy();
    // The DB computes the fee; the engine never states it.
    expect(c).not.toHaveProperty('buyInFee');
    expect(c).not.toHaveProperty('fee');
    for (const k of ['buyIn', 'guaranteedPrize', 'bountyAmount'])
      expect(Number.isInteger(c[k])).toBe(true);
  });

  it('a Midway rebuy: whole rebuy and add-on prices on the door keys', async () => {
    vi.spyOn(supabase, 'from');
    const row = await built(midwayRebuy(), START);
    const mapped = diamondSpawnConfig(row, midwayRebuy(), START);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const c = mapped.config;
    expect(c.buyIn).toBe(10); // 8.8 -> 9 -> ladder 10
    expect(c.type).toBe('mtt');
    expect(c.rebuy).toBe(true);
    expect(c.addOn).toBe(true);
    expect(c.rebuyCost).toBe(9);
    expect(c.addonCost).toBe(9);
    expect(c.guaranteedPrize).toBe(400);
    // The chip-door spellings the Diamond create door refuses are never sent.
    for (const k of ['isRebuy', 'isReentry', 'addOnAvailable', 'addOnCost', 'guarantee'])
      expect(c).not.toHaveProperty(k);
  });

  it('a bounty that cannot be one whole Diamond inside the entry is refused before any claim', () => {
    const mapped = diamondSpawnConfig(
      { variant: 'bounty', tournament_type: 'MTT', max_players: 100, bounty_amount: 0.5 },
      { buyIn: 0 },
      START
    );
    expect(mapped).toEqual({
      ok: false,
      reason: 'diamond_schedule_bounty_not_whole_within_the_buy_in',
    });
  });

  it('the door answer is read without folding unknown into a spawn', () => {
    expect(readDiamondSpawnAnswer({ ok: true, tournament_id: TID, replayed: true }, null)).toEqual({
      ok: true,
      tournamentId: TID,
      replayed: true,
    });
    expect(readDiamondSpawnAnswer({ ok: false, reason: 'house_short' }, null)).toEqual({
      ok: false,
      reason: 'house_short',
    });
    expect(readDiamondSpawnAnswer(null, { message: 'boom' }).ok).toBe(false);
    expect(readDiamondSpawnAnswer({ ok: true }, null).ok).toBe(false);
    expect(readDiamondSpawnAnswer([], null).ok).toBe(false);
  });
});

describe('a Diamond schedule spawns through the door', () => {
  it('claims the occurrence, calls the RPC with the mapped config, never inserts, links the id', async () => {
    const db = fakeDb({ club: arenaClub });
    const svc = new ScheduledTournamentService() as any;
    const cfg = midwayBounty();
    await svc.spawnInstance(schedule(ARENA, cfg), cfg, 'key-1', START);

    expect(db.writes('tournament_schedule_spawns', 'insert')).toEqual([
      { schedule_id: SCHEDULE, spawn_key: 'key-1' },
    ]);
    expect(db.writes('tournaments', 'insert')).toEqual([]);
    const spawn = db.rpcCalls.filter((c) => c.name === DIAMOND_SPAWN_RPC);
    expect(spawn).toHaveLength(1);
    const args = spawn[0].args as Record<string, any>;
    expect(args.p_schedule_id).toBe(SCHEDULE);
    expect(args.p_scheduled_start).toBe(START.toISOString());
    expect(args.p_config.buyIn).toBe(15);
    expect(args.p_config.guaranteedPrize).toBe(500);
    expect(args.p_config.bountyAmount).toBe(3);
    expect(db.writes('tournament_schedule_spawns', 'update')).toEqual([{ tournament_id: TID }]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('{ok:false} inserts nothing, links nothing, releases the claim, reports the reason, and backs off', async () => {
    const db = fakeDb({
      club: arenaClub,
      spawnAnswer: {
        data: { ok: false, reason: 'diamond_house_cannot_cover: short by 400' },
        error: null,
      },
      houseAvailable: 100,
    });
    const svc = new ScheduledTournamentService() as any;
    const seed = vi.spyOn(svc.horseSeeder, 'topUpWithHorses');
    const cfg = { ...midwayBounty(), horsesToRegister: 5 };
    await svc.spawnInstance(schedule(ARENA, cfg), cfg, 'key-2', START);

    expect(db.writes('tournaments', 'insert')).toEqual([]);
    expect(db.writes('tournament_schedule_spawns', 'update')).toEqual([]);
    expect(db.writes('tournament_schedule_spawns', 'delete')).toHaveLength(1);
    expect(seed).not.toHaveBeenCalled();
    const messages = vi.mocked(reportError).mock.calls.map((c) => String((c[0] as Error).message));
    expect(messages.some((m) => m.includes('short by 400'))).toBe(true);

    // The house did not move, so the next poll does not ask again.
    await svc.spawnInstance(schedule(ARENA, cfg), cfg, 'key-2', START);
    expect(db.rpcCalls.filter((c) => c.name === DIAMOND_SPAWN_RPC)).toHaveLength(1);
  });

  it('an unreadable arena club row spawns nothing this poll', async () => {
    const db = fakeDb({ club: null });
    const svc = new ScheduledTournamentService() as any;
    const cfg = midwayBounty();
    await svc.spawnInstance(schedule(ARENA, cfg), cfg, 'key-3', START);
    expect(db.writes('tournament_schedule_spawns', 'insert')).toEqual([]);
    expect(db.writes('tournaments', 'insert')).toEqual([]);
    expect(db.rpcCalls.filter((c) => c.name === DIAMOND_SPAWN_RPC)).toEqual([]);
  });

  it('the guarantee bank of a Diamond schedule is the arena house', async () => {
    fakeDb({ club: arenaClub, houseAvailable: 12_345 });
    const svc = new ScheduledTournamentService() as any;
    expect(await svc.readFundingBank(ARENA)).toBe(12_345);
  });
});

describe('a chip schedule is untouched', () => {
  it('inserts exactly the row buildInsertRow builds, and never calls the Diamond door', async () => {
    const cfg = midwayBounty();
    vi.spyOn(supabase, 'from');
    const expected = await built(cfg, START, CHIP_CLUB);
    vi.restoreAllMocks();

    const db = fakeDb({ club: chipClub });
    const svc = new ScheduledTournamentService() as any;
    await svc.spawnInstance(schedule(CHIP_CLUB, cfg), cfg, 'key-4', START);
    expect(db.writes('tournaments', 'insert')).toEqual([expected]);
    expect(db.rpcCalls.filter((c) => c.name === DIAMOND_SPAWN_RPC)).toEqual([]);
    expect(db.writes('tournament_schedule_spawns', 'update')).toEqual([
      { tournament_id: 'chip-tournament' },
    ]);
    expect(await svc.readFundingBank(CHIP_CLUB)).toBe(50_000);
  });

  it('a union schedule never even reads its club to decide', async () => {
    const db = fakeDb({ club: chipClub });
    const svc = new ScheduledTournamentService() as any;
    const cfg = midwayBounty();
    await svc.spawnInstance(schedule(MIDWAY_UNION_ID, cfg, MIDWAY_UNION_ID), cfg, 'key-5', START);
    expect(db.calls.filter((c) => c.table === 'clubs')).toEqual([]);
    expect(db.writes('tournaments', 'insert')).toHaveLength(1);
    expect(db.rpcCalls.filter((c) => c.name === DIAMOND_SPAWN_RPC)).toEqual([]);
  });
});

/** club_members fake: answers the rows whose club is in the `.in('club_id', ...)` list. */
function membershipDb(
  club: Record<string, unknown>,
  members: Array<{ user_id: string; club_id: string }>
) {
  const asked: string[][] = [];
  vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
    let clubIds: string[] = [];
    const b: Record<string, any> = {};
    for (const m of ['select', 'eq', 'is', 'gt', 'order', 'limit', 'range']) b[m] = () => b;
    b.in = (col: string, vals: string[]) => {
      if (col === 'club_id') {
        clubIds = vals;
        asked.push(vals);
      }
      return b;
    };
    const answer = () =>
      table === 'clubs'
        ? { data: club, error: null }
        : {
            data: members
              .filter((m) => clubIds.includes(m.club_id))
              .map((m) => ({ user_id: m.user_id }))
              .sort((a, b) => a.user_id.localeCompare(b.user_id)),
            error: null,
          };
    b.maybeSingle = async () => answer();
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
    return b as never;
  }) as never);
  return asked;
}

describe('horses register into Diamond Arena events like players', () => {
  const DSS = DIAMOND_ARENA_HORSE_CLUBS[0];
  const members = [
    { user_id: 'arena-human', club_id: ARENA },
    { user_id: 'dss-horse-1', club_id: DSS },
    { user_id: 'dss-horse-2', club_id: DSS },
    { user_id: 'chip-horse', club_id: CHIP_CLUB },
  ];

  it('a Diamond event draws on the arena members plus Deep Stack Society', async () => {
    const asked = membershipDb(arenaClub, members);
    const svc = new TournamentRecurringService() as any;
    const ids: Set<string> = await svc.clubMemberIdsForScope(ARENA, undefined);
    expect([...ids].sort()).toEqual(['arena-human', 'dss-horse-1', 'dss-horse-2']);
    expect(asked[0].sort()).toEqual([ARENA, ...DIAMOND_ARENA_HORSE_CLUBS].sort());
  });

  it('a chip standalone club still draws on exactly its own members', async () => {
    const asked = membershipDb(chipClub, members);
    const svc = new TournamentRecurringService() as any;
    const ids: Set<string> = await svc.clubMemberIdsForScope(CHIP_CLUB, undefined);
    expect([...ids]).toEqual(['chip-horse']);
    expect(asked).toEqual([[CHIP_CLUB]]);
  });
});

describe('the Diamond bankroll gate reads Diamonds', () => {
  /** Two event-lane horse ids, found rather than hard-coded, so the lane hash cannot drift the test. */
  const eventLaneIds = (prefix: string, n: number): string[] => {
    const out: string[] = [];
    for (let i = 0; out.length < n && i < 10_000; i++) {
      const id = `${prefix}-${i}`;
      if (gameLaneFor(id) !== 'cash') out.push(id);
    }
    return out;
  };

  it('a horse whose Diamonds cannot carry the entry is not registered; one that can is', async () => {
    const [rich, broke] = eventLaneIds('dss-horse', 2);
    const tables: string[] = [];
    const memberWalletReads: unknown[] = [];
    const target = {
      club_id: ARENA,
      union_id: null,
      buy_in_amount: 9,
      buy_in_fee: 1,
    };
    vi.spyOn(supabase, 'from').mockImplementation(((table: string) => {
      tables.push(table);
      const b: Record<string, any> = {};
      for (const m of ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit', 'range'])
        b[m] = (...args: unknown[]) => {
          if (table === 'club_members' && m === 'select') memberWalletReads.push(args[0]);
          return b;
        };
      const answer = () => {
        if (table === 'tournaments') return { data: target, error: null };
        if (table === 'clubs') return { data: arenaClub, error: null };
        if (table === 'profiles')
          return {
            data: [
              {
                id: rich,
                display_name: rich,
                username: rich,
                use_real_name: false,
                diamonds: 100_000,
              },
              {
                id: broke,
                display_name: broke,
                username: broke,
                use_real_name: false,
                diamonds: 5,
              },
            ],
            error: null,
          };
        return { data: [], error: null };
      };
      b.maybeSingle = async () => answer();
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
      return b as never;
    }) as never);
    const rpc = vi.fn(async (name: string, _args?: unknown) =>
      name === 'fn_horse_tournament_entry_ticket_hints'
        ? { data: { ok: true, holder_ids: [] }, error: null }
        : { data: { ok: true, registration_id: 'r' }, error: null }
    );
    vi.spyOn(supabase, 'rpc').mockImplementation(rpc as never);

    const svc = new TournamentRecurringService() as any;
    vi.spyOn(svc, 'horseLoadMap').mockResolvedValue(new Map());
    vi.spyOn(svc, 'clubMemberIdsForTournament').mockResolvedValue(new Set([rich, broke]));
    await svc.registerHorses(TID, 2);

    const entered = rpc.mock.calls
      .filter(([name]) => name === 'fn_register_horse_for_tournament')
      .map(([, args]) => (args as unknown as { p_user_id: string }).p_user_id);
    expect(entered).toEqual([rich]);
    // The arena has no chip wallet for a Deep Stack horse; it was never consulted.
    expect(memberWalletReads).toEqual([]);
  });
});

describe('the overlay guard covers the arena while its tournaments are on', () => {
  it('adds the arena host only when the switch reads exactly true', () => {
    expect(overlayHostsFrom({ club_id: ARENA, tournaments_enabled: true })).toEqual([
      MIDWAY_UNION_ID,
      ARENA,
    ]);
    expect(overlayHostsFrom({ club_id: ARENA, tournaments_enabled: false })).toEqual([
      MIDWAY_UNION_ID,
    ]);
    expect(overlayHostsFrom({ club_id: ARENA, tournaments_enabled: null })).toEqual([
      MIDWAY_UNION_ID,
    ]);
    expect(overlayHostsFrom(null)).toEqual([MIDWAY_UNION_ID]);
    expect(
      overlayHostsFrom({ club_id: ARENA, tournaments_enabled: true }, { message: 'x' })
    ).toEqual([MIDWAY_UNION_ID]);
  });
});
