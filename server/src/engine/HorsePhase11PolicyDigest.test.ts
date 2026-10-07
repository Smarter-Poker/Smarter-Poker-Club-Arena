/**
 * The Phase 11 policy digest hashes every runtime file that can change a
 * Phase 11 candidate decision or its legal form. Until the October 7 audit
 * nothing compared its file list with the code: Phase 12 and Phase 13 pinned
 * their lists against the live policy's import closure, Phase 11 did not, so a
 * new runtime import into the Omaha policy or sampler would have left the
 * digest unchanged while the code it binds changed. The list is now checked
 * against the actual transitive runtime import closure of the live policy, the
 * sampler and the packs (type-only imports excluded), so a new runtime import
 * fails here until it is either hashed or excluded with a reason.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  HORSE_PHASE11_POLICY_DIAGNOSTIC_BOUNDARY,
  HORSE_PHASE11_POLICY_DIGEST_DEFINITION,
  HORSE_PHASE11_POLICY_EXCLUDED_CLOSURE_FILES,
  HORSE_PHASE11_POLICY_SOURCE_FILES,
  horsePhase11PolicyDigest,
  horsePhase11PolicyDigestOf,
  runningPhase11PolicySourceReader,
} from './HorsePhase11PolicyDigest.js';
import type { OmahaPolicyVariant } from './omaha/OmahaVariantPolicyPack.js';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const VARIANTS: OmahaPolicyVariant[] = ['plo5', 'plo6', 'plo8'];

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
    if (HORSE_PHASE11_POLICY_DIAGNOSTIC_BOUNDARY.includes(rel)) continue;
    for (const spec of runtimeImports(file)) {
      const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
      if (!existsSync(target)) throw new Error(`unresolved ${spec} from ${rel}`);
      queue.push(target);
    }
  }
  return [...seen].sort();
}

describe('P11.2 Phase 11 policy digest (audit 2026-10-07)', () => {
  it('hashes or names every runtime closure file of the policy, the sampler and the packs', () => {
    const closure = runtimeClosure([
      'src/engine/omaha/OmahaVariantLivePolicy.ts',
      'src/engine/omaha/OmahaVariantSampler.ts',
      'src/engine/omaha/OmahaVariantPolicyPack.ts',
    ]);
    const hashed = new Set(HORSE_PHASE11_POLICY_SOURCE_FILES);
    const excluded = new Set(Object.keys(HORSE_PHASE11_POLICY_EXCLUDED_CLOSURE_FILES));
    expect(hashed.size).toBe(HORSE_PHASE11_POLICY_SOURCE_FILES.length);
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
    for (const file of HORSE_PHASE11_POLICY_SOURCE_FILES)
      expect(existsSync(path.join(serverRoot, file)), file).toBe(true);
    for (const reason of Object.values(HORSE_PHASE11_POLICY_EXCLUDED_CLOSURE_FILES))
      expect(reason.length).toBeGreaterThan(20);
  });

  it('gives each pack its own digest, moves with any hashed byte, and fails closed', () => {
    expect(HORSE_PHASE11_POLICY_DIGEST_DEFINITION).toMatch(/^horse-phase11-policy-digest-v\d+$/);
    const digests = VARIANTS.map((v) => horsePhase11PolicyDigest(v));
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(digests).size).toBe(3);
    for (const v of VARIANTS)
      expect(horsePhase11PolicyDigestOf(v, runningPhase11PolicySourceReader)).toBe(
        horsePhase11PolicyDigest(v)
      );
    const edited = (target: string) => (file: string) =>
      file === target
        ? Buffer.concat([runningPhase11PolicySourceReader(file), Buffer.from('\n')])
        : runningPhase11PolicySourceReader(file);
    for (const file of HORSE_PHASE11_POLICY_SOURCE_FILES)
      expect(horsePhase11PolicyDigestOf('plo8', edited(file)), file).not.toBe(
        horsePhase11PolicyDigest('plo8')
      );
    // An excluded file does not move it: it is not bound, by name.
    for (const file of Object.keys(HORSE_PHASE11_POLICY_EXCLUDED_CLOSURE_FILES))
      expect(horsePhase11PolicyDigestOf('plo8', edited(file)), file).toBe(
        horsePhase11PolicyDigest('plo8')
      );
    expect(
      horsePhase11PolicyDigestOf('plo5', (file) => {
        if (file.endsWith('OmahaVariantSampler.ts')) throw new Error('unreadable');
        return runningPhase11PolicySourceReader(file);
      })
    ).toBeNull();
    expect(
      horsePhase11PolicyDigestOf('flo8' as OmahaPolicyVariant, () => Buffer.from(''))
    ).toBeNull();
  });
});
