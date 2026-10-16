/**
 * The digest hole, closed (2026-10-16). Every phase digest hashed HorseLogic.ts
 * but none of the modules it decides with, so a change to the preflop bars, a
 * solver consult, the EV engine or the persona changed every qualified pack's
 * live behaviour under an unchanged digest. HORSE_REFERENCE_DECISION_SOURCE_FILES
 * now enters all four digests; this test keeps that list equal to the code:
 * every runtime import of HorseLogic, and everything those sources import, is
 * either hashed by every phase, in the list, or named with a reason.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { HORSE_PHASE10_POLICY_SOURCE_FILES } from './HorsePhase10Authority.js';
import { HORSE_PHASE11_POLICY_SOURCE_FILES } from './HorsePhase11PolicyDigest.js';
import { HORSE_PHASE12_POLICY_SOURCE_FILES } from './HorsePhase12PolicyDigest.js';
import { HORSE_PHASE13_POLICY_SOURCE_FILES } from './HorsePhase13PolicyDigest.js';
import {
  HORSE_REFERENCE_DECISION_BOUNDARY,
  HORSE_REFERENCE_DECISION_EXCLUDED,
  HORSE_REFERENCE_DECISION_SOURCE_FILES,
  HORSE_REFERENCE_DECISION_SOURCE_REASONS,
} from './HorseReferenceDecisionSources.js';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const PHASES = {
  10: HORSE_PHASE10_POLICY_SOURCE_FILES,
  11: HORSE_PHASE11_POLICY_SOURCE_FILES,
  12: HORSE_PHASE12_POLICY_SOURCE_FILES,
  13: HORSE_PHASE13_POLICY_SOURCE_FILES,
};
const hashedByAll = (f: string) => Object.values(PHASES).every((list) => list.includes(f));

/** Relative runtime imports of one file (type-only imports excluded). */
function runtimeImports(rel: string): string[] {
  const file = path.join(serverRoot, rel);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const out: string[] = [];
  for (const st of source.statements) {
    let spec: string | null = null;
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
      spec = (st.moduleSpecifier as ts.StringLiteral).text;
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) {
      spec = (st.moduleSpecifier as ts.StringLiteral).text;
    }
    if (!spec || !spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
    if (!existsSync(target)) throw new Error(`unresolved ${spec} from ${rel}`);
    out.push(path.relative(serverRoot, target).split(path.sep).join('/'));
  }
  return out;
}

describe('the reference decision sources (digest hole closed 2026-10-16)', () => {
  it('every phase digest hashes every reference source', () => {
    for (const [phase, list] of Object.entries(PHASES))
      for (const file of HORSE_REFERENCE_DECISION_SOURCE_FILES)
        expect(list, `phase ${phase} ${file}`).toContain(file);
    for (const file of HORSE_REFERENCE_DECISION_SOURCE_FILES) {
      expect(existsSync(path.join(serverRoot, file)), file).toBe(true);
      expect(HORSE_REFERENCE_DECISION_SOURCE_REASONS[file].length).toBeGreaterThan(20);
    }
    for (const reason of Object.values(HORSE_REFERENCE_DECISION_EXCLUDED))
      expect(reason.length).toBeGreaterThan(20);
    for (const file of HORSE_REFERENCE_DECISION_BOUNDARY)
      expect(HORSE_REFERENCE_DECISION_SOURCE_FILES).toContain(file);
  });

  it('every runtime import of HorseLogic is hashed by every phase, a reference source, or named', () => {
    const imports = runtimeImports('src/engine/HorseLogic.ts');
    expect(imports.length).toBeGreaterThan(20);
    for (const file of imports)
      expect(
        hashedByAll(file) ||
          HORSE_REFERENCE_DECISION_SOURCE_FILES.includes(file) ||
          Object.hasOwn(HORSE_REFERENCE_DECISION_EXCLUDED, file),
        `${file} is decided-with by HorseLogic and bound by no digest`
      ).toBe(true);
    // The named exclusions are real imports or real closure files, not stale.
    const closure = referenceClosure();
    for (const file of Object.keys(HORSE_REFERENCE_DECISION_EXCLUDED))
      expect(imports.includes(file) || closure.includes(file), file).toBe(true);
  });

  it("the reference sources' own runtime closure is hashed by every phase, listed, or named", () => {
    for (const file of referenceClosure())
      expect(
        hashedByAll(file) ||
          HORSE_REFERENCE_DECISION_SOURCE_FILES.includes(file) ||
          Object.hasOwn(HORSE_REFERENCE_DECISION_EXCLUDED, file),
        `${file} is imported by a reference source and bound by no digest`
      ).toBe(true);
  });
});

/** Everything the reference sources import, not following the boundaries
 * or files every phase already hashes (their closure is that phase's test). */
function referenceClosure(): string[] {
  const seen = new Set<string>();
  const queue = [...HORSE_REFERENCE_DECISION_SOURCE_FILES];
  while (queue.length) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (HORSE_REFERENCE_DECISION_BOUNDARY.includes(rel)) continue;
    if (hashedByAll(rel) && !HORSE_REFERENCE_DECISION_SOURCE_FILES.includes(rel)) continue;
    if (rel === 'src/engine/HorseLogic.ts') continue;
    for (const target of runtimeImports(rel)) queue.push(target);
  }
  return [...seen].sort();
}
