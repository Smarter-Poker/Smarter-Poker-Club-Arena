/**
 * The engine snapshot carries the equipped frame and aura onto the seat.
 *
 * This is the DURABLE half of the propagation story. `useSeatedProfileSync` is
 * the instant half, and it only fires for a client that was already watching
 * when the change happened. A player who joins the table a minute later, or
 * whose realtime connection dropped and came back, gets their neighbours'
 * cosmetics from here — the same field group and the same query
 * (`loadSeatedPlayers`) that has carried `avatar_url` since Bible V8 §2.3.
 *
 * If these ever diverge, a seat draws a gold ring around a stale face.
 */

import { describe, it, expect } from 'vitest';
import { mapEngineSnapshot } from '@/utils/mapEngineSnapshot';

function makeSnapshot(players: unknown[]) {
  return {
    table_id: 't-1',
    pot: 0,
    current_bet: 0,
    stage: 'preflop',
    dealer_seat: 1,
    big_blind: 2,
    small_blind: 1,
    players,
    action_history: [],
    community_cards: [],
    side_pots: [],
    winners: [],
    disconnect_states: {},
  } as Parameters<typeof mapEngineSnapshot>[0];
}

describe('mapEngineSnapshot — avatar cosmetics', () => {
  it('carries equipped_frame and equipped_aura onto the seat', () => {
    const out = mapEngineSnapshot(
      makeSnapshot([
        {
          seat: 3,
          user_id: 'villain',
          username: 'Villain',
          stack: 1000,
          avatar_url: '/avatars/table/vip_wolf@2x.webp',
          equipped_frame: 'frame-gold',
          equipped_aura: 'aura-fire',
        },
      ]),
      'hero',
      9
    );
    const seat = out.players[2];
    expect(seat).not.toBeNull();
    expect(seat!.avatar).toBe('/avatars/table/vip_wolf@2x.webp');
    expect(seat!.frame).toBe('frame-gold');
    expect(seat!.aura).toBe('aura-fire');
  });

  it('normalises the engine empty string to undefined, not to ""', () => {
    /* The engine sends '' for "nothing equipped" because its payload fields are
       non-optional strings. The seat merge treats a falsy cosmetic as none, and
       '' would round-trip through the realtime merge's no-op guard as a value
       that differs from undefined and re-render nine seats on every snapshot. */
    const out = mapEngineSnapshot(
      makeSnapshot([
        {
          seat: 1,
          user_id: 'hero',
          username: 'Hero',
          stack: 1000,
          equipped_frame: '',
          equipped_aura: '',
        },
      ]),
      'hero',
      9
    );
    expect(out.players[0]!.frame).toBeUndefined();
    expect(out.players[0]!.aura).toBeUndefined();
  });

  it('leaves both undefined when an older engine omits the fields entirely', () => {
    // The Hetzner engine and the published bundle deploy separately, so a
    // client WILL meet a snapshot that predates these fields.
    const out = mapEngineSnapshot(
      makeSnapshot([{ seat: 1, user_id: 'hero', username: 'Hero', stack: 1000 }]),
      'hero',
      9
    );
    expect(out.players[0]!.frame).toBeUndefined();
    expect(out.players[0]!.aura).toBeUndefined();
  });
});
