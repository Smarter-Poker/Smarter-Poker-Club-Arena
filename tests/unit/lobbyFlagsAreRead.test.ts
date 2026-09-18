import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  cashEntry,
  tournamentEntry,
  withClubLabel,
  cashRuleMedallions,
  type LobbyTableRow,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';

/**
 * FIVE FLAGS THE CREATION PAGE WROTE AND NOTHING READ (2026-08-25).
 *
 * TableConfigPage has written is_private, is_vip_only, is_featured,
 * label_as_new and hide_club_name since it was built. Only is_private had a
 * reader (fn_club_home_in_scope). The other four were columns that changed
 * nothing at all: get_club_home never selected them, so they could not reach a
 * card even in principle.
 *
 * These pin each flag to its consequence, so "wired" cannot quietly become
 * "written" again.
 */

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const table = (over: Partial<LobbyTableRow> = {}): LobbyTableRow =>
  ({
    id: 't1',
    name: 'NLH 1/2',
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 40,
    max_buy_in: 200,
    max_players: 6,
    current_players: 2,
    status: 'active',
    ...over,
  }) as unknown as LobbyTableRow;

const tourn = (over: Partial<LobbyTournamentRow> = {}): LobbyTournamentRow =>
  ({
    id: 'g1',
    name: 'Nightly',
    format_contract: 'mtt-v1',
    game_type: 'NLH',
    buy_in_amount: 10,
    buy_in_fee: 1,
    guaranteed_prize: 0,
    start_time: new Date(Date.now() + 600000).toISOString(),
    status: 'REGISTERING',
    current_players: 3,
    max_players: 100,
    starting_chips: 5000,
    ...over,
  }) as unknown as LobbyTournamentRow;

describe('the lobby flags reach the card', () => {
  it('a plain table claims none of them', () => {
    const e = cashEntry(table());
    expect([e.featured, e.isNew, e.vipOnly, e.hideClubName]).toEqual([false, false, false, false]);
  });

  it('reads them off a cash row', () => {
    const e = cashEntry(
      table({ is_featured: true, label_as_new: true, is_vip_only: true, hide_club_name: true })
    );
    expect([e.featured, e.isNew, e.vipOnly, e.hideClubName]).toEqual([true, true, true, true]);
  });

  it('accepts either name for featured — is_featured on a table, is_pinned on a tournament', () => {
    expect(cashEntry(table({ is_featured: true })).featured).toBe(true);
    expect(tournamentEntry(tourn({ is_pinned: true }), 'mtt').featured).toBe(true);
    expect(tournamentEntry(tourn(), 'mtt').featured).toBe(false);
  });

  it('is served by get_club_home, which is the only place a card can get them', () => {
    // The RPC body lives in the migration; this pins the CLIENT half — the row
    // type has to declare the fields or TypeScript would drop them silently.
    const entries = src('src/components/lobby/lobbyEntries.ts');
    for (const f of ['is_vip_only', 'label_as_new', 'is_featured', 'hide_club_name']) {
      expect(entries, `${f} is not on the row type`).toContain(f);
    }
  });

  it('renders a chip for each and pins featured to the top', () => {
    const tsx = src('src/components/lobby/LobbyTable.tsx');
    expect(tsx).toContain('lt-flag--featured');
    expect(tsx).toContain('lt-flag--vip');
    expect(tsx).toContain('lt-flag--new');
    // The sink partitions into pinned / open / gone.
    expect(tsx).toContain('const pinned: LobbyEntry[] = [];');
    /* Dan 2026-09-03: empty cash tables sink below the tables with a game on
       (and above the ones nobody can enter), still under the featured pin. */
    expect(tsx).toContain('return pinned.concat(open, empty, gone);');
  });
});

describe('hide_club_name finally has something to hide', () => {
  const names = { 'club-a': 'Aces High', 'club-b': 'Midway' };

  it('names another club on a union board', () => {
    const e = cashEntry(table({ club_id: 'club-b' } as Partial<LobbyTableRow>));
    expect(withClubLabel(e, 'club-a', names).clubLabel).toBe('Midway');
  });

  it('says nothing about the club you are standing in', () => {
    const e = cashEntry(table({ club_id: 'club-a' } as Partial<LobbyTableRow>));
    // Same object back, so the page's entry identity cache is not defeated.
    expect(withClubLabel(e, 'club-a', names)).toBe(e);
  });

  it('honours hide_club_name', () => {
    const e = cashEntry(
      table({ club_id: 'club-b', hide_club_name: true } as Partial<LobbyTableRow>)
    );
    expect(withClubLabel(e, 'club-a', names)).toBe(e);
    expect(withClubLabel(e, 'club-a', names).clubLabel).toBeNull();
  });

  it('says nothing when the name is not known', () => {
    const e = cashEntry(table({ club_id: 'club-z' } as Partial<LobbyTableRow>));
    expect(withClubLabel(e, 'club-a', names).clubLabel).toBeNull();
  });
});

describe('a medallion appears only once something enforces it', () => {
  it('CAP, once ServerTableEngineTurns clamps the bet', () => {
    const r = cashRuleMedallions({ cap_enabled: true, cap_bb: 20 });
    const cap = r.find((m) => m.key === 'cap');
    expect(cap?.detail).toBe('20BB');
  });

  it('the rejoin floor has no medallion: it is house law on every cash table (chip continuity, 2026-09-04)', () => {
    expect(cashRuleMedallions({ no_rathole: true }).some((m) => m.key === 'no_rathole')).toBe(
      false
    );
    expect(cashRuleMedallions({ no_rathole: false }).some((m) => m.key === 'no_rathole')).toBe(
      false
    );
  });

  it('PINEAPPLE, ANONYMOUS and NO RAILBIRDS, once the engine acts on them', () => {
    const keys = cashRuleMedallions({
      pineapple_holdem: true,
      is_anonymous: true,
      restrict_observers: true,
    }).map((m) => m.key);
    expect(keys).toContain('pineapple');
    expect(keys).toContain('anonymous');
    expect(keys).toContain('restrict_observers');
  });

  it('still refuses the three nothing enforces', () => {
    // VPIP, maintain_hands and calltime_enabled have no reader anywhere. A
    // chip for them would be a promise the table will not keep.
    const keys = cashRuleMedallions({
      // deliberately shaped like the columns that exist but are inert
      ...({ vpip_enabled: true, maintain_hands: 10, calltime_enabled: true } as object),
    }).map((m) => m.key);
    expect(keys).not.toContain('vpip');
    expect(keys).not.toContain('min_hands');
    expect(keys).not.toContain('call_time');
  });
});

describe('featured pins, but only a game you can actually enter', () => {
  it('checks the status as well as seatFirstJoinable', () => {
    const tsx = src('src/components/lobby/LobbyTable.tsx');
    // seatFirstJoinable returns true for EVERY cash row by design, so on its
    // own it would have floated a full featured table above forty joinable
    // ones. The status test is what stops that.
    expect(tsx).toContain("r.status !== 'full'");
    expect(tsx).toContain('r.featured && enterable');
  });

  it('a full featured table reports a status the pin test rejects', () => {
    const full = cashEntry(table({ is_featured: true, current_players: 6, max_players: 6 }));
    expect(full.featured).toBe(true);
    expect(full.status).toBe('full');
  });
});
