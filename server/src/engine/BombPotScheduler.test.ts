/**
 * BOMB POT SCHEDULER — trigger-timing verification (2026-08-27, Dan's spec §4
 * and QA matrix §21.2 T01-T04).
 *
 * The scheduler is a pure state machine over (settings, dealerSeat,
 * dealtInCount, now), so every trigger mode is driven deterministically here
 * with no engine, no clock and no database.
 */
import { describe, it, expect } from 'vitest';
import {
  BombPotScheduler,
  bombPotSettingsFromTable,
  resolveBombPotVariant,
  type BombPotSchedulerSettings,
} from './BombPotScheduler.js';

const base = (over: Partial<BombPotSchedulerSettings> = {}): BombPotSchedulerSettings => ({
  enabled: true,
  triggerMode: 'every_n_hands',
  frequency: 3,
  intervalSeconds: 0,
  minPlayers: 2,
  ...over,
});

describe('bombPotSettingsFromTable', () => {
  it('maps legacy rows (no new columns) to a viable every_n_hands config', () => {
    const s = bombPotSettingsFromTable({ bomb_pot_enabled: true, bomb_pot_frequency: 10 });
    expect(s.enabled).toBe(true);
    expect(s.triggerMode).toBe('every_n_hands');
    expect(s.frequency).toBe(10);
    expect(s.minPlayers).toBe(3);
  });

  it('keeps the legacy off-contract: enabled with frequency 0 deals no bombs', () => {
    const s = bombPotSettingsFromTable({ bomb_pot_enabled: true, bomb_pot_frequency: 0 });
    expect(s.enabled).toBe(false);
  });

  it('timed mode needs a positive interval to be viable', () => {
    expect(
      bombPotSettingsFromTable({
        bomb_pot_enabled: true,
        bomb_pot_trigger_mode: 'timed',
        bomb_pot_interval_seconds: 0,
      }).enabled
    ).toBe(false);
    expect(
      bombPotSettingsFromTable({
        bomb_pot_enabled: true,
        bomb_pot_trigger_mode: 'timed',
        bomb_pot_interval_seconds: 1800,
      }).enabled
    ).toBe(true);
  });

  it('clamps the minimum-players floor at 2', () => {
    const s = bombPotSettingsFromTable({
      bomb_pot_enabled: true,
      bomb_pot_frequency: 5,
      bomb_pot_min_players: 0,
    });
    expect(s.minPlayers).toBe(2);
  });
});

describe('every_n_hands', () => {
  it('fires exactly every N hands', () => {
    const sch = new BombPotScheduler();
    const s = base({ frequency: 3 });
    const results: boolean[] = [];
    for (let i = 0; i < 9; i++) {
      results.push(sch.noteHandStart(s, 1 + (i % 4), 4, 0).isBombPot);
    }
    expect(results).toEqual([false, false, true, false, false, true, false, false, true]);
  });

  it('a due bomb stays pending below the minimum-players floor (spec §3.1)', () => {
    const sch = new BombPotScheduler();
    const s = base({ frequency: 2, minPlayers: 3 });
    expect(sch.noteHandStart(s, 1, 2, 0).isBombPot).toBe(false);
    // Due now, but only two players — pending, dealt as a normal hand.
    expect(sch.noteHandStart(s, 2, 2, 0).isBombPot).toBe(false);
    expect(sch.isPending()).toBe(true);
    expect(sch.noteHandStart(s, 3, 2, 0).isBombPot).toBe(false);
    // Third player returns: the pending token detonates on this hand.
    const d = sch.noteHandStart(s, 4, 3, 0);
    expect(d.isBombPot).toBe(true);
    expect(d.triggerReason).toBe('every_n_hands');
    expect(sch.isPending()).toBe(false);
  });

  it('felt countdown matches the legacy bomb_pot_in contract', () => {
    const sch = new BombPotScheduler();
    const s = base({ frequency: 3 });
    sch.noteHandStart(s, 1, 4, 0);
    expect(sch.handsUntilDue(s)).toBe(2);
    sch.noteHandStart(s, 2, 4, 0);
    expect(sch.handsUntilDue(s)).toBe(1);
  });
});

describe('once_per_orbit (spec §4.2, T01/T02)', () => {
  it('fires once per completed button orbit — three-handed', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'once_per_orbit' });
    const fires: number[] = [];
    // Button walks 1→2→3→1→2→3→1 …
    const seats = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1];
    seats.forEach((d, i) => {
      if (sch.noteHandStart(s, d, 3, 0).isBombPot) fires.push(i);
    });
    // Anchor at hand 0 (dealer 1). Orbit completes when the button crosses
    // seat 1 again: hands 3, 6, 9.
    expect(fires).toEqual([3, 6, 9]);
  });

  it('T01: a seat leaving mid-orbit neither doubles nor skips the bomb', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'once_per_orbit' });
    // Anchor: dealer 1. Seat 1 then leaves; the button walks 2→3→2 (wrapping
    // past the vanished seat 1) — the wrap crosses the anchor NUMBER once.
    expect(sch.noteHandStart(s, 1, 3, 0).isBombPot).toBe(false);
    expect(sch.noteHandStart(s, 2, 2, 0).isBombPot).toBe(false);
    expect(sch.noteHandStart(s, 3, 2, 0).isBombPot).toBe(false);
    const d = sch.noteHandStart(s, 2, 2, 0); // wrapped 3→2, crossing seat 1
    expect(d.isBombPot).toBe(true);
    expect(d.triggerReason).toBe('once_per_orbit');
    // And no second bomb for the same orbit.
    expect(sch.noteHandStart(s, 3, 2, 0).isBombPot).toBe(false);
  });

  it('T02: a seat joining mid-orbit does not create a second bomb', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'once_per_orbit' });
    expect(sch.noteHandStart(s, 1, 2, 0).isBombPot).toBe(false); // anchor 1
    expect(sch.noteHandStart(s, 2, 3, 0).isBombPot).toBe(false); // seat 5 joins
    expect(sch.noteHandStart(s, 5, 3, 0).isBombPot).toBe(false); // button reaches 5
    const d = sch.noteHandStart(s, 1, 3, 0); // wraps to anchor — one bomb
    expect(d.isBombPot).toBe(true);
    expect(sch.noteHandStart(s, 2, 3, 0).isBombPot).toBe(false);
  });

  it('heads-up: one bomb every two hands', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'once_per_orbit' });
    const fires: number[] = [];
    [1, 2, 1, 2, 1].forEach((d, i) => {
      if (sch.noteHandStart(s, d, 2, 0).isBombPot) fires.push(i);
    });
    expect(fires).toEqual([2, 4]);
  });
});

describe('timed (spec §4.3, T03/T04)', () => {
  const MIN = 60_000;

  it('T03: becomes due mid-interval and starts on the NEXT hand boundary', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'timed', intervalSeconds: 600 }); // 10 min
    expect(sch.noteHandStart(s, 1, 4, 0).isBombPot).toBe(false); // due at 10min
    expect(sch.noteHandStart(s, 2, 4, 5 * MIN).isBombPot).toBe(false);
    const d = sch.noteHandStart(s, 3, 4, 11 * MIN); // first boundary past due
    expect(d.isBombPot).toBe(true);
    expect(d.triggerReason).toBe('timed');
  });

  it('T04: a pause across three intervals produces ONE bomb, not three', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'timed', intervalSeconds: 600 });
    sch.noteHandStart(s, 1, 4, 0);
    // Table paused for 35 minutes — three intervals elapsed.
    expect(sch.noteHandStart(s, 2, 4, 35 * MIN).isBombPot).toBe(true);
    // Clock reset from the ACTUAL bomb start: the very next hand is normal.
    expect(sch.noteHandStart(s, 3, 4, 36 * MIN).isBombPot).toBe(false);
    // …and the following bomb lands one full interval after the last one.
    expect(sch.noteHandStart(s, 4, 4, 46 * MIN).isBombPot).toBe(true);
  });

  it('exposes the due timestamp for the felt clock', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'timed', intervalSeconds: 600 });
    sch.noteHandStart(s, 1, 4, 1000);
    expect(sch.nextBombDueAt(s)).toBe(1000 + 600_000);
  });
});

describe('bomb_pot_only (spec §4.4)', () => {
  it('every hand at or above the floor is a bomb; below it, normal hands', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'bomb_pot_only', minPlayers: 3 });
    expect(sch.noteHandStart(s, 1, 4, 0).isBombPot).toBe(true);
    expect(sch.noteHandStart(s, 2, 3, 0).isBombPot).toBe(true);
    expect(sch.noteHandStart(s, 3, 2, 0).isBombPot).toBe(false);
    expect(sch.noteHandStart(s, 1, 3, 0).isBombPot).toBe(true);
  });
});

describe('resolveBombPotVariant (spec §10.1)', () => {
  it('whitelisted overrides win; everything else means same-as-table', () => {
    expect(resolveBombPotVariant('nlh', 'plo4')).toBe('plo4');
    expect(resolveBombPotVariant('plo4', 'nlh')).toBe('nlh');
    expect(resolveBombPotVariant('nlh', 'PLO5')).toBe('plo5');
    expect(resolveBombPotVariant('nlh', null)).toBe('nlh');
    expect(resolveBombPotVariant('nlh', '')).toBe('nlh');
    // Unknown or unsupported values must NEVER deal a half-understood game.
    expect(resolveBombPotVariant('nlh', 'plo8')).toBe('nlh');
    expect(resolveBombPotVariant('nlh', 'short_deck')).toBe('nlh');
    expect(resolveBombPotVariant('nlh', 'DROP TABLE tables')).toBe('nlh');
  });
});

describe('timed persistence seed (spec §4.3)', () => {
  const MIN = 60_000;

  it('resumes a persisted future due time instead of restarting the cycle', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'timed', intervalSeconds: 1800 }); // 30 min
    // Engine restarts at t=0; the row says the bomb is due at t=5min.
    sch.seedNextDueAt(5 * MIN);
    expect(sch.noteHandStart(s, 1, 4, 0).isBombPot).toBe(false);
    expect(sch.nextBombDueAt(s)).toBe(5 * MIN); // NOT re-set to 0 + 30min
    expect(sch.noteHandStart(s, 2, 4, 6 * MIN).isBombPot).toBe(true);
  });

  it('a due time that passed during the deploy detonates at the first boundary', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'timed', intervalSeconds: 1800 });
    sch.seedNextDueAt(5 * MIN);
    const d = sch.noteHandStart(s, 1, 4, 10 * MIN); // restart took a while
    expect(d.isBombPot).toBe(true);
    expect(d.triggerReason).toBe('timed');
  });

  it('never overwrites a running clock', () => {
    const sch = new BombPotScheduler();
    const s = base({ triggerMode: 'timed', intervalSeconds: 1800 });
    sch.noteHandStart(s, 1, 4, 0); // clock set to 30min
    sch.seedNextDueAt(5 * MIN); // stale persisted value arrives late
    expect(sch.nextBombDueAt(s)).toBe(30 * MIN);
  });
});

describe('full scheduler persistence (2026-08-28)', () => {
  it('a restart mid-orbit resumes the orbit instead of restarting it', () => {
    const s = base({ triggerMode: 'once_per_orbit' });
    const sch1 = new BombPotScheduler();
    // Button walked 1 → 2 → 3 of a 1-anchored orbit, then the engine died.
    sch1.noteHandStart(s, 1, 3, 0);
    sch1.noteHandStart(s, 2, 3, 0);
    sch1.noteHandStart(s, 3, 3, 0);
    const saved = sch1.exportState();

    const sch2 = new BombPotScheduler();
    sch2.restoreState(saved);
    // Next hand wraps 3 → 1, crossing the restored anchor: the bomb fires
    // exactly where it would have without the restart.
    expect(sch2.noteHandStart(s, 1, 3, 0).isBombPot).toBe(true);
  });

  it('a restart with a pending token keeps the token', () => {
    const s = base({ frequency: 2, minPlayers: 3 });
    const sch1 = new BombPotScheduler();
    sch1.noteHandStart(s, 1, 2, 0);
    sch1.noteHandStart(s, 2, 2, 0); // due, held by the player floor
    expect(sch1.isPending()).toBe(true);

    const sch2 = new BombPotScheduler();
    sch2.restoreState(sch1.exportState());
    expect(sch2.isPending()).toBe(true);
    // Third player arrives after the deploy: the surviving token detonates.
    expect(sch2.noteHandStart(s, 3, 3, 0).isBombPot).toBe(true);
  });

  it('every-N counter survives the restart', () => {
    const s = base({ frequency: 5 });
    const sch1 = new BombPotScheduler();
    for (let i = 0; i < 3; i++) sch1.noteHandStart(s, 1 + i, 4, 0);
    const sch2 = new BombPotScheduler();
    sch2.restoreState(sch1.exportState());
    expect(sch2.handsUntilDue(s)).toBe(2);
  });

  it('restore is refused after the scheduler has started', () => {
    const s = base({ frequency: 5 });
    const sch = new BombPotScheduler();
    sch.noteHandStart(s, 1, 4, 0);
    sch.restoreState({ h: 4, p: true });
    expect(sch.isPending()).toBe(false);
    expect(sch.handsUntilDue(s)).toBe(4); // 5 - 1, not 5 - 4
  });

  it('a corrupt persisted row degrades gracefully, field by field', () => {
    const s = base({ frequency: 3 });
    const sch = new BombPotScheduler();
    sch.restoreState({ h: 'garbage', p: 'yes', a: -2, d: NaN, r: 'DROP TABLE' });
    expect(sch.isPending()).toBe(false);
    expect(sch.noteHandStart(s, 1, 4, 0).isBombPot).toBe(false);
  });
});

describe('disable mid-session', () => {
  it('drops all pending state so re-enabling starts a fresh schedule', () => {
    const sch = new BombPotScheduler();
    const s = base({ frequency: 2, minPlayers: 3 });
    sch.noteHandStart(s, 1, 2, 0);
    // Due after two hands, but held pending by the three-player floor.
    sch.noteHandStart(s, 2, 2, 0);
    expect(sch.isPending()).toBe(true);
    // The host switches bomb pots off: the stale token is dropped.
    expect(sch.noteHandStart(base({ enabled: false }), 3, 4, 0).isBombPot).toBe(false);
    expect(sch.isPending()).toBe(false);
    // Re-enabled: the old token must NOT detonate — a fresh cycle starts.
    expect(sch.noteHandStart(s, 1, 4, 0).isBombPot).toBe(false);
    expect(sch.noteHandStart(s, 2, 4, 0).isBombPot).toBe(true);
  });
});
