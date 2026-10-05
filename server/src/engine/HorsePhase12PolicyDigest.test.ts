/**
 * The Phase 12 policy digest hashes every runtime file that can change a
 * Phase 12 candidate decision or its legal form. The list is checked against
 * the actual transitive runtime import closure of the live policy, the sampler
 * and the pack (type-only imports excluded), so a new runtime import fails
 * here until it is either hashed or excluded with a reason.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
  HORSE_PHASE12_POLICY_EXCLUDED_CLOSURE_FILES,
  HORSE_PHASE12_POLICY_SOURCE_FILES,
  HORSE_PHASE12_POLICY_SOURCE_REASONS,
  horsePhase12PolicyDigest,
  horsePhase12PolicyDigestOf,
  runningPhase12PolicySourceReader,
} from './HorsePhase12PolicyDigest.js';
import type { RemainingPolicyVariant } from './remainingVariants/RemainingVariantPolicyPack.js';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const VARIANTS: RemainingPolicyVariant[] = ['short_deck', 'pineapple', 'flh', 'flo8'];

/** Relative runtime import specifiers of one file (type-only imports excluded). */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const out: string[] = [];
  for (const st of source.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      if (
        clause &&
        !clause.name &&
        named &&
        ts.isNamedImports(named) &&
        named.elements.length > 0 &&
        named.elements.every((e) => e.isTypeOnly)
      )
        continue;
      out.push((st.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) {
      out.push((st.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return out.filter((s) => s.startsWith('.'));
}
function runtimeClosure(roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = roots.map((r) => path.join(serverRoot, r));
  while (queue.length) {
    const file = queue.shift()!;
    const rel = path.relative(serverRoot, file).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const spec of runtimeImports(file)) {
      const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
      if (!existsSync(target)) throw new Error(`unresolved ${spec} from ${rel}`);
      queue.push(target);
    }
  }
  return [...seen].sort();
}

describe('P12.2 Phase 12 policy digest', () => {
  it('hashes or names every runtime closure file of the policy, the sampler and the pack', () => {
    const closure = runtimeClosure([
      'src/engine/remainingVariants/RemainingVariantLivePolicy.ts',
      'src/engine/remainingVariants/RemainingVariantSampler.ts',
      'src/engine/remainingVariants/RemainingVariantPolicyPack.ts',
    ]);
    expect(closure).toHaveLength(26);
    const hashed = new Set(HORSE_PHASE12_POLICY_SOURCE_FILES);
    const excluded = new Set(Object.keys(HORSE_PHASE12_POLICY_EXCLUDED_CLOSURE_FILES));
    for (const file of closure)
      expect(hashed.has(file) !== excluded.has(file), `${file} hashed xor excluded`).toBe(true);
    // Every excluded file is really in the closure, and nothing is both.
    for (const file of excluded) expect(closure).toContain(file);
    // Beyond the closure: the owner that invokes and legalizes the policy, and
    // the registry that routes the variant to it.
    expect([...hashed].filter((f) => !closure.includes(f)).sort()).toEqual([
      'src/engine/HorseLogic.ts',
      'src/engine/HorsePolicyRegistry.ts',
    ]);
  });

  it('names the files the brief requires and gives every hashed file a reason', () => {
    for (const file of [
      'src/engine/BettingStructure.ts',
      'src/engine/HorseFiveCardScore.ts',
      'src/config/rakeSpec.ts',
      'src/config/tableSeating.ts',
      'src/engine/VariantRules.ts',
      'src/engine/HorseEval.ts',
      'src/engine/HorseLogic.ts',
      'src/engine/PokerEngine.ts',
      'src/engine/plo4/Plo4LivePolicy.ts',
      'src/engine/plo4/Plo4PolicyPack.ts',
      'src/engine/omaha/OmahaCardFacts.ts',
    ])
      expect(HORSE_PHASE12_POLICY_SOURCE_FILES).toContain(file);
    for (const file of HORSE_PHASE12_POLICY_SOURCE_FILES) {
      expect(HORSE_PHASE12_POLICY_SOURCE_REASONS[file].length).toBeGreaterThan(20);
      expect(existsSync(path.join(serverRoot, file))).toBe(true);
    }
    for (const reason of Object.values(HORSE_PHASE12_POLICY_EXCLUDED_CLOSURE_FILES))
      expect(reason.length).toBeGreaterThan(20);
    expect(HORSE_PHASE12_POLICY_DIGEST_DEFINITION).toBe('horse-phase12-policy-digest-v1');
  });

  it('gives each pack its own digest, moves with any hashed byte, and fails closed', () => {
    const digests = VARIANTS.map((v) => horsePhase12PolicyDigest(v));
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(digests).size).toBe(4);
    for (const v of VARIANTS)
      expect(horsePhase12PolicyDigestOf(v, runningPhase12PolicySourceReader)).toBe(
        horsePhase12PolicyDigest(v)
      );
    const edited = (target: string) => (file: string) =>
      file === target
        ? Buffer.concat([runningPhase12PolicySourceReader(file), Buffer.from('\n')])
        : runningPhase12PolicySourceReader(file);
    for (const file of [
      'src/engine/BettingStructure.ts',
      'src/engine/HorseLogic.ts',
      'src/config/rakeSpec.ts',
    ])
      expect(horsePhase12PolicyDigestOf('flh', edited(file))).not.toBe(
        horsePhase12PolicyDigest('flh')
      );
    expect(
      horsePhase12PolicyDigestOf('flo8', (file) => {
        if (file.endsWith('OmahaCardFacts.ts')) throw new Error('unreadable');
        return runningPhase12PolicySourceReader(file);
      })
    ).toBeNull();
    expect(
      horsePhase12PolicyDigestOf('plo5' as RemainingPolicyVariant, () => Buffer.from(''))
    ).toBeNull();
  });
});
