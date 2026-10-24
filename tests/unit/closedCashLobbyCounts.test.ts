import { describe, expect, it } from 'vitest';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';

const row = (extra: Partial<LobbyTableRow> = {}): LobbyTableRow => ({
  id: 'cash-table',
  name: 'PLO 1/2',
  game_variant: 'plo4',
  small_blind: 1,
  big_blind: 2,
  min_buy_in: 80,
  max_buy_in: 400,
  max_players: 6,
  current_players: 2,
  status: 'running',
  ...extra,
});

describe('closed admission and closed tables are different lobby facts', () => {
  it('keeps real occupants visible while saying the game refuses new joins', () => {
    const entry = cashEntry(
      row({
        cluster_id: 'game',
        lifecycle: 'live',
        cluster_front: true,
        cluster_enabled: false,
        cluster_players: 2,
        cluster_tables: 1,
      })
    );
    expect(entry.players).toBe(2);
    expect(entry.status).toBe('closed');
    expect(entry.statusLabel).toBe('Join Closed');
  });
  it('never displays an old saved count as players at a truly closed table', () => {
    const entry = cashEntry(row({ status: 'closed', current_players: 9 }));
    expect(entry.players).toBe(0);
    expect(entry.statusLabel).toBe('Closed');
  });
  it('keeps an empty disabled game Closed and an active game Running', () => {
    expect(
      cashEntry(
        row({
          cluster_id: 'game',
          lifecycle: 'live',
          cluster_front: true,
          cluster_enabled: false,
          cluster_players: 0,
          cluster_tables: 1,
        })
      ).statusLabel
    ).toBe('Closed');
    expect(cashEntry(row()).players).toBe(2);
  });
});
