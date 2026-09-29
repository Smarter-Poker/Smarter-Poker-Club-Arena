/**
 * A DEPARTED PLAYER LEAVES NO TIME-BANK METADATA BEHIND (2026-09-25).
 *
 * Release 778075b4 wedged every tournament that had ever lost a player. The
 * stop path captures stopped time-bank custody and refuses, by design, when
 * `timeBankMeta` names a user with no live bank ("Stopped time bank metadata
 * has no original balance"). On a tournament table that was every departed
 * player: the deal set metadata for everyone dealt in, and a table-balancing
 * move or an elimination removed the seat without removing the metadata. The
 * refusal happened before the custody object was assigned, so
 * `hasUnretiredStoppedTimeBankCustody()` stayed true through the
 * `timeBankMeta.size > 0` branch, `unregisterTableEngine` refused for ever,
 * and the manager's stop failed every five seconds: 31,061 refusals over 24
 * engines in 1.6 hours, 17 managers quarantined, 50 tables idle for hours.
 *
 * The invariant these tests hold: `timeBankMeta` names only a user who
 * either has a live bank or is covered by stopped custody. A departure
 * forgets the bank and the metadata together.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({
  row: null as any,
  rpc: vi.fn(),
  historyRead: vi.fn(),
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    rpc: data.rpc,
    from: (tableName: string) =>
      tableName === 'hand_history'
        ? {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: data.historyRead,
                  }),
                }),
              }),
            }),
          }
        : {
            upsert: async (row: unknown) => {
              data.row = row;
              return { error: null };
            },
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: data.row, error: null }) }),
            }),
          },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/supabase.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase.js')),
  loadTable: async () => ({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tournament_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    small_blind: 1,
    big_blind: 2,
    max_players: 6,
    game_variant: 'nlh',
  }),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { GameServer } from '../GameServer.js';

const table = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tournament = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const stays = {
  seated: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  moved: 'cccccccc-cccc-4ccc-8ccc-000000000002',
  busted: 'cccccccc-cccc-4ccc-8ccc-000000000003',
};
const users = {
  seated: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
  moved: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
  busted: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003',
};
type Who = keyof typeof users;
const seat = (who: Who, seatNumber: number) => ({
  user_id: users[who],
  occupancy_id: stays[who],
  seat_number: seatNumber,
  stack: 1500,
});

/** A tournament dealer with three players dealt in, exactly as the deal seeds them. */
function dealtInTournamentEngine() {
  const e = new ServerTableEngine(table) as any;
  e.lifecycleCanMutate = () => true;
  e.tableInfo = { id: table, tournament_id: tournament, tournament_type: 'mtt' };
  e.handCount = 12;
  e.parkWriteRetryMs = 0;
  e.flushSnapshot = vi.fn().mockResolvedValue(undefined);
  e.adoptSeatRoster([seat('seated', 1), seat('moved', 2), seat('busted', 3)]);
  for (const who of ['seated', 'moved', 'busted'] as const) {
    // ServerTableEngineDealing seeds a bank and its metadata together, once,
    // for every player dealt in.
    e.timeBankEngine.initializePlayer(table, users[who], {
      remainingSeconds: 40,
      usesRemaining: 2,
    });
    e.timeBankMeta.set(users[who], { initialSeconds: 40, baseSeconds: 40, dbConsumedSeconds: 0 });
  }
  return e;
}

beforeEach(() => {
  data.row = null;
  data.rpc.mockReset();
  data.historyRead.mockReset().mockResolvedValue({ data: { hand_number: 12 }, error: null });
});

describe('a departed tournament player leaves no time-bank metadata behind', () => {
  it('forgets the bank and the metadata of every seat the next roster no longer holds', () => {
    const e = dealtInTournamentEngine();
    // The balancing move and the elimination both commit in the database; the
    // engine learns of either the same way, from the next authoritative roster.
    e.adoptSeatRoster([seat('seated', 1)]);
    expect([...e.timeBankMeta.keys()]).toEqual([users.seated]);
    expect(e.timeBankEngine.getPlayerBank(table, users.seated)).not.toBeNull();
    expect(e.timeBankEngine.getPlayerBank(table, users.moved)).toBeNull();
    expect(e.timeBankEngine.getPlayerBank(table, users.busted)).toBeNull();
    expect(e.timeBankEngine.hasPlayerBanksForTable(table)).toBe(true);
  });

  it('stops without refusing custody, captures only the seated player, and retires through the closed-session path', async () => {
    const e = dealtInTournamentEngine();
    e.adoptSeatRoster([seat('seated', 1)]);
    await expect(e.stop()).resolves.toBeUndefined();
    expect(Object.keys(e.stoppedTimeBankCustody.banks)).toEqual([users.seated]);
    expect(e.stoppedTimeBankCustody.banks[users.seated]).toMatchObject({
      occupancyId: stays.seated,
      remainingSeconds: 40,
      usesRemaining: 2,
    });
    expect([...e.timeBankMeta.keys()]).toEqual([users.seated]);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
    const owner = Object.assign(Object.create(GameServer.prototype), {
      tableEngines: new Map([[table, e]]),
      tournamentOwnedTables: new Set([table]),
    });
    expect(owner.unregisterTableEngine(table, e)).toBe(true);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
    expect(owner.tableEngines.has(table)).toBe(false);
  });

  it('stops without refusing custody after an acknowledged park that names only the seated player', async () => {
    const e = dealtInTournamentEngine();
    e.adoptSeatRoster([seat('seated', 1)]);
    await e.persistPresenceForRestart('parked');
    expect(Object.keys(data.row.time_bank_snapshot.players)).toEqual([users.seated]);
    await expect(e.stop()).resolves.toBeUndefined();
    expect(Object.keys(e.stoppedTimeBankCustody.banks)).toEqual([users.seated]);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
  });

  it('still refuses custody for metadata that names a user with no bank', async () => {
    // The stop-time check is the invariant's witness and stays exactly as it
    // was; the departures above are what changed to agree with it.
    const e = dealtInTournamentEngine();
    e.timeBankEngine.removePlayer(table, users.moved);
    await expect(e.stop()).rejects.toThrow('teardown failed');
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(true);
  });
});
