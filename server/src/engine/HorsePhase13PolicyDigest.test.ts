/**
 * The Phase 13 policy digest hashes every runtime file that can change a
 * Phase 13 joint proposal, its legal form, or whether it may act. The list is
 * checked against the actual transitive runtime import closure of every
 * non-test owner under src/engine/multiway/ (type-only imports excluded), so a
 * new runtime import fails here until it is either hashed or excluded with a
 * reason.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  HORSE_PHASE13_POLICY_BOUNDARY,
  HORSE_PHASE13_POLICY_DIGEST_DEFINITION,
  HORSE_PHASE13_POLICY_EXCLUDED_CLOSURE_FILES,
  HORSE_PHASE13_POLICY_SOURCE_FILES,
  HORSE_PHASE13_POLICY_SOURCE_REASONS,
  horsePhase13PolicyDigest,
  horsePhase13PolicyDigestOf,
  runningPhase13PolicySourceReader,
} from './HorsePhase13PolicyDigest.js';
import { JOINT_VARIANTS, type JointVariant } from './multiway/JointInputBinding.js';
import { KNOWN_VARIANTS } from './VariantRules.js';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));

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
    if (HORSE_PHASE13_POLICY_BOUNDARY.includes(rel)) continue;
    for (const spec of runtimeImports(file)) {
      const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
      if (!existsSync(target)) throw new Error(`unresolved ${spec} from ${rel}`);
      queue.push(target);
    }
  }
  return [...seen].sort();
}
/** Every non-test owner of the joint policy. */
const MULTIWAY_OWNERS = readdirSync(path.join(serverRoot, 'src/engine/multiway'))
  .filter((f) => f.endsWith('.ts') && !f.includes('.test'))
  .map((f) => `src/engine/multiway/${f}`)
  .sort();

describe('P13.3 Phase 13 policy digest', () => {
  it('hashes every joint owner, and hashes or names every other runtime closure file', () => {
    expect(MULTIWAY_OWNERS).toHaveLength(13);
    const hashed = new Set(HORSE_PHASE13_POLICY_SOURCE_FILES);
    for (const owner of MULTIWAY_OWNERS) expect(hashed.has(owner), owner).toBe(true);
    const closure = runtimeClosure(MULTIWAY_OWNERS);
    expect(closure).toHaveLength(42);
    const excluded = new Set(Object.keys(HORSE_PHASE13_POLICY_EXCLUDED_CLOSURE_FILES));
    for (const file of closure)
      expect(hashed.has(file) !== excluded.has(file), `${file} hashed xor excluded`).toBe(true);
    // Every excluded file and every boundary is really in the closure.
    for (const file of excluded) expect(closure).toContain(file);
    for (const file of HORSE_PHASE13_POLICY_BOUNDARY) expect(closure).toContain(file);
    // Beyond the closure: the owner that invokes and legalizes the policy, and
    // the registry that routes every variant through it.
    expect([...hashed].filter((f) => !closure.includes(f)).sort()).toEqual([
      'src/engine/HorseLogic.ts',
      'src/engine/HorsePolicyRegistry.ts',
    ]);
    expect(hashed.size).toBe(32);
  });

  it('never reaches the table controller or the database client', () => {
    // P13.3: JointDeductions imported the two pot-scaling helpers from
    // HandController, which pulled the controller and, through it, the
    // Supabase client into the joint owner (and into the offline completion
    // reader, which then never exited). The helpers now live in
    // WinnerUnitScaling.ts, which imports nothing.
    const closure = runtimeClosure(MULTIWAY_OWNERS);
    expect(closure).toContain('src/engine/WinnerUnitScaling.ts');
    expect(closure).not.toContain('src/engine/HandController.ts');
    expect(closure.filter((f) => f.startsWith('src/services/'))).toEqual([]);
    expect(runtimeImports(path.join(serverRoot, 'src/engine/WinnerUnitScaling.ts'))).toEqual([]);
  });

  it('a boundary hashed for one function reads no imported binding in it', () => {
    const imported = (source: string) =>
      [...source.matchAll(/^import\s+(?!type)[^;]*?\{([^}]*)\}/gms)].flatMap((m) =>
        m[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith('type '))
          .map((s) => s.split(/\s+as\s+/).pop()!)
      );
    // HorseTournamentUtility: buildTournamentActionCandidates and its helper.
    const utility = readFileSync(
      path.join(serverRoot, 'src/engine/HorseTournamentUtility.ts'),
      'utf8'
    );
    const start = utility.indexOf('function uniqueCandidate');
    const builder = utility.slice(
      start,
      utility.indexOf('\n}\n', utility.indexOf('export function buildTournamentActionCandidates'))
    );
    expect(start).toBeGreaterThan(0);
    for (const name of imported(utility))
      expect(new RegExp(`\\b${name}\\b`).test(builder), `candidate builder reads ${name}`).toBe(
        false
      );
  });

  it('names the files the brief requires and gives every file a reason', () => {
    for (const file of [
      'src/engine/HorseLogic.ts',
      'src/engine/HorsePolicyRegistry.ts',
      'src/engine/BettingStructure.ts',
      'src/engine/VariantRules.ts',
      'src/engine/WinnerUnitScaling.ts',
      'src/engine/HorseTournamentUtility.ts',
    ])
      expect(HORSE_PHASE13_POLICY_SOURCE_FILES).toContain(file);
    for (const file of HORSE_PHASE13_POLICY_SOURCE_FILES) {
      expect(HORSE_PHASE13_POLICY_SOURCE_REASONS[file].length).toBeGreaterThan(20);
      expect(existsSync(path.join(serverRoot, file))).toBe(true);
    }
    for (const reason of Object.values(HORSE_PHASE13_POLICY_EXCLUDED_CLOSURE_FILES))
      expect(reason.length).toBeGreaterThan(20);
    expect(HORSE_PHASE13_POLICY_DIGEST_DEFINITION).toBe('horse-phase13-policy-digest-v1');
  });

  it('gives each of the nine variants its own digest, moves with any hashed byte, and fails closed', () => {
    expect([...JOINT_VARIANTS].sort()).toEqual([...KNOWN_VARIANTS].sort());
    const digests = JOINT_VARIANTS.map((v) => horsePhase13PolicyDigest(v));
    for (const d of digests) expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(digests).size).toBe(9);
    for (const v of JOINT_VARIANTS)
      expect(horsePhase13PolicyDigestOf(v, runningPhase13PolicySourceReader)).toBe(
        horsePhase13PolicyDigest(v)
      );
    const edited = (target: string) => (file: string) =>
      file === target
        ? Buffer.concat([runningPhase13PolicySourceReader(file), Buffer.from('\n')])
        : runningPhase13PolicySourceReader(file);
    for (const file of [
      'src/engine/multiway/JointResponseTree.ts',
      'src/engine/WinnerUnitScaling.ts',
      'src/engine/HorseLogic.ts',
      'src/engine/BettingStructure.ts',
      'src/config/rakeSpec.ts',
    ])
      expect(horsePhase13PolicyDigestOf('nlh', edited(file))).not.toBe(
        horsePhase13PolicyDigest('nlh')
      );
    // An excluded file, or the controller itself, never moves it.
    expect(horsePhase13PolicyDigestOf('nlh', edited('src/engine/HandController.ts'))).toBe(
      horsePhase13PolicyDigest('nlh')
    );
    expect(horsePhase13PolicyDigestOf('nlh', edited('src/engine/HorseMind.ts'))).toBe(
      horsePhase13PolicyDigest('nlh')
    );
    expect(
      horsePhase13PolicyDigestOf('plo4', (file) => {
        if (file.endsWith('JointDeductions.ts')) throw new Error('unreadable');
        return runningPhase13PolicySourceReader(file);
      })
    ).toBeNull();
    expect(horsePhase13PolicyDigestOf('stud' as JointVariant, () => Buffer.from(''))).toBeNull();
  });
});
