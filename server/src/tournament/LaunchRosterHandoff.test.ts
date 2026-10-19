import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ read: vi.fn(), rpc: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from(table: string) {
      const q: any = {};
      for (const name of ['select', 'eq', 'in', 'is', 'limit', 'order', 'maybeSingle'])
        q[name] = () => q;
      q.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(transport.read(table)).then(resolve, reject);
      return q;
    },
    rpc: (name: string, args: unknown) => Promise.resolve(transport.rpc(name, args)),
  },
}));

import { TournamentManagerBase, readLaunchCohort } from './TournamentManagerBase.js';

const id = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tableId = id(10);
const tournamentId = id(20);
const start = '2026-10-19T00:00:00.000Z';
type Row = {
  id: string;
  user_id: string;
  status: string;
  table_id: string | null;
  seat_number: number | null;
  chips: number;
};
let roster: Row[];
let cohort: string[] | null;
let extraSeat: boolean;

function playing(n: number): Row {
  return {
    id: id(n),
    user_id: id(n + 100),
    status: 'playing',
    table_id: tableId,
    seat_number: n,
    chips: 1000,
  };
}
function pending(n = 3): Row {
  return { ...playing(n), status: 'registered', table_id: null, seat_number: null, chips: 0 };
}
const mtt = (format = 'mtt-v1') => ({
  id: tournamentId,
  format_contract: format,
  tournament_type: format === 'mtt-v1' ? 'MTT' : 'SNG',
  variant: format === 'mtt-v1' ? 'freezeout' : 'sng',
  max_players: format === 'mtt-v1' ? 100 : 2,
  starting_chips: 1000,
});
async function proof(format = 'mtt-v1', expected = [id(101), id(102)]) {
  const manager: any = Object.create(TournamentManagerBase.prototype);
  const lifecycle = {};
  manager.tournamentId = tournamentId;
  manager.tableEngines = new Map([[tableId, {}]]);
  manager.assertLifecycleCurrent = (token: unknown) => expect(token).toBe(lifecycle);
  return manager.proveTournamentLaunchSetup(
    lifecycle,
    mtt(format),
    2,
    expected,
    2,
    null,
    start,
    cohort
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  roster = [playing(1), playing(2), pending()];
  cohort = [id(1), id(2)];
  extraSeat = false;
  transport.rpc.mockReset();
  transport.read.mockImplementation((table: string) => {
    const playingRows = roster.filter((row) => row.status === 'playing');
    const seats = playingRows.map((row) => ({ ...row, stack: row.chips }));
    if (extraSeat) seats.push({ ...playing(3), stack: 1000 });
    const data: Record<string, unknown> = {
      tournaments: { status: 'REGISTERING', started_at: null },
      tournament_players: roster,
      tables: [{ id: tableId, status: 'waiting', current_players: seats.length, max_players: 9 }],
      table_seats: seats,
    };
    // The engine's service role holds no grant on the receipt table: the
    // cohort must arrive with the begin RPC, never from a direct read.
    if (!(table in data)) throw new Error(`Unexpected launch read: ${table}`);
    return { data: data[table], error: null };
  });
});

describe('the actual launch proof retains the locked field and its accepted-entry handoff', () => {
  it('proves the seated launch field while a later accepted entrant waits for its chair', async () => {
    expect(await proof()).toBe(true);
  });
  it('also accepts a post-cohort entry already present in the process snapshot', async () => {
    expect(await proof('mtt-v1', [id(101), id(102), id(103)])).toBe(true);
  });
  it('does not omit an unseated member of the locked launch cohort', async () => {
    cohort = [id(1), id(2), id(3)];
    expect(await proof()).toBe(false);
  });
  it('retains strict full-roster proof when the receipt carries no cohort', async () => {
    cohort = null;
    expect(await proof()).toBe(false);
    roster.pop();
    expect(await proof()).toBe(true);
  });
  it('retains exact seat-first launch proof', async () => {
    expect(await proof('sng-v1')).toBe(false);
    roster.pop();
    expect(await proof('sng-v1')).toBe(true);
  });
  it('proves a fully funded post-cohort entrant who is already seated', async () => {
    roster[2] = playing(3);
    expect(await proof()).toBe(true);
  });
  it('requires the funded floor to grow with every already-playing entrant', async () => {
    roster[2] = { ...playing(3), chips: 0 };
    expect(await proof()).toBe(false);
  });
  it('does not hide a missing original player behind a later playing entrant', async () => {
    roster = [playing(1), playing(3)];
    expect(await proof()).toBe(false);
  });
  it.each(['negative', 'coordinate', 'duplicate', 'live-chair'] as const)(
    'refuses malformed pending evidence: %s',
    async (kind) => {
      if (kind === 'negative') roster[2].chips = -1;
      if (kind === 'coordinate') roster[2].table_id = tableId;
      if (kind === 'duplicate') roster[2].user_id = roster[0].user_id;
      if (kind === 'live-chair') extraSeat = true;
      expect(await proof()).toBe(false);
    }
  );
});

describe('the begin receipt cohort', () => {
  it('reads an absent or NULL cohort as the strict legacy proof', () => {
    expect(readLaunchCohort(undefined)).toBeNull();
    expect(readLaunchCohort(null)).toBeNull();
  });
  it('accepts exact unique identities', () => {
    expect(readLaunchCohort([id(1), id(2)])).toEqual([id(1), id(2)]);
  });
  it.each([[[id(1), id(1)]], [['unknown']], [[1]], ['{}']])(
    'refuses a malformed cohort %#',
    (value) => {
      expect(readLaunchCohort(value)).toBeUndefined();
    }
  );
});

describe('accepted entries awaiting chairs are seated through the database door', () => {
  function seater(rows: Array<{ user_id: string }>, format = 'mtt-v1') {
    const manager: any = Object.create(TournamentManagerBase.prototype);
    manager.tournamentId = tournamentId;
    manager.tournamentCache = mtt(format);
    manager.requestUrgentEliminationSweepAfter = vi.fn();
    let remaining = [...rows];
    transport.read.mockImplementation((table: string) => {
      expect(table).toBe('tournament_players');
      return { data: remaining, error: null };
    });
    const seated: string[] = [];
    const answer = { reason: 'ok' as string };
    transport.rpc.mockImplementation((name: string, args: any) => {
      expect(name).toBe('fn_seat_late_registrant');
      expect(args.p_tournament_id).toBe(tournamentId);
      if (answer.reason !== 'ok')
        return { data: { ok: false, reason: answer.reason }, error: null };
      seated.push(args.p_user_id);
      remaining = remaining.filter((row) => row.user_id !== args.p_user_id);
      return { data: { ok: true }, error: null };
    });
    return { manager, seated, answer };
  }

  it('seats every handed-off entry and reports nothing left', async () => {
    const { manager, seated } = seater([{ user_id: id(201) }, { user_id: id(202) }]);
    expect(await manager.seatAcceptedEntrantsAwaitingChairs('test', () => true)).toBe(true);
    expect(seated).toEqual([id(201), id(202)]);
  });
  it('keeps the wake and re-drives while the platform is frozen', async () => {
    const { manager, answer } = seater([{ user_id: id(201) }]);
    answer.reason = 'platform_frozen';
    expect(await manager.seatAcceptedEntrantsAwaitingChairs('test', () => true)).toBe(false);
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });
  it('treats an entry another path already seated as done', async () => {
    const { manager, answer } = seater([{ user_id: id(201) }]);
    answer.reason = 'already_seated_or_missing';
    // The row still reads back once; the second page must not retry it forever.
    expect(await manager.seatAcceptedEntrantsAwaitingChairs('test', () => true)).toBe(true);
  });
  it('never seats into a fixed-field format', async () => {
    const { manager, seated } = seater([{ user_id: id(201) }], 'sng-v1');
    expect(await manager.seatAcceptedEntrantsAwaitingChairs('test', () => true)).toBe(true);
    expect(seated).toEqual([]);
    expect(transport.rpc).not.toHaveBeenCalled();
  });
  it('stops without writing once its authority is gone', async () => {
    const { manager } = seater([{ user_id: id(201) }]);
    expect(await manager.seatAcceptedEntrantsAwaitingChairs('test', () => false)).toBe(false);
    expect(transport.rpc).not.toHaveBeenCalled();
  });
});
