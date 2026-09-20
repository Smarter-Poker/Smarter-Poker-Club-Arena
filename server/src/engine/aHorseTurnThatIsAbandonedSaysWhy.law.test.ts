/**
 * LAW: a horse turn that the engine abandons must say which authority it lost.
 *
 * `scheduleHorseAction` guards six stages with one fence - abort signal, turn
 * token, hand controller, hand number, lifecycle, current seat, engine lease
 * generation. Until 2026-09-11 every one of those six answered a failure with
 * a bare `return`.
 *
 * The consequence was a blind spot exactly where it mattered most. A horse
 * whose table lost its engine lease mid-turn was never scheduled, never asked
 * the decision worker for anything, and appeared in no counter at all. The
 * seventeen-second clock then resolved its seat as a forced check/fold, so the
 * only trace was `poker_horse_turn_timeouts_total{kind="timer"}` - a number
 * that names the clock, not the cause.
 *
 * Measured on production that evening:
 *
 *   poker_horse_decision_fallbacks_total          0
 *   decision worker queue depth                   0
 *   decision worker compute                       4.9 ms
 *   poker_horse_turn_timeouts_total{kind=timer}   19-40 / min
 *   hands dealt                                   164 / min
 *   engine lease losses                           1,652 / min across 1,570 tables
 *
 * Every horse gauge read perfect while roughly one horse turn in eight was
 * being folded by the clock. The same counts were zero half an hour earlier,
 * so the signal existed - nothing in the horse subsystem was able to carry it.
 *
 * This law does not assert that turns are never abandoned. Abandoning is
 * correct: a superseded turn or a lost lease MUST NOT act. It asserts that
 * abandoning is never silent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const turns = readFileSync(resolve(here, 'ServerTableEngineTurns.ts'), 'utf8');
const instruments = readFileSync(resolve(here, '../observability/engineInstruments.ts'), 'utf8');

/** Comment-stripped and whitespace-collapsed: prose about a rule is not a
 *  rule, and prettier decides where a long condition wraps. */
const flat = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

const REASONS = [
  'aborted',
  'superseded',
  'hand_replaced',
  'lifecycle_locked',
  'seat_moved',
  'lease_lost',
  'clock_expired',
] as const;

const STAGES = [
  'schedule',
  'fallback',
  'fast_result',
  'deep_start',
  'deep_result',
  'commit',
] as const;

describe('a horse turn that is abandoned says why', () => {
  it('no fence check is unstaged', () => {
    // A bare fenceIsCurrent() is the exact shape of the bug: it refuses the
    // turn and records nothing.
    expect(flat(turns)).not.toContain('fenceIsCurrent()');
    // Exactly one call per stage. The declaration reads `fenceIsCurrent = (`
    // and so is not counted here; a seventh call site would be an unnamed
    // stage and would fail this.
    expect(turns.match(/fenceIsCurrent\(/g) ?? []).toHaveLength(STAGES.length);
  });

  it('every stage of the turn is guarded and named', () => {
    const f = flat(turns);
    for (const stage of STAGES) {
      expect(f, `stage ${stage} is not used`).toContain(`fenceIsCurrent('${stage}')`);
    }
  });

  it('the fence returns a reason, and records it before refusing', () => {
    const f = flat(turns);
    expect(f).toContain('const fenceRefusal = (): HorseTurnAbandonReason | null =>');
    for (const reason of REASONS) {
      expect(f, `reason ${reason} is not returned`).toContain(`return '${reason}'`);
    }
    // The counter is incremented on the refusal path, not the success path.
    expect(f).toContain('const reason = fenceRefusal(); if (reason === null) return true;');
    expect(f).toContain('horseTurnsAbandonedTotal.inc(1, { reason, stage })');
  });

  it('a metrics failure can never change gameplay', () => {
    // Same contract as every other counter on this path.
    expect(flat(turns)).toMatch(
      /horseTurnsAbandonedTotal\.inc\(1, \{ reason, stage \}\); \} catch \{ \}/
    );
  });

  it('the counter is always on, not behind a flag', () => {
    // poker_hands_total lived on the flag-gated registry, ENGINE_METRICS is
    // set nowhere in this estate, and SLOHandsAreNotBeingDealt (critical, SMS)
    // was structurally unable to fire for it. Not again.
    expect(flat(instruments)).toContain(
      "export const horseTurnsAbandonedTotal: Counter = alwaysOnRegistry.counter( 'poker_horse_turns_abandoned_total'"
    );
  });

  it('every reason and stage is zero-seeded, so a rule never faces an absent metric', () => {
    // An alert on a name with no series evaluates to an empty vector, which
    // reads exactly like healthy and can never fire. Thirteen metrics were in
    // that state on 2026-09-11.
    const f = flat(instruments);
    for (const reason of REASONS) expect(f).toContain(`'${reason}'`);
    for (const stage of STAGES) expect(f).toContain(`'${stage}'`);
    expect(f).toContain('horseTurnsAbandonedTotal.inc(0, { reason, stage })');
  });
});
