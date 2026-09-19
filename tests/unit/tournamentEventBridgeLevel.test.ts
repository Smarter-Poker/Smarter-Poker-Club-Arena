/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BLIND LEVEL CROSSES ONE BOUNDARY, AND THE OFF-BY-ONE HAS SHIPPED TWICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The engine broadcasts `level_up` with `level: this.currentLevel`, and that is
 * a ZERO-BASED ARRAY INDEX: initialised to 0, loaded from
 * `tournaments.current_level`, and passed to
 * `resolveBlindLevel(blindStructure, index)` which returns `blindStructure[i]`.
 *
 * `BLIND_LEVEL_CHANGE` consumers expect the DISPLAY level. TournamentClock
 * renders `payload.level` raw as "LEVEL {n}" and its comment says outright
 * "THE PAYLOAD IS ALREADY THE DISPLAY LEVEL", because the emitter it was
 * written against sent `newLevel + 1`.
 *
 * That conversion has been wrong in production in BOTH directions: once a clock
 * that flashed one level backwards, then a correction that made it flash one
 * level forwards, "LEVEL 6 -> LEVEL 7 on the projector in front of the room".
 * The relay is the single place the conversion happens now, so this is the test
 * that keeps it honest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitted: Array<{ name: string; payload: any }> = [];
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (name: string, payload: any) => {
      emitted.push({ name, payload });
    },
  },
}));

import { relayTournamentEvent } from '../../src/services/tournamentEventBridge';

const T = 'tourney-1';
const only = (name: string) => emitted.filter((e) => e.name === name);

/** The relay dedupes on event identity for 1500ms; separate ids keep cases apart. */
let seq = 0;
const freshTournament = () => `${T}-${++seq}`;

beforeEach(() => {
  emitted.length = 0;
});

describe('relaying the engine level_up onto the bus', () => {
  it('converts the zero-based engine index to the display level', () => {
    const id = freshTournament();
    // The engine's very first level is index 0. The room calls that LEVEL 1.
    relayTournamentEvent(id, {
      type: 'level_up',
      payload: { level: 0, smallBlind: 25, bigBlind: 50, ante: 0 },
    });
    expect(only('BLIND_LEVEL_CHANGE')[0].payload).toEqual({
      tournamentId: id,
      level: 1,
      smallBlind: 25,
      bigBlind: 50,
      ante: 0,
    });
  });

  it('keeps the blinds and ante exactly as the engine sent them', () => {
    const id = freshTournament();
    relayTournamentEvent(id, {
      type: 'level_up',
      payload: { level: 5, blinds: '300/600', smallBlind: 300, bigBlind: 600, ante: 600 },
    });
    const p = only('BLIND_LEVEL_CHANGE')[0].payload;
    // index 5 is the sixth level played, displayed as LEVEL 6
    expect(p.level).toBe(6);
    expect([p.smallBlind, p.bigBlind, p.ante]).toEqual([300, 600, 600]);
  });

  it('never emits level 0, which would render as "LEVEL 0"', () => {
    for (const bad of [-1, -5]) {
      emitted.length = 0;
      relayTournamentEvent(freshTournament(), { type: 'level_up', payload: { level: bad } });
      const p = only('BLIND_LEVEL_CHANGE')[0]?.payload;
      expect(p?.level).toBeGreaterThanOrEqual(1);
    }
  });

  it('says nothing at all when the level is not a number', () => {
    for (const bad of [undefined, null, 'six', NaN]) {
      emitted.length = 0;
      relayTournamentEvent(freshTournament(), {
        type: 'level_up',
        payload: { level: bad as never },
      });
      expect(
        only('BLIND_LEVEL_CHANGE'),
        'a level the relay cannot read must not become LEVEL 1 by default'
      ).toEqual([]);
    }
  });

  it('also publishes the page-level update the dead emitter published alongside', () => {
    const id = freshTournament();
    relayTournamentEvent(id, { type: 'level_up', payload: { level: 2 } });
    expect(only('TOURNAMENT_UPDATED')[0].payload).toEqual({
      tournamentId: id,
      status: 'blind_level_3',
    });
  });
});

describe('relaying eliminations onto the bus', () => {
  it('carries the server field name, which the existing emitter reads wrongly', () => {
    const id = freshTournament();
    // The server sends `playerName`. TablePage's own emit reads `elimData.username`,
    // so the name has always arrived empty there. Both spellings are accepted.
    relayTournamentEvent(id, {
      type: 'player_eliminated',
      payload: { userId: 'u-1', position: 9, prize: 250, playerName: 'Ada' },
    });
    expect(only('PLAYER_ELIMINATED')[0].payload).toEqual({
      tournamentId: id,
      userId: 'u-1',
      position: 9,
      prize: 250,
      username: 'Ada',
    });
  });

  /**
   * THE DEDUPE KEY. The break relays key on `payload.level`, which an
   * elimination does not have. Reusing that key would have made every bust
   * inside the 1500ms window collapse into one event, and on a bubble two
   * players can bust in the same hand.
   */
  it('does not collapse two different players busting in the same instant', () => {
    const id = freshTournament();
    relayTournamentEvent(id, {
      type: 'player_eliminated',
      payload: { userId: 'u-1', position: 9, playerName: 'Ada' },
    });
    relayTournamentEvent(id, {
      type: 'player_eliminated',
      payload: { userId: 'u-2', position: 8, playerName: 'Grace' },
    });
    expect(only('PLAYER_ELIMINATED').map((e) => e.payload.userId)).toEqual(['u-1', 'u-2']);
  });

  it('still swallows the same elimination arriving twice from two mounted pages', () => {
    const id = freshTournament();
    const one = { type: 'player_eliminated', payload: { userId: 'u-9', position: 3, prize: 10 } };
    relayTournamentEvent(id, one);
    relayTournamentEvent(id, one);
    expect(only('PLAYER_ELIMINATED')).toHaveLength(1);
  });
});

describe('what the relay must not do', () => {
  it('ignores an event type it does not map, rather than guessing', () => {
    relayTournamentEvent(freshTournament(), { type: 'chip_race', payload: { level: 4 } });
    expect(emitted).toEqual([]);
  });

  it('ignores a missing tournament id', () => {
    relayTournamentEvent('', { type: 'level_up', payload: { level: 1 } });
    expect(emitted).toEqual([]);
  });

  it('still relays the break events it always did', () => {
    const id = freshTournament();
    relayTournamentEvent(id, {
      type: 'tournament_break',
      payload: { breakDurationMinutes: 5, level: 6 },
    });
    expect(only('TOURNAMENT_BREAK')).toHaveLength(1);
    expect(only('BREAK_START')).toHaveLength(1);
  });
});
