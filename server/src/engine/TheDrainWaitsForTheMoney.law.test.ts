/**
 * THE DRAIN WAITS FOR THE MONEY, AND THE BARRIER NAMES THE RIGHT FAULT.
 *
 * Two defects, one incident shape, found 2026-09-06 by reading the fifteen
 * `settlement_barrier_abandoned` criticals on the alert board.
 *
 * Every one of them said "settlement for hand #N exceeded 300s; dealing
 * resumed while it ran" and carried `waitedMs: 30000`. Thirty seconds, in a
 * message claiming three hundred - so the loop's own timeout condition
 * (waited < maxWaitMs) was still TRUE and it had not timed out at all. It
 * exited on `this.running`, which goes false when the engine is stopping.
 * Three shutdowns (09-05 16:07, 09-05 17:50, 09-06 04:10), five tables each,
 * all five inside one second: one SIGTERM filed as five money incidents.
 *
 * The second defect is why that mattered. drainHands() called a table parked
 * at a hand boundary as soon as `!isRunning()` - including a table whose
 * postHandTasks (settlement, rake record, hand history) was still writing. So
 * the drain reported a clean stop and the process exited on top of in-flight
 * money, at :55, every hour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (f: string): string => readFileSync(join(__dirname, f), 'utf8');

describe('the drain waits for the money', () => {
  it('drainHands refuses to call a table parked while its settlement is in flight', () => {
    const src = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');
    const boundary = src.slice(src.indexOf('const atBoundary'), src.indexOf('let drained'));
    // the in-flight check must be its own early return BEFORE the isRunning
    // shortcut, or the shortcut answers first and the check never runs.
    const code = boundary
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('/*') && !l.startsWith('*') && !l.startsWith('//'))
      .join('\n');
    expect(code).toContain('if (e.hasSettlementInFlight()) return false;');
    expect(code.indexOf('e.hasSettlementInFlight()')).toBeLessThan(code.indexOf('!e.isRunning()'));
  });

  it('every in-flight write stays visible until its own promise settles', () => {
    const base = read('ServerTableEngineBase.ts');
    expect(base).toContain('protected settlementInFlight: Set<Promise<void>> = new Set();');
    expect(base).toContain(
      'hasSettlementInFlight(): boolean {\n    return (this.settlementInFlight?.size ?? 0) > 0;'
    );
    // A gameplay timeout may let a newer hand start while the older promise
    // still writes. A set retains both instead of replacing the first.
    expect(base).toContain('settlements.add(p);');
    expect(base).toContain('settlements.delete(tracked);');
    // Rejection is not equivalent to a durable boundary.
    expect(base).toContain('if (failed) this.terminalBoundaryPersistenceFailed = true;');
    expect(base).toContain('.catch(() => clear(true));');
  });

  it('both settle paths register their barrier with the tracker', () => {
    const s = read('ServerTableEngineSettlement.ts');
    const calls = s.match(/this\.trackSettlementInFlight\(this\.postHandTasksPromise\);/g) ?? [];
    expect(calls.length).toBe(2);
  });
});

describe('the barrier transfers exact ownership on stop', () => {
  const dealing = read('ServerTableEngineDealing.ts');

  it('a shutdown is not filed as an abandoned settlement', () => {
    expect(dealing).toContain('if (!settled && !this.running) {');
    const shutdown = dealing.slice(
      dealing.indexOf('if (!settled && !this.running) {'),
      dealing.indexOf('if (this.postHandTasksPromise === pending)')
    );
    expect(shutdown).not.toContain('raiseFinancialAlert');
    expect(shutdown).toContain('the drain owns it from here');
    expect(shutdown).toContain('return;');
  });

  it('neither time nor a terminal fence erases the in-flight writer marker', () => {
    const wait = dealing.slice(
      dealing.indexOf('while (!settled && this.running) {'),
      dealing.indexOf('if (this.postHandTasksPromise === pending)')
    );
    expect(wait).not.toContain('settlement_barrier_abandoned');
    expect(wait).not.toContain('trackSettlementInFlight(null)');
    expect(wait).not.toMatch(/waited\s*[>=]/);
    expect(wait).toContain('return;');
  });
});
