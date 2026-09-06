/**
 * A PARKED TABLE IS NOT A STALLED ONE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS ABOUT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `lastProgressAtMs` is a wall clock. `msSinceProgress()` reads it, the stall
 * predicate reads that, `poker_stalled_tables` reads that, and until 2026-09-05
 * `liveness` read THAT - so a wrong answer here ended with sp-autoheal
 * restarting production and voiding every hand on ~300 tables.
 *
 * The clock kept running through periods when the table was deliberately not
 * dealing, and nothing ever credited them back. Two of those periods:
 *
 *  1. THE MAINTENANCE BREAK. A parked table is excluded from the predicate by
 *     `paused`, so the damage is invisible until :00, when every table on the
 *     fleet stops being paused at once and reappears already carrying the whole
 *     break as "no progress". MEASURED over 24 hours:
 *
 *       the twelve largest stall spikes ALL fell in HH:00:07 - HH:00:37
 *       peak 120 tables at 18:00:22, as poker_paused_tables went 343 -> 0
 *       49.5% of every stalled table-second in the day sat in minute :00
 *       first-observed stall values clustered at 433-446s - a jump, not a climb
 *
 *  2. A DEAL HOLD. `dealHoldUntilMs` holds the first deal under a Spin reveal,
 *     and holds a seat-first tournament between its seats selling and its
 *     advertised start. Measured, table row created -> tournament start_time:
 *     2287s, 2212s, 3078s. Through all of it the table has 2+ dealable seats,
 *     is not `paused`, and reads as stalled. A live poll of two such tables
 *     caught 56 stalled samples; all 56 had a dealing loop that had moved
 *     within two seconds, and not one was wedged.
 *
 * Together those account for the great majority of a signal that had 1,081
 * distinct tables - about a third of the fleet's churn - flagged as stalled in
 * twelve hours while the watchdog, correctly, rebuilt none of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * CLAUDE.md §13 rule 4 already states it for money and seats: "Deadlines are
 * thawed, not burned. If you add a wall-clock deadline a player can lose to,
 * add it to fn_thaw_platform in the same PR, or a five-minute break silently
 * eats it." The progress clock is such a deadline - what it loses is not a
 * player's money but the platform's own judgement about whether it is alive -
 * and it was never thawed.
 *
 * So: time a table was TOLD not to deal is not time it failed to deal. Every
 * pause authority credits the clock when it lets go, and every deliberate hold
 * is visible to the one predicate that decides whether a table is broken.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE = readFileSync(join(ROOT, 'server/src/engine/ServerTableEngineBase.ts'), 'utf8');
const SERVER = readFileSync(join(ROOT, 'server/src/GameServer.ts'), 'utf8');

/**
 * The body of a method, from its DECLARATION to the matching closing brace.
 *
 * Anchored on a line start, because `indexOf('resumeDealing()')` finds the
 * first CALL SITE and happily returns the body of whatever encloses it - which
 * is how the first draft of this law passed while asserting nothing.
 */
function methodBody(src: string, signature: string): string {
  const start = src.search(
    new RegExp(`^\\s*(?:public |private |protected )?${signature.replace(/[(){}]/g, '\\$&')}`, 'm')
  );
  expect(start, `${signature} not found - re-point this law`).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

describe('the progress clock is credited when a pause ends', () => {
  it('releasePauseGate marks progress', () => {
    // THE REGRESSION, BY NAME. Without this line the break is charged to the
    // table as a stall the instant the break ends, and 49.5% of the day's
    // stalled table-seconds were exactly that.
    const body = methodBody(BASE, 'releasePauseGate(): void {');
    expect(
      body,
      'releasePauseGate must call markProgress() - a table told not to deal has not failed to deal'
    ).toMatch(/this\.markProgress\(\)/);
  });

  it('every resume path goes through that one gate', () => {
    // The credit is in the shared gate rather than in each caller, so a third
    // pause authority added later inherits it instead of re-learning this.
    // If either of these stops funnelling through releasePauseGate, the fix
    // has quietly become partial.
    expect(methodBody(BASE, 'resumeFromMaintenance(): void {')).toMatch(
      /this\.releasePauseGate\(\)/
    );
    expect(methodBody(BASE, 'resumeDealing(): void {')).toMatch(/this\.releasePauseGate\(\)/);
  });
});

describe('a deliberate hold is a pause by design', () => {
  const body = methodBody(BASE, 'isPausedByDesign(): boolean {');

  it('names all four authorities that stop a table on purpose', () => {
    // Each of these was learned from an incident: hand-for-hand rebuilt a
    // paused final-table bubble; the maintenance break dealt 1204 hands inside
    // itself and drove the hourly watchdog_kill_rebuild wave; and the deal hold
    // made every seat-first tournament read as stalled for up to 51 minutes.
    expect(body).toMatch(/handForHandPaused/);
    expect(body).toMatch(/maintenancePaused/);
    expect(body).toMatch(/dealHoldUntilMs/);
    expect(body).toMatch(/tableFSM\.state === 'paused'/);
  });

  it('the hold is compared against now, not merely non-zero', () => {
    // dealHoldUntilMs is only ever extended, never cleared, so `> 0` would
    // excuse a table forever after its first Spin reveal - which is the
    // opposite failure, and a far more expensive one: a genuinely wedged
    // table that can never be reported.
    expect(body).toMatch(/dealHoldUntilMs > Date\.now\(\)/);
    expect(body).not.toMatch(/dealHoldUntilMs > 0/);
  });
});

describe('the stall predicate reads the by-design pause', () => {
  it('the liveness snapshot publishes isPausedByDesign, not a raw FSM state', () => {
    // The snapshot is the single source every consumer reads: the /health
    // stall list, deadStalledCount, the liveness verdict, poker_stalled_tables
    // and the deploy drain gate. They can only agree about what "broken" means
    // if they are all asking this one question.
    const snap = methodBody(SERVER, 'tableLivenessSnapshot() {');
    expect(snap).toMatch(/paused:\s*engine\.isPausedByDesign\(\)/);
    expect(snap).toMatch(/msSinceProgress:\s*engine\.msSinceProgress\(\)/);
  });

  it('every stall filter excludes a paused table', () => {
    // Four filters, one rule. A new one that forgets `!t.paused` re-creates
    // the hourly watchdog_kill_rebuild wave (#2651) on the next break.
    const filters = [...SERVER.matchAll(/t\.dealable >= [^\n]*msSinceProgress > [\d_]+/g)].map(
      (m) => m[0]
    );
    expect(filters.length, 'no stall filters found - re-point this law').toBeGreaterThan(0);
    for (const f of filters) {
      expect(f, `a stall filter does not exclude a paused table: ${f}`).toMatch(/!t\.paused/);
    }
  });
});
