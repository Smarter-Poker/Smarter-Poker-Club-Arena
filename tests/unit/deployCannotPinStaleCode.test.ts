/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A GREEN DEPLOY MUST ACTUALLY DEPLOY (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Found by asking the database what the engine was running: `engine_leader`
 * had sat on build 6aa60e39 for three and a half hours across ~15 merges,
 * while every `auto-deploy-hetzner` run reported success.
 *
 * The mechanism: the drain gate waits for `handsInFlightTotal` to reach ZERO
 * before it will restart the engine. On this platform that number is never
 * zero — the horse fleet deals ~200 hands a minute across ~71 tables, so
 * roughly seventy hands are in flight at any instant of any day. All sixteen
 * polls therefore fail every single time, and the "staleness cap" below them
 * is not a rare backstop: it is the ONLY path a deploy ever takes. At six
 * hours, that is how old production code was allowed to get.
 *
 * This is the same shape as the bug the gate's own comments record for
 * `humansSeatedTotal` — "a table EMPTYING can take forever and, with horses
 * seated, never happens" — reproduced one level down. A condition that a
 * healthy production fleet can never satisfy is not a gate, it is a deadlock.
 *
 * What makes a short cap safe is the SIGTERM drain: the engine parks every
 * table at a hand boundary before it stops, on every restart path, inside the
 * grace Docker gives it. These two must stay in step, so they are pinned
 * together here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const WF = read('.github/workflows/auto-deploy-hetzner.yml');

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

describe('the drain gate cannot pin production on stale code', () => {
  it('the staleness cap is short enough to be a real deploy path', () => {
    // The wait-for-zero loop above it cannot succeed on a continuously
    // dealing fleet, so this cap IS the path. Six hours meant six-hour-old
    // code — including security fixes — with every run reporting success.
    const m = WF.match(/MAX_ENGINE_AGE_SEC=(\d+)/);
    expect(m).toBeTruthy();
    const cap = Number(m![1]);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(3600);
  });

  it('proceeding is safe because the engine drains itself first', () => {
    // The cap may only be short because a restart no longer voids hands.
    // If this ever stops being true, the cap must be reconsidered — which is
    // why the two are asserted in one test.
    const idx = read('server/src/index.ts');
    const shutdown = idx.slice(idx.indexOf('const shutdown'), idx.indexOf("process.on('SIGINT'"));
    // A budget, literal or named -- see budgetFrom above for why.
    expect(shutdown).toMatch(/drainHands\([A-Za-z0-9_]+\)/);
    expect(read('server/src/GameServer.ts')).toMatch(/engine\.pauseAfterHand\(\)/);
  });

  it('the drain budget fits inside the grace the supervisor actually gives', () => {
    // engine-up.sh stops the container with an explicit grace period. A drain
    // longer than that grace is a drain that gets SIGKILLed halfway.
    const up = read('server/scripts/engine-up.sh');
    const grace = Number(up.match(/docker stop -t (\d+)/)![1]) * 1000;
    const budget = budgetFrom(read('server/src/index.ts'), /drainHands\(([A-Za-z0-9_]+)\)/);
    expect(budget).toBeLessThan(grace);
  });

  it('a run that ships nothing says so loudly, not quietly', () => {
    // Both no-op paths must annotate. An agent reading `gh run list` sees
    // only "success"; a warning surfaces in the run header without anyone
    // thinking to open the log of a green run. This is how three and a half
    // hours of staleness went unnoticed.
    expect(WF).toMatch(/::warning title=NOT DEPLOYED::/);
    expect(WF).toMatch(/::warning title=PROCEEDING ON STALENESS CAP::/);
  });
});
