/**
 * LAW: a preparation that can never resolve is not a hand in the air, and
 *      nothing on the restart path may treat it as one.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT HAPPENED (2026-09-18 to 2026-09-21, 57 hours)
 * ---------------------------------------------------
 * Engine 8825af51 took one tournament hand permit that could never resolve
 * inside that process. Every layer above it then read "unresolved" as "a hand
 * may be in flight" and refused to restart:
 *
 *   - MaintenanceBreak counted the table as unparked, so readyForRestart
 *     stayed false;
 *   - engine-release-transaction.sh requires readyForRestart, so the cutover
 *     was refused;
 *   - and the cutover is the only thing that can replace the process holding
 *     the permit.
 *
 * Measured in engine_maintenance_break_log: 71 breaks under that engine, 70
 * with ready_for_restart_at NULL, unparked_at_countdown 1 at EVERY countdown,
 * while thaw_ok stayed true and ~158 tables resumed each time. Six lease-less
 * RUNNING tournaments, 49 seats and 4,908,000 tournament chips were frozen
 * behind it, the oldest since 2026-09-14.
 *
 * The permit that did it, read from the database on 2026-09-21: permit
 * 14cddb92 on table 9f30d335, hand 12943630, state aborted_unsettled - with
 * zero dispatch rows, zero hand snapshots and zero atomic commits. The hand
 * provably never started. There was nothing to protect, for 57 hours.
 *
 * THE THREE THINGS THIS PINS
 * --------------------------
 * 1. The engine tells the truth about a stopped generation. A stopped,
 *    terminal engine that has released process ownership is MORE parked than
 *    a running one, and parkForTournamentMove must not answer a blanket "no"
 *    for it. What makes that safe is that the answer still carries every
 *    conjunct proving no move can be in flight, and that the quarantine
 *    REPLAYS the pending move to a receipt rather than discarding it.
 *
 * 2. Both blocker classes share one bound. The per-engine class was bounded
 *    in #4909; the manager-retained class was left unbounded and is the one
 *    that held the platform. One definition, used by both.
 *
 * 3. The release gate asks whether a hand is in the AIR, from the database,
 *    and fails closed. "I could not tell" is its own outcome and refuses
 *    (CLAUDE.md 10.86 rule 1); an unreadable answer is never coerced into an
 *    empty one (rule 2); and there is no flag, variable or argument that
 *    turns a refusal into permission.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const ENGINE = read('server/src/engine/ServerTableEngineBase.ts');
const MANAGER = read('server/src/tournament/TournamentManager.ts');
const BREAK = read('server/src/maintenance/MaintenanceBreak.ts');
const TRANSACTION = read('server/scripts/engine-release-transaction.sh');
const INFLIGHT = read('server/scripts/engine-release-inflight-hands.py');
const GUARD = read('server/scripts/legacy-engine-checkpoint-guard.mjs');
const PUBLISHER = read('server/scripts/legacy-engine-checkpoint.mjs');

/**
 * The body of `async parkForTournamentMove(...)`, bounded by its own matching
 * brace - never by a byte count. A fixed window drifts off the code it guards
 * the moment a comment is added above it, in whichever direction is worse:
 * red for no reason, or green while watching nothing. See
 * tests/helpers/sourceWindow.ts.
 */
function parkForTournamentMoveBody(): string {
  const body = sliceMethod(ENGINE, 'async parkForTournamentMove(');
  expect(body).toContain('this.tournamentMovePauseOwners.add(ownerId)');
  return body;
}

describe('1. a stopped generation is answered truthfully, and no live move can be swallowed', () => {
  it('does not blanket-refuse a stopped engine', () => {
    const body = parkForTournamentMoveBody();
    // The exact regression: an unconditional refusal for !running. That is what
    // made manager shutdown unable to ever resolve its own pending set.
    expect(body).not.toMatch(/if\s*\(!this\.running\)\s*return\s+false\s*;/);
    expect(body).toContain('if (!this.running) {');
  });

  it('answers yes for a stopped generation only with every no-move-in-flight conjunct', () => {
    const body = parkForTournamentMoveBody();
    const stopped = body.slice(body.indexOf('if (!this.running) {'));
    // Each of these is a separate way a move could still be live. Dropping any
    // one of them is how this predicate would start swallowing a real move.
    for (const conjunct of [
      'this.claimedTournamentMovePauseOwners.has(ownerId)',
      'this.terminal',
      'this.hasReleasedProcessOwnership()',
      'this.tournamentMoveOperations.size === 0',
      '!this.hasSettlementInFlight()',
      'this.postHandTasksPromise === null',
    ]) {
      expect(stopped).toContain(conjunct);
    }
    // It must be a conjunction. A single `||` here would let one satisfied
    // clause stand in for all six.
    const predicate = stopped.slice(stopped.indexOf('return ('), stopped.indexOf(');'));
    expect(predicate).not.toContain('||');
  });

  it('the quarantine replays a pending move to a receipt and never just drops it', () => {
    const body = sliceMethod(MANAGER, 'protected resolveTournamentSeatMoveQuarantine(');
    // The UUID is forgotten ONLY after requestTournamentSeatMoveAtBoundary
    // returned a receipt. Any `delete` that is not downstream of that is a
    // move being discarded, which is the money risk this whole law guards.
    const replay = body.indexOf('await this.requestTournamentSeatMoveAtBoundary(');
    const forget = body.indexOf('this.pendingTournamentSeatMoveOutcomes.delete(requestId)');
    expect(replay).toBeGreaterThan(-1);
    expect(forget).toBeGreaterThan(replay);
    // A failed replay must refuse, not fall through to the delete.
    expect(body).toContain("reportError(error, 'Tournament.atomic_move_quarantine_unresolved'");
    // An unresolved pending set can never certify the manager as clean.
    expect(body).toContain('if (this.pendingTournamentSeatMoveOutcomes.size > 0) return false;');
  });
});

describe('2. both preparation blocker classes share one bound', () => {
  it('declares the bound once and uses it from both loops', () => {
    expect(BREAK).toContain('private f06PreparationHoldsGate(tableId: string): boolean {');
    expect(BREAK).toContain('MaintenanceBreak.F06_UNRESOLVED_GATE_MS');
    const uses = BREAK.match(/this\.f06PreparationHoldsGate\(tableId\)/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it('the manager-retained class is bounded, not counted unconditionally', () => {
    const loop = sliceMethod(
      BREAK,
      'for (const tableId of this.deps.retainedPreparationBlockers?.() ?? []) {'
    );
    // The regression: push + count with no bound, which is what held the gate
    // shut for 70 consecutive breaks.
    expect(loop).toContain('if (this.f06PreparationHoldsGate(tableId)) {');
    expect(loop).toContain("count('f06_preparation_stuck')");
    const unconditional = /\?\.\(\) \?\? \[\]\) \{\s*out\.push\(tableId\);/;
    expect(loop).not.toMatch(unconditional);
  });

  it('past the bound the table is still named and counted, just not blocking', () => {
    // Identification never stops (CLAUDE.md 10.5's distinction, applied here):
    // the stuck table keeps its reason, its counter and its /health field.
    expect(BREAK).toContain('f06StuckTables: this.f06StuckTableCount');
    expect(BREAK).toContain('breaksSinceRestartCertified: this.breaksSinceRestartCertified');
  });
});

describe('3. the release gate asks the database, and fails closed', () => {
  it('ships the in-flight reader and calls it from the certificate', () => {
    expect(
      statSync(join(ROOT, 'server/scripts/engine-release-inflight-hands.py')).mode & 0o111
    ).toBeGreaterThan(0);
    expect(TRANSACTION).toContain('INFLIGHT_HANDS="$CONTROL_DIR/engine-release-inflight-hands.py"');
    // 2026-09-21: this pinned `if "$INFLIGHT_HANDS" ...; then`, and that form
    // is exactly what folded a MISSING helper into "the felt is not quiet".
    // The helper was absent from the installed generation for five releases,
    // the shell answered 127, and the gate reported a database refusal that
    // had never happened. The pin moves to the case that keeps the helper's
    // three answers apart; the guarantee it protects is unchanged and is
    // asserted below (exactly one `return 0`, and it is the QUIET branch).
    expect(TRANSACTION).toContain('"$INFLIGHT_HANDS" --env-file "$ENV_FILE"');
    expect(TRANSACTION).toContain('case "$inflight_rc" in');
  });

  it('keeps the window, durability and budget predicates unchanged', () => {
    // Only the unparked component is relaxed. If any of these stop being
    // required, the gate is admitting a cutover outside a certified break.
    expect(TRANSACTION).toContain('m.get("phase")=="counting_down"');
    expect(TRANSACTION).toContain('m.get("durableConfirmed") is True');
    expect(TRANSACTION).toContain('if remaining<int(__import__("os").environ["MIN_BREAK_MS"]):');
    expect(TRANSACTION).toContain(
      'ok=(m.get("readyForRestart") is True and m.get("unparkedTables")==0)'
    );
  });

  it('admits ONLY preparation reasons, by allow-list, and never cards in the air', () => {
    expect(TRANSACTION).toContain(
      'PREPARATION_ONLY={"f06_preparation_unresolved","f06_preparation_stuck"}'
    );
    // An allow-list, so an unrecognised reason refuses. A deny-list would let
    // every reason a future engine invents through by default.
    expect(TRANSACTION).toContain(
      'if not isinstance(k,str) or k not in PREPARATION_ONLY: raise SystemExit(1)'
    );
    // Assert the SET ITSELF, not a slice of the file: the surrounding prose
    // names the excluded reasons on purpose, and a text search would match it.
    const literal = TRANSACTION.slice(
      TRANSACTION.indexOf('PREPARATION_ONLY={'),
      TRANSACTION.indexOf('}', TRANSACTION.indexOf('PREPARATION_ONLY={')) + 1
    );
    const admitted = [...literal.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]).sort();
    expect(admitted).toEqual(['f06_preparation_stuck', 'f06_preparation_unresolved']);
  });

  it("requires the engine's own hands-in-flight witness to be present and zero", () => {
    expect(TRANSACTION).toContain(
      'if not isinstance(hands,int) or isinstance(hands,bool) or hands!=0: raise SystemExit(1)'
    );
  });

  it('gives "could not tell" its own exit code, distinct from both answers', () => {
    expect(INFLIGHT).toContain('EXIT_QUIET = 0');
    expect(INFLIGHT).toContain('EXIT_HAND_IN_AIR = 1');
    expect(INFLIGHT).toContain('EXIT_UNKNOWN = 3');
    // The three must be distinct; UNKNOWN sharing a code with QUIET is the
    // exact failure CLAUDE.md 10.86 rule 1 was written about.
    const codes = ['EXIT_QUIET = 0', 'EXIT_HAND_IN_AIR = 1', 'EXIT_UNKNOWN = 3'];
    expect(new Set(codes.map((c) => c.split('= ')[1])).size).toBe(3);
  });

  it('never coerces an unreadable answer into an empty one', () => {
    // res.ok first, every time (CLAUDE.md 10.86 rule 2).
    expect(INFLIGHT).toContain('if response.status != 200:');
    expect(INFLIGHT).toContain('except HTTPError as exc:');
    expect(INFLIGHT).toContain('unknown(f"the database could not be reached: {exc}")');
    // A short read that filled its page is not "these are all of them".
    expect(INFLIGHT).toContain('if len(rows) >= ROW_LIMIT:');
    expect(INFLIGHT).toContain('if not isinstance(rows, list):');
    // A wrong project is unreadable, not empty.
    expect(INFLIGHT).toContain(
      'unknown("the engine environment does not point at the pinned project")'
    );
  });

  it('bounds freshness, because an incomplete snapshot alone is not a live hand', () => {
    // 2,553 incomplete snapshot rows existed on 2026-09-21, the oldest last
    // touched on 2026-08-22. Gating on existence would refuse for ever - the
    // same forever-block, one level up (CLAUDE.md 10.86 rule 4).
    expect(INFLIGHT).toContain('DEFAULT_MAX_AGE_SECONDS = 120');
    expect(INFLIGHT).toContain('"updated_at": f"gte.{since.isoformat()}"');
    expect(INFLIGHT).toContain('"is_complete": "eq.false"');
    expect(INFLIGHT).toContain('if not 30 <= args.max_age_seconds <= 600:');
  });

  it('has no bypass: nothing turns a refusal into permission', () => {
    // Not an env var, not a flag, not a --force. The whole point of the file
    // is that it cannot be talked out of a refusal by hand.
    expect(INFLIGHT).not.toMatch(/--force|--skip|ALLOW_|FORCE_|SKIP_|BYPASS/);
    // Scope to the admission block only - up to the close of the function.
    const from = TRANSACTION.indexOf('"$INFLIGHT_HANDS" --env-file');
    const admission = TRANSACTION.slice(from, TRANSACTION.indexOf('\n}', from));
    expect(admission).not.toMatch(/\|\|\s*true/);
    expect(admission).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE/);
    // The helper's own success is the only thing that proceeds; every other
    // path out of this block refuses.
    expect(admission).toContain('return 0');
    expect(admission).toContain('return 1');
    expect(admission.match(/return 0/g)).toHaveLength(1);
  });

  it('never prints or exports a credential', () => {
    expect(INFLIGHT).not.toMatch(/print\([^)]*service_key/);
    expect(INFLIGHT).not.toMatch(/print\([^)]*SERVICE_ROLE/);
    expect(INFLIGHT).toContain('PROJECT_HOST = "kuklfnapbkmacvwxktbh.supabase.co"');
    expect(INFLIGHT).toContain('class RefuseRedirects(HTTPRedirectHandler):');
  });
});

/**
 * 4. THE LEGACY CHECKPOINT CARRIED THE SAME UNBOUNDED REFUSAL (2026-09-23)
 * ------------------------------------------------------------------------
 * Section 3 bounded the health gate. The legacy checkpoint - which runs INSIDE
 * the engine process, after that gate has already certified the break - held
 * its own copy of the same fail-closed condition in two places, both unbounded:
 * `captureEngine` refused ANY retained F06 permit on ANY engine, and the final
 * readiness check asked the predecessor's own `readyForRestart()`, which on
 * 8825af51 has no bound at all. So the release still could not land, and the
 * fix for the wedge stayed behind the wedge. Run 35897820986 is the
 * measurement: `captureEngine.f06_custody_not_drained`, `retryAllowed:false`,
 * `stopped=true terminal=true banks=0 permitPhase=attempted`, with production
 * 190 commits and four days behind main.
 *
 * The rule is unchanged and is simply applied one more time: a hand that might
 * be in the air still refuses, from rows; only the case where waiting cannot
 * help is bounded; and what the release stepped over is NAMED.
 */
describe('4. the legacy checkpoint bounds the same condition, the same way', () => {
  const deferral = GUARD.slice(
    GUARD.indexOf('const deadEngineCustody = ('),
    GUARD.indexOf('const captureEngine = (')
  );
  const proof = GUARD.slice(
    GUARD.indexOf('async function proveUnresolvableCustody('),
    GUARD.indexOf('const restartHeldOnlyByProvenUnresolvableCustody = ()')
  );
  const readiness = GUARD.slice(
    GUARD.indexOf('const restartHeldOnlyByProvenUnresolvableCustody = ()'),
    GUARD.indexOf('// Prove, PER TABLE and from rows, that every deferred boundary generation')
  );

  it('the capture defers such a permit instead of refusing it for ever', () => {
    // The regression, in the exact form it held the platform: an unconditional
    // refusal for any permit at all.
    expect(GUARD).not.toContain(
      "require(engine.f06CurrentPermit === null &&\n          engine.f06RecoveryInFlight === false, 'f06_custody_not_drained');"
    );
    expect(GUARD).toContain('deadEngineCustody(tableId, engine)), ');
    expect(deferral).toContain('deferredUnresolvableCustody.set(tableId, permitPhaseOf(engine));');
  });

  it('only an engine that can never run again, and holds no bank, is deferred', () => {
    // Each of these is a separate way the permit could still be resolved in
    // this process, or a separate thing the engine could still be holding.
    for (const conjunct of [
      'engine.f06CurrentPermit === null ||',
      'engine.f06RecoveryInFlight !== false ||',
      'engine.running !== false ||',
      'engine.terminal !== true ||',
      'engine.handController !== null ||',
      'engine.timeBankEngine.playerBanks.size !== 0',
    ])
      expect(deferral).toContain(conjunct);
    // Unreadable is never "dead": it keeps the original refusal.
    expect(deferral).toContain('catch {');
    expect(deferral).toContain('return false;');
  });

  it('it asks the database per table, with the ONE predicate this file has', () => {
    expect(proof).toContain(".from('hand_state_snapshots')");
    expect(proof).toContain(".eq('is_complete', false)");
    expect(proof).toContain(".gte('updated_at', since)");
    expect(proof).toContain(".in('table_id', page)");
    // Shared with the boundary proof and with the in-flight reader. A second,
    // differently-tuned predicate for the same fact is how a gate ends up
    // disagreeing with itself.
    expect(proof).toContain('inflightWindowMs');
  });

  it('"could not tell" is its own outcome and it refuses', () => {
    expect(proof).toContain(
      "require(!error && Array.isArray(data) && data.length === 0,\n          'f06_custody_unresolvable_unproven');"
    );
    // The bound is a refusal, not a truncation that reads as "none found".
    expect(proof).toContain('.limit(page.length + 1);');
    expect(proof).toContain(
      "require(ids.length <= maxTables, 'f06_custody_unresolvable_unproven');"
    );
  });

  it('the proof runs before anything is written', () => {
    const proved = GUARD.indexOf('await proveUnresolvableCustody(checkAll);');
    expect(proved).toBeGreaterThan(-1);
    expect(proved).toBeLessThan(GUARD.indexOf("persistPresenceForRestart('parked')"));
    // And the deferral cannot be satisfied by anything other than that call.
    expect((GUARD.match(/deferredUnresolvableCustody/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("readiness asks the engine's own answer first, and only then the fallback", () => {
    expect(GUARD).toContain(
      'require(maintenance.readyForRestart() === true ||\n      restartHeldOnlyByProvenUnresolvableCustody()'
    );
  });

  it('the fallback admits ONLY preparation reasons, by the same allow-list', () => {
    expect(readiness).toContain(
      "if (name !== 'f06_preparation_unresolved' && name !== 'f06_preparation_stuck')"
    );
    // The same two reasons the release transaction admits, and no others.
    const admitted = [...readiness.matchAll(/'(f06_preparation_[a-z]+)'/g)].map((m) => m[1]).sort();
    expect([...new Set(admitted)]).toEqual(['f06_preparation_stuck', 'f06_preparation_unresolved']);
  });

  it('the fallback can only be satisfied by tables the rows PROVED quiet', () => {
    expect(readiness).toContain('provenUnresolvableCustody.has(tableId)');
    // A blocker the guard cannot put a table id to is COULD NOT TELL: the count
    // equality is what makes an unidentifiable blocker refuse instead of pass.
    expect(readiness).toContain('blockers.length === counted &&');
    expect(readiness).toContain('if (counted === 0) return false;');
    // A deferral is not a proof. Only the proven set may be read here.
    expect(readiness).not.toContain('deferredUnresolvableCustody');
  });

  /* The same three outcomes, in the other capture. `physical()` has carried
     this rule since #5020 and #5021; `captureEngine`, which walks every table
     `physical()` does not, demanded a flat zero, so the release cleared the
     permit refusal and stopped one require later on the same table with
     `boundary=1/false, permitPhase=attempted` (run 35927313976). */
  const boundary = GUARD.slice(
    GUARD.indexOf('const boundaryGenerationsAllowed = ('),
    GUARD.indexOf('const captureEngine = (')
  );

  it('the other capture no longer demands a flat zero boundary count', () => {
    const drain = GUARD.slice(
      GUARD.indexOf('require(engine.settlementInFlight instanceof Set &&'),
      GUARD.indexOf("'engine_work_not_drained');")
    );
    // The regression, in the exact form that stopped run 35927313976 one
    // require after the permit refusal it had just cleared. (`neverStarted`
    // keeps its own flat zero and is a different, narrower predicate, so this
    // is scoped to the drain require rather than to the whole file.)
    expect(drain).not.toContain('engine.terminalBoundaryPendingGenerations.size === 0');
    expect(drain).toContain(
      'engine.terminalBoundaryPendingGenerations.size <=\n          boundaryGenerationsAllowed(tableId, engine)'
    );
    // Every other conjunct of the drain proof is untouched.
    for (const conjunct of [
      'engine.settlementInFlight.size === 0 &&',
      'engine.postHandTasksPromise === null &&',
      'engine.actionLock === false &&',
      'engine.tournamentMoveOperations.size === 0 &&',
      'engine.terminalBoundaryPersistenceFailed === false',
    ])
      expect(drain).toContain(conjunct);
  });

  it('an attempted permit admits exactly one, and any other phase admits none', () => {
    expect(boundary).toContain("if (phase === 'attempted') return 1;");
    expect(boundary).toContain("if (phase !== 'none') return 0;");
  });

  it('with no permit it is deferred to the same row proof, never waved through', () => {
    expect(boundary).toContain('deferredUnresolvableCustody.set(tableId,');
  });

  it('the shape is proved before the count, and a live engine keeps its zero', () => {
    for (const conjunct of [
      'collection.size > maxEntriesPerTable ||',
      'Number.isSafeInteger(value) && value > 0',
      // A failed persistence is an allowance only through the dead-engine
      // deferral (section 5), never by itself.
      '(engine.terminalBoundaryPersistenceFailed !== false &&\n            !failedBoundaryOnDeadEngine(tableId, engine)) ||',
      'engine.running !== false ||',
      'engine.terminal !== true ||',
      'engine.handController !== null ||',
      'engine.f06RecoveryInFlight !== false ||',
      'engine.timeBankEngine.playerBanks.size !== 0',
    ])
      expect(boundary).toContain(conjunct);
    // Unreadable is never an allowance.
    expect(boundary).toContain('catch {');
    expect(boundary).toContain('return 0;');
  });

  it('has no bypass, and names what it stepped over', () => {
    const region = deferral + proof + readiness + boundary;
    expect(region).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE|allowUnresolved/);
    // The record of a refusal that did not happen still has to reach a reader.
    expect(GUARD).toContain('unresolvableCustody = `tables=${ids.length} ');
    expect(GUARD).toContain('...(unresolvableCustody === null ? {} : { unresolvableCustody }),');
    expect(PUBLISHER).toContain("'unresolvableCustody',");
  });
});

/* 5. A FAILED BOUNDARY ON AN ENGINE THAT WILL NEVER RUN AGAIN (2026-09-23).
   Every release was refused with `captureEngine.engine_work_not_drained` and
   `stopped=true,terminal=true,scope=tournament,seats=3,banks=0,f06=true/false,
   permitPhase=attempted,settling=0,postTasks=false,moves=0,boundary=0/true,
   accounting=0`. The only failing term was the flat
   `terminalBoundaryPersistenceFailed === false`, which build 8825af51 never
   clears on a stopped engine. The flag on a DEAD engine is now deferred to
   the same row proof; on anything else it refuses exactly as before. */
describe('5. a failed boundary on a dead engine is proved from rows, never waved through', () => {
  const helper = GUARD.slice(
    GUARD.indexOf('const failedBoundaryOnDeadEngine = ('),
    GUARD.indexOf('const boundaryGenerationsAllowed = (')
  );
  const drain = GUARD.slice(
    GUARD.indexOf('require(engine.settlementInFlight instanceof Set &&'),
    GUARD.indexOf("'engine_work_not_drained');") + "'engine_work_not_drained');".length
  );
  const physical = GUARD.slice(
    GUARD.indexOf('const physical = ('),
    GUARD.indexOf('const vector = (')
  );

  it('"dead" is the existing conjunction and nothing wider', () => {
    for (const conjunct of [
      'engine.terminalBoundaryPersistenceFailed !== true ||',
      'engine.running !== false ||',
      'engine.terminal !== true ||',
      'engine.handController !== null ||',
      'engine.f06RecoveryInFlight !== false ||',
      '!(engine.timeBankEngine?.playerBanks instanceof Map) ||',
      'engine.timeBankEngine.playerBanks.size !== 0',
    ])
      expect(helper).toContain(conjunct);
    // Unreadable is never dead.
    expect(helper).toContain('catch {');
    expect(helper).toContain('return false;');
  });

  it('the table is deferred to the same row proof, which runs before anything is written', () => {
    expect(helper).toContain('deferredUnresolvableCustody.set(tableId,');
    const proofAt = GUARD.indexOf('await proveUnresolvableCustody(checkAll);');
    expect(proofAt).toBeGreaterThan(0);
    expect(proofAt).toBeLessThan(GUARD.indexOf("stage = 'checkpoint';"));
  });

  it('the capture drain admits the flag only through that deferral', () => {
    expect(drain).toContain(
      '(engine.terminalBoundaryPersistenceFailed === false ||\n          failedBoundaryOnDeadEngine(tableId, engine))'
    );
    // Every other conjunct of the drain proof is untouched.
    for (const conjunct of [
      'engine.settlementInFlight.size === 0 &&',
      'engine.postHandTasksPromise === null &&',
      'engine.actionLock === false &&',
      'engine.tournamentMoveOperations.size === 0 &&',
    ])
      expect(drain).toContain(conjunct);
  });

  it('physical() applies the same rule, so the refusal does not move one check up', () => {
    expect(physical).toContain(
      'terminalBoundaryPersistenceFailed === true &&\n            failedBoundaryOnDeadEngine(tableId, engine)'
    );
    expect(physical).toContain(
      'terminalBoundaryPersistenceFailed === false || failedBoundaryDeferred,'
    );
    expect(physical).toContain(
      '(terminalBoundaryPersistenceFailed === false || failedBoundaryDeferred),'
    );
  });

  it('has no bypass', () => {
    expect(helper).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE|allowUnresolved|setTimeout|setInterval/);
  });
});
