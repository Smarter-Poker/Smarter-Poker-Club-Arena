/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FROM A TOURNAMENT TABLE, QUICK JOIN OFFERS TOURNAMENTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-04, verbatim: "IF YOU ARE CURRENTLY ON A MTT TABLE, AND CLICK
 * THE + BUTTON TO ADD ANOTHER, IT SHOULD BRING YOU TO MORE MTT'S, IT CURRENTLY
 * ONLY IDENTIFIES THE 'GAME TYPE' (NO LIMIT HOLDEM) AND SHOWS YOU CASH GAMES,
 * INSTEAD OF THE CURRENT TOURNAMENTS FOR 'QUICK JOIN' FUNCTIONALITY."
 *
 * The sheet's candidate query is `.is('tournament_id', null)`: cash tables, by
 * construction. A Spin was given its own answer on 2026-09-05; every other
 * tournament returned null from that branch and fell through to the cash query,
 * where the only thing left to match on was the variant.
 *
 * Pinned here: what is offered and in what order (pure), what the real lobby
 * rules let through (the loader, against mocked reads), and the wiring in
 * MultiTablePage that keeps a tournament player off the cash sheet and keeps
 * JOIN on the existing registration surface instead of a second one.
 *
 * Registry: docs/laws.d/a-tournament-offers-more-tournaments.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  rankQuickJoinTournaments,
  rankQuickJoinTables,
  quickJoinIsTournament,
  type QuickJoinTournamentCandidate,
} from '../src/lib/quickJoinRanking';

const h = vi.hoisted(() => ({
  getTournaments: vi.fn(),
  registrations: [] as Array<{ tournament_id: string }>,
  registrationsError: null as unknown,
  tableRow: null as { id: string; tournament_id: string | null } | null,
  tournamentRow: null as Record<string, unknown> | null,
}));

vi.mock('../src/services/TournamentService', () => ({
  tournamentService: { getTournaments: h.getTournaments },
}));

vi.mock('../src/lib/supabase', () => {
  /** A chain that answers like PostgREST: thenable, and `.maybeSingle()`. */
  const chain = (many: () => unknown, one: () => unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'limit', 'order', 'neq', 'is', 'not']) {
      c[m] = () => c;
    }
    c.maybeSingle = () => Promise.resolve(one());
    c.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve(many()).then(ok, bad);
    return c;
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'tournament_players') {
          return chain(
            () => ({ data: h.registrations, error: h.registrationsError }),
            () => ({ data: null, error: null })
          );
        }
        if (table === 'tables') {
          return chain(
            () => ({ data: h.tableRow ? [h.tableRow] : [], error: null }),
            () => ({ data: h.tableRow, error: null })
          );
        }
        if (table === 'tournaments') {
          return chain(
            () => ({ data: h.tournamentRow ? [h.tournamentRow] : [], error: null }),
            () => ({ data: h.tournamentRow, error: null })
          );
        }
        return chain(
          () => ({ data: [], error: null }),
          () => ({ data: null, error: null })
        );
      },
    },
  };
});

import {
  quickJoinTournamentRows,
  readTournamentContext,
  toQuickJoinTournamentCandidate,
} from '../src/lib/quickJoinTournaments';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const HOUR = 3600_000;

const event = (
  over: Partial<QuickJoinTournamentCandidate> & { id: string }
): QuickJoinTournamentCandidate => ({
  name: over.id,
  variant: 'nlh',
  format: 'mtt',
  buyIn: 55,
  entrants: 10,
  capacity: null,
  entryOpen: true,
  stateLabel: 'Registering',
  startMs: 1_000_000,
  ...over,
});

/** The event the player is sitting in for most cases: a 55 NLH MTT. */
const playing = { id: 'current', variant: 'nlh', buyIn: 55 };

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

// ═══════════════════════════════════════════════════════════════════════════════
// THE RANKING (pure)
// ═══════════════════════════════════════════════════════════════════════════════

describe('what is never offered', () => {
  it('the tournament the player is already sitting in', () => {
    const ranked = rankQuickJoinTournaments([event({ id: 'current' }), event({ id: 'other' })], {
      currentTournament: playing,
    });
    expect(ids(ranked)).toEqual(['other']);
  });

  it('a tournament the player is already registered or seated in', () => {
    const ranked = rankQuickJoinTournaments([event({ id: 'mine' }), event({ id: 'open' })], {
      currentTournament: playing,
      excludeIds: ['mine'],
    });
    expect(ids(ranked)).toEqual(['open']);
  });

  it('one whose late registration has closed, or that is finishing or over', () => {
    const ranked = rankQuickJoinTournaments(
      [
        event({ id: 'closed', entryOpen: false, stateLabel: 'Running' }),
        event({ id: 'late', stateLabel: 'Late Reg' }),
      ],
      { currentTournament: playing }
    );
    expect(ids(ranked)).toEqual(['late']);
  });

  it('a capped event that is full, while an uncapped one is never "full"', () => {
    const ranked = rankQuickJoinTournaments(
      [
        event({ id: 'full-sng', format: 'sng', entrants: 9, capacity: 9 }),
        event({ id: 'filling-sng', format: 'sng', entrants: 4, capacity: 9 }),
        event({ id: 'big-mtt', entrants: 4000, capacity: null }),
      ],
      { currentTournament: playing }
    );
    expect(ids(ranked).sort()).toEqual(['big-mtt', 'filling-sng']);
    expect(ranked.find((r) => r.id === 'filling-sng')?.seatsOpen).toBe(5);
    expect(ranked.find((r) => r.id === 'big-mtt')?.seatsOpen).toBeNull();
  });

  it('a Spin, which answers through its own sheet', () => {
    const ranked = rankQuickJoinTournaments(
      [event({ id: 'spin', format: 'spin' }), event({ id: 'mtt' })],
      { currentTournament: playing }
    );
    expect(ids(ranked)).toEqual(['mtt']);
  });

  it('the same tournament twice, when two scopes both returned it', () => {
    const ranked = rankQuickJoinTournaments([event({ id: 'a' }), event({ id: 'a' })], {
      currentTournament: playing,
    });
    expect(ids(ranked)).toEqual(['a']);
  });
});

describe('the order', () => {
  it('the same game comes before every other game, whatever the price', () => {
    const ranked = rankQuickJoinTournaments(
      [
        event({ id: 'plo-same-price', variant: 'plo', buyIn: 55 }),
        event({ id: 'nlh-far', variant: 'nlh', buyIn: 1050 }),
      ],
      { currentTournament: playing }
    );
    expect(ids(ranked)).toEqual(['nlh-far', 'plo-same-price']);
    expect(ranked[0].tier).toBe('same-game');
    expect(ranked[1].tier).toBe('other');
  });

  it('within a game, the nearest buy-in to the one being played comes first', () => {
    const ranked = rankQuickJoinTournaments(
      [
        event({ id: 'b-1050', buyIn: 1050 }),
        event({ id: 'b-11', buyIn: 11 }),
        event({ id: 'b-55', buyIn: 55 }),
        event({ id: 'b-109', buyIn: 109 }),
        event({ id: 'b-free', buyIn: 0 }),
      ],
      { currentTournament: playing }
    );
    expect(ids(ranked)).toEqual(['b-55', 'b-11', 'b-109', 'b-free', 'b-1050']);
    expect(ranked[0].tier).toBe('same-buy-in');
  });

  it('aliases of one game are one game', () => {
    const ranked = rankQuickJoinTournaments(
      [event({ id: 'omaha', variant: 'omaha' }), event({ id: 'holdem', variant: 'holdem' })],
      { currentTournament: { id: 'current', variant: 'nlhe', buyIn: 55 } }
    );
    expect(ids(ranked)).toEqual(['holdem', 'omaha']);
  });

  it('at the same price the sooner start wins, and an event with no clock goes last', () => {
    const ranked = rankQuickJoinTournaments(
      [
        event({ id: 'sng-no-clock', format: 'sng', entrants: 4, capacity: 9, startMs: null }),
        event({ id: 'later', startMs: 5 * HOUR }),
        event({ id: 'sooner', startMs: 1 * HOUR }),
      ],
      { currentTournament: playing }
    );
    expect(ids(ranked)).toEqual(['sooner', 'later', 'sng-no-clock']);
  });

  it('is deterministic: the same events in any order give the same sheet', () => {
    const set = [
      event({ id: 'c', name: 'Charlie' }),
      event({ id: 'a', name: 'Alpha' }),
      event({ id: 'b', name: 'Bravo' }),
    ];
    const forward = ids(rankQuickJoinTournaments(set, { currentTournament: playing }));
    const backward = ids(
      rankQuickJoinTournaments([...set].reverse(), { currentTournament: playing })
    );
    expect(forward).toEqual(['a', 'b', 'c']);
    expect(backward).toEqual(forward);
  });

  it('shows five, and still ranks sensibly when the current event is unreadable', () => {
    const many = Array.from({ length: 8 }, (_, i) => event({ id: `t${i}`, startMs: i * HOUR }));
    expect(rankQuickJoinTournaments(many, { currentTournament: playing })).toHaveLength(5);
    const blind = rankQuickJoinTournaments(many, { currentTournament: null });
    expect(ids(blind)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(blind.every((r) => r.tier === 'other')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE LOADER (the lobby's own rules decide what can be entered)
// ═══════════════════════════════════════════════════════════════════════════════

const soon = () => new Date(Date.now() + 2 * HOUR).toISOString();

const dbRow = (over: Record<string, unknown> & { id: string }) => ({
  name: `event ${over.id}`,
  game_type: 'nlh',
  format_contract: 'mtt-v2',
  buy_in_amount: 50,
  buy_in_fee: 5,
  guaranteed_prize: null,
  start_time: soon(),
  status: 'REGISTERING',
  current_players: 12,
  max_players: null,
  starting_chips: 10000,
  late_reg_mins: 0,
  late_reg_levels: 0,
  ...over,
});

describe('quickJoinTournamentRows', () => {
  beforeEach(() => {
    h.getTournaments.mockReset();
    h.registrations = [];
    h.registrationsError = null;
  });

  const context = {
    id: 'current',
    clubId: 'club-1',
    buyIn: 55,
    variant: 'nlh',
    format: 'mtt' as const,
  };

  it('lists enterable tournaments and nothing else, in ranked order', async () => {
    h.registrations = [{ tournament_id: 'mine' }];
    h.getTournaments.mockResolvedValue([
      dbRow({ id: 'current' }),
      dbRow({ id: 'mine' }),
      dbRow({ id: 'far', buy_in_amount: 1000, buy_in_fee: 50 }),
      dbRow({ id: 'near', buy_in_amount: 100, buy_in_fee: 9 }),
      dbRow({ id: 'same' }),
      dbRow({ id: 'plo', game_type: 'plo' }),
      dbRow({ id: 'running-closed', status: 'RUNNING', started_at: new Date().toISOString() }),
      dbRow({ id: 'bagged', status: 'BAGGED' }),
      dbRow({ id: 'no-contract', format_contract: undefined }),
      dbRow({ id: 'spin', format_contract: 'spin-v1', max_players: 3, current_players: 1 }),
      dbRow({ id: 'full-sng', format_contract: 'sng-v1', max_players: 9, current_players: 9 }),
    ]);

    const rows = (await quickJoinTournamentRows(['club-1'], context, 'user-1')) ?? [];

    expect(rows.map((r) => r.id)).toEqual(['same', 'near', 'far', 'plo']);
    // Asked to throw, so an unreadable list is never mistaken for an empty one.
    expect(h.getTournaments).toHaveBeenCalledWith('club-1', { throwOnError: true });
    for (const r of rows) {
      // Every row is a TOURNAMENT and says where JOIN goes.
      expect(r.tournamentId).toBe(r.id);
      expect(r.code).toBe('MTT');
    }
  });

  it('prints the lobby buy-in total, the entrants and the state on each row', async () => {
    h.getTournaments.mockResolvedValue([
      dbRow({ id: 'paid', name: 'sunday nlh special', current_players: 1204 }),
      dbRow({ id: 'free', buy_in_amount: 0, buy_in_fee: 0 }),
      dbRow({
        id: 'sng',
        format_contract: 'sng-v1',
        max_players: 9,
        current_players: 4,
        buy_in_amount: 20,
        buy_in_fee: 2,
      }),
    ]);
    const rows = (await quickJoinTournamentRows(['club-1'], context, 'user-1')) ?? [];
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(by.paid.stakes).toBe('55');
    expect(by.paid.seats).toBe('1,204 Entered');
    expect(by.paid.name).toBe('Sunday NLH Special');
    expect(by.paid.reason.length).toBeGreaterThan(0);

    expect(by.free.stakes).toBe('Free Buy');

    expect(by.sng.code).toBe('SNG');
    expect(by.sng.stakes).toBe('22');
    expect(by.sng.seats).toBe('4/9');
    expect(by.sng.max).toBe(9);

    for (const r of rows) {
      // Player-visible copy: no em dash, every word capitalised.
      for (const text of [r.reason, r.seats, r.stakes]) {
        expect(text).not.toContain('—');
        for (const word of text.split(' ').filter((w) => /^[a-z]/i.test(w))) {
          expect(word[0], `"${text}"`).toBe(word[0].toUpperCase());
        }
      }
    }
  });

  it('reads every scope club once and offers a shared event once', async () => {
    h.getTournaments.mockImplementation(async (clubId: string) =>
      clubId === 'hub'
        ? [dbRow({ id: 'shared' }), dbRow({ id: 'hub-only' })]
        : [dbRow({ id: 'shared' })]
    );
    const rows = await quickJoinTournamentRows(['hub', 'club-1', 'hub'], context, 'user-1');
    expect(h.getTournaments).toHaveBeenCalledTimes(2);
    expect(rows?.map((r) => r.id).sort()).toEqual(['hub-only', 'shared']);
  });

  it('an empty club is an empty LIST, never null: it must not fall through to cash', async () => {
    h.getTournaments.mockResolvedValue([]);
    await expect(quickJoinTournamentRows(['club-1'], context, 'user-1')).resolves.toEqual([]);
  });

  it('a list NOBODY could read is null, not "No Open Tournaments"; one readable club is a list', async () => {
    h.getTournaments.mockRejectedValue({ message: 'timeout' });
    await expect(quickJoinTournamentRows(['hub', 'club-1'], context, 'user-1')).resolves.toBeNull();
    h.getTournaments.mockImplementation(async (clubId: string) => {
      if (clubId === 'hub') throw new Error('timeout');
      return [dbRow({ id: 'open' })];
    });
    const rows = await quickJoinTournamentRows(['hub', 'club-1'], context, 'user-1');
    expect(rows?.map((r) => r.id)).toEqual(['open']);
  });

  it('a failed registration read costs only the filter, not the sheet', async () => {
    h.registrationsError = { message: 'rls' };
    h.registrations = [];
    h.getTournaments.mockResolvedValue([dbRow({ id: 'open' })]);
    const rows = await quickJoinTournamentRows(['club-1'], context, 'user-1');
    expect(rows?.map((r) => r.id)).toEqual(['open']);
  });

  it('entry is decided by the lobby rules, not by a second copy of them', () => {
    const open = toQuickJoinTournamentCandidate(dbRow({ id: 'x' }) as never);
    expect(open.entryOpen).toBe(true);
    expect(open.buyIn).toBe(55);
    expect(open.capacity).toBeNull();
    const done = toQuickJoinTournamentCandidate(dbRow({ id: 'y', status: 'COMPLETED' }) as never);
    expect(done.entryOpen).toBe(false);
    const src = read('src/lib/quickJoinTournaments.ts');
    expect(src).toContain('isTournamentEntryUnavailable(t, entrants)');
    expect(src).toContain('tournamentStatus(t)');
    expect(src).toContain('tournamentService.getTournaments(clubId, { throwOnError: true })');
  });
});

describe('readTournamentContext', () => {
  it('says a cash table is a cash table, and is null only for what it could not read', async () => {
    h.tableRow = { id: 't1', tournament_id: null };
    await expect(readTournamentContext('t1')).resolves.toEqual({ format: 'cash' });
    await expect(readTournamentContext(null)).resolves.toBeNull();
    h.tableRow = null;
    await expect(readTournamentContext('t1')).resolves.toBeNull();
  });

  it('reads the event, its total price and its format', async () => {
    h.tableRow = { id: 't1', tournament_id: 'tour-1' };
    h.tournamentRow = {
      id: 'tour-1',
      club_id: 'club-1',
      buy_in_amount: 50,
      buy_in_fee: 5,
      game_type: 'plo',
      variant: 'mtt',
      tournament_type: 'MTT',
      format_contract: 'mtt-v2',
      max_players: null,
    };
    await expect(readTournamentContext('t1')).resolves.toEqual({
      id: 'tour-1',
      clubId: 'club-1',
      buyIn: 55,
      variant: 'plo',
      format: 'mtt',
    });
  });

  it('still calls a Spin a Spin when the row has no readable contract', async () => {
    h.tableRow = { id: 't1', tournament_id: 'tour-2' };
    h.tournamentRow = { id: 'tour-2', club_id: 'c', buy_in_amount: 10, variant: 'spin' };
    const ctx = await readTournamentContext('t1');
    expect(ctx?.format).toBe('spin');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE WIRING
// ═══════════════════════════════════════════════════════════════════════════════

describe('MultiTablePage', () => {
  const MULTI = read('src/pages/MultiTablePage.tsx');
  const HANDLER = MULTI.slice(
    MULTI.indexOf('const handleAddTable = useCallback('),
    MULTI.indexOf('const handleQuickJoinPick')
  );

  it('answers the tournament question before the cash query ever runs', () => {
    const branch = HANDLER.indexOf('if (inTournament) {');
    const cash = HANDLER.indexOf("\n            .is('tournament_id', null)");
    expect(branch).toBeGreaterThan(0);
    expect(cash).toBeGreaterThan(branch);
    // The branch always returns: an empty list is rendered, never passed on.
    const body = HANDLER.slice(branch, HANDLER.indexOf('/* A cash table after all.'));
    expect(body).toContain('mod.quickJoinTournamentRows(tournamentScope, tournamentCtx, user?.id)');
    expect(body.match(/\breturn;/g)?.length).toBe(2);
  });

  it('either witness is enough, a Spin keeps its own sheet, and a row read as cash is cash', () => {
    expect(HANDLER).toContain(
      'const inTournament = quickJoinIsTournament(tableRead, tabSaysTournament);'
    );
    expect(quickJoinIsTournament({ format: 'mtt' }, false)).toBe(true);
    expect(quickJoinIsTournament(null, true)).toBe(true);
    expect(quickJoinIsTournament({ format: 'spin' }, true)).toBe(false);
    expect(quickJoinIsTournament({ format: 'cash' }, true)).toBe(false);
    expect(HANDLER).toMatch(/activeTab\?\.gameCode !== 'SPIN'/);
    // The spin branch is still asked first and still wins.
    expect(HANDLER.indexOf('if (spinRows) {')).toBeLessThan(HANDLER.indexOf('if (inTournament) {'));
  });

  it('JOIN on a tournament row opens its lobby page in a tab; it registers nobody', () => {
    const pick = MULTI.slice(
      MULTI.indexOf('const handleQuickJoinTournamentPick = useCallback('),
      MULTI.indexOf('THE CONTEXT THE EMBEDDED LOBBY NAVIGATES THROUGH')
    );
    expect(pick).toContain("openTournamentTab({ tournamentId, search: '' });");
    for (const forbidden of ['registerPlayer', '.rpc(', 'registerMtt', 'navigate(']) {
      expect(pick).not.toContain(forbidden);
    }
    expect(MULTI).toContain('? handleQuickJoinTournamentPick(row.tournamentId)');
    const lib = read('src/lib/quickJoinTournaments.ts');
    for (const forbidden of ['registerPlayer', '.rpc(', '.insert(', '.update(', '.delete(']) {
      expect(lib).not.toContain(forbidden);
    }
  });

  it('the sheet says tournaments, in Title Case, in the zones it already had', () => {
    expect(MULTI).toContain(
      "eyebrow={quickJoin.tournamentLobby ? 'Open Tournaments' : 'Open Seats'}"
    );
    expect(MULTI).toContain("? 'No Open Tournaments Right Now'");
    expect(MULTI).toContain(": 'No Open Seats Right Now'");
    expect(MULTI).toContain('row.seats ?? `${row.players}/${row.max}`');
    expect(MULTI).toContain('title="Quick Join"');
    expect(MULTI).toContain('Browse Full Lobby');
  });

  it('Browse Full Lobby lands on the tournament list from a tournament, the lobby otherwise', () => {
    const browse = MULTI.slice(
      MULTI.indexOf('const handleQuickJoinLobby = useCallback('),
      MULTI.indexOf('// ─── Update table info')
    );
    expect(browse).toContain('if (list) openLobbyTabOn(list);');
    expect(browse).toContain("else masterBus.emit('OPEN_LOBBY_TAB', {});");
    expect(MULTI).toContain('initialGameType={table.lobbyGameType}');
    const home = read('src/pages/ClubHomePage.tsx');
    expect(home).toContain("useState<GameType>(initialGameType ?? 'ALL')");
    // The landing is held for the mount it was requested for, and spent there:
    // the strip clears the request once the page reports it applied.
    expect(home).toContain("const tab = landingGameTypeRef.current ?? p.tab ?? 'ALL';");
    expect(MULTI).toContain('onInitialGameTypeConsumed={() => consumeLobbyLanding(table.id)}');
  });

  it('nothing here moves the active tab without a tap (NO AUTO TABLE SWITCHING)', () => {
    const added = [
      MULTI.slice(
        MULTI.indexOf('const openLobbyTabOn = useCallback('),
        MULTI.indexOf('const handleAddTable = useCallback(')
      ),
      MULTI.slice(
        MULTI.indexOf('const buyInAskedRef = useRef'),
        MULTI.indexOf('// P1-2 FIX: hand each child a STABLE callback')
      ),
    ];
    for (const block of added) {
      expect(block.length).toBeGreaterThan(50);
      expect(block).not.toContain('setActiveIndex');
    }
  });
});

describe('a cash table still gets the cash sheet', () => {
  it('the cash ranking is untouched by the tournament one', () => {
    const ranked = rankQuickJoinTables(
      [
        { id: 'plo-12', name: 'a', variant: 'plo', bigBlind: 2, players: 5, maxPlayers: 9 },
        { id: 'nlh-12', name: 'b', variant: 'nlh', bigBlind: 2, players: 8, maxPlayers: 9 },
        { id: 'plo-25', name: 'c', variant: 'plo', bigBlind: 5, players: 5, maxPlayers: 9 },
      ],
      { currentTable: { id: 'seated', variant: 'plo', bigBlind: 2 } }
    );
    expect(ranked.map((r) => [r.id, r.tier])).toEqual([
      ['plo-12', 'exact'],
      ['plo-25', 'adjacent'],
      ['nlh-12', 'other'],
    ]);
  });
});
