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
    expect(BASE).toMatch(/engine\.pauseAfterHand\(/);
  });
});

/**
 * Dan 2026-08-19: "AT THE 55 OF THE HOUR, THE LAST HAND IS DEALT FOR ALL
 * TOURNAMENT TABLES, ONCE THE LAST HAND ON EVERY TABLE IS COMPLETED, THE 5
 * MINUTE BREAK STARTS... SO IT CAN BE UP TO LIKE A 6 MINUTE BREAK."
 *
 * The break is TWO phases. Starting the five-minute timer at :55 (as the code
 * did) silently shortened every break by however long the final hand ran.
 */
describe('the break is two phases: last hand, THEN five minutes', () => {
  const trigger = GAME_SERVER.slice(
    GAME_SERVER.indexOf('private async triggerSynchronizedBreak'),
    GAME_SERVER.indexOf('private async waitForAllTablesParked')
  );

  it(':55 announces the last hand rather than starting the clock', () => {
    expect(trigger).toMatch(/LAST HAND/);
    expect(trigger).toMatch(/pauseForBreak\(GameServer\.BREAK_DURATION_MS\)/);
  });

  it('waits for every table across every tournament before counting down', () => {
    expect(trigger).toMatch(/await this\.waitForAllTablesParked\(mttEngines\)/);
    const waitAt = trigger.indexOf('waitForAllTablesParked');
    const countdownAt = trigger.indexOf('beginBreakCountdown');
    const resumeTimerAt = trigger.indexOf('breakResumeTimer');
    expect(waitAt).toBeGreaterThan(-1);
    // Order matters: wait -> start countdown -> schedule the resume.
    expect(waitAt).toBeLessThan(countdownAt);
    expect(countdownAt).toBeLessThan(resumeTimerAt);
  });

  it('the five minutes are measured from AFTER the last hand', () => {
    // The resume timer must be armed after the wait, not at :55.
    const waitAt = trigger.indexOf('waitForAllTablesParked');
    const timerAt = trigger.indexOf('setTimeout');
    expect(waitAt).toBeLessThan(timerAt);
  });

  it('a wedged table cannot hold the break open forever', () => {
    const waiter = GAME_SERVER.slice(GAME_SERVER.indexOf('private async waitForAllTablesParked'));
    expect(waiter).toMatch(/LAST_HAND_GRACE_MS/);
    expect(waiter).toMatch(/deadline/);
  });

  it('all-tables-parked reads the real between-hands park signal', () => {
    const parked = BASE.slice(BASE.indexOf('areAllTablesParked'));
    expect(parked).toMatch(/isWaitingForHandForHand\(\)/);
    // A tournament with no tables must not block everyone else.
    expect(parked).toMatch(/engines\.length === 0\) return true/);
  });

  it('a SYNCHRONIZED break leaves break_ends_at NULL until the countdown starts', () => {
    /**
     * 2026-08-27: pauseForBreak takes a second kind of break now — the add-on
     * break, which belongs to one tournament and therefore knows its own end
     * time immediately. So the write is conditional rather than a bare null:
     *
     *   break_ends_at: synchronized ? null : <now + duration>
     *
     * The invariant this test was written for is untouched — at :55 the five
     * minutes do not start until every table everywhere has finished its last
     * hand, so the synchronized branch must still be NULL. Pinning the ternary
     * keeps that AND stops the add-on branch quietly becoming null too, which
     * would leave its countdown with nothing to count to.
     */
    const pause = BASE.slice(
      BASE.indexOf('async pauseForBreak'),
      BASE.indexOf('areAllTablesParked')
    );
    expect(pause).toMatch(/break_ends_at:\s*synchronized\s*\?\s*null\s*:/);
    const begin = BASE.slice(BASE.indexOf('async beginBreakCountdown'));
    expect(begin).toMatch(/break_ends_at:\s*endsAt/);
  });
});

/**
 * Dan 2026-08-19: PAUSED IS NOT DEAD.
 *
 * TWO independent reapers rebuild "stalled" table engines on the same 180s
 * threshold — one in TournamentManagerBase, one in GameServer.discoverCashTables.
 * A synchronized break parks every tournament table for five minutes, which
 * crosses that threshold, so a reaper that does not understand a deliberate
 * pause will dismantle the break from the outside.
 */
describe('neither reaper treats a deliberately paused table as a zombie', () => {
  it("GameServer's reaper skips engines paused by design", () => {
    const reaper = GAME_SERVER.slice(
      GAME_SERVER.indexOf('const shouldBeDealing'),
      GAME_SERVER.indexOf('const shouldBeDealing') + 3000
    );
    expect(reaper).toMatch(/engine\.isPausedByDesign\(\)/);
    // The pause check must gate the SAME condition as the staleness check.
    expect(reaper).toMatch(
      /shouldBeDealing && !parkedOnPurpose && engine\.msSinceProgress\(\) > 180_000/
    );
  });

  it("the tournament manager's sweep also respects a by-design pause", () => {
    const revive = BASE.slice(
      BASE.indexOf('protected async reviveDeadTableEngines'),
      BASE.indexOf('protected async reviveDeadTableEngines') + 2200
    );
    expect(revive).toMatch(/engine\.isPausedByDesign\(\)/);
    expect(revive).toMatch(/!parkedOnPurpose && engine\.msSinceProgress\(\) > 180_000/);
  });

  it('a pause is only healthy for as long as a real break could last', () => {
    // Otherwise this guard would trade "breaks get dismantled" for "a wedged
    // table never recovers", which is the worse bug.
    expect(GAME_SERVER).toMatch(/MAX_HEALTHY_PAUSE_MS = 10 \* 60 \* 1000/);
    expect(BASE).toMatch(/MAX_HEALTHY_PAUSE_MS = 10 \* 60 \* 1000/);
    expect(GAME_SERVER).toMatch(/msPaused\(\) > GameServer\.MAX_HEALTHY_PAUSE_MS/);
    expect(BASE).toMatch(/msPaused\(\) <= TournamentManagerBase\.MAX_HEALTHY_PAUSE_MS/);
  });

  it('the ceiling exceeds a full break plus the last-hand grace', () => {
    // 5 min break + 2 min grace = 7 min worst legitimate case.
    expect(10 * 60 * 1000).toBeGreaterThan(5 * 60 * 1000 + 2 * 60 * 1000);
  });

  it('isPausedByDesign covers both a break pause and hand-for-hand', () => {
    const ENGINE = readFileSync(
      resolve(__dirname, '../../server/src/engine/ServerTableEngineBase.ts'),
      'utf8'
    );
    const fn = ENGINE.slice(ENGINE.indexOf('isPausedByDesign(): boolean'));
    expect(fn).toMatch(/handForHandPaused \|\| this\.tableFSM\.state === 'paused'/);
  });
});

describe('a restart mid-break does not resume play', () => {
  const resumeFn = BASE.slice(
    BASE.indexOf('async resume()'),
    BASE.indexOf('async pauseForBreak') > BASE.indexOf('async resume()')
      ? BASE.indexOf('async pauseForBreak')
      : BASE.length
  );

  it('re-pauses the rebuilt engines for the remaining break time', () => {
    /* SUPERSEDED BY #801, AND LEFT RED ON main. This asserted the gate
       `tournament.on_break && tournament.break_ends_at`, which #801 removed on
       purpose: pauseForBreak writes break_ends_at as NULL at :55 and
       beginBreakCountdown fills it in up to two minutes later, so a restart
       inside that window matched the old gate's second half as false and
       skipped the whole recovery - the tournament dealt straight through the
       remainder of its own break. (Seven live rows were found stranded with
       on_break true and no break.) The rule now is that on_break ALONE opens
       the block and a missing end time is RECONSTRUCTED from break_started_at,
       which is what this pins. House rule 8: the test that pins replaced
       behaviour is updated in the commit that replaces it. */
    expect(resumeFn).toMatch(/if \(tournament\.on_break\) \{/);
    /* And the conjunction may not come back. A positive assertion alone would
       still pass if someone re-added `&& tournament.break_ends_at` on a later
       line, which is exactly the shape of the original defect. */
    expect(resumeFn).not.toMatch(/tournament\.on_break && tournament\.break_ends_at/);
    expect(resumeFn).toMatch(/tournament\.break_started_at/);
    expect(resumeFn).toMatch(/LAST_HAND_GRACE_MS \+\s*TournamentManagerBase\.BREAK_DURATION_MS/);
    expect(resumeFn).toMatch(/remainingMs/);
    expect(resumeFn).toMatch(
      /engine\.pauseAfterHand\(remainingMs \+ TournamentManagerBase\.LAST_HAND_GRACE_MS\)/
    );
  });

  it('re-arms the resume for the remainder', () => {
    expect(resumeFn).toMatch(
      /setTimeout\([\s\S]{0,80}resumeFromBreak\(\)[\s\S]{0,40}remainingMs\)/
    );
  });

  it('clears a break that already expired while the engine was down', () => {
    /* The UPDATE moved into clearPersistedBreak() in #801, so it is no longer
       inside the sliced resume() body. Both halves are pinned: resume() must
       call it, and it must be the write that clears both columns. */
    expect(resumeFn).toMatch(/await this\.clearPersistedBreak\(\);/);
    const clearFn = BASE.slice(
      BASE.indexOf('protected async clearPersistedBreak'),
      BASE.indexOf('protected async clearPersistedBreak') + 600
    );
    expect(clearFn).toMatch(/on_break: false, break_ends_at: null/);
  });
});

describe('the engine pause outlasts the break', () => {
  const ENGINE = readFileSync(
    resolve(__dirname, '../../server/src/engine/ServerTableEngineBase.ts'),
    'utf8'
  );
  const DEALING = readFileSync(
    resolve(__dirname, '../../server/src/engine/ServerTableEngineDealing.ts'),
    'utf8'
  );

  it('the park no longer self-resumes after a hard-coded 120s', () => {
    // 120s is shorter than a 5-minute break: every table used to resume mid-break.
    expect(DEALING).toMatch(/this\.pauseMaxWaitMs \?\? 120000/);
    expect(DEALING).not.toMatch(/\}, 120000\);/);
  });

  it('the break asks for a budget covering the last hand plus the break', () => {
    expect(BASE).toMatch(/breakDurationMs \+ TournamentManagerBase\.LAST_HAND_GRACE_MS/);
  });

  it('the extended budget is released on resume', () => {
    const resume = ENGINE.slice(ENGINE.indexOf('resumeDealing()'));
    expect(resume).toMatch(/pauseMaxWaitMs = null/);
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
