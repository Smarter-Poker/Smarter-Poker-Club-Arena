import { beforeEach, describe, expect, it } from 'vitest';
import {
  observePublicHandStats,
  resetPublicObservedHandStats,
  publicObservedReceiptKeys,
  restorePublicObservedReceiptKeys,
} from '../../src/hooks/publicObservedHandStats';
const packet = {
  hand_id: 'committed-hand',
  hand_number: 1,
  public_stats_version: 1,
  players: [
    { user_id: 'a', vpip: true, pfr: true, won: false },
    { user_id: 'b', vpip: true, pfr: false, won: true },
  ],
};
const send = (
  data: Record<string, unknown> = packet,
  observer = 'viewer',
  table = 'table',
  type = 'HAND_PUBLIC_STATS'
) => observePublicHandStats(observer, table, type, data);
beforeEach(resetPublicObservedHandStats);
describe('server-proved public observations', () => {
  it('records one committed hand exactly once across mounted/room readers', () => {
    expect(send()).toEqual([
      { playerId: 'a', vpip: true, pfr: true, won: false },
      { playerId: 'b', vpip: true, pfr: false, won: true },
    ]);
    expect(send(packet, 'viewer', 'another-room')).toEqual([]);
    expect(send(packet, 'another-viewer')).toHaveLength(2);
  });
  it('never counts the early presentation completion or a malformed summary', () => {
    expect(send(packet, 'viewer', 'table', 'HAND_COMPLETE')).toEqual([]);
    expect(send({ ...packet, public_stats_version: undefined })).toEqual([]);
    expect(
      send({ ...packet, players: [{ user_id: 'a', vpip: false, pfr: true, won: false }] })
    ).toEqual([]);
    expect(send({ ...packet, players: [packet.players[0], packet.players[0]] })).toEqual([]);
    expect(send()).toHaveLength(2);
  });
  it('accepts a delayed committed result without assigning it to a newer hand', () => {
    expect(send({ ...packet, hand_id: 'newer-hand', hand_number: 2 })).toHaveLength(2);
    expect(send()).toHaveLength(2);
    expect(send()).toEqual([]);
  });
  it('restores replay receipts and never returns private fields', () => {
    const result = send({
      ...packet,
      hole_cards: ['Ah', 'Ad'],
      players: packet.players.map((row) => ({ ...row, hole_cards: ['Ah', 'Ad'] })),
    });
    expect(JSON.stringify(result)).not.toMatch(/Ah|Ad|hole_cards/);
    const saved = publicObservedReceiptKeys();
    resetPublicObservedHandStats();
    restorePublicObservedReceiptKeys(saved);
    expect(send()).toEqual([]);
  });
});
