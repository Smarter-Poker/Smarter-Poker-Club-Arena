/**
 * LAW: A LIGHTNING ANCHOR SEAT NEVER BECOMES A SECOND TAB BESIDE ITS ROOM
 * (2026-10-24).
 *
 * A Lightning player's chips stay on an anchor seat at a real table (its
 * table_seats row stays open) while they play in the room tab keyed by their
 * pool-session id. MultiTablePage's seat rebuild added that anchor as another
 * tab; the tab's handoff then followed to the open room, closed itself and
 * requested the rebuild again, which added it again. See
 * src/lightning/lightningAnchorTabs.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anchorsShownByOpenRooms } from '../src/lightning/lightningAnchorTabs';

const rooms: Record<string, string> = { 'pool-1': 'cluster-L' };
const roomCluster = (id: string) => rooms[id] ?? null;

describe('a Lightning anchor never doubles its room tab', () => {
  it('skips the anchor when its game room is open', () => {
    const skip = anchorsShownByOpenRooms(
      [
        { id: 'anchor-1', cluster_id: 'cluster-L' },
        { id: 'cash-2', cluster_id: 'cluster-C' },
      ],
      ['pool-1'],
      roomCluster
    );
    expect([...skip]).toEqual(['anchor-1']);
  });

  it('keeps the anchor when no room tab is open (its handoff is the way back in)', () => {
    expect(
      anchorsShownByOpenRooms(
        [{ id: 'anchor-1', cluster_id: 'cluster-L' }],
        ['cash-9'],
        roomCluster
      ).size
    ).toBe(0);
  });

  it('never skips a table it cannot place in a Cluster', () => {
    expect(
      anchorsShownByOpenRooms(
        [{ id: 'tourney-1', cluster_id: null }, { id: 'old-1' }],
        ['pool-1'],
        roomCluster
      ).size
    ).toBe(0);
  });

  it('is what the seat rebuild uses, with the Cluster read alongside each table', () => {
    const page = readFileSync('src/pages/MultiTablePage.tsx', 'utf8');
    expect(page).toMatch(
      /'id, name, game_variant, game_type, max_players, small_blind, big_blind, tournament_id, cluster_id'/
    );
    expect(page).toMatch(
      /const anchorsShown = anchorsShownByOpenRooms\(\s*tblRows \?\? \[\],\s*survivors\.map\(\(t\) => t\.id\),\s*\(tabId\) => getLightningPoolSession\(tabId\)\?\.clusterId\s*\);\s*const candidates = ids\.filter\(\(id\) => !known\.has\(id\) && !anchorsShown\.has\(id\)\);/
    );
  });
});
