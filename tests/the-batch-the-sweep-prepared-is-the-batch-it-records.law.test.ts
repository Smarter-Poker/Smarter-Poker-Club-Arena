/**
 * THE BATCH THE SWEEP PREPARED IS THE BATCH IT RECORDS (2026-09-27).
 *
 * Supersedes "a sweep that cannot afford its first mutation never makes one"
 * (2026-09-10). That law bought a starved bust pass ONE committed finish per
 * sweep and then yielded. Read on production 2026-09-27 22:44 UTC: the
 * process-wide elimination scheduler had 317 managers registered, 275 queued,
 * all four slots busy and an oldest wait of 333 s, so a large MTT was admitted
 * about every six minutes and each admission recorded exactly one bust.
 * Three freerolls (341, 347 and 309 entrants) accumulated 213, 96 and 100
 * busted players still `status='playing'` at 0 chips; every one of those rows
 * kept its roster chair, the balancer could place nobody, all 110 open tables
 * drained to one player each, and nothing dealt for hours.
 *
 * The rules pinned here:
 *   1. the work budget decides whether a bust pass may START recording, and
 *      nothing else: once the reads are paid for, the prepared, ordered batch
 *      (bounded by SWEEP_MUTATION_BATCH_SIZE) is recorded whole inside a batch
 *      window the clock cannot close; manager stop and the abort signal can;
 *   2. the window is opened by the bust assignment pass alone, closed with it
 *      in a finally, and reset at every sweep admission, so no other stage and
 *      no later sweep inherits it;
 *   3. a pass that ran past the budget says so once, with the backlog size;
 *   4. the movement admission of a parked table names the door's refusal
 *      instead of the bare label (CLAUDE.md 10.86 rule 1);
 *   5. a manager requests one sweep when it adopts an event - registering the
 *      scheduler only makes it wakeable, and the routine wake is a hand
 *      completing with a zero stack, which an event whose tables cannot deal
 *      will never produce.
 *
 * docs/changelog/2026-09-27-a-prepared-bust-batch-is-recorded.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceEnclosingBlock, sliceMethod, sliceStatement } from './helpers/sourceWindow';

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const BASE = read('server/src/tournament/TournamentManagerBase.ts');
const ELIM = read('server/src/tournament/TournamentManagerEliminations.ts');
const MANAGER = read('server/src/tournament/TournamentManager.ts');

describe('the batch the sweep prepared is the batch it records', () => {
  it('the batch window is the one thing that outranks the deadline, and only the deadline', () => {
    const allowed = sliceMethod(BASE, 'protected eliminationMutationAllowed()');
    expect(allowed).toContain('this.running &&');
    expect(allowed).toContain('!this.eliminationSweepSignal?.aborted &&');
    expect(allowed).toContain('this.eliminationMutationBatchOpen ||');
    expect(allowed).toContain('Date.now() < this.eliminationSweepDeadlineAt');
    // the budget check itself does not know about the window: the pass yields
    // after the batch exactly as every other stage does
    const expired = sliceMethod(BASE, 'protected eliminationWorkBudgetExpired()');
    expect(expired).not.toContain('eliminationMutationBatchOpen');
  });

  it('the bust assignment pass opens the window, records the batch in a try, and closes it in finally', () => {
    const open = ELIM.indexOf('this.openEliminationMutationBatch();');
    const loop = ELIM.indexOf('for (let i = 0; i < bustedOrdered.length; i++) {');
    const close = ELIM.indexOf('this.closeEliminationMutationBatch();', loop);
    expect(open).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(loop);
    const tryBlock = ELIM.slice(open, close + 'this.closeEliminationMutationBatch();'.length);
    expect(tryBlock).toMatch(/try \{\s*for \(let i = 0; i < bustedOrdered\.length; i\+\+\) \{/);
    expect(tryBlock).toMatch(/\} finally \{\s*this\.closeEliminationMutationBatch\(\);/);
    // the clock has no vote inside the loop; stop and abort still do
    const loopBody = ELIM.slice(loop, close);
    expect(loopBody).not.toContain('eliminationWorkBudgetExpired()');
    expect(loopBody).toContain('if (!this.running || signal.aborted) return;');
    // and the window is opened nowhere else
    expect(ELIM.match(/openEliminationMutationBatch\(\)/g)).toHaveLength(1);
    expect(MANAGER).not.toContain('openEliminationMutationBatch');
  });

  it('the window is reset with the deadline at every sweep admission', () => {
    const admission = sliceEnclosingBlock(ELIM, 'this.eliminationSweepDeadlineAt = Date.now()');
    expect(admission).toContain('this.closeEliminationMutationBatch();');
    expect(BASE).toContain('private eliminationMutationBatchOpen = false;');
  });

  it('a pass that ran past the budget says so once, with the backlog that caused it', () => {
    const report = sliceEnclosingBlock(ELIM, "'Tournament.bust_batch_recorded_past_budget'", 0, 2);
    expect(report).toContain('this.eliminationWorkBudgetExpired()');
    expect(report).toContain('${bustedOrdered.length} player(s) to record');
    expect(report).toContain('recorded whole before this sweep yields');
    // the old one-finish grace is gone, not renamed
    expect(BASE).not.toContain('SWEEP_MUTATION_GRACE_MS');
    expect(BASE).not.toContain('grantEliminationMutationGrace');
    expect(ELIM).not.toContain('bust_mutation_grace_granted');
  });

  it('a committed elimination is what counts as progress for the yield after the batch', () => {
    const committed = sliceStatement(ELIM, 'committedThisPass++');
    expect(committed).toBe('committedThisPass++;');
    const refusal = sliceEnclosingBlock(ELIM, 'this.bustRefusalStreak.set(');
    expect(refusal).not.toContain('committedThisPass++');
    const yieldAfter = sliceEnclosingBlock(
      ELIM,
      'committedThisPass > 0 && this.eliminationWorkBudgetExpired()'
    );
    expect(yieldAfter).toContain('requestUrgentEliminationSweepAfter');
  });

  it('the batch bound and the work budget are unchanged: the window widens nothing but the batch', () => {
    expect(BASE).toMatch(/static readonly SWEEP_WORK_BUDGET_MS = 5_000;/);
    expect(BASE).toMatch(/static readonly SWEEP_MUTATION_BATCH_SIZE = 20;/);
  });

  it('a parked table whose movement admission the door refuses hears the reason', () => {
    const admission = sliceEnclosingBlock(MANAGER, "supabase.rpc('fn_f06_admit_parked_movement'");
    expect(admission).toContain('f06_movement_admission_unproven [${String(error.code');
    expect(admission).toContain('${String(error.message ?? error)}');
    // the label is still the prefix, so nothing that matched it stops matching
    expect(admission).not.toMatch(/throw new Error\('f06_movement_admission_unproven'\)/);
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
});
