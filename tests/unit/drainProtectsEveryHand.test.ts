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

describe('the engine drains itself before stopping', () => {
  it('GameServer exposes a bounded drainHands()', () => {
    const src = read('server/src/GameServer.ts');
    expect(src).toMatch(/async drainHands\(maxWaitMs = \d+\)/);
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
    // The drain must sit INSIDE the 20s race, not before it.
    const drainAt = shutdown.indexOf('drainHands(');
    const raceAt = shutdown.indexOf('Promise.race');
    const capAt = shutdown.indexOf('20_000');
    expect(raceAt).toBeGreaterThan(-1);
    expect(drainAt).toBeGreaterThan(raceAt);
    expect(capAt).toBeGreaterThan(drainAt);
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
