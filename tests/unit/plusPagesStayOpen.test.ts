import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const source = readFileSync(resolve(__dirname, '../../src/pages/MultiTablePage.tsx'), 'utf8');
describe('plus pages remain owned by the player', () => {
  it('a seat refresh cannot restore table focus over an open page', () => {
    const restore = source.slice(
      source.indexOf('// Seat refreshes must never'),
      source.indexOf("const lastId = sessionStorage.getItem('ca_last_active_table')")
    );
    expect(restore).toContain('if (visible && !isTableTab(visible)) return');
  });
  it('reopening the lobby retains its current page', () => {
    const open = source.slice(
      source.indexOf("useMasterBusSubscription('OPEN_LOBBY_TAB'"),
      source.indexOf("useMasterBusSubscription('OPEN_HUB_TAB'")
    );
    expect(open).not.toContain('clearLobbyTournaments');
    expect(open).not.toContain('lobbyPageHistory: undefined');
  });
  it('a background seat notification cannot replace a lobby page', () => {
    const seat = source.slice(
      source.indexOf("useMasterBusSubscription('TABLE_SEATED'"),
      source.indexOf('// ─── Dan 2026-08-15: in-table')
    );
    expect(seat).not.toContain('prev.findIndex(isLobbyTab)');
  });
});
