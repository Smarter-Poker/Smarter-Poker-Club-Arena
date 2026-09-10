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
  RESUME_IN_FLIGHT_HORIZON_MS,
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
const DISCOVERY = sliceMethod(SRC, 'private async discoverTournaments(');
const DISCOVERY_CODE = blankNonCode(DISCOVERY);
/** The re-adoption loop itself, by its own braces. */
const RESUME_LOOP = sliceEnclosingBlock(SRC, "'GameServer.Tournament_resume_failed_for_t'", 0, 1);

describe('the RUNNING re-adoption loop is wired to the law', () => {
  it('no longer launches an admission for every managerless RUNNING tournament', () => {
    expect(DISCOVERY_CODE).not.toContain('for (const tournament of running || [])');
    expect(DISCOVERY).toMatch(/selectRunningResumes\(\s*running \|\| \[\]/);
  });

  it('selects against the budget, the in-flight resumes and the admission registry', () => {
    const selection = DISCOVERY.slice(DISCOVERY.indexOf('selectRunningResumes('));
    expect(selection).toContain('budget: this.tournamentResumeBudget');
    expect(selection).toContain(
      'resumesInFlight: resumesHoldingASlot(this.tournamentResumesInFlight'
    );
    expect(selection).toContain(
      'admissionInFlight: (id) => this.tournamentManagerAdmissionOperations.has(id)'
    );
    expect(selection).toContain('hasManager: (id) => this.tournamentEngines.has(id)');
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

  it('a manager that lost or outlived its lease is distress too', () => {
    const renewal = sliceMethod(SRC, 'private async performOwnedEngineLeaseProofRenewal(');
    expect(renewal).toContain('this.tournamentResumeDistress += lostManagers.length');
  });

  it('applies exactly one verdict per pass, in a finally, with the C20 law', () => {
    expect(DISCOVERY).toContain(
      'const resumeDistressSinceLastPass = this.tournamentResumeDistress;'
    );
    expect(DISCOVERY).toContain('this.tournamentResumeDistress = 0;');
    const verdict = sliceEnclosingBlock(
      SRC,
      'this.tournamentResumeBudget = nextEngineStartBudget('
    );
    expect(DISCOVERY).toMatch(
      /\}\s*finally\s*\{\s*this\.tournamentResumeBudget = nextEngineStartBudget\(\s*this\.tournamentResumeBudget,\s*resumePassDistressed\s*\)/
    );
    expect(verdict).toContain('resumePassDistressed');
    expect(DISCOVERY_CODE.match(/nextEngineStartBudget\(/g) ?? []).toHaveLength(1);
  });

  it('an unreadable board is distress, not a clean pass', () => {
    const refusal = sliceEnclosingBlock(SRC, 'GameServer.running_board_read_failed');
    expect(refusal).toContain('resumePassDistressed = true;');
  });
});
