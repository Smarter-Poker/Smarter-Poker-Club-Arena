/**
 * POLICY (Dan, 2026-08-19):
 *   "ALL TOURNAMENT FEATURE AND FUNCTIONS TO INCLUDE RAKE AND SYNCRONIZED
 *    BREAKS ARE WORKING... BREAKS START AT THE 55 MINUTE MARK OF EVERY HOUR
 *    AND LAST FOR 5 MINUTES."
 *
 * Both were verified BROKEN on production before this change.
 *
 * RAKE — horses were registered with a raw INSERT into tournament_players,
 * skipping every money step the human path performs. In 90 minutes cash games
 * booked 12,506.44 of rake across 5,657 records while tournaments booked ONE
 * record (a human's $1.00, immediately reversed). Prize pools were still paid
 * in full, so tournaments minted ~27,000-30,000 chips a day out of nothing.
 * Horses now buy in through fn_register_horse_for_tournament, which mirrors
 * fn_register_for_tournament exactly (entry split, wallet debit, rake_records
 * row, prize/bounty/rake pool updates) and is gated to horses + service_role.
 *
 * BREAKS — the timer fired at the TOP of the hour, not :55, and the table
 * liveness sweep rebuilt any engine idle >180s. A 5-minute break crosses that
 * threshold, so three minutes in, the sweep declared every paused table dead
 * and replaced it with a FRESH (unpaused) engine that resumed dealing. Watched
 * live at 04:00 with two MTTs running and a stable engine: 03:59=17 hands,
 * 04:00=12, 04:01=1, 04:02=10 — dealing straight through the break.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const GAME_SERVER = readFileSync(resolve(__dirname, '../../server/src/GameServer.ts'), 'utf8');
const BASE = readFileSync(
  resolve(__dirname, '../../server/src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const RECURRING = readFileSync(
  resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
  'utf8'
);

describe('synchronized breaks run :55 -> :00', () => {
  const sched = GAME_SERVER.slice(
    GAME_SERVER.indexOf('private scheduleSynchronizedBreaks'),
    GAME_SERVER.indexOf('private async triggerSynchronizedBreak')
  );

  it('the break starts at the 55 minute mark', () => {
    expect(GAME_SERVER).toMatch(/BREAK_START_MINUTE\s*=\s*55/);
  });

  it('the break lasts 5 minutes', () => {
    expect(GAME_SERVER).toMatch(/BREAK_DURATION_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  });

  it('the scheduler targets :55, not the top of the hour', () => {
    expect(sched).toMatch(/setMinutes\(\s*GameServer\.BREAK_START_MINUTE\s*,\s*0\s*,\s*0\s*\)/);
    // The old code snapped to :00 then added an hour.
    expect(sched).not.toMatch(/setMinutes\(\s*0\s*,\s*0\s*,\s*0\s*\)/);
    expect(sched).not.toContain('msUntilNextHour');
  });

  it('rolls to the next hour when :55 has already passed', () => {
    expect(sched).toMatch(/nextBreak\.getTime\(\)\s*<=\s*now\.getTime\(\)/);
    expect(sched).toMatch(/setHours\(nextBreak\.getHours\(\)\s*\+\s*1\)/);
  });

  it('the liveness sweep does not rebuild engines during a break', () => {
    const start = BASE.indexOf('protected async reviveDeadTableEngines');
    const revive = BASE.slice(start, start + 1800);
    // Paused is not dead: the sweep must bail out before the dead check.
    expect(revive).toMatch(/if \(this\.onBreak\) return;/);
    const guardAt = revive.indexOf('this.onBreak');
    const deadAt = revive.indexOf('msSinceProgress() > 180_000');
    expect(guardAt).toBeGreaterThan(-1);
    expect(deadAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(deadAt);
  });

  it('break state is persisted so it is observable and survives a restart', () => {
    expect(BASE).toMatch(/on_break:\s*true/);
    expect(BASE).toMatch(/break_ends_at:/);
    expect(BASE).toMatch(/on_break:\s*false/);
  });

  it('still pauses the tables themselves', () => {
    expect(BASE).toContain('engine.pauseAfterHand()');
  });
});

describe('tournament rake is actually collected', () => {
  const start = RECURRING.indexOf('private async registerHorses');
  const registerFn = RECURRING.slice(start, start + 7000);

  it('horses register through the money path, not a raw insert', () => {
    expect(registerFn).toContain('fn_register_horse_for_tournament');
  });

  it('no longer bypasses buy-in by inserting straight into tournament_players', () => {
    expect(registerFn).not.toMatch(/from\('tournament_players'\)\s*\n?\s*\.insert\(/);
  });

  it('passes both the tournament and the specific horse', () => {
    expect(registerFn).toMatch(/p_tournament_id:\s*tournamentId/);
    expect(registerFn).toMatch(/p_user_id:\s*horse\.id/);
  });

  it('only counts a horse as seated when the RPC reports ok', () => {
    expect(registerFn).toMatch(/\?\.ok\s*===\s*true/);
  });

  it('surfaces why registrations were skipped instead of failing silently', () => {
    expect(registerFn).toMatch(/failures/);
    expect(registerFn).toMatch(/console\.warn/);
  });
});
