/**
 * BAGGED: a multi-day event between days (MULTI-DAY-DESIGN release R2).
 *
 * Every status reader in src/ must understand it before any row can be
 * BAGGED. It is live, closed to entry, not dealing, and never finished or
 * cancelled. Each assertion below pins a reader that, without a BAGGED
 * branch, fell to a default that said something false: "Registering" (and so
 * Register / Unregister buttons), "Finished", "Bagged" in raw caps, or a
 * clock reading "Level Change Pending" all night.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  tournamentEntry,
  tournamentStatus,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';
import { isTournamentEntryUnavailable } from '../../src/utils/tournamentPresentation';
import { mapSatelliteRowToCard } from '../../src/components/tournament/details/useSatellites';
import { tournamentStatusLabel } from '../../src/pages/SearchPage';
import { DAY_COMPLETE_LABEL, isBaggedStatus } from '../../src/utils/multiDaySchedule';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const row = (o: Partial<LobbyTournamentRow> = {}): LobbyTournamentRow =>
  ({
    format_contract: 'mtt-v1',
    id: 't',
    name: 'Two Day Main',
    game_type: 'NLH',
    buy_in_amount: 100,
    buy_in_fee: 10,
    guaranteed_prize: 0,
    start_time: new Date(Date.now() - 20 * 3600_000).toISOString(),
    started_at: new Date(Date.now() - 20 * 3600_000).toISOString(),
    status: 'BAGGED',
    current_players: 40,
    max_players: null,
    starting_chips: 10000,
    late_reg_levels: 6,
    current_level: 12,
    ...o,
  }) as LobbyTournamentRow;

describe('the one predicate', () => {
  it('matches BAGGED in any case and nothing else', () => {
    expect(isBaggedStatus('BAGGED')).toBe(true);
    expect(isBaggedStatus('bagged')).toBe(true);
    for (const s of ['RUNNING', 'COMPLETED', 'CANCELLED', 'REGISTERING', '', null, undefined]) {
      expect(isBaggedStatus(s)).toBe(false);
    }
    expect(DAY_COMPLETE_LABEL).toBe('Day Complete');
  });
});

describe('the lobby board', () => {
  it('labels it Day Complete under the running key, never Registering, Completed or Cancelled', () => {
    expect(tournamentStatus(row())).toEqual({ key: 'running', label: 'Day Complete' });
    // An unresolved historical format still does not read as finished.
    expect(tournamentStatus(row({ format_contract: undefined }))).toEqual({
      key: 'running',
      label: 'Day Complete',
    });
  });

  it('carries no live pip: nobody is dealing', () => {
    const entry = tournamentEntry(row(), 'mtt');
    expect(entry.status).toBe('running');
    expect(entry.statusLabel).toBe('Day Complete');
    expect(entry.live).toBe(false);
    // The same board still pips a RUNNING event.
    expect(tournamentEntry(row({ status: 'RUNNING' }), 'mtt').live).toBe(true);
  });

  it('is closed to entry, which every Register button reads', () => {
    expect(isTournamentEntryUnavailable(row(), 40)).toBe(true);
    expect(isTournamentEntryUnavailable(row({ status: 'REGISTERING' }), 40)).toBe(false);
  });

  it('stays listed on the club lobby and the tournament lobby, sorted with events under way', () => {
    const club = read('src/pages/ClubHomePage.tsx');
    expect(club).toMatch(/LOBBY_TOURNAMENT_STATUSES = \[[^\]]*'BAGGED'/);
    expect(club).toMatch(/u === 'RUNNING' \|\| u === 'IN_PROGRESS' \|\| u === 'BAGGED'\) return 1/);
    const lobby = read('src/pages/tournament/TournamentLobbyPage.tsx');
    expect(lobby).toMatch(/\.in\('status', \['ANNOUNCED', 'REGISTERING', 'RUNNING', 'BAGGED'\]\)/);
    expect(lobby).toMatch(/tournament\.status === 'BAGGED'\s*\?\s*'bagged'/);
    const service = read('src/services/TournamentService.ts');
    expect(service.match(/\.in\('status', \['REGISTERING', 'RUNNING', 'BAGGED'\]\)/g)).toHaveLength(
      2
    );
  });
});

describe('other readers', () => {
  it('a satellite between days is bagged, not finished', () => {
    expect(mapSatelliteRowToCard({ id: 's', name: 'Sat', status: 'BAGGED' }).status).toBe('bagged');
    expect(mapSatelliteRowToCard({ id: 's', name: 'Sat', status: 'COMPLETED' }).status).toBe(
      'finished'
    );
  });

  it('search prints Day Complete in Title Case, not the raw column', () => {
    expect(tournamentStatusLabel('BAGGED')).toBe('Day Complete');
  });

  it('the details footer shows Day Complete before any Register or Unregister branch', () => {
    const src = read('src/pages/tournament/TournamentDetails.tsx');
    const bagged = src.indexOf('if (isBaggedStatus(tournament.status)) {');
    expect(bagged).toBeGreaterThan(0);
    expect(bagged).toBeLessThan(src.indexOf("if (tournament.status === 'COMPLETED') {"));
    expect(bagged).toBeLessThan(src.indexOf('onClick={handleUnregister}'));
  });

  it('the blind clock stops overnight instead of reading Level Change Pending', () => {
    const src = read('src/components/tournament/details/BlindsTab.tsx');
    expect(src).toMatch(/isBaggedStatus\(rowStatus\)/);
    expect(src).toMatch(
      /\} else if \(isBagged\) \{\s*mainClock = '--:--';\s*mainCaption = DAY_COMPLETE_LABEL;/
    );
  });

  it('the HUD is not terminal for it and arms no deadline', () => {
    const src = read('src/components/tournament/TournamentHUD.tsx');
    expect(src).toMatch(/const TERMINAL = \['COMPLETED', 'CANCELLED', 'FINISHED', 'ABORTED'\];/);
    expect(src).toMatch(/if \(status === 'BAGGED'\) return null;/);
  });

  it('the status unions carry it', () => {
    expect(read('src/types/database.types.ts')).toMatch(/\| 'BAGGED';/);
    expect(read('src/types/club.types.ts')).toMatch(/\| 'bagged'/);
    expect(read('src/components/tournament/TournamentLobbyCard.tsx')).toMatch(
      /status: 'registering' \| 'running' \| 'bagged' \| 'finished' \| 'cancelled';/
    );
  });
});
