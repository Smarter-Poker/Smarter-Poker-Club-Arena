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
import { blankNonCode, sliceMethod } from '../helpers/sourceWindow';
import { isShortFormat } from '../../server/src/tournament/breakEligibility';

const GAME_SERVER = readFileSync(resolve(__dirname, '../../server/src/GameServer.ts'), 'utf8');
const BASE = readFileSync(
  resolve(__dirname, '../../server/src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const RECURRING = readFileSync(
  resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
  'utf8'
);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PIN MUST SLICE THE METHOD, NOT A FIXED NUMBER OF BYTES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-28. The `registerHorses` pins below read a 7000-character window
 * from the start of the signature. Comments were added inside that method and
 * pushed the asserted code to offsets 7241, 7440, 7471 and 7695 - just past
 * the end of the window. Three pins went red on main, and the code they guard
 * had not changed by a character.
 *
 * That failure mode is worse than a false alarm. A pin whose window can drift
 * off the thing it guards can ALSO drift off it silently in the other
 * direction, going green while the invariant is gone, and the obvious way out
 * of a red window is to make it bigger, which just moves the cliff.
 *
 * So take the whole method by matching braces from its opening one. Reading
 * one byte past a string literal or a comment containing a brace is not
 * possible here for a reason worth stating: both are stripped first, exactly
 * as every other source-grep gate in this repo does it.
 */

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

  it('a causal replacement inherits the active break before it can deal', () => {
    const prepare = sliceMethod(BASE, 'private prepareManagedTableEngineForPlay');
    expect(prepare).toMatch(/if \(this\.onBreak\)/);
    expect(prepare).toMatch(
      /pauseAfterHand\(TournamentManagerBase\.MAX_HEALTHY_PAUSE_MS,\s*\{\s*beforeNextHand:\s*true/
    );
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
    // Renamed from mttEngines 2026-08-27: the snapshot is every format now,
    // not only the MTTs. See the takesSynchronizedBreaks suite below.
    expect(trigger).toMatch(/await this\.waitForAllTablesParked\(breakEngines\)/);
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

  it('break_ends_at is left NULL until the countdown actually starts', () => {
    const pause = BASE.slice(
      BASE.indexOf('async pauseForBreak'),
      BASE.indexOf('areAllTablesParked')
    );
    expect(pause).toMatch(/break_ends_at:\s*null/);
    const begin = sliceMethod(BASE, 'async beginBreakCountdown');
    const persist = sliceMethod(BASE, 'private async persistSynchronizedBreakCountdown');
    expect(begin).toContain('persistSynchronizedBreakCountdown(endsAt)');
    expect(persist).toMatch(/update\(\{ break_ends_at:\s*endsAt \}/);
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

  it("the tournament manager's causal recovery prepares a replacement before admission", () => {
    const recovery = sliceMethod(BASE, 'private async performManagedTableEngineRecovery');
    const prepareAt = recovery.indexOf('this.prepareManagedTableEngineForPlay(fresh)');
    const replaceAt = recovery.indexOf('this.gameServer.replaceTableEngine');
    expect(prepareAt).toBeGreaterThan(-1);
    expect(replaceAt).toBeGreaterThan(prepareAt);
  });

  it('a pause is only healthy for as long as a real break could last', () => {
    // Otherwise this guard would trade "breaks get dismantled" for "a wedged
    // table never recovers", which is the worse bug.
    expect(GAME_SERVER).toMatch(/MAX_HEALTHY_PAUSE_MS = 10 \* 60 \* 1000/);
    expect(BASE).toMatch(/MAX_HEALTHY_PAUSE_MS = 10 \* 60 \* 1000/);
    expect(GAME_SERVER).toMatch(/msPaused\(\) > GameServer\.MAX_HEALTHY_PAUSE_MS/);
    expect(BASE).toMatch(/pauseAfterHand\(TournamentManagerBase\.MAX_HEALTHY_PAUSE_MS/);
  });

  it('the ceiling exceeds a full break plus the last-hand grace', () => {
    // 5 min break + 2 min grace = 7 min worst legitimate case.
    expect(10 * 60 * 1000).toBeGreaterThan(5 * 60 * 1000 + 2 * 60 * 1000);
  });

  /**
   * Each disjunct is asserted on its own, deliberately.
   *
   * This used to be one regex requiring `handForHandPaused` and the FSM check
   * to sit next to each other. #2695 inserted `maintenancePaused` between them
   * - the fix for 1204 hands dealt inside a maintenance break - and left this
   * test red on main, because the predicate had become MORE correct in a shape
   * the regex forbade. A guard that fails when the thing it guards is improved
   * teaches people to delete it.
   *
   * So: require every term to be present, and say nothing about their order or
   * their neighbours. Adding a fifth reason a table is paused on purpose should
   * not have to come back here.
   */
  it('isPausedByDesign covers hand-for-hand, a maintenance break, and the FSM', () => {
    const ENGINE = readFileSync(
      resolve(__dirname, '../../server/src/engine/ServerTableEngineBase.ts'),
      'utf8'
    );
    const fn = sliceMethod(ENGINE, 'isPausedByDesign(): boolean');
    /* Resolved with #2705, which fixed the same red pin concurrently by
       re-pinning all three terms as one adjacent sequence. That is the shape
       that has now broken twice: #2695 inserted `maintenancePaused` between
       the original two and turned a correct improvement into a red build. A
       fourth authority would do it again.

       So each term is required on its own, with nothing said about order or
       neighbours, plus one assertion that they are joined by || and never &&.
       Checked that this still catches the regressions the pin exists for:
       deleting `maintenancePaused` (the exact 1204-hands bug) fails it, and
       flipping the || to && fails it. */
    const body = fn;
    const code = blankNonCode(body);
    expect(code).toMatch(/this\.handForHandPaused/);
    expect(code).toMatch(/this\.maintenancePaused/);
    expect(body).toMatch(/this\.tableFSM\.state === 'paused'/);

    // An armed move can still be landing its current hand. It counts as a
    // deliberate pause only after the dealing loop has physically parked at
    // the gate; every other pause authority remains an independent disjunct.
    const parkedMove =
      /\(this\.tournamentMovePauseOwners\.size > 0\s*&&\s*this\.handForHandResolve !== null\)/;
    expect(code).toMatch(parkedMove);
    expect(code.replace(parkedMove, '')).not.toMatch(/&&/);
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
    /* 2026-08-27: the call now also passes { beforeNextHand: true }. Restarting
       INTO a live break is a break, so the rebuilt engines must park without
       dealing rather than opening one more hand first - which is what an
       un-flagged pause means. The budget argument is unchanged. */
    expect(resumeFn).toMatch(
      /engine\.pauseAfterHand\(remainingMs \+ TournamentManagerBase\.LAST_HAND_GRACE_MS,\s*\{\s*beforeNextHand:\s*true,?\s*\}\)/
    );
  });

  it('re-arms the resume for the remainder', () => {
    expect(resumeFn).toMatch(
      /setLifecycleTimeout\([\s\S]{0,100}resumeFromBreak\(\)[\s\S]{0,40}remainingMs\)/
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
    expect(clearFn).toMatch(/on_break: false,\s*break_started_at: null,\s*break_ends_at: null/);
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
    //
    // MOVED 2026-08-27: the park itself moved out of the dealing loop and into
    // ServerTableEngineBase.awaitPauseGate, so the loop could await it from the
    // TOP of the iteration as well as after the deal — a gate that only sat
    // after dealHand() was unreachable for any table that was idle, holding for
    // a spin wheel, or short a player at :55. The budget rule is unchanged and
    // is asserted where it now lives; the dealing loop must no longer carry a
    // park of its own.
    expect(ENGINE).toMatch(/this\.pauseMaxWaitMs \?\? 120000/);
    expect(ENGINE).not.toMatch(/\}, 120000\);/);
    expect(DEALING).not.toMatch(/\}, 120000\);/);
    expect(DEALING).not.toMatch(/this\.handForHandResolve = resolve/);
    expect(DEALING).toMatch(/await this\.awaitPauseGate\(\)/);
  });

  it('the break asks for a budget covering the last hand plus the break', () => {
    expect(BASE).toMatch(/breakDurationMs \+ TournamentManagerBase\.LAST_HAND_GRACE_MS/);
  });

  it('the extended budget is released on resume', () => {
    // MOVED, NOT REMOVED (2026-09-01). `resumeDealing` and the new
    // `resumeFromMaintenance` share their tail, so the three lines that let
    // the gate go live in `releasePauseGate`. The budget must still be
    // dropped there — a break's multi-minute window inherited by the next
    // hand-for-hand pause is the 2026-08-19 bug in reverse.
    const release = ENGINE.slice(ENGINE.indexOf('private releasePauseGate()'));
    expect(release).toMatch(/pauseMaxWaitMs = null/);
    expect(ENGINE.slice(ENGINE.indexOf('resumeDealing(): void {'))).toMatch(
      /this\.releasePauseGate\(\)/
    );
  });
});

describe('the slicer these pins depend on', () => {
  /**
   * A helper that silently returns the wrong span turns every pin built on it
   * into a pin that passes for the wrong reason, so it gets its own pins.
   */
  const SRC = [
    'class X {',
    '  private async registerHorses() {',
    '    // a comment with a } brace in it',
    "    const s = 'a string with { and } in it';",
    '    if (true) {',
    '      doThing();',
    '    }',
    '    return 1;',
    '  }',
    '  private async other() {',
    '    NOT_IN_THE_SLICE;',
    '  }',
    '}',
  ].join('\n');

  it('stops at the end of the method, not at a byte count', () => {
    const out = sliceMethod(SRC, 'private async registerHorses');
    expect(out).toContain('doThing();');
    expect(out).toContain('return 1;');
    expect(out).not.toContain('NOT_IN_THE_SLICE');
    expect(out.trimEnd().endsWith('}')).toBe(true);
  });

  it('is not fooled by a brace inside a comment or a string', () => {
    // Both appear before the real closing brace; counting them would end the
    // slice early and quietly drop the assertions that follow.
    const out = sliceMethod(SRC, 'private async registerHorses');
    expect(out).toContain('a string with { and }');
    expect(out).toContain('return 1;');
  });

  it('fails loudly when the method is renamed', () => {
    // Renaming the method must break the pin, not disarm it. A slicer that
    // returned '' would make every assertion below vacuously... fail, but a
    // slicer that returned the WHOLE FILE would make them vacuously pass.
    expect(() => sliceMethod(SRC, 'private async notHere')).toThrow(/not found/);
  });
});

describe('tournament rake is actually collected', () => {
  const registerFn = sliceMethod(RECURRING, 'private async registerHorses');

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY FORMAT TAKES THE :55 BREAK (Dan 2026-08-27, binding)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "DO A DEEP DIVE AND AUDIT INTO THE SYNCHRONIZED BREAKS FOR EVERY MTT, SPIN
 *  AND HEADS UP... THEY SHOULD START AT THE :55 OF THE HOUR EVERY HOUR."
 *
 * Verified broken: GameServer gated the break on isMttOrXmtt(), whose entire
 * job is to return FALSE for SNG and SPIN. Heads-Up has no type of its own on
 * this platform (it is variant 'sng' + max_players 2), so that one predicate
 * excluded all three formats Dan named — the whole 32-board Spin fleet and the
 * whole 16-board Heads-Up fleet dealt through every break while the MTTs sat
 * on the break screen.
 */
describe('the :55 break covers every format, not only the MTTs', () => {
  const trigger = GAME_SERVER.slice(
    GAME_SERVER.indexOf('private async triggerSynchronizedBreak'),
    GAME_SERVER.indexOf('private async waitForAllTablesParked')
  );
  const hold = GAME_SERVER.slice(
    GAME_SERVER.indexOf('private async holdIfBreakIsRunning'),
    GAME_SERVER.indexOf('private async waitForAllTablesParked')
  );

  it('the break snapshot does not filter on format', () => {
    expect(trigger).toMatch(/tm\.takesSynchronizedBreaks\(\)/);
    // THE REGRESSION: any format predicate back in this gate re-excludes
    // Spin and Heads-Up, because that is exactly what isMttOrXmtt() means.
    expect(trigger).not.toMatch(/isMttOrXmtt/);
  });

  it('a tournament that starts mid-break is held regardless of format', () => {
    expect(hold).toMatch(/tm\.takesSynchronizedBreaks\(\)/);
    expect(hold).not.toMatch(/isMttOrXmtt/);
  });

  it('the only opt-out is the explicit per-tournament column', () => {
    const gate = BASE.slice(
      BASE.indexOf('takesSynchronizedBreaks(): boolean'),
      BASE.indexOf('takesSynchronizedBreaks(): boolean') + 200
    );
    expect(gate).toMatch(/synchronizedBreaksEnabled\(\)/);
    // No format may be read here. Spin, sng and tournament_type are all
    // disqualifying — see the method's own docstring.
    expect(gate).not.toMatch(/spin|sng|tournament_type|variant/i);
  });

  it('isMttOrXmtt still exists but normalises case', () => {
    /* UPDATED 2026-08-27, house rule 8 — the behaviour this pinned moved, it
       was not removed.

       The `toUpperCase()` / `toLowerCase()` literals left this method when the
       format rule was lifted into `isShortFormat` in breakEligibility.ts, so
       that ONE predicate could serve both `isMttOrXmtt()` and
       `mayTakeSynchronizedBreak()` (the reason is in that file's docstring: a
       rule stated twice is one forgotten edit away from disagreeing with
       itself). Grepping this method for a literal it no longer contains says
       nothing about whether case is still normalised.

       So the INTENT is asserted instead, in two halves: this method still
       delegates rather than growing a second copy of the rule, and the rule it
       delegates to is genuinely case-insensitive. The second half is now a
       BEHAVIOURAL assertion, which is strictly stronger than the regex it
       replaces — a `toUpperCase()` compared against a lowercase literal would
       have passed the old pin and matched nothing in production. */
    const fn = sliceMethod(BASE, 'isMttOrXmtt(): boolean');
    expect(fn).toMatch(/isShortFormat\(/);

    // Either column identifies the format, in any casing. See the docstring on
    // isShortFormat for why both are read: the two disagree in the wild.
    for (const format of ['SPIN', 'spin', 'Spin', 'SNG', 'sng', 'Sng']) {
      expect(isShortFormat(format, null)).toBe(true);
      expect(isShortFormat(null, format)).toBe(true);
    }
    // And an MTT is an MTT whatever case it arrives in.
    for (const format of ['MTT', 'mtt', 'XMTT', 'xmtt']) {
      expect(isShortFormat(format, null)).toBe(false);
      expect(isShortFormat(null, format)).toBe(false);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PARK IS REACHABLE FROM AN IDLE TABLE (Dan 2026-08-27, binding)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "AT THE :55 BREAK HAS STARTED, AND ALL HANDS FINISH. ONCE A TABLE HAS
 *  FINISHED THE HAND, THEY STOP, AND DON'T RESTART UNTIL THE BREAK IS OVER."
 *
 * Verified broken: the park lived inline AFTER `await this.dealHand(...)`, and
 * every guard above it leaves the iteration with `continue` (short-handed,
 * spin-reveal hold, bounty reveal, admin lock) while the start-up wait loop
 * enters the dealing loop below it entirely. A table that was not mid-hand at
 * :55 therefore never parked:
 *
 *   - areAllTablesParked() stayed false, so the platform burned the whole
 *     2-minute LAST_HAND_GRACE_MS every hour and started the break late;
 *   - and the moment that table got players back it dealt a full hand IN THE
 *     MIDDLE OF THE BREAK before parking.
 */
describe('a paused table parks whatever it was doing', () => {
  const DEALING = readFileSync(
    resolve(__dirname, '../../server/src/engine/ServerTableEngineDealing.ts'),
    'utf8'
  );
  const ENGINE_BASE = readFileSync(
    resolve(__dirname, '../../server/src/engine/ServerTableEngineBase.ts'),
    'utf8'
  );
  const loop = DEALING.slice(DEALING.indexOf('protected async dealingLoop'));

  it('the gate is awaited before the short-handed idle branch', () => {
    const gateAt = loop.indexOf('await this.awaitPauseGate()');
    const shortHandedAt = loop.indexOf('activePlayers.length < this.minPlayersToDeal()');
    const dealAt = loop.indexOf('await this.dealHand(');
    expect(gateAt).toBeGreaterThan(-1);
    expect(shortHandedAt).toBeGreaterThan(-1);
    expect(dealAt).toBeGreaterThan(-1);
    // THE REGRESSION: a gate that only sits after the deal is unreachable for
    // every table that never reaches the deal.
    expect(gateAt).toBeLessThan(shortHandedAt);
    expect(gateAt).toBeLessThan(dealAt);
  });

  it('it also parks immediately after a hand lands, not after the display pause', () => {
    const dealAt = loop.indexOf('await this.dealHand(');
    const postDealGate = loop.indexOf('await this.awaitPauseGate()', dealAt);
    const displayPause = loop.indexOf('wentToShowdown');
    expect(postDealGate).toBeGreaterThan(dealAt);
    expect(postDealGate).toBeLessThan(displayPause);
  });

  it('parking never fires an invalid FSM transition from an idle table', () => {
    const gate = ENGINE_BASE.slice(
      ENGINE_BASE.indexOf('protected async awaitPauseGate'),
      ENGINE_BASE.indexOf('protected async awaitPauseGate') + 3000
    );
    // The FSM has no waiting -> paused edge, and the gate is now reachable
    // from the idle branches where the table sits in 'waiting'.
    expect(gate).toMatch(
      /tableFSM\.state === 'running'\s*\)\s*\{\s*\n\s*this\.tableFSM\.transition\('paused'\)/
    );
  });

  /**
   * A BREAK MEANS STOP. HAND-FOR-HAND MEANS ONE MORE HAND, THEN STOP.
   *
   * The bubble sync resumes every table together and re-pauses them 500ms
   * later, on purpose, "to let dealing start" - it is arming the park for the
   * hand about to be dealt. If the top-of-loop gate honoured that re-pause the
   * table would park BEFORE dealing, the sync would see everyone parked,
   * resume, re-pause, and park again: the bubble could never burst and the
   * tournament would freeze on the money. So the top-of-loop gate is gated on
   * holdBeforeNextHand, which only the STOP callers pass.
   */
  it('hand-for-hand still gets its one more hand, so the bubble can burst', () => {
    const loopSrc = DEALING.slice(DEALING.indexOf('protected async dealingLoop'));
    const gateAt = loopSrc.indexOf('await this.awaitPauseGate()');
    // The top-of-loop park must be conditional on holdBeforeNextHand.
    expect(loopSrc.slice(0, gateAt)).toMatch(/this\.handForHandPaused && this\.holdBeforeNextHand/);
    // The bubble sync's re-pause must NOT claim it.
    const sync = sliceMethod(BASE, 'protected startHandForHandSync');
    const advance = sliceMethod(BASE, 'private advanceHandForHandBarrier');
    expect(sync).toMatch(/this\.advanceHandForHandBarrier\(\)/);
    expect(advance).toMatch(/engine\.pauseAfterHand\(\)/);
    expect(advance).not.toMatch(/beforeNextHand/);
  });

  it('every STOP caller asks for the hold, so nothing is dealt into a break', () => {
    const pause = BASE.slice(
      BASE.indexOf('async pauseForBreak'),
      BASE.indexOf('areAllTablesParked')
    );
    expect(pause).toMatch(/beforeNextHand:\s*true/);
    // The add-on break and the restart-into-a-live-break path are breaks too.
    expect((BASE.match(/beforeNextHand:\s*true/g) || []).length).toBeGreaterThanOrEqual(3);
    // A drain is stopping the process; it must not open another hand either.
    expect(GAME_SERVER).toMatch(
      /pauseAfterHand\(DRAIN_BUDGET_MS,\s*\{\s*beforeNextHand:\s*true\s*\}\)/
    );
  });

  it('resuming clears the hold, so the next pause is judged on its own terms', () => {
    /**
     * The clearing MOVED, it did not go away (2026-09-01). `resumeDealing()`
     * and the new `resumeFromMaintenance()` both end by releasing the gate, so
     * the three lines they shared live in `releasePauseGate()` and this reads
     * them there. Pinning the body of one caller would have gone red for a
     * refactor that changed no behaviour — and `npx vitest run tests/` is the
     * step that publishes the bundle, so a cosmetic red here stops every
     * deploy on the platform.
     */
    // Use the declaration as the anchor. Terminal closeout now calls this
    // helper before its declaration, so the shorter anchor would slice that
    // caller rather than the method it is supposed to guard.
    const release = sliceMethod(ENGINE_BASE, 'private releasePauseGate(): void');
    expect(release).toMatch(/this\.holdBeforeNextHand = false/);
    expect(release).toMatch(/this\.pauseMaxWaitMs = null/);
    // And resumeDealing must still route through it rather than half-resuming.
    const resume = sliceMethod(ENGINE_BASE, 'resumeDealing(): void');
    expect(resume).toMatch(/this\.releasePauseGate\(\)/);
  });

  it('hand-for-hand cannot lift a maintenance break', () => {
    /**
     * Two independent pause authorities, and the reason is a bug this would
     * otherwise reintroduce: hand-for-hand's 500ms sync loop calls
     * resumeDealing() the moment every table is waiting, which during a
     * maintenance break is immediately. Without this early return it dealt a
     * hand inside the break AND destroyed the break's pause budget on the way
     * through, so the table self-resumed two minutes into a five minute break.
     */
    const resume = blankNonCode(sliceMethod(ENGINE_BASE, 'resumeDealing(): void'));
    const resumeGate = /if\s*\(([\s\S]*?)\)\s*\{\s*this\.pausedSinceMs/.exec(resume)?.[1];
    expect(resumeGate).toBeDefined();
    expect(resumeGate).toContain('this.tournamentMovePauseOwners.size > 0');
    expect(resumeGate).toContain('this.maintenancePaused');
    expect(resumeGate).toContain('this.finalTableDealPaused');
    expect(resumeGate).toContain('this.terminalCloseoutPaused');
    expect(resumeGate).not.toMatch(/&&/);
    // The maintenance resume is the mirror image: it must not lift a
    // hand-for-hand or tournament-move pause it did not set.
    const maint = blankNonCode(sliceMethod(ENGINE_BASE, 'resumeFromMaintenance(): void'));
    const maintenanceGate = /if\s*\(([\s\S]*?)\)\s*return;/.exec(maint)?.[1];
    expect(maintenanceGate).toBeDefined();
    expect(maintenanceGate).toContain('this.tournamentMovePauseOwners.size > 0');
    expect(maintenanceGate).toContain('this.handForHandPaused');
    expect(maintenanceGate).toContain('this.finalTableDealPaused');
    expect(maintenanceGate).toContain('this.terminalCloseoutPaused');
    expect(maintenanceGate).not.toMatch(/&&/);
  });

  it('the park is what areAllTablesParked reads, so an idle table counts', () => {
    const gate = ENGINE_BASE.slice(
      ENGINE_BASE.indexOf('protected async awaitPauseGate'),
      ENGINE_BASE.indexOf('protected async awaitPauseGate') + 3000
    );
    // isWaitingForHandForHand() is handForHandPaused && handForHandResolve !== null,
    // so the gate must be what assigns handForHandResolve.
    expect(gate).toMatch(/this\.handForHandResolve = resolve/);
    expect(gate).toMatch(/this\.pauseMaxWaitMs \?\? 120000/);
  });
});
