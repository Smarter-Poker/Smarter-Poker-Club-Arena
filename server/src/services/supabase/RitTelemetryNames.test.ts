/**
 * The telemetry listened for 'rit_resolved'; the hub actually carries
 * 'rit_result'. Result: on 2026-08-21 production showed 17 RIT offers, 17
 * chooser decisions and ZERO resolutions - which reads exactly like "run it
 * twice never completes". It did complete: all 17 hands settled across
 * multiple boards (5 of them across three), 6,604.73 in pots awarded.
 *
 * A name mismatch between the emitter and the recorder is invisible by
 * construction - nothing throws, a row simply never appears. So this test
 * derives the emitted names from the ENGINE SOURCE and asserts the recorder
 * knows every one of them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const RUNOUT = 'src/engine/ServerTableEngineRunout.ts';
const HAND_FACTS = 'src/services/supabase/handFacts.ts';

/** Every `type: 'rit_*' | 'insurance_*'` literal the runout emits on the hub. */
function emittedNames(): string[] {
  const src = readFileSync(RUNOUT, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/type:\s*'((?:rit|insurance)_[a-z_]+)'/g)) names.add(m[1]);
  return [...names].sort();
}

/** The names the recorder will actually write a row for. */
function recordedNames(): string[] {
  const src = readFileSync(HAND_FACTS, 'utf8');
  const block = src.match(/const RIT_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('RIT_EVENT_TYPES not found in handFacts.ts');
  // Ignore commented-out lines so a name mentioned only in prose does not count.
  return [...block[1].matchAll(/^\s*'([a-z_]+)',/gm)].map((m) => m[1]).sort();
}

describe('RIT / insurance telemetry names', () => {
  it('the engine emits at least the offer, decision and result events', () => {
    const emitted = emittedNames();
    expect(emitted).toContain('rit_offer');
    expect(emitted).toContain('rit_chooser_decided');
    expect(emitted).toContain('rit_result');
  });

  it('every name the engine emits is one the recorder writes a row for', () => {
    const recorded = new Set(recordedNames());
    const missing = emittedNames().filter((n) => !recorded.has(n));
    expect(missing).toEqual([]);
  });

  it("records 'rit_result' - the resolution event that was being dropped", () => {
    expect(recordedNames()).toContain('rit_result');
  });

  it('keeps the internal engine name too, so either spelling is captured', () => {
    expect(recordedNames()).toContain('rit_resolved');
  });
});
