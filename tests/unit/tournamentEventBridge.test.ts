import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitted = vi.hoisted(() => ({ calls: [] as Array<[string, any]> }));

vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    emit: (name: string, payload: any) => {
      emitted.calls.push([name, payload]);
    },
  },
}));

import { relayTournamentEvent } from '@/services/tournamentEventBridge';

/**
 * Dan 2026-08-23, on finding these logged as known-dead instead of fixed:
 * "WHY WOULD YOU LEAVE THIS INSTEAD OF FIXING IT?!"
 *
 * TournamentManagerBase has always broadcast the breaks on `t-break-<id>`, and
 * TournamentClock has always subscribed to BREAK_START / TOURNAMENT_BREAK on
 * MasterBus. Nothing joined the two, so the clock never flipped to break and
 * TournamentDetails never toasted. This is the join.
 */
describe('tournamentEventBridge', () => {
  beforeEach(() => {
    emitted.calls = [];
  });

  /**
   * Each test uses its own tournament id. The bridge's dedupe map is MODULE
   * state - deliberately, because it exists to swallow the same broadcast
   * arriving from several mounted pages - so tests sharing an id would collide
   * with each other rather than with anything real. A first draft of this file
   * did exactly that and blamed the bridge.
   */
  let n = 0;
  const tid = () => `t-${++n}`;

  const names = () => emitted.calls.map(([n]) => n);

  it('turns a break broadcast into both spellings the components listen for', () => {
    const id = tid();
    relayTournamentEvent(id, {
      type: 'tournament_break',
      payload: { level: 4, breakDurationMinutes: 5 },
    });
    expect(names()).toEqual(['TOURNAMENT_BREAK', 'BREAK_START']);
    expect(emitted.calls[0][1]).toMatchObject({ tournamentId: id, durationMinutes: 5 });
  });

  it('derives the duration when only an end time is sent', () => {
    // `tournament_break_started` carries breakEndsAt and no minutes. Without
    // this, TournamentClock falls back to a hardcoded 300 seconds and shows the
    // wrong countdown on every synchronized break.
    relayTournamentEvent(tid(), {
      type: 'tournament_break_started',
      payload: { level: 7, breakEndsAt: new Date(Date.now() + 4 * 60_000).toISOString() },
    });
    expect(emitted.calls[0][1].durationMinutes).toBe(4);
  });

  it('turns break_ended into both end spellings', () => {
    relayTournamentEvent(tid(), { type: 'break_ended', payload: { level: 4 } });
    expect(names()).toEqual(['TOURNAMENT_BREAK_END', 'BREAK_END']);
  });

  it('does not double-toast when several pages share the channel', () => {
    // getOrCreateChannel hands every page the SAME channel object, so N mounted
    // pages calling this receive the same broadcast N times.
    const id = tid();
    const evt = { type: 'tournament_break', payload: { level: 4, breakDurationMinutes: 5 } };
    relayTournamentEvent(id, evt);
    relayTournamentEvent(id, evt);
    relayTournamentEvent(id, evt);
    expect(names()).toEqual(['TOURNAMENT_BREAK', 'BREAK_START']);
  });

  it('still relays a genuinely different break', () => {
    const id = tid();
    relayTournamentEvent(id, { type: 'tournament_break', payload: { level: 4 } });
    relayTournamentEvent(id, { type: 'tournament_break', payload: { level: 5 } });
    expect(names()).toEqual(['TOURNAMENT_BREAK', 'BREAK_START', 'TOURNAMENT_BREAK', 'BREAK_START']);
  });

  it('ignores everything that is not a break, and bad input', () => {
    relayTournamentEvent(tid(), { type: 'level_up', payload: {} });
    relayTournamentEvent(tid(), { type: 'player_eliminated', payload: {} });
    relayTournamentEvent(tid(), null);
    relayTournamentEvent('', { type: 'tournament_break', payload: {} });
    expect(names()).toEqual([]);
  });
});
