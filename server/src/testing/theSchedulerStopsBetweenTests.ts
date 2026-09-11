/**
 * THE DEADLINE SCHEDULER STOPS BETWEEN TESTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `deadlineScheduler` (src/engine/DeadlineScheduler.ts) is one instance per
 * process, started by every PreciseActionTimer an engine constructs and never
 * stopped by anything in the engine, because in production nothing should
 * stop it. In this suite that meant one test's tick loop and one test's
 * pending deadlines outlived the test: `vi.clearAllTimers()` removed the
 * interval that vitest could see, the scheduler still believed it was
 * running, and the deadlines of a table the previous test had abandoned sat
 * in the heap under the same table id the next test would use.
 *
 * Until 2026-09-10 the loop was also REAL - the singleton had bound the real
 * `setInterval` and `Date.now` at import - so it ticked through every test's
 * fake clock at real 100ms intervals and fired every fake-clock deadline as
 * already past. That is the mechanism behind SeatFirstActualDeal.test.ts
 * folding the first actor through an "expired" time bank on a loaded CI
 * runner and passing in 29ms on an idle Mac.
 *
 * So: after every test, stop it. The tick loop is cleared under whatever
 * timers that test installed, the heap is emptied, and the next engine (or
 * the next `schedule()` on an engine built earlier) starts it again under
 * the timers of its own test. One line, applied to every file, so that no
 * file has to know the singleton exists.
 */
import { afterEach } from 'vitest';
import { deadlineScheduler } from '../engine/DeadlineScheduler.js';

afterEach(() => {
  deadlineScheduler.stop();
});
