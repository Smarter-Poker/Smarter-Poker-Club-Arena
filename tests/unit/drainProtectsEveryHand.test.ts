/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DRAIN PROTECTS THE HAND, NOT THE PLAYER (Dan, 2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Restarting an engine mid-hand voids that hand. The only guard was the deploy
 * workflow's drain gate, and it read `humansSeatedTotal` — so it waited for
 * HUMANS to leave and let a horse's hand be voided without a second thought.
 * Two defects in one gate:
 *
 *   1. It protected people rather than hands (CLAUDE.md 10.5 forbids exactly
 *      this), and
 *   2. it waited for the wrong event — a table EMPTYING can take forever and,
 *      with horses seated, never happens, so it deferred for hours and then
 *      restarted under seated players anyway.
 *
 * Dan chose "protect the hand, not the player". The engine now drains itself
 * on every restart path (not just deploys), and the gate waits on hands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

/**
 * The shutdown budgets moved from inline literals to named constants
 * (DRAIN_BUDGET_MS / SHUTDOWN_CAP_MS) on 2026-09-01, so these pins resolve the
 * value through the name instead of matching `drainHands(28000)`. The property
 * being asserted is unchanged -- only the way the number is spelled in the
 * source moved. Falls back to a literal so an inlined value still reads.
 */
function budgetFrom(src: string, callPattern: RegExp): number {
  const m = src.match(callPattern);
  if (!m) throw new Error(`no match for ${callPattern}`);
  const token = m[1];
  if (/^[0-9_]+$/.test(token)) return Number(token.replace(/_/g, ''));
  const decl = src.match(new RegExp(`const ${token} = ([0-9_]+);`));
  if (!decl) throw new Error(`${token} is not declared as a numeric constant`);
  return Number(decl[1].replace(/_/g, ''));
}

describe('the engine drains itself before stopping', () => {
  it('GameServer exposes a bounded drainHands()', () => {
    const src = read('server/src/GameServer.ts');
    // Format-agnostic on purpose: prettier wraps this signature across three
    // lines on commit, so an exact-spacing regex passes locally and fails in
    // CI (the trap CLAUDE.md section 11 warns about). Assert the CONTRACT —
    // the method exists, takes a millisecond budget, and has a default — not
    // the whitespace prettier happens to choose today.
    expect(src).toMatch(/async drainHands\(\s*maxWaitMs = \d+/);
    // It must pause every engine after its current hand...
    expect(src).toMatch(/engine\.pauseAfterHand\(\)/);
    // ...and it must be bounded, or a stuck table holds the process open
    // until the supervisor SIGKILLs us mid-flush.
    expect(src).toMatch(/Date\.now\(\) < deadline/);
  });

  it('shutdown drains before it stops, inside the hard cap', () => {
    const src = read('server/src/index.ts');
    const shutdown = src.slice(src.indexOf('const shutdown'), src.indexOf("process.on('SIGINT'"));
    expect(shutdown).toMatch(/drainHands\(/);
    // The drain must sit INSIDE the hard race, not before it.
    // 2026-08-28: the cap moved 20s -> 30s when the drain budget went 8s ->
    // 18s (8s expired with most tables still mid-hand, so the drain stopped
    // exactly the hands it exists to protect). Asserted as "there is a cap
    // and the drain is inside it" rather than pinning the literal, so the
    // ORDER — the thing that matters — survives future tuning.
    const drainAt = shutdown.indexOf('drainHands(');
    const raceAt = shutdown.indexOf('Promise.race');
    const capMatch = shutdown.match(/setTimeout\(r, ([A-Za-z0-9_]+)\)/);
    expect(capMatch).toBeTruthy();
    const capAt = shutdown.indexOf(capMatch![0]);
    expect(raceAt).toBeGreaterThan(-1);
    expect(drainAt).toBeGreaterThan(raceAt);
    expect(capAt).toBeGreaterThan(drainAt);

    // The budget must fit inside the cap, and the cap inside Docker's grace
    // (`docker stop -t 45` in server/scripts/engine-up.sh) — otherwise the
    // supervisor SIGKILLs the engine mid-flush and the drain buys nothing.
    const idxSrc = read('server/src/index.ts');
    const budget = budgetFrom(idxSrc, /drainHands\(([A-Za-z0-9_]+)\)/);
    const cap = budgetFrom(idxSrc, /setTimeout\(r, ([A-Za-z0-9_]+)\)/);
    expect(budget).toBeLessThan(cap);
    expect(cap).toBeLessThan(45_000);
    // And the budget must actually outlast a hand, or it expires with tables
    // still mid-hand and stops them anyway.
    //
    // 2026-09-01: floor raised 15s -> 25.8s. The "~20s" above was an estimate;
    // measured over 41,269 real hands the median is 17.2s and the p90 48.2s, so
    // an 18s budget was still expiring on 47% of hands. The floor is 1.5x the
    // measured median, because a budget that merely equals p50 expires on half
    // the tables by definition.
    expect(budget).toBeGreaterThanOrEqual(25_800);
  });
});

describe('the deploy gate waits on hands, never on humanity', () => {
  const wf = () => read('.github/workflows/auto-deploy-hetzner.yml');

  it('waits on a declared break, and never on a human count', () => {
    /**
     * SUPERSEDED THE HANDS POLL (Dan 2026-09-01). This pinned
     * `handsInFlightTotal`, which was itself the 2026-08-27 fix for a gate
     * that had waited on `humansSeatedTotal` and so let a horse's hand be
     * voided where a human's would not (CLAUDE.md 10.5).
     *
     * Counting hands was still the wrong shape: it asked "is anybody mid-hand
     * at this instant" of a fleet that is always mid-hand, so the gate never
     * passed and the deploy fell through to a staleness cap that restarted on
     * live play regardless. The engine now STOPS the platform - every table,
     * horse and human alike, parked between hands - and says so. The gate
     * waits for that.
     *
     * What this test still protects is the invariant underneath both fixes:
     * the deploy must never decide on WHO is seated.
     */
    const src = wf();
    const gate = src.slice(
      src.indexOf('Wait for the maintenance break'),
      src.indexOf('Cut over to the new image')
    );
    expect(gate).toMatch(/readyForRestart/);
    expect(gate).not.toMatch(/d\.get\("humansSeatedTotal"\)/);
    expect(gate).not.toMatch(/is_horse|isHorse/);
  });

  it('health publishes the break state the gate depends on', () => {
    // A gate reading a field nobody publishes is a gate that is permanently
    // blind — this pins the two ends together.
    const gs = read('server/src/GameServer.ts');
    // Phase 1 (to-do #2563 item 4) widened the block to carry the measured
    // clock skew alongside the break snapshot, so the pin now requires BOTH:
    // the snapshot spread and the skew field riding with it.
    expect(gs).toMatch(/maintenance: \{ \.\.\.this\.maintenanceBreak\.snapshot\(\), dbClockSkewMs/);
    expect(read('server/src/maintenance/MaintenanceBreak.ts')).toMatch(/readyForRestart\(\)/);
  });

  it('the break parks every table without asking who is sitting at it', () => {
    // CLAUDE.md 10.5, asserted at the source rather than inferred: there is no
    // horse branch in the module that decides which tables stop.
    const mb = read('server/src/maintenance/MaintenanceBreak.ts');
    const code = mb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/is_horse|isHorse|humansSeated/);
  });
});
