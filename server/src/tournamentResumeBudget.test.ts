/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RUNNING RE-ADOPTION IS BUDGETED (2026-09-10)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE INCIDENT
 * Production at 70a6a75f and again at 3ed2c159: every tournament discovery pass
 * re-adopted the ~740 RUNNING tournaments that had no manager in the process,
 * all at once - ~740 lease claims, ~740 managers and ~1000 table engines inside
 * about three seconds on a single-core box. The main loop saturated, the lease
 * heartbeats starved, and in ten minutes 818 managers lost their lease, 241
 * lease proofs expired and 743 lease generations "expired before [they were]
 * renewed". A fenced manager leaves tournamentEngines, so the next pass saw the
 * same ~740 as managerless and adopted them all again: 7 tables dealing out of
 * ~1000. At 20:13 UTC the storm ended in a RangeError and a supervisor restart.
 *
 * It is C20 again. The cash fleet learned in August that adoption without a
 * budget turns load into failure and failure back into load; the RUNNING loop
 * never got the budget.
 *
 * THE FIX UNDER TEST
 * The same AIMD law (nextEngineStartBudget) now governs RUNNING re-adoption,
 * with its own instance. Because a resume admission stays in flight through the
 * claim, the manager's resume and its tables' readiness, the budget bounds the
 * loop's resumes IN FLIGHT, not only the ones launched this pass. The first
 * block pins the selection law; the second pins the wiring, because a correct
 * law that nothing calls is how this incident happened.
 *
 * FAILS ON THE OLD CODE: the old loop launched an admission for every
 * managerless RUNNING id in one pass and applied no verdict, so every wiring
 * assertion below is red against it (checked by running this file against the
 * pre-fix GameServer.ts), and the law module did not exist.
 *
 * 2026-09-11, review of #4218, two more holes, each pinned below:
 *   - A resume can settle with no manager and no retry (resume_failed,
 *     owned_elsewhere), and nothing remembered it, so a budget's worth of
 *     events that cannot resume at the head of the board took every slot on
 *     every pass and the tail was never adopted. Ids waiting on a retry timer
 *     were relaunched ahead of the tail the same way. Now such an id cools
 *     down (5 s doubling to 5 min) and a pending retry counts as in flight.
 *     The starvation law below is red against the selection without the
 *     cooldown (checked by removing the skip and re-running).
 *   - The renewal pass charged every manager it retired as distress, and a
 *     finished tournament's manager is retired there, so normal completions
 *     halved the budget; and a quarantined manager was charged on every pass.
 *     aFinishedTournamentIsNotALostLease.test.ts drives the pass itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ENGINE_START_BUDGET_MAX,
  ENGINE_START_BUDGET_MIN,
  nextEngineStartBudget,
} from './engineStartBudget.js';
import {
  RESUME_COOLDOWN_CAP_MS,
  RESUME_COOLDOWN_FIRST_MS,
  RESUME_IN_FLIGHT_HORIZON_MS,
  RunningResumeCooldowns,
  resumeCooldownMs,
  resumesHoldingASlot,
  selectRunningResumes,
} from './tournamentResumeBudget.js';
import { blankNonCode, sliceEnclosingBlock, sliceMethod } from './testHelpers/sourceWindow.js';

/** The production board of 2026-09-10: ~740 RUNNING, oldest started_at first. */
const FLEET = 740;
const board = Array.from({ length: FLEET }, (_, i) => ({
  id: `t-${String(i).padStart(4, '0')}`,
  name: `Event ${i}`,
}));

const pass = (
  over: Partial<Parameters<typeof selectRunningResumes>[1]> = {}
): Parameters<typeof selectRunningResumes>[1] => ({
  hasManager: () => false,
  admissionInFlight: () => false,
  coolingDown: () => false,
  resumesInFlight: 0,
  budget: ENGINE_START_BUDGET_MAX,
  ...over,
});

describe('the RUNNING re-adoption law', () => {
  it('a restart does not resume the whole board in one pass', () => {
    // The old loop's answer here was all 740.
    const picked = selectRunningResumes(board, pass());
    expect(picked).toHaveLength(ENGINE_START_BUDGET_MAX);
    expect(picked.length).toBeLessThan(FLEET);
  });

  it('keeps the board order, so the longest-waiting event goes first', () => {
    // The board is read started_at ascending. The budget decides how many,
    // never which, and nothing here can see who is seated: horses are players.
    const picked = selectRunningResumes(board, pass());
    expect(picked.map((t) => t.id)).toEqual(
      board.slice(0, ENGINE_START_BUDGET_MAX).map((t) => t.id)
    );
  });

  it('counts resumes still in flight from earlier passes against the budget', () => {
    expect(selectRunningResumes(board, pass({ resumesInFlight: 20 }))).toHaveLength(
      ENGINE_START_BUDGET_MAX - 20
    );
    expect(selectRunningResumes(board, pass({ resumesInFlight: ENGINE_START_BUDGET_MAX }))).toEqual(
      []
    );
    expect(selectRunningResumes(board, pass({ resumesInFlight: 999 }))).toEqual([]);
  });

  it('an owned or already-admitting tournament spends no budget and is not relaunched', () => {
    const owned = new Set(['t-0000', 't-0002']);
    const admitting = new Set(['t-0001']);
    const picked = selectRunningResumes(
      board,
      pass({
        hasManager: (id) => owned.has(id),
        admissionInFlight: (id) => admitting.has(id),
        budget: 2,
      })
    );
    expect(picked.map((t) => t.id)).toEqual(['t-0003', 't-0004']);
  });

  it('a cooling-down tournament spends no budget either, and the order still holds', () => {
    const cooling = new Set(['t-0000', 't-0001', 't-0003']);
    const picked = selectRunningResumes(
      board,
      pass({ coolingDown: (id) => cooling.has(id), budget: 3 })
    );
    expect(picked.map((t) => t.id)).toEqual(['t-0002', 't-0004', 't-0005']);
  });

  it('the cooldown starts at five seconds and doubles to a five-minute cap', () => {
    expect(RESUME_COOLDOWN_FIRST_MS).toBe(5_000);
    expect(RESUME_COOLDOWN_CAP_MS).toBe(5 * 60_000);
    expect([1, 2, 3, 4, 5, 6, 7].map(resumeCooldownMs)).toEqual([
      5_000,
      10_000,
      20_000,
      40_000,
      80_000,
      160_000,
      RESUME_COOLDOWN_CAP_MS,
    ]);
    expect(resumeCooldownMs(1_000)).toBe(RESUME_COOLDOWN_CAP_MS);
    // Nonsense input is the first step, never zero and never negative.
    expect(resumeCooldownMs(0)).toBe(RESUME_COOLDOWN_FIRST_MS);
    expect(resumeCooldownMs(Number.NaN)).toBe(RESUME_COOLDOWN_FIRST_MS);
  });

  it('a streak ends when its id gets a manager or leaves the board, and not before', () => {
    const cooldowns = new RunningResumeCooldowns();
    expect(cooldowns.recordFailure('a', 0)).toBe(5_000);
    expect(cooldowns.recordFailure('a', 5_000)).toBe(10_000);
    expect(cooldowns.coolingDown('a', 14_999)).toBe(true);
    expect(cooldowns.coolingDown('a', 15_000)).toBe(false);
    cooldowns.recordFailure('b', 0);
    cooldowns.recordFailure('c', 0);
    cooldowns.recordFailure('d', 0);
    expect(cooldowns.size).toBe(4);

    // 'a' is still RUNNING and managerless: its streak (and its next, longer,
    // step) survive the board read. 'b' got a manager, 'c' left the board.
    cooldowns.settle([{ id: 'a' }, { id: 'b' }, { id: 'd' }], (id) => id === 'b');
    expect(cooldowns.size).toBe(2);
    expect(cooldowns.recordFailure('a', 15_000)).toBe(20_000);
    expect(cooldowns.coolingDown('b', 1)).toBe(false);
    expect(cooldowns.recordFailure('b', 1)).toBe(5_000);

    // A resume that leaves a manager ends the streak at once.
    cooldowns.forget('d');
    expect(cooldowns.coolingDown('d', 1)).toBe(false);
    expect(cooldowns.recordFailure('d', 1)).toBe(5_000);
  });

  it('a budget of events that cannot resume at the head of the board does not starve the tail', () => {
    // A resume that settles with no manager and no retry (resume_failed,
    // owned_elsewhere) leaves its id RUNNING and managerless. With no memory
    // of that, every pass handed the room to the same failing head and the
    // tail was never adopted. More than a budget of them, failing forever, at
    // the full budget and at the floor.
    const PASS_MS = 5_000;
    const PASS_LIMIT = 2_000;
    for (const budget of [ENGINE_START_BUDGET_MAX, ENGINE_START_BUDGET_MIN]) {
      const failing = new Set(board.slice(0, budget + 3).map((t) => t.id));
      const tail = FLEET - failing.size;
      const owned = new Set<string>();
      const cooldowns = new RunningResumeCooldowns();
      const launchedAt = new Map<string, number[]>();
      let previousTailRank = -1;
      let now = 0;
      let passes = 0;
      while (owned.size < tail && passes < PASS_LIMIT) {
        passes++;
        cooldowns.settle(board, (id) => owned.has(id));
        const picked = selectRunningResumes(
          board,
          pass({
            budget,
            hasManager: (id) => owned.has(id),
            coolingDown: (id) => cooldowns.coolingDown(id, now),
          })
        );
        // The budget is spent every pass: the room a cooling head leaves goes
        // to the next row, it is not left idle.
        if (owned.size + budget <= tail) expect(picked).toHaveLength(budget);
        for (const t of picked) {
          launchedAt.set(t.id, [...(launchedAt.get(t.id) ?? []), now]);
          if (failing.has(t.id)) {
            cooldowns.recordFailure(t.id, now);
            continue;
          }
          // Among the tail, still nobody younger before somebody older.
          const rank = Number(t.id.slice(2));
          expect(rank).toBeGreaterThan(previousTailRank);
          previousTailRank = rank;
          owned.add(t.id);
        }
        now += PASS_MS;
      }

      expect(owned.size, `the whole tail is adopted at budget ${budget}`).toBe(tail);
      for (const id of failing) {
        // The failing head is never dropped: it is tried again, each time
        // after a longer wait, up to the cap (a pass late at most, when the
        // rest of the head holds the room at that moment).
        const at = launchedAt.get(id) ?? [];
        expect(at.length).toBeGreaterThan(1);
        at.slice(1).forEach((launch, i) => {
          const gap = launch - at[i];
          expect(gap).toBeGreaterThanOrEqual(resumeCooldownMs(i + 1));
          expect(gap).toBeLessThanOrEqual(resumeCooldownMs(i + 1) + PASS_MS);
        });
      }
    }
  });

  it('the remainder is picked up by later passes, oldest first, and the fleet converges', () => {
    const owned = new Set<string>();
    let passes = 0;
    let previousNewest = -1;
    while (owned.size < FLEET) {
      passes++;
      const picked = selectRunningResumes(board, pass({ hasManager: (id) => owned.has(id) }));
      expect(picked.length).toBeGreaterThan(0);
      for (const t of picked) {
        const rank = Number(t.id.slice(2));
        // Nobody younger is adopted before somebody older.
        expect(rank).toBeGreaterThan(previousNewest);
        previousNewest = rank;
        owned.add(t.id);
      }
      expect(passes).toBeLessThanOrEqual(FLEET);
    }
    expect(passes).toBe(Math.ceil(FLEET / ENGINE_START_BUDGET_MAX));
  });

  it('under sustained lease loss the loop retreats to the floor and still converges', () => {
    // The storm's feedback: every pass sees managers losing their leases. The
    // law halves the budget, never below the floor, so the load a failing box
    // is asked to carry shrinks instead of being re-issued in full.
    let budget = ENGINE_START_BUDGET_MAX;
    const launched: number[] = [];
    for (let i = 0; i < 6; i++) {
      launched.push(selectRunningResumes(board, pass({ budget })).length);
      budget = nextEngineStartBudget(budget, true);
    }
    expect(launched[0]).toBe(ENGINE_START_BUDGET_MAX);
    expect(launched[launched.length - 1]).toBe(ENGINE_START_BUDGET_MIN);
    expect(Math.max(...launched)).toBeLessThan(FLEET);
    expect(Math.min(...launched)).toBeGreaterThan(0);
  });

  it('a wedged admission stops holding a slot after the horizon, never forever', () => {
    const now = 1_000_000;
    const fresh = now - 1_000;
    const wedged = now - RESUME_IN_FLIGHT_HORIZON_MS;
    expect(resumesHoldingASlot([fresh, fresh, wedged], now)).toBe(2);
    // A budget's worth of wedged admissions cannot stop every other resume.
    const allWedged = Array.from({ length: ENGINE_START_BUDGET_MAX }, () => wedged);
    expect(
      selectRunningResumes(board, pass({ resumesInFlight: resumesHoldingASlot(allWedged, now) }))
    ).toHaveLength(ENGINE_START_BUDGET_MAX);
  });
});

const SRC = readFileSync(resolve(__dirname, './GameServer.ts'), 'utf8');
/**
 * Since 2026-09-11 the re-adoption lives in its own lane. It was inside
 * discoverTournaments, whose pass walks every REGISTERING tournament and
 * awaits a horse top-up for each - minutes per pass on production - so a
 * budget applied once per pass let 25 resumes through every ~15 minutes.
 */
const LANE = sliceMethod(SRC, 'private async discoverRunningResumes(');
const LANE_CODE = blankNonCode(LANE);
const DISCOVERY_CODE = blankNonCode(sliceMethod(SRC, 'private async discoverTournaments('));
/** The re-adoption loop itself, by its own braces. */
const RESUME_LOOP = sliceEnclosingBlock(SRC, "'GameServer.Tournament_resume_failed_for_t'", 0, 1);

describe('the RUNNING re-adoption loop is wired to the law', () => {
  it('no longer launches an admission for every managerless RUNNING tournament', () => {
    expect(LANE_CODE).not.toContain('for (const tournament of running || [])');
    expect(LANE).toMatch(/selectRunningResumes\(\s*running \|\| \[\]/);
  });

  it('runs on its own five-second lane, never behind the REGISTERING walk', () => {
    // The whole re-adoption moved out of the big loop: no selection, no
    // verdict and no RUNNING board read are left in it.
    expect(DISCOVERY_CODE).not.toContain('selectRunningResumes(');
    expect(DISCOVERY_CODE).not.toContain('nextEngineStartBudget(');
    expect(DISCOVERY_CODE).not.toContain('tournamentResumeDistress');
    // Its own loop, joined by shutdown like every discovery loop, on the
    // discovery cadence.
    expect(LANE).toContain('while (this.directAdmissionIsCurrent(generation))');
    expect(LANE).toContain('await this.sleep(TOURNAMENT_DISCOVERY_INTERVAL)');
    const boot = sliceMethod(SRC, 'private async performStart(');
    expect(boot).toMatch(
      /this\.launchDiscoveryJob\(\s*this\.discoverRunningResumes\(\),\s*'GameServer\.Tournament_resume_lane_fatal_err'/
    );
  });

  it('selects against the budget, the in-flight resumes and the admission registry', () => {
    const selection = LANE.slice(LANE.indexOf('selectRunningResumes('));
    expect(selection).toContain('budget: this.tournamentResumeBudget');
    expect(selection).toContain(
      'resumesInFlight: resumesHoldingASlot(this.tournamentResumesInFlight'
    );
    // In flight includes a retry still waiting on its timer (2026-09-11):
    // reading only the operations map relaunched those ids ahead of the tail.
    expect(selection).toMatch(
      /admissionInFlight: \(id\) =>\s*this\.tournamentManagerAdmissionOperations\.has\(id\) \|\|\s*this\.tournamentManagerAdmissionRetryTimers\.has\(id\)/
    );
    expect(selection).toContain('hasManager: (id) => this.tournamentEngines.has(id)');
    expect(selection).toContain(
      'coolingDown: (id) => this.tournamentResumeCooldowns.coolingDown(id,'
    );
  });

  it('a resume that settles without a manager cools down; a manager or leaving the board ends it', () => {
    // Recorded in the finally, so a resume that threw cools down too.
    const settled = sliceEnclosingBlock(
      SRC,
      'this.tournamentResumeCooldowns.recordFailure(tournamentId, Date.now());',
      0,
      2
    );
    expect(settled).toContain(
      'if (this.tournamentResumesInFlight.get(tournamentId) === launchedAt)'
    );
    expect(settled).toMatch(
      /if \(this\.tournamentEngines\.has\(tournamentId\)\) \{\s*this\.tournamentResumeCooldowns\.forget\(tournamentId\);\s*\} else \{\s*this\.tournamentResumeCooldowns\.recordFailure\(tournamentId, Date\.now\(\)\);/
    );
    expect(RESUME_LOOP).toContain('.finally(() => {');
    // The streak ends only on a board that was actually read.
    const refusal = sliceEnclosingBlock(SRC, 'GameServer.running_board_read_failed');
    expect(refusal).not.toContain('this.tournamentResumeCooldowns.settle(');
    expect(LANE).toMatch(
      /\} else \{[^}]*this\.tournamentResumeCooldowns\.settle\(running \|\| \[\], \(id\) =>\s*this\.tournamentEngines\.has\(id\)/
    );
    // And the re-check after the stagger reads the same in-flight rule.
    expect(RESUME_LOOP).toContain('this.tournamentManagerAdmissionRetryTimers.has(tournamentId)');
  });

  it('staggers the launches and tracks every launched resume until it settles', () => {
    expect(RESUME_LOOP).toContain('await this.sleep(TOURNAMENT_RESUME_STAGGER_MS)');
    expect(RESUME_LOOP).toContain('this.tournamentResumesInFlight.set(tournamentId, launchedAt)');
    expect(RESUME_LOOP).toContain('this.tournamentResumesInFlight.delete(tournamentId)');
    expect(RESUME_LOOP).toContain('this.tournamentManagerAdmissionOperations.has(tournamentId)');
  });

  it('a failed or retried resume is distress for the next verdict', () => {
    expect(RESUME_LOOP).toContain('this.tournamentManagerAdmissionRetryTimers.has(tournamentId)');
    expect(RESUME_LOOP.match(/this\.tournamentResumeDistress\+\+/g) ?? []).toHaveLength(2);
  });

  it('a manager that lost its lease is distress; one that stood down on its own is not', () => {
    // 2026-09-11. This pin used to require `tournamentResumeDistress +=
    // lostManagers.length`: every manager the renewal pass retires, and a
    // finished tournament's manager is retired there, so each normal
    // completion was charged as a lost lease and halved the budget.
    const renewal = sliceMethod(SRC, 'private async performOwnedEngineLeaseProofRenewal(');
    const code = blankNonCode(renewal);
    expect(code).not.toContain('lostManagers.length');
    // Judged BEFORE the fence: the fence sets the expiry flag the judgment reads.
    const judged = code.indexOf('manager.stoodDownWithItsLeaseIntact()');
    const fenced = code.indexOf('manager.fenceForTournamentLeaseLoss()');
    expect(judged).toBeGreaterThan(-1);
    expect(fenced).toBeGreaterThan(judged);
    // Only a manager that did not stand down is reported and charged...
    expect(code).toMatch(
      /if \(!manager\.stoodDownWithItsLeaseIntact\(\)\) \{\s*reportError\([\s\S]*?\);\s*this\.tournamentResumeDistress\+\+;\s*\}/
    );
    expect(code.match(/this\.tournamentResumeDistress/g) ?? []).toHaveLength(1);
    // ...and each manager is judged once, however many passes it stays.
    expect(code).toMatch(
      /if \(!this\.tournamentManagersJudgedLost\.has\(manager\)\) \{\s*this\.tournamentManagersJudgedLost\.add\(manager\);/
    );
    // The judgment must not be able to fence what it judges.
    const accessor = blankNonCode(
      sliceMethod(
        readFileSync(resolve(__dirname, './tournament/TournamentManagerBase.ts'), 'utf8'),
        'stoodDownWithItsLeaseIntact(): boolean {'
      )
    );
    for (const sideEffect of [
      'hasCurrentTournamentLeaseAuthority(',
      'isRunning(',
      'lifecycleIsCurrent(',
      'expireTournamentLeaseAuthority(',
      'tournamentLeaseAuthorityIsCurrent(',
    ]) {
      expect(accessor).not.toContain(sideEffect);
    }
  });

  it('applies exactly one verdict per pass, in a finally, with the C20 law', () => {
    expect(LANE).toContain('const resumeDistressSinceLastPass = this.tournamentResumeDistress;');
    expect(LANE).toContain('this.tournamentResumeDistress = 0;');
    const verdict = sliceEnclosingBlock(
      SRC,
      'this.tournamentResumeBudget = nextEngineStartBudget('
    );
    expect(LANE).toMatch(
      /\}\s*finally\s*\{\s*this\.tournamentResumeBudget = nextEngineStartBudget\(\s*this\.tournamentResumeBudget,\s*resumePassDistressed\s*\)/
    );
    expect(verdict).toContain('resumePassDistressed');
    expect(LANE_CODE.match(/nextEngineStartBudget\(/g) ?? []).toHaveLength(1);
  });

  it('an unreadable board is distress, not a clean pass', () => {
    const refusal = sliceEnclosingBlock(SRC, 'GameServer.running_board_read_failed');
    expect(refusal).toContain('resumePassDistressed = true;');
  });
});
