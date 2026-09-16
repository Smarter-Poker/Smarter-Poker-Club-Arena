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

  /**
   * UPDATED 2026-09-09 - the pin moved to the new mechanism, and this is why.
   *
   * It used to assert `durationMinutes: 5` off the `tournament_break` event,
   * which is the :55 LAST-HAND announcement. That event carries
   * `breakEndsAt: null` on purpose: the engine REMOVED the end time from it on
   * 2026-08-27 (TournamentManagerBase.ts:1494-1508) because clients counting
   * down to :55 plus five minutes hit 0:00 up to two minutes before play
   * resumed and then sat there under a full-screen opaque overlay.
   *
   * Forwarding the duration reconstructed that exact fabricated instant one
   * layer down: both lobby consumers turn a bare duration into
   * `Date.now() + minutes * 60_000` (TournamentClock.tsx:378-384,
   * BlindsTab.tsx:210-213). A seed belongs to a countdown that has started, so
   * the last-hand branch now forwards `phase` and no seed - and this test
   * pins that, rather than pinning the number that produced the bug.
   */
  it('announces the last hand with a phase and NO invented countdown', () => {
    const id = tid();
    relayTournamentEvent(id, {
      type: 'tournament_break',
      payload: { level: 4, phase: 'last_hand', breakEndsAt: null, breakDurationMinutes: 5 },
    });
    expect(names()).toEqual(['TOURNAMENT_BREAK', 'BREAK_START']);
    expect(emitted.calls[0][1]).toMatchObject({ tournamentId: id, phase: 'last_hand' });
    expect(emitted.calls[0][1].durationMinutes).toBeUndefined();
    expect(emitted.calls[0][1].breakEndsAt).toBeUndefined();
  });

  it('seeds the countdown once the break has actually started', () => {
    const id = tid();
    const endsAt = new Date(Date.now() + 5 * 60_000).toISOString();
    relayTournamentEvent(id, {
      type: 'tournament_break_started',
      payload: { level: 4, phase: 'counting_down', breakEndsAt: endsAt, breakDurationMinutes: 5 },
    });
    expect(emitted.calls[0][1]).toMatchObject({
      tournamentId: id,
      phase: 'counting_down',
      durationMinutes: 5,
      breakEndsAt: endsAt,
    });
  });

  /**
   * A break event with no `phase` at all - an older engine, or a replayed
   * broadcast. The TYPE still says which half it is, and the absence of an end
   * time still means there is nothing to count down to.
   */
  it('infers the phase when the engine did not send one', () => {
    const noPhase = tid();
    relayTournamentEvent(noPhase, { type: 'tournament_break', payload: { level: 4 } });
    expect(emitted.calls[0][1].phase).toBe('last_hand');
    expect(emitted.calls[0][1].durationMinutes).toBeUndefined();

    emitted.calls = [];
    const started = tid();
    relayTournamentEvent(started, {
      type: 'tournament_break_started',
      payload: { level: 4, breakDurationMinutes: 5 },
    });
    expect(emitted.calls[0][1].phase).toBe('counting_down');
    expect(emitted.calls[0][1].durationMinutes).toBe(5);
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
