/**
 * A SWEEP THAT CANNOT AFFORD ITS FIRST MUTATION NEVER MAKES ONE (2026-09-10).
 *
 * The elimination sweep runs under a five-second work budget. On a large
 * backlog the READS that prepare a bust batch can spend all of it, and every
 * mutation below them asks `eliminationMutationAllowed()`, which is false once
 * the budget is gone: `eliminatePlayer` refused silently, the pass aborted as
 * though the database had said no, the durable wake was never acknowledged,
 * and the next sweep repeated the same reads on the same backlog. Fifteen
 * tournaments sat in that livelock for up to 100 minutes.
 *
 * Two rules, both pinned here:
 *   1. a sweep that has committed NOTHING may extend its deadline once, only
 *      in the bust assignment pass, and it says so out loud;
 *   2. a manager requests one sweep when it adopts an event - registering the
 *      scheduler only makes it wakeable, and the routine wake is a hand
 *      completing with a zero stack, which an event whose tables cannot deal
 *      will never produce.
 *
 * docs/changelog/2026-09-10-a-sweep-that-cannot-afford-its-first-mutation.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceEnclosingBlock, sliceMethod, sliceStatement } from './helpers/sourceWindow';

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const BASE = read('server/src/tournament/TournamentManagerBase.ts');
const ELIM = read('server/src/tournament/TournamentManagerEliminations.ts');

describe('a sweep that cannot afford its first mutation', () => {
  it('the grace is one bounded extension, granted at most once per sweep', () => {
    expect(BASE).toMatch(/static readonly SWEEP_MUTATION_GRACE_MS = 5_000;/);
    const grant = sliceMethod(BASE, 'protected grantEliminationMutationGrace()');
    expect(grant).toContain('if (this.eliminationMutationGraceGranted) return false;');
    expect(grant).toContain('this.eliminationMutationGraceGranted = true;');
    expect(grant).toContain('TournamentManagerBase.SWEEP_MUTATION_GRACE_MS');
  });

  it('the grace flag is cleared with the deadline it extends, never carried between sweeps', () => {
    const admission = sliceEnclosingBlock(ELIM, 'this.eliminationSweepDeadlineAt = Date.now()');
    expect(admission).toContain('this.eliminationMutationGraceGranted = false;');
  });

  it('the bust pass yields when it has committed something and extends only when it has not', () => {
    const guard = sliceEnclosingBlock(ELIM, 'this.grantEliminationMutationGrace()', 0, 2);
    expect(guard).toContain('committedThisPass > 0 || !this.grantEliminationMutationGrace()');
    expect(guard).toContain('requestUrgentEliminationSweepAfter');
    // an extended budget is a measurement about the work, not something to swallow
    expect(guard).toContain("'Tournament.bust_mutation_grace_granted'");
  });

  it('a committed elimination is what counts as progress for that rule', () => {
    // the counter advances only after the door accepted the finish, so it sits
    // beside the streak reset and never inside the refusal branch
    const committed = sliceStatement(ELIM, 'committedThisPass++');
    expect(committed).toBe('committedThisPass++;');
    const refusal = sliceEnclosingBlock(ELIM, 'this.bustRefusalStreak.set(');
    expect(refusal).not.toContain('committedThisPass++');
  });

  it('a manager requests one sweep when it adopts the event, on start and on resume', () => {
    expect(BASE).toContain("this.requestEliminationSweep('engine.start');");
    expect(BASE).toContain("this.requestEliminationSweep('engine.resume');");
    // and the request comes after the scheduler exists, or it wakes nothing
    const startIdx = BASE.indexOf('this.startEliminationChecker();');
    const wakeIdx = BASE.indexOf("this.requestEliminationSweep('engine.start');");
    expect(startIdx).toBeGreaterThan(-1);
    expect(wakeIdx).toBeGreaterThan(startIdx);
    const resumeChecker = BASE.lastIndexOf('this.startEliminationChecker();');
    const resumeWake = BASE.indexOf("this.requestEliminationSweep('engine.resume');");
    expect(resumeWake).toBeGreaterThan(resumeChecker);
  });

  it('the work budget itself is unchanged - the grace is an extension, not a new ceiling', () => {
    expect(BASE).toMatch(/static readonly SWEEP_WORK_BUDGET_MS = 5_000;/);
    expect(BASE).toMatch(/static readonly SWEEP_MUTATION_BATCH_SIZE = 20;/);
  });
});
