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

  it('reads handsInFlightTotal, not humansSeatedTotal', () => {
    const src = wf();
    const gate = src.slice(src.indexOf('Drain gate'), src.indexOf('Pull the exact commit'));
    // It must READ the hands figure...
    expect(gate).toMatch(/d\.get\("handsInFlightTotal"\)/);
    // ...and must not READ a human count. Asserted on the actual field read
    // rather than the mere appearance of the string, because the comment above
    // the gate deliberately names the old field to explain what changed — and
    // a test that forbids naming the bug forbids documenting it.
    expect(gate).not.toMatch(/d\.get\("humansSeatedTotal"\)/);
  });

  it('health publishes the hands figure the gate depends on', () => {
    // A gate reading a field nobody publishes is a gate that is permanently
    // blind — this pins the two ends together.
    expect(read('server/src/GameServer.ts')).toMatch(/handsInFlightTotal:/);
  });
});
