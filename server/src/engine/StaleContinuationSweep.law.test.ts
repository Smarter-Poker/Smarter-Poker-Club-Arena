/**
 * ═══ STALE-CONTINUATION SWEEP (2026-08-31) ════════════════════════════════
 *
 * The rake-law incident (#2267/#2295/#2318) was one instance of a class: a
 * delayed continuation - a timer, a retry loop, a catch handler, a resumed
 * sleep - reading LIVE per-hand engine state (`this.handController`,
 * `this.handCount`, `this.currentHand*`) that belongs to whatever hand the
 * table is on when the continuation WAKES, not the hand it was created for.
 * This sweep closed every remaining instance found in the engine, and these
 * pins are source-level tripwires so the shapes cannot quietly return.
 * (Source assertions, in the style of RestartFidelity.test.ts: crude, but
 * they fail the exact edit that would reintroduce the bug.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(HERE, f), 'utf-8');

describe('settlement reads its own hand, never the live fields', () => {
  it('postHandTasks reads ONLY the synchronous snapshot after taking it', () => {
    const src = read('./ServerTableEngineSettlement.ts');
    const fnStart = src.indexOf('protected async postHandTasks');
    expect(fnStart).toBeGreaterThan(-1);
    const body = src.slice(fnStart);
    const snapStart = body.indexOf('const snap = {');
    expect(snapStart, 'the synchronous per-hand snapshot must exist').toBeGreaterThan(-1);
    const snapEnd = body.indexOf('};', snapStart);
    // Comment lines may cite the old field names as history; CODE may not.
    const afterSnap = body
      .slice(snapEnd)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    // Any live per-hand read after the snapshot is the board_not_recorded
    // corpse waiting to happen again: dealHand blanks these fields and
    // reallocates handCount while a stalled settlement is still writing.
    expect(afterSnap).not.toMatch(/this\.currentHand[A-Z]/);
    expect(afterSnap).not.toMatch(/this\.handCount/);
  });

  it('the settlement barrier is assigned before the body can yield', () => {
    const src = read('./ServerTableEngineSettlement.ts');
    const wrapper = src.slice(
      src.indexOf('protected async handleHandCompleteEvent'),
      src.indexOf('private async settleCompletedHand')
    );
    expect(wrapper).toContain('this.postHandTasksPromise = wholeSettlement');
  });

  it('the dealing loop waits with liveness instead of walking away at 45s', () => {
    const src = read('./ServerTableEngineDealing.ts');
    expect(src).not.toMatch(/postHandTasks exceeded 45s/);
    expect(src).toContain('settlement_barrier_abandoned');
  });
});

describe('delayed continuations name the hand they belong to', () => {
  it('a pre-action beat acts only on the controller it was armed for', () => {
    const src = read('./ServerTableEngineTurns.ts');
    const idx = src.indexOf('preActionVisibleMs);');
    expect(idx).toBeGreaterThan(-1);
    const around = src.slice(Math.max(0, idx - 1500), idx + 1500);
    expect(around).toContain('controllerAtBeat');
    expect(around).toContain('this.handController !== controllerAtBeat');
  });

  it('hole cards are stamped with the hand number captured at the deal', () => {
    const src = read('./ServerTableEngineDealing.ts');
    const fn = src.slice(src.indexOf('protected async persistHoleCardsWithRetry'));
    const loop = fn.slice(0, fn.indexOf('rePushHoleCards'));
    expect(loop).toContain('const handNumberAtDeal = this.handCount');
    expect(loop).not.toMatch(/p_hand_number: this\.handCount/);
  });

  it('every runout continuation still carries its controller (#2318)', () => {
    const src = read('./ServerTableEngineRunout.ts');
    expect(src).toMatch(/safeContinueRunout\(reason: string, controller: HandController \| null\)/);
    expect(src).not.toMatch(/safeContinueRunout\('[a-z_]+'\)/);
  });
});
