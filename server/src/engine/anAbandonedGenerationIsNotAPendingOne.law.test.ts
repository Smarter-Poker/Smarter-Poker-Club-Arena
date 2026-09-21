/**
 * LAW: AN ABANDONED GENERATION IS NOT A PENDING ONE, AND IT IS PROVED FROM ROWS.
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-09-21. Every `auto-deploy-hetzner` run died on one line:
 *
 *   {"ok":false,"reason":"mixed_original_work_not_drained",
 *    "failedCheck":"engineCollection.size",
 *    "failedTable":"2c621856-e728-4e8b-bf08-4c56746a8649",
 *    "failedField":"terminalBoundaryPendingGenerations",
 *    "observed":"1","expected":"0"}
 *
 * `terminalBoundaryPendingGenerations` is an in-memory Set<number>. A number
 * is added by `beginTerminalBoundaryPersistence()` immediately before
 * `HandController.start()`, and removed at exactly three sites - one in
 * ServerTableEngineDealing (the hand never started) and two in
 * ServerTableEngineSettlement (post-hand tasks rejected; the authoritative
 * commit succeeded). ALL THREE ARE DOWNSTREAM OF `HAND_COMPLETE`.
 * `fenceTerminalEngine()` sets `handController = null` synchronously and never
 * touched the set, so after a fence no HAND_COMPLETE can dispatch, no resolver
 * can run, and the number was unreachable: the count said "pending" for ever
 * when the truth was "abandoned, and nothing will ever resolve me". That is
 * the CLAUDE.md 10.86 shape, and it held the cutover shut for 59 hours with 49
 * seats and 4,908,000 tournament chips frozen behind it.
 *
 * The rows said the same thing from the other side: table 2c621856 has ZERO
 * `hand_state_snapshots` rows, ever, and its three `f06_hand_permits` are
 * 12942021 `aborted_unsettled` with no dispatch and no commit (never started)
 * and 12941732 / 12859817 `accepted` with one `hand_history` row each (settled
 * durably). No hand was in the air, and none ever had been.
 *
 * THE FIX IS TWO HALVES AND EITHER ALONE IS A DEFECT.
 *
 *   A. The engine stops leaving an unresolvable generation behind. A THIRD
 *      named outcome - abandoned - distinct from success and from failure,
 *      carrying why. Deliberately NOT `finish(gen, false)`: that sets
 *      `terminalBoundaryPersistenceFailed`, which every reader checks ONE STEP
 *      EARLIER, so the deadlock would move up a line, and it asserts the
 *      boundary did not succeed, which is a fact not in evidence.
 *
 *   B. The release guard stops refusing on it for ever - WITHOUT waving it
 *      through. `physical()` is synchronous and cannot read a row, so it
 *      DEFERS the table and `proveAbandonedBoundaries` refuses the whole
 *      checkpoint unless the database proves the felt is quiet for each one,
 *      before `sealAndRetireOriginals` retires anything. Half A alone would
 *      let a fenced engine pass a drain check with NO ROW READ - the exact
 *      hazard this gate exists to prevent, and a route to voiding a live
 *      player's hand.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServerTableEngine } from './ServerTableEngine.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const read = (...parts: string[]): string => readFileSync(join(__dirname, ...parts), 'utf8');
const base = read('ServerTableEngineBase.ts');
const guard = read('..', '..', 'scripts', 'legacy-engine-checkpoint-guard.mjs');
const inflight = read('..', '..', 'scripts', 'engine-release-inflight-hands.py');

const engineFor = (suffix: string): any =>
  new ServerTableEngine(`00000000-0000-4000-8000-0000000000${suffix}`) as any;

describe('A. the engine names the third outcome instead of leaving a count nobody can clear', () => {
  it('a fence abandons the generation it just made unreachable', () => {
    const engine = engineFor('a1');
    const generation = engine.beginTerminalBoundaryPersistence();
    expect(engine.terminalBoundaryPendingGenerations.has(generation)).toBe(true);

    engine.killForRestartPublic('cash_lease_proof_expired');

    expect(engine.terminalBoundaryPendingGenerations.size).toBe(0);
    const abandoned = engine.abandonedTerminalBoundaries();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].generation).toBe(generation);
    // It carries WHY, and it names the fence that orphaned it.
    expect(abandoned[0].reason).toContain('engine_fenced:');
    expect(abandoned[0].atMs).toBeGreaterThan(0);
  });

  it('abandoning never asserts the boundary failed', () => {
    const engine = engineFor('a2');
    engine.beginTerminalBoundaryPersistence();
    engine.killForRestartPublic('dealing_loop_threw');
    // The guard checks this field one step EARLIER than the pending count. If
    // an abandonment set it, the deadlock would simply move up a line.
    expect(engine.terminalBoundaryPersistenceFailed).toBe(false);
  });

  it('a late failure is still a failure after the generation was abandoned', () => {
    const engine = engineFor('a3');
    const generation = engine.beginTerminalBoundaryPersistence();
    engine.killForRestartPublic('tournament_lease_proof_expired');
    expect(engine.terminalBoundaryPersistenceFailed).toBe(false);

    // postHandTasks was still writing at the fence and then rejected.
    engine.finishTerminalBoundaryPersistence(generation, false);
    expect(engine.terminalBoundaryPersistenceFailed).toBe(true);
    expect(engine.abandonedTerminalBoundaries()).toEqual([]);
  });

  it('a late success retires the abandonment rather than leaving a false record', () => {
    const engine = engineFor('a4');
    const generation = engine.beginTerminalBoundaryPersistence();
    engine.killForRestartPublic('dealing_loop_threw');
    engine.finishTerminalBoundaryPersistence(generation, true);
    expect(engine.abandonedTerminalBoundaries()).toEqual([]);
    expect(engine.terminalBoundaryPersistenceFailed).toBe(false);
  });

  it('an ordinary resolution is untouched: only a fence abandons', () => {
    const engine = engineFor('a5');
    const generation = engine.beginTerminalBoundaryPersistence();
    engine.finishTerminalBoundaryPersistence(generation, false);
    expect(engine.terminalBoundaryPersistenceFailed).toBe(true);
    expect(engine.terminalBoundaryPendingGenerations.size).toBe(0);
    expect(engine.abandonedTerminalBoundaries()).toEqual([]);
  });

  it('the abandonment sits at the line that makes the generation unreachable', () => {
    const fence = base.slice(
      base.indexOf('private fenceTerminalEngine('),
      base.indexOf('onRestartRequired(')
    );
    const lines = fence
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
    const controller = lines.indexOf('this.handController = null;');
    expect(controller).toBeGreaterThan(-1);
    // Immediately after - not somewhere later, and not in a caller that some
    // future fence path could forget to go through.
    expect(lines[controller + 1]).toContain('this.abandonTerminalBoundaryPersistence(');
    // Every fence path runs it: killForRestart delegates here, and so does the
    // startup-policy close.
    expect(base).toContain('this.fenceTerminalEngine(reason, notifyOwner);');
  });

  it('abandoned is a named outcome carrying a reason, not a second failure flag', () => {
    expect(base).toContain('protected terminalBoundaryAbandonedGenerations: Map<');
    const method = base.slice(
      base.indexOf('private abandonTerminalBoundaryPersistence('),
      base.indexOf('abandonedTerminalBoundaries()')
    );
    expect(method).toContain('this.terminalBoundaryPendingGenerations.delete(generation)');
    expect(method).toContain('reason,');
    expect(method).not.toContain('terminalBoundaryPersistenceFailed');
    expect(method).not.toContain('finishTerminalBoundaryPersistence');
  });
});

describe('B. the release guard defers the table and proves it from rows', () => {
  const physical = guard.slice(
    guard.indexOf('const physical = ('),
    guard.indexOf('const vector =')
  );
  const prove = guard.slice(
    guard.indexOf('async function proveAbandonedBoundaries('),
    guard.indexOf('async function sealAndRetireOriginals(')
  );

  it('a non-empty boundary set is deferred, never refused outright and never ignored', () => {
    expect(physical).toContain("name === 'terminalBoundaryPendingGenerations'");
    expect(physical).toContain('deferredAbandonedBoundaries.set(tableId,');
    // Every other collection keeps the exact original zero-size refusal. #5011
    // rewrote that one line as `size <= allowed` so the guard could admit ONE
    // entry on THIS field for an engine that still holds the interrupted hand's
    // undischarged permit. For every other field `allowed` is 0, `size <= 0` is
    // `size === 0`, and the reported `expected` is still '0' - so the guarantee
    // this law was written for is unchanged and only its wording moved.
    expect(physical).toContain(
      "const allowed = name === 'terminalBoundaryPendingGenerations' && interrupted ? 1 : 0;"
    );
    expect(physical).toContain(
      "drained(size <= allowed, 'engineCollection.size', size, String(allowed), () => ({"
    );
  });

  it('the deferral and the interrupted-hand allowance are disjoint', () => {
    // THE PERMIT SEPARATES THEM. #5021 defers only when there is no outstanding
    // hand at all; #5011 admits one entry only when the engine still holds that
    // hand's permit in {unknown,reserved,terminated}. A permit in any other
    // phase - `attempted` above all - is a hand that MAY HAVE STARTED, and it
    // must keep #5011's refusal (`expected` 0, before any row read and before
    // any RPC) rather than being softened into a deferral.
    expect(physical).toContain("name === 'terminalBoundaryPendingGenerations' && permit === null");
    expect(physical).toContain(
      "permit !== null && ['unknown', 'reserved', 'terminated'].includes(capture.phase)"
    );
  });

  it('the deferral is gated on the engine being fenced and fully drained', () => {
    const deferral = physical.slice(
      physical.indexOf("name === 'terminalBoundaryPendingGenerations'"),
      physical.indexOf("'engineCollection.abandonedShape'")
    );
    for (const conjunct of [
      'running === false',
      'terminal === true',
      'terminalTeardownComplete === true',
      'releasedProcessOwnership === true',
      'handController === null',
      'dealingLoopPromise === null',
      'postHandTasksPromise === null',
      'snapshotFlushPromise === null',
      'f06HandPreparation === null',
      'f06RecoveryInFlight === false',
      'terminalBoundaryPersistenceFailed === false',
    ])
      expect(deferral).toContain(conjunct);
    // Shape, not just emptiness: a set holding anything but positive integers,
    // or more of them than a table can hold, is refused without a row read.
    expect(deferral).toContain('Number.isSafeInteger(value) && value > 0');
    expect(deferral).toContain('size <= maxEntriesPerTable');
  });

  it('a boundary that moves between observations refuses', () => {
    expect(physical).toContain("'engineCollection.abandonedChanged'");
    expect(physical).toContain('previous === undefined || previous.signature === signature');
  });

  it('the proof runs before anything is retired or any custody is transferred', () => {
    const order = guard.indexOf('await proveAbandonedBoundaries(checkAll);');
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(guard.indexOf('await sealAndRetireOriginals(checkAll);'));
    // And the deferral cannot be satisfied by anything other than that call.
    expect(guard.match(/deferredAbandonedBoundaries/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('it asks the database per table, with the exact predicate the release gate uses', () => {
    expect(prove).toContain(".from('hand_state_snapshots')");
    expect(prove).toContain(".eq('is_complete', false)");
    expect(prove).toContain(".gte('updated_at', since)");
    expect(prove).toContain(".in('table_id', page)");
  });

  it('ONE definition of "a hand is in the air", shared with the in-flight reader', () => {
    const windowMs = guard.match(/const inflightWindowMs = (\d+);/);
    const seconds = inflight.match(/DEFAULT_MAX_AGE_SECONDS = (\d+)/);
    expect(windowMs).not.toBeNull();
    expect(seconds).not.toBeNull();
    // A second, differently-tuned predicate for the same fact is how a gate
    // ends up disagreeing with itself. Move them together or not at all.
    expect(Number(windowMs![1])).toBe(Number(seconds![1]) * 1000);
  });

  it('"could not tell" is its own outcome and it refuses', () => {
    expect(prove).toContain('require(!error && Array.isArray(data) && data.length === 0,');
    expect(prove).toContain("'mixed_abandoned_generation_unproven'");
    // The bound is a refusal, not a truncation that reads as "none found".
    expect(prove).toContain(
      "require(ids.length <= maxTables, 'mixed_abandoned_generation_unproven')"
    );
  });

  it('has no bypass: nothing turns this refusal into permission', () => {
    expect(prove).not.toMatch(/process\.env|options\.(?!expected)|allow|force|skip|override/);
    // The fleet fence is re-checked on both sides of the read.
    expect(prove.match(/checkAll\(\);/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
