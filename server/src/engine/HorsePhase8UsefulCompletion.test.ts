import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalPhase8Value,
  digestPhase8UsefulCompletion,
  type Phase8UsefulCompletionRequest,
} from './HorsePhase8UsefulCompletion.js';

// P8.1 equivalence control, self-contained on whatever machine runs it. Both
// digests are computed here, in this process, with the clock frozen at zero
// so no work deadline can stop either pass: the outcome cannot depend on
// machine speed. The second pass visits the population in reverse, so a
// decision that read state left by another (a cache, a workspace, an RNG
// stream) would change its row. Any later continuation change runs the same
// comparison against the unchanged tree before shipping (the diagnostic's
// `compare` and `digest` modes). The digest recorded on the development Mac,
// docs/evidence/phase8/phase8-useful-completion-digest-before.json, is
// evidence for that machine only and is deliberately not asserted here.
const evidence = resolve(process.cwd(), '../docs/evidence/phase8');
const population = JSON.parse(
  readFileSync(resolve(evidence, 'phase8-useful-completion-population.json'), 'utf8')
) as { sha256: string; count: number; requests: Phase8UsefulCompletionRequest[] };

function frozenDigest(order?: number[]) {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    return digestPhase8UsefulCompletion(population.requests, order);
  } finally {
    clock.mockRestore();
  }
}

describe('Phase 8.1 useful-completion equivalence', () => {
  it('reads the frozen population it was recorded against', () => {
    const actual = createHash('sha256')
      .update(JSON.stringify(canonicalPhase8Value(population.requests)))
      .digest('hex');
    expect(actual).toBe(population.sha256);
    expect(population.requests).toHaveLength(population.count);
  });

  it('reproduces every decision, distribution and receipt exactly in any order', () => {
    const forward = frozenDigest();
    const reverse = frozenDigest(population.requests.map((_, i) => i).reverse());
    expect(forward.rows).toHaveLength(population.count);
    for (const row of reverse.rows) expect(row).toEqual(forward.rows[row.index]);
    expect(reverse.sha256).toBe(forward.sha256);
    // Not vacuous: with no deadline, Phase 8 completes on this population.
    expect(forward.rows.some((r) => r.completed === true)).toBe(true);
  }, 120_000);
});
