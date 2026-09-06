// ---------------------------------------------------------------------------
// THE WAIT BUDGET, AND THE CEILING IT HAS TO FIT UNDER.
//
// WHY THIS FILE EXISTS (measured 2026-09-06, PR #3272).
//
// The server suite went red on one test out of 6,192:
//
//   FAIL src/engine/RunItTwice.multiway.test.ts
//     > decline -> the pot runs ONCE (full flow through the real wait)
//     > a declined offer continues the runout to a single-board completion
//   Error: Test timed out in 10000ms.
//
// It passed locally, twice, including with the Supabase env stripped and
// CI=true. It was not reproducible because it is not a logic bug - it is a
// budget that was set exactly equal to the ceiling it lives under.
//
// THE SHAPE OF THE BUG. Two tests wait on real wall-clock for an engine event,
// each polling against its own deadline:
//
//   const deadline = Date.now() + 10_000;          // RunItTwice.multiway
//   async function waitFor(ready, timeoutMs = 10_000)  // InsuranceRitExclusivity
//
// and `vitest.config.ts` carried `testTimeout: 10_000`. THE SAME NUMBER. So the
// internal deadline can never be reached: vitest kills the test at the exact
// moment the loop would have given up, the `expect(...).toBeDefined()` that was
// supposed to explain the failure never runs, and what CI prints instead is
// "Test timed out in 10000ms" - which names no cause and sends the next agent
// looking for a logic bug that is not there.
//
// Both waits were themselves de-flake fixes, and both were RIGHT to replace a
// fixed `setTimeout` with a conditional wait. Each author then picked 10_000 as
// the budget because that is what the ceiling was. The wait became robust; the
// headroom became zero.
//
// WHY 10s WAS NEVER ENOUGH ANYWAY. The CI boxes run 18 runners on 16 cores
// (CLAUDE.md 1.1.7), and the same run that failed shows what that does:
//
//   SeededRandom > next() stays within [0, 1)            3,045ms   (pure arithmetic)
//   HorseLogic V2 - legality fuzz                       68,697ms
//   Duration 189.87s  (collect 847.74s, tests 1060.39s)  ~10x oversubscribed
//
// InsuranceRitExclusivity's own header records a `sleep(400)` that took
// 30,675ms on this hardware - a 76x stretch. A 10-second budget under a
// 10-second ceiling on that box is not a flake, it is a scheduled failure.
//
// THE RULE. The budget a test waits for and the ceiling vitest enforces are ONE
// definition each, they live here, and the budget is strictly smaller. The gap
// is what lets an exhausted wait throw its own diagnostic instead of dying
// anonymously. `theWaitBudgetFitsUnderTheCeiling.law.test.ts` holds them apart.
//
// CLAUDE.md 1.1.7: a number tuned to hardware and written down as a constant
// outlives the hardware. These two are allowed to be constants only because
// the law pins their RELATIONSHIP, which is the part that actually matters.
// ---------------------------------------------------------------------------

/**
 * The ceiling. `vitest.config.ts` imports this - do not restate the number
 * there, or the two drift and the gap below silently closes again.
 */
export const TEST_TIMEOUT_MS = 30_000;

/**
 * What a wall-clock wait may spend. Strictly less than TEST_TIMEOUT_MS so an
 * exhausted wait still gets to run its assertion and say what was missing.
 */
export const WAIT_BUDGET_MS = 20_000;

/** How often a wait re-checks. Small enough to be invisible when it passes. */
export const WAIT_POLL_MS = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `ready()` is true, or the budget is spent.
 *
 * Throws with a diagnostic rather than returning quietly, because the whole
 * reason this file exists is that a wait which gives up silently leaves the
 * caller's `expect()` to report a symptom instead of the cause. `describe`
 * should say what you were waiting for, in words the next reader can act on.
 */
export async function waitFor(
  ready: () => boolean,
  describe: string,
  budgetMs: number = WAIT_BUDGET_MS
): Promise<void> {
  const started = Date.now();
  const deadline = started + budgetMs;
  while (!ready() && Date.now() < deadline) await sleep(WAIT_POLL_MS);
  if (!ready()) {
    throw new Error(
      `waitFor gave up after ${Date.now() - started}ms waiting for: ${describe}. ` +
        `Budget ${budgetMs}ms, ceiling ${TEST_TIMEOUT_MS}ms. ` +
        'A wait that spends its whole budget on a loaded runner is usually the ' +
        'runner, not the code - check the suite duration before hunting logic.'
    );
  }
}

/**
 * The event-list flavour, which is what the engine tests actually need. On
 * exhaustion it names what DID arrive, so one CI read is enough to tell "the
 * event never fired" from "the event fired but late".
 */
export async function waitForEvent<T extends { type: string }>(
  events: readonly T[],
  type: string,
  budgetMs: number = WAIT_BUDGET_MS
): Promise<T> {
  const started = Date.now();
  const deadline = started + budgetMs;
  let found = events.find((e) => e.type === type);
  while (!found && Date.now() < deadline) {
    await sleep(WAIT_POLL_MS);
    found = events.find((e) => e.type === type);
  }
  if (!found) {
    const seen = [...new Set(events.map((e) => e.type))];
    throw new Error(
      `waited ${Date.now() - started}ms for a "${type}" event that never arrived. ` +
        `Budget ${budgetMs}ms, ceiling ${TEST_TIMEOUT_MS}ms. ` +
        `${events.length} event(s) did arrive: ${seen.join(', ') || '(none at all)'}.`
    );
  }
  return found;
}
