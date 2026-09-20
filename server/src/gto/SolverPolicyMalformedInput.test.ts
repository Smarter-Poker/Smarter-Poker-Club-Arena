import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateSolverPolicyAnswer,
  validateSolverPolicyArtifactBundle,
} from './SolverPolicyContract.js';

const fixture = JSON.parse(
  readFileSync(new URL('./contracts/fixtures/exact-policy.v1.json', import.meta.url), 'utf8')
);

describe('solver policy malformed JSON boundary', () => {
  it('rejects malformed nested values without throwing from either public validator', () => {
    const paths: Array<Array<string | number>> = [];
    const walk = (value: unknown, path: Array<string | number>) => {
      paths.push(path);
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value))
          walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
      }
    };
    walk(fixture, []);
    const failures: string[] = [];
    for (const path of paths)
      for (const replacement of [null, false, 0, '', [], {}, [null]]) {
        let candidate = structuredClone(fixture);
        if (!path.length) candidate = replacement;
        else {
          let owner = candidate;
          for (const key of path.slice(0, -1)) owner = owner[key];
          owner[path.at(-1)!] = replacement;
        }
        try {
          const result = validateSolverPolicyAnswer(candidate);
          expect(typeof result.valid).toBe('boolean');
          const envelope = {
            contractVersion: 'smarter-poker.solver-policy.v1',
            schemaSha256: 'bad',
            policyVersion: 'audit',
            generatedAt: '2026-09-14T00:00:00Z',
            sourceArtifact: 'local-negative-test',
            policies: [candidate],
          };
          expect(validateSolverPolicyArtifactBundle(envelope).valid).toBe(false);
        } catch (error) {
          failures.push(
            `${path.join('.') || '$'}=${JSON.stringify(replacement)}: ${String(error)}`
          );
        }
      }
    expect(failures).toEqual([]);
  });
});
