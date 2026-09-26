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

  it('admits ONLY bounded reasons, by allow-list, and never cards in the air', () => {
    // 2026-09-25: the set gained the bounded stopped-bank class and was renamed
    // to say what it now holds. Both preparation reasons are still in it; the
    // raw stopped-bank reason is NOT (see the law test named for that day).
    expect(TRANSACTION).toContain(
      'BOUNDED_ONLY={"f06_preparation_unresolved","f06_preparation_stuck"}'
    );
    // An allow-list, so an unrecognised reason refuses. A deny-list would let
    // every reason a future engine invents through by default.
    expect(TRANSACTION).toContain('if not isinstance(k,str): raise SystemExit(1)');
    expect(TRANSACTION).toContain('if k not in BOUNDED_ONLY: raise SystemExit(1)');
    // Assert the SET ITSELF, not a slice of the file: the surrounding prose
    // names the excluded reasons on purpose, and a text search would match it.
    const literal = TRANSACTION.slice(
      TRANSACTION.indexOf('BOUNDED_ONLY={'),
      TRANSACTION.indexOf('}', TRANSACTION.indexOf('BOUNDED_ONLY={')) + 1
    );
    const admitted = [...literal.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]).sort();
    // 2026-09-26 (#5267): stopped_bank_custody_stuck left the set again; past
    // its bound it is a bank still not on disk, and it refuses.
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
      'engine.terminalBoundaryPersistenceFailed !== false ||',
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

/* A STICKY "DID NOT SUCCEED" ON A PROCESS THAT IS ALREADY DEAD (2026-09-24).

   Run 35956154940 cleared the boundary-count refusal #5155 bounded and then
   stopped on the LAST conjunct of the same proof, on table 6557ebd8, with
   `boundary=0/true, permitPhase=attempted`: an EMPTY pending set and a set
   `terminalBoundaryPersistenceFailed`. That flag is cleared only by
   `beginTerminalBoundaryPersistence`, which runs immediately before
   `HandController.start`, so a stopped terminal engine can never reach it and
   the refusal blocks the process replacement that is its only resolution. */
describe('a flag a dead process can never clear is answered from rows', () => {
  const sticky = GUARD.slice(
    GUARD.indexOf('const deadBoundaryFailureDeferred = ('),
    GUARD.indexOf('const captureEngine = (')
  );

  it('the drain proof no longer ends on a flat sticky flag', () => {
    const drain = GUARD.slice(
      GUARD.indexOf('require(engine.settlementInFlight instanceof Set &&'),
      GUARD.indexOf("'engine_work_not_drained');")
    );
    expect(drain).toContain(
      '(engine.terminalBoundaryPersistenceFailed === false ||\n          deadBoundaryFailureDeferred(tableId, engine))'
    );
  });

  it('only a resolved failure on a fenced, drained, bank-free engine is deferred', () => {
    for (const conjunct of [
      'engine.terminalBoundaryPersistenceFailed !== true ||',
      'engine.terminalBoundaryPendingGenerations.size !== 0 ||',
      'engine.running !== false ||',
      'engine.terminal !== true ||',
      'engine.handController !== null ||',
      'engine.f06RecoveryInFlight !== false ||',
      'engine.postHandTasksPromise !== null ||',
      'engine.settlementInFlight.size !== 0 ||',
      'engine.timeBankEngine.playerBanks.size !== 0',
    ])
      expect(sticky).toContain(conjunct);
    // A permit in a phase this guard cannot reason from is an engine we do not
    // understand, and it refuses rather than deferring.
    expect(sticky).toContain("if (phase !== 'attempted' && phase !== 'none') return false;");
    // Unreadable is never "dead".
    expect(sticky).toContain('catch {');
    expect(sticky).toContain('return false;');
  });

  it('a deferral is never a waiver: the same row proof answers for it', () => {
    expect(sticky).toContain('deferredUnresolvableCustody.set(tableId, `failedBoundary:${phase}`)');
    expect(sticky).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE|allowUnresolved/);
  });

  it('a still-pending generation keeps refusing one conjunct earlier, with no row read', () => {
    const boundary = GUARD.slice(
      GUARD.indexOf('const boundaryGenerationsAllowed = ('),
      GUARD.indexOf('const deadBoundaryFailureDeferred = (')
    );
    expect(boundary).toContain('engine.terminalBoundaryPersistenceFailed !== false ||');
  });

  it('the capture walk finishes, so one refused release names the whole set', () => {
    // The release only ever named the table that refused FIRST, so a fleet
    // holding several shapes cost one maintenance break per shape to read.
    expect(GUARD).toContain('noteCensus(tableId, code);');
    expect(GUARD).toContain('...(refusalCensus === null ? {} : { refusalCensus }),');
    expect(PUBLISHER).toContain("'refusalCensus',");
    const walk = GUARD.slice(
      GUARD.indexOf('for (const [id, engine] of entries) {'),
      GUARD.indexOf('const checkEngine = (captured) => {')
    );
    // The walk is observation only. It still refuses, and it still refuses
    // before anything downstream of it can capture, prove or write.
    expect(walk).toContain("if (reason !== null) throw new Error('legacy_checkpoint_refused');");
    expect(walk).toContain('if (reason === null) captures.push(captured);');
    expect(walk).toContain('if (reason === null) throw error;');
    expect(walk).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE|allowUnresolved/);
  });

  it('an engine_work_not_drained refusal now names every field it turns on', () => {
    const detail = GUARD.slice(
      GUARD.indexOf('const engineRefusalDetail = ('),
      GUARD.indexOf('const deadEngineCustody = (')
    );
    for (const term of [
      '`settling=${sizeOf(engine?.settlementInFlight)}`',
      '`postTasks=${engine?.postHandTasksPromise != null}`',
      '`moves=${sizeOf(engine?.tournamentMoveOperations)}`',
      '`actionLock=${engine?.actionLock === true}`',
    ])
      expect(detail).toContain(term);
  });
});

/* A RESTORED BANK NO ROSTER WILL EVER CLAIM (2026-09-24).

   Run 36000655625 refused `captureEngine.parked_bank_invalid` on b027e4cf with
   `stopped=true terminal=true seats=0 banks=0 meta=0 parked=2`. `parkedTimeBanks`
   is filled once by `readParkedTimeBanks` inside `start()` and emptied only by
   `applyParkedTimeBanks`, whose one caller is `adoptSeatRoster` in the
   wait-for-players loop, so a stopped terminal engine holds those banks for ever
   and the refusal blocks the process replacement that is its only resolution. */
describe('a restored bank no roster will ever claim is answered from rows', () => {
  const parked = GUARD.slice(
    GUARD.indexOf('const deadParkedBanksDeferred = ('),
    GUARD.indexOf('const captureEngine = (')
  );

  it('the parked-bank proof keeps both shape conjuncts and bounds only the last', () => {
    const loop = GUARD.slice(
      GUARD.indexOf('for (const [userId, bank] of Object.entries(engine.parkedTimeBanks)) {'),
      GUARD.indexOf("'parked_bank_invalid');")
    );
    // A key that is not a user id, or a bank that is not restorable, still
    // refuses on every engine. Only the occupancy equality is bounded.
    expect(loop).toContain('uuid(userId) &&');
    expect(loop).toContain('validBank(bank) &&');
    expect(loop).toContain(
      '(seats.get(userId)?.occupancy_id === bank.occupancyId ||\n            deadParkedBanksDeferred(tableId, engine))'
    );
  });

  it('only an engine that can never adopt a roster, holding nothing live, is deferred', () => {
    // Each of these is a separate way the bank could still be claimed in this
    // process, or a separate thing the engine could still be holding.
    for (const conjunct of [
      'engine.running !== false ||',
      'engine.terminal !== true ||',
      'engine.f06RecoveryInFlight !== false ||',
      'engine.seatedPlayers.length !== 0 ||',
      'engine.timeBankEngine.playerBanks.size !== 0 ||',
      'engine.timeBankMeta.size !== 0 ||',
      'Object.keys(engine.parkedTimeBanks).length > maxEntriesPerTable',
    ])
      expect(parked).toContain(conjunct);
    // Unreadable is never "dead".
    expect(parked).toContain('catch {');
    expect(parked).toContain('return false;');
  });

  it('a deferral is never a waiver: the same row proof answers for it', () => {
    expect(parked).toContain('deferredUnresolvableCustody.set(');
    expect(parked).toContain('`parkedNoRoster:${Object.keys(engine.parkedTimeBanks).length}`');
    expect(parked).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE|allowUnresolved/);
  });

  it('the stopped-custody proof defers the same table instead of refusing it', () => {
    const custody = GUARD.slice(
      GUARD.indexOf('require((retained8825 || engine.timeBankMeta.size === 0) &&'),
      GUARD.indexOf("'stopped_engine_retains_custody');")
    );
    // The same flat zero, one require later, on the same fact.
    expect(custody).not.toContain('Object.keys(engine.parkedTimeBanks).length === 0 &&');
    expect(custody).toContain(
      '(Object.keys(engine.parkedTimeBanks).length === 0 ||\n            deadParkedBanksDeferred(tableId, engine))'
    );
    // Everything else it proves about a stopped engine is untouched.
    expect(custody).toContain('engine.timeBankEngine.playerBanks.size === 0 &&');
    expect(custody).toContain('Object.keys(states).length === 0');
  });

  it('a parked_bank_invalid refusal names which of its three facts failed', () => {
    const detail = GUARD.slice(
      GUARD.indexOf('const engineRefusalDetail = ('),
      GUARD.indexOf('const deadEngineCustody = (')
    );
    expect(detail).toContain('`parkedFault=${parkedFaultOf(engine)}`');
    const fault = GUARD.slice(
      GUARD.indexOf('const parkedFaultOf = ('),
      GUARD.indexOf('const engineRefusalDetail = (')
    );
    for (const value of [
      "return 'user_not_uuid';",
      "return 'bank_not_restorable';",
      "return 'unseated';",
      "return 'occupancy_mismatch';",
    ])
      expect(fault).toContain(value);
    // Observability only: it reads nothing the original conjunction does not.
    expect(fault).toContain('catch {');
    expect(fault).toContain("return 'unreadable';");
  });
});

/* A LIVE SEAT BETWEEN ITS BANKS IS NOT CUSTODY (2026-09-24).

   Run 36026978112 refused `bank_metadata_without_bank` on 3a294223, ONE live
   cash table out of 439 walked, whose seated player held accounting metadata
   and no live bank. 8825 creates a seat's bank and its metadata together at
   deal time and deletes the metadata only for a user the next roster no longer
   holds, so a player removed and re-seated at the same table keeps the
   metadata, loses the bank, and gets both back at the next deal.
   `captureParkedTimeBanks` skips a seat with no bank, so the row this
   checkpoint writes is identical either way: the refusal protected no value
   and made the release a lottery on ordinary fleet churn. */
describe('the capture does not refuse a live engine for a bank it never held', () => {
  const metadata = GUARD.slice(
    GUARD.indexOf('const disposed = new Set();'),
    GUARD.indexOf("'bank_metadata_without_bank');")
  );

  it('a stopped engine still qualifies only by holding no bank at all', () => {
    // The regression, in the exact form that refused run 36026978112: a live
    // engine could pass this require only by not seating the player at all.
    expect(metadata).not.toContain('(stopped && engine.timeBankEngine.playerBanks.size === 0)');
    expect(metadata).toContain('!seated ||');
    expect(metadata).toContain('!stopped ||');
    expect(metadata).toContain('engine.timeBankEngine.playerBanks.size === 0');
    expect(metadata).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE|allowUnresolved/);
  });

  it('the live case rests on an ordering this file pins, not on repeated conjuncts', () => {
    // `!stopped` is the ONLY conjunct added, because a non-stopped engine
    // reaches that require only through these two, which prove the rest. They
    // are asserted here rather than repeated there, so a reorder is what goes
    // red instead of nothing.
    const parked = GUARD.slice(
      GUARD.indexOf('require(engine.running === true &&'),
      GUARD.indexOf("'engine_not_physically_parked');")
    );
    for (const conjunct of [
      'engine.terminal === false &&',
      'engine.teardownPromise === null &&',
      'engine.maintenancePaused === true &&',
      'engine.holdBeforeNextHand === true &&',
      'engine.handController === null',
    ])
      expect(parked).toContain(conjunct);
    expect(GUARD.indexOf("'engine_not_physically_parked');")).toBeLessThan(
      GUARD.indexOf("'bank_metadata_without_bank');")
    );
    expect(GUARD.indexOf("'engine_work_not_drained');")).toBeLessThan(
      GUARD.indexOf("'bank_metadata_without_bank');")
    );
  });

  it('a disposed seat is still proved from rows, whatever its engine is doing', () => {
    const proof = GUARD.slice(
      GUARD.indexOf('const disposedTables = captures.filter('),
      GUARD.indexOf("'stopped_disposed_banks_unproven', 'snapshotsRead');")
    );
    // The disposed proof is not gated on `stopped`, so admitting a live seat
    // routes it into the same row proof rather than around it.
    expect(proof).toContain('captures.filter((capture) => capture.disposed.length > 0)');
    expect(proof).toContain("'hand_state_snapshots'");
    expect(proof).toContain(".eq('is_complete', false)");
    expect(proof).not.toMatch(/FORCE|SKIP|BYPASS|OVERRIDE|allowUnresolved/);
  });

  it('a deferral record that outgrew its carrier counts its kinds first', () => {
    // Run 36022429840 deferred 47 tables and the 512-character cut left the
    // first nine, alphabetically, so the kinds behind the other 38 were gone.
    const record = GUARD.slice(
      GUARD.indexOf('const kindOf = (label) =>'),
      GUARD.indexOf('restartHeldOnlyByProvenUnresolvableCustody')
    );
    expect(record).toContain('unresolvableCustody = `tables=${ids.length} ');
    expect(record.indexOf('.map(([kind, count]) => `${kind}=${count}`)')).toBeLessThan(
      record.indexOf('.map((id) => `${id}:${deferredUnresolvableCustody.get(id)}`)')
    );
    // The carrier itself is asserted where it is observable, on the emitted
    // record in the guard suite, not by pinning a number in this source.
    expect(record).toContain('deferredUnresolvableCustody.get(id)');
  });
});
