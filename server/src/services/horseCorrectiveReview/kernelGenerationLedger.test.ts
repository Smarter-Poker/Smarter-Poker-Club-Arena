import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';
import {
  parsePhase14GenerationLedger,
  phase14GenerationTransitionAllowed,
  phase14LedgerSelectionAllowed,
  phase14SelectionIdentityDigest,
  PHASE14_GENERATION_LEDGER_PATH,
  readPhase14GenerationLedger,
} from './kernelGenerationLedger.js';
import { PHASE14_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase14ReleaseSelections.js';
import { CORRECTIVE_DOMAIN_KEYS } from './domain.js';
import { kernelAdmissionFixture } from './kernelAdmission.test-support.js';
import { admitCorrectiveKernelAttachment } from './kernelAdmission.js';
import { now } from './kernelApproval.test-support.js';
import { readCurrentCorrectiveGeneration } from './kernelGenerationProvider.js';
const empty = () =>
  JSON.parse(
    readFileSync(new URL('../../../../' + PHASE14_GENERATION_LEDGER_PATH, import.meta.url), 'utf8')
  );
function at(generation: number, retired: number[] = []) {
  const value = empty();
  value.domains['nlh-cash'] = {
    highestPublishedGeneration: generation,
    authorityDigest: 'a'.repeat(64),
    retiredGenerations: retired,
  };
  return value;
}
describe('durable Phase14 published generation and withdrawal floors', () => {
  it('the emitted runtime loader resolves the shipped source .mjs owner with allowJs disabled', async () => {
    const source = readFileSync(new URL('./kernelGenerationLedger.ts', import.meta.url), 'utf8');
    const emitted = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const path = '../../../src/services/horseCorrectiveReview/kernelGenerationLedgerRules.mjs';
    expect(emitted).toContain(path);
    const emittedEntry = new URL(
      '../../../dist/services/horseCorrectiveReview/kernelGenerationLedger.js',
      import.meta.url
    );
    const target = new URL(path, emittedEntry);
    expect(existsSync(target)).toBe(true);
    const actual = await import(target.href);
    expect(typeof actual.parsePhase14GenerationLedger).toBe('function');
  });

  it('the actual current protected selectors agree with shipped immutable floor/tombstone data', () => {
    const ledger = readPhase14GenerationLedger();
    expect(ledger).not.toBeNull();
    expect(Object.keys(ledger!.domains).sort()).toEqual([...CORRECTIVE_DOMAIN_KEYS].sort());
    for (const domain of CORRECTIVE_DOMAIN_KEYS)
      expect(
        phase14LedgerSelectionAllowed(
          ledger,
          domain,
          PHASE14_PROTECTED_RELEASE_SELECTIONS[domain] ?? null
        ),
        domain
      ).toBe(true);
  });
  it('refuses generation regression, removed tombstones and same-generation identity replacement', () => {
    const before = parsePhase14GenerationLedger(at(3, [1, 2]));
    expect(
      phase14GenerationTransitionAllowed(before, parsePhase14GenerationLedger(at(2, [1])))
    ).toBe(false);
    expect(
      phase14GenerationTransitionAllowed(before, parsePhase14GenerationLedger(at(3, [1])))
    ).toBe(false);
    const replaced = at(3, [1, 2]);
    replaced.domains['nlh-cash'].authorityDigest = 'b'.repeat(64);
    expect(phase14GenerationTransitionAllowed(before, parsePhase14GenerationLedger(replaced))).toBe(
      false
    );
    expect(
      phase14GenerationTransitionAllowed(before, parsePhase14GenerationLedger(at(4, [1, 2, 3])))
    ).toBe(true);
  });
  it('allows initial bootstrap only at floorzero and never silently reinitializes publication', () => {
    expect(phase14GenerationTransitionAllowed(null, parsePhase14GenerationLedger(empty()))).toBe(
      true
    );
    expect(phase14GenerationTransitionAllowed(null, parsePhase14GenerationLedger(at(1)))).toBe(
      false
    );
  });
  it('a cold admission on CURRENT source refuses a previously retired approval without a local holder history', () => {
    const f = kernelAdmissionFixture();
    f.ledger.domains['nlh-cash']!.retiredGenerations.push(1);
    expect(
      admitCorrectiveKernelAttachment('nlh-cash', f.selection, f.reader, now, f.context).admission
    ).toMatchObject({ status: 'refused', reason: 'evidence_mismatch' });
  });
  it('requires the exact current published authority identity and floor, not only a valid old signature', () => {
    const f = kernelAdmissionFixture();
    const ledger = parsePhase14GenerationLedger(f.ledger)!;
    expect(phase14LedgerSelectionAllowed(ledger, 'nlh-cash', f.selection)).toBe(true);
    expect(
      phase14LedgerSelectionAllowed(ledger, 'nlh-cash', {
        ...f.selection,
        qualificationSha256: '0'.repeat(64),
      })
    ).toBe(false);
    const value = at(2);
    value.domains['nlh-cash'].authorityDigest = phase14SelectionIdentityDigest({
      ...f.selection,
      approvalGeneration: 2,
    });
    expect(
      phase14LedgerSelectionAllowed(parsePhase14GenerationLedger(value), 'nlh-cash', f.selection)
    ).toBe(false);
  });
  it('reads the NEXT generation from authenticated CURRENT protected main even for an older evaluation checkout', () => {
    const value = at(7, [1, 4, 7]),
      bytes = Buffer.from(JSON.stringify(value)),
      calls: string[] = [];
    const result = readCurrentCorrectiveGeneration('nlh-cash', (path) => {
      calls.push(path);
      return calls.length === 1
        ? { name: 'main', protected: true, commit: { sha: 'f'.repeat(40) } }
        : {
            type: 'file',
            path: PHASE14_GENERATION_LEDGER_PATH,
            encoding: 'base64',
            content: bytes.toString('base64'),
            size: bytes.length,
          };
    });
    expect(result).toMatchObject({
      status: 'current_generation',
      receipt: {
        mainSha: 'f'.repeat(40),
        highestPublishedGeneration: 7,
        nextGeneration: 8,
        retiredGenerations: [1, 4, 7],
      },
    });
    expect(calls[1]).toContain('?ref=' + 'f'.repeat(40));
    expect(
      readCurrentCorrectiveGeneration('nlh-cash', () => {
        throw Error('private metadata error');
      })
    ).toMatchObject({ status: 'unavailable', reason: 'generation_provider_unavailable' });
  });
});
