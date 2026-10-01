import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalPhase8Value,
  digestPhase8UsefulCompletion,
  type Phase8UsefulCompletionDigestRow,
  type Phase8UsefulCompletionRequest,
} from './HorsePhase8UsefulCompletion.js';

// P8.1 equivalence control. The frozen population and the digest recorded on
// the engine source at 4948e0ff live beside the diagnostic's evidence
// (docs/evidence/phase8/). Any change to the continuation path must reproduce
// every row exactly: selected action and amount, every candidate distribution
// and utility moment (order-dependent floating sums), continuation work
// counters and receipts. A deliberate behaviour change re-records the digest
// in its own reviewed commit; an optimization never does.
const evidence = resolve(process.cwd(), '../docs/evidence/phase8');
const population = JSON.parse(
  readFileSync(resolve(evidence, 'phase8-useful-completion-population.json'), 'utf8')
) as { sha256: string; count: number; requests: Phase8UsefulCompletionRequest[] };
const before = JSON.parse(
  readFileSync(resolve(evidence, 'phase8-useful-completion-digest-before.json'), 'utf8')
) as { populationSha256: string; sha256: string; rows: Phase8UsefulCompletionDigestRow[] };

describe('Phase 8.1 useful-completion equivalence', () => {
  it('reads the frozen population it was recorded against', () => {
    const actual = createHash('sha256')
      .update(JSON.stringify(canonicalPhase8Value(population.requests)))
      .digest('hex');
    expect(actual).toBe(population.sha256);
    expect(before.populationSha256).toBe(population.sha256);
    expect(population.requests).toHaveLength(population.count);
  });

  it('reproduces every recorded decision, distribution and receipt exactly', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let digest: ReturnType<typeof digestPhase8UsefulCompletion>;
    try {
      digest = digestPhase8UsefulCompletion(population.requests);
    } finally {
      clock.mockRestore();
    }
    for (const row of digest.rows) expect(row).toEqual(before.rows[row.index]);
    expect(digest.rows).toHaveLength(before.rows.length);
    expect(digest.sha256).toBe(before.sha256);
    // The control is not vacuous: Phase 8 completes on part of the population.
    expect(digest.rows.some((r) => r.completed === true)).toBe(true);
  }, 120_000);
});
