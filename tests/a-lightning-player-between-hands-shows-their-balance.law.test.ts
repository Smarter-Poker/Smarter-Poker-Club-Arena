/**
 * LAW (Dan 2026-10-24): "IN LIGHTNING GAMES, WHEN YOU MOVE TO A NEW TABLE AFTER
 * FOLDING... IT SHOUDN'T SAY SITTING OUT... AND IT SHOULD 100% ALWAYS SHOW YOUR
 * BALANCE AT ALL TIMES, IT SHOULD NEVER SAY 0.00"
 *
 * After a Lightning fold the engine publishes the idle room (no players), so
 * the table draws the hero's chair itself. That chair used to be the cash
 * seat-row placeholder: status 'sitting_out' and a stack of 0 (a pool session
 * has no seat row and no pending buy-in). It is now decided by
 * lightningWaitingHero.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  lightningSessionStackFor,
  lightningWaitingHero,
} from '../src/lightning/lightningWaitingHero';

describe('a Lightning player between hands', () => {
  it('is not sitting out after a fold', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: 187.5, sessionStack: null }).status
    ).toBe('active');
  });

  it('is sitting out only when they asked to be', () => {
    expect(
      lightningWaitingHero({ sittingOut: true, lastSeenStack: 187.5, sessionStack: null }).status
    ).toBe('sitting_out');
  });

  it('keeps the balance they folded with', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: 187.5, sessionStack: 200 }).stack
    ).toBe(187.5);
  });

  it('reads the pool balance when the room has not shown them yet', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: null, sessionStack: 200 }).stack
    ).toBe(200);
  });

  it('prefers the pool balance over a last-seen zero (an unpaid all-in)', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: 0, sessionStack: 412 }).stack
    ).toBe(412);
  });

  it('never invents a zero', () => {
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: null, sessionStack: null }).stack
    ).toBeNull();
    expect(
      lightningWaitingHero({ sittingOut: false, lastSeenStack: Number.NaN, sessionStack: -5 }).stack
    ).toBeNull();
  });

  it('adopts a session read only for its own room', () => {
    expect(lightningSessionStackFor('room-a', { poolSessionId: 'room-a', stack: 150 })).toBe(150);
    expect(lightningSessionStackFor('room-a', { poolSessionId: 'room-b', stack: 150 })).toBeNull();
    expect(lightningSessionStackFor('room-a', { poolSessionId: null, stack: 150 })).toBeNull();
    expect(lightningSessionStackFor(null, { poolSessionId: 'room-a', stack: 150 })).toBeNull();
  });

  it('is how the table draws the hero chair in a Lightning room', () => {
    const page = readFileSync('src/pages/TablePage.tsx', 'utf8');
    expect(page).toContain('lightningWaitingHero({');
    // The placeholder chair takes its status and balance from the waiting seat.
    expect(page).toMatch(
      /stack:\s*lightningWaitingSeat\?\.stack \?\? heroRowStack \?\? pendingSeatStackRef\.current \?\? 0/
    );
    expect(page).toMatch(
      /status: lightningWaitingSeat \? lightningWaitingSeat\.status : 'sitting_out'/
    );
  });
});
