/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: EVERY RESTART BLOCKER DECLARES ITS BOUND (2026-09-26)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Almost every release blocker of the week of 2026-09-20 had one shape: a
 * reason the restart census reported as "not yet" when the truth was "never"
 * (CLAUDE.md 10.86 rule 1) -
 *
 *   f06_preparation_unresolved       70 breaks on 8825af51, bounded in #4909
 *   the retained-preparation loop    same class, left unbounded, 2026-09-21
 *   stopped_bank_custody_unconfirmed 137 -> 187 tables on 778075b4, 2026-09-25
 *   terminalBoundaryPendingGenerations  the same shape one layer down
 *
 * Each was bounded one incident at a time, after it had already wedged every
 * release. This law makes the bound something a reason must DECLARE before it
 * can ship. It derives the reasons from the code - every `count(...)` in
 * `MaintenanceBreak.unparkedTables()`, every fallback literal there, and every
 * literal the engines' `maintenanceDurabilityReason()` can return - rather
 * than from a list written here, because a hard-coded enumeration is exactly
 * what missed a packaged helper earlier the same week. Each derived reason
 * must be a key of `MaintenanceBreak.UNPARKED_REASON_BOUNDS` (or the declared
 * never-name of one), and:
 *
 *   - a reason the census asks of a NON-RUNNING engine (above the
 *     `if (!engine.isRunning()) continue` skip, or in the retained-preparation
 *     loop) must be scope 'lifetime': no dealing loop will ever resolve it, so
 *     it needs a finite bound and a distinct never-name, plus an explicit
 *     `neverHoldsGate` saying whether the never outcome still refuses;
 *   - a scope 'break' reason is a fact about a live loop within one break,
 *     and its never outcome is the break ending uncertified
 *     (`breaksSinceRestartCertified`), which is already its own number;
 *   - every lifetime reason is DRIVEN past its bound here and must change to
 *     its never-name with exactly the gate verdict it declares;
 *   - every declared name is zero-seeded on /metrics so a rule can read it
 *     the first time it matters.
 *
 * NEGATIVE PROOF is built in: the same audit is run over a copy of the census
 * with an unbounded reason planted above the skip, and over an engine that
 * returns an undeclared reason, and must report both.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MaintenanceBreak, type UnparkedReasonBound } from './MaintenanceBreak.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');
const BREAK_SRC = read('./MaintenanceBreak.ts');
const GAMESERVER_SRC = read('../GameServer.ts');
const REGISTRY = MaintenanceBreak.UNPARKED_REASON_BOUNDS as Record<string, UnparkedReasonBound>;

function engineSources(): string[] {
  const dir = resolve(here, '../engine');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => readFileSync(join(dir, f), 'utf8'));
}

/** Every string literal an engine's maintenanceDurabilityReason() can return. */
function engineReasons(sources: string[]): string[] {
  const out = new Set<string>();
  for (const src of sources) {
    let at = src.indexOf('maintenanceDurabilityReason(): string | null {');
    while (at !== -1) {
      const end = src.indexOf('\n  }\n', at);
      const body = src.slice(at, end === -1 ? undefined : end);
      for (const m of body.matchAll(/return '([a-z][a-z0-9_]*)'/g)) out.add(m[1]);
      at = src.indexOf('maintenanceDurabilityReason(): string | null {', at + 1);
    }
  }
  return [...out].sort();
}

function censusBody(src: string): string {
  const start = src.indexOf('private unparkedTables(): string[] {');
  if (start === -1) return '';
  return src.slice(start, src.indexOf('\n    return out;', start));
}

type Audit = { reasons: string[]; violations: string[] };

/** Every `count(<arg>)` call with its balanced argument text and offset. */
function countCalls(body: string): Array<{ arg: string; at: number }> {
  const out: Array<{ arg: string; at: number }> = [];
  const re = /(?<![A-Za-z0-9_.])count\(/g;
  for (const m of body.matchAll(re)) {
    const open = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = open;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    out.push({ arg: body.slice(open, i - 1).trim(), at: m.index ?? 0 });
  }
  return out;
}

/** The whole law as one pure function, so it can be run over planted sources. */
function audit(
  breakSrc: string,
  engines: string[],
  registry: Record<string, UnparkedReasonBound>
): Audit {
  const violations: string[] = [];
  const body = censusBody(breakSrc);
  if (!body) return { reasons: [], violations: ['the census unparkedTables() was not found'] };
  const skipAt = body.indexOf('if (!engine.isRunning()) continue;');
  if (skipAt === -1) violations.push('the running-engine skip was not found in the census');
  const fromEngines = engineReasons(engines);
  if (fromEngines.length === 0)
    violations.push('no engine maintenanceDurabilityReason() literals were found');

  const lifetimeNevers = new Map<string, UnparkedReasonBound>();
  for (const [key, b] of Object.entries(registry))
    if (b.scope === 'lifetime') lifetimeNevers.set(b.never, b);
  const declared = (r: string) => r in registry || lifetimeNevers.has(r);
  const lifetime = (r: string) => registry[r]?.scope === 'lifetime' || lifetimeNevers.has(r);

  const reasons = new Set<string>(fromEngines);
  // Every count(...) call: a literal, or an identifier/expression whose
  // provenance is the engine's own answer.
  for (const { arg, at } of countCalls(body)) {
    const beforeSkip = skipAt === -1 || at < skipAt;
    const lit = /^'([a-z][a-z0-9_]*)'$/.exec(arg);
    if (lit) {
      reasons.add(lit[1]);
      if (beforeSkip && !lifetime(lit[1]))
        violations.push(
          `${lit[1]}: asked of a non-running engine but not declared scope 'lifetime'`
        );
      continue;
    }
    if (arg === 'custodyReason') {
      // Derived from the engine's stopped_bank_custody_* answers.
      const custody = fromEngines.filter((r) => r.startsWith('stopped_bank_custody_'));
      if (custody.length === 0)
        violations.push('custodyReason has no engine answers to derive from');
      for (const r of custody)
        if (!lifetime(r))
          violations.push(`${r}: a terminal-engine custody answer not declared scope 'lifetime'`);
      continue;
    }
    if (/^engine\.maintenanceDurabilityReason\?\.\(\) \?\? '([a-z_]+)'$/.test(arg)) {
      if (beforeSkip) violations.push(`${arg}: engine durability asked of a non-running engine`);
      continue;
    }
    if (arg === 'reason') continue; // the count helper's own parameter
    violations.push(`count(${arg}): a reason whose provenance this law cannot derive`);
  }
  // Fallback literals (?? 'x' and the custody ternary's refusing default).
  for (const m of body.matchAll(/\?\? '([a-z][a-z0-9_]*)'/g)) reasons.add(m[1]);
  for (const m of body.matchAll(/:\s*'([a-z][a-z0-9_]*)';/g)) reasons.add(m[1]);
  // Every reason that can reach unparkedReasons has a declaration.
  for (const r of reasons)
    if (!declared(r)) violations.push(`${r}: not declared in UNPARKED_REASON_BOUNDS`);
  // Every declaration is well-formed.
  for (const [key, b] of Object.entries(registry)) {
    if (b.scope === 'break') {
      if (b.never !== 'break_uncertified')
        violations.push(`${key}: a break reason's never is the uncertified break`);
      continue;
    }
    if (!Number.isSafeInteger(b.boundMs) || b.boundMs <= 0)
      violations.push(`${key}: no finite positive bound`);
    if (!b.never || b.never === key || b.never in registry)
      violations.push(`${key}: its never-name must be distinct from every live reason`);
    if (typeof b.neverHoldsGate !== 'boolean')
      violations.push(`${key}: neverHoldsGate is not declared`);
  }
  return { reasons: [...reasons].sort(), violations };
}

// ── fixtures for driving the census ────────────────────────────────────────
type Engine = Record<string, () => unknown>;
const table = (over: Engine = {}): Engine => ({
  isRunning: () => true,
  isBetweenHands: () => true,
  isParkedBetweenHands: () => true,
  pauseForMaintenance: () => undefined,
  resumeFromMaintenance: () => undefined,
  isMaintenanceStateDurable: () => true,
  maintenanceDurabilityReason: () => null,
  ...over,
});
/** How the census reaches each lifetime reason. A new lifetime reason needs one. */
const lifetimeFixture = (reason: string): Engine | null => {
  if (reason.startsWith('stopped_bank_custody_'))
    return table({
      isRunning: () => false,
      hasUnretiredStoppedTimeBankCustody: () => true,
      isMaintenanceStateDurable: () => false,
      maintenanceDurabilityReason: () => reason,
    });
  if (reason === 'f06_preparation_unresolved')
    return table({ isRunning: () => false, hasUnresolvedF06Preparation: () => true });
  return null;
};
function atClock(engines: Array<[string, Engine]>) {
  let clock = 5_000_000;
  const mb = new MaintenanceBreak({
    engines: () => new Map(engines) as never,
    isRunning: () => true,
    now: () => clock,
  } as never);
  Object.assign(mb as never, { phase: 'counting_down', durableConfirmed: true });
  return { mb, advance: (ms: number) => (clock += ms) };
}

describe('every restart blocker declares its bound', () => {
  const real = audit(BREAK_SRC, engineSources(), REGISTRY);

  it('derives the reasons from the code, and finds the ones this week was about', () => {
    // Not the source of truth - a floor that proves the derivation still sees.
    for (const r of [
      'cards_in_air',
      'f06_preparation_unresolved',
      'f06_preparation_stuck',
      'stopped_bank_custody_unwritten',
      'stopped_bank_custody_unreadable',
      'stopped_bank_custody_stuck',
      'bank_park_write_incomplete',
    ])
      expect(real.reasons, r).toContain(r);
  });

  it('every derived reason is declared, and every declaration is well-formed', () => {
    expect(real.violations).toEqual([]);
  });

  it('drives every lifetime reason past its bound to its declared verdict', () => {
    const lifetimes = Object.entries(REGISTRY).filter(([, b]) => b.scope === 'lifetime');
    expect(lifetimes.length).toBeGreaterThanOrEqual(3);
    for (const [key, b] of lifetimes) {
      if (b.scope !== 'lifetime') continue;
      const blocker = lifetimeFixture(key);
      expect(blocker, `${key} needs a fixture proving its bound`).not.toBeNull();
      const { mb, advance } = atClock([
        ['blocker', blocker!],
        ['ok', table()],
      ]);
      const snap1 = mb.snapshot();
      expect(snap1.unparkedTables, `${key} holds inside its bound`).toBe(1);
      expect(snap1.unparkedReasons, key).toMatchObject({ [key]: 1 });
      advance(b.boundMs - 1);
      expect(mb.snapshot().unparkedReasons, `${key} at its bound`).toMatchObject({ [key]: 1 });
      advance(2);
      const snap2 = mb.snapshot();
      expect(snap2.unparkedReasons, `${key} past its bound`).toMatchObject({ [b.never]: 1 });
      expect(snap2.unparkedReasons ?? {}, key).not.toHaveProperty(key);
      expect(snap2.unparkedTables, `${key} never holds: ${b.neverHoldsGate}`).toBe(
        b.neverHoldsGate ? 1 : 0
      );
    }
  });

  it('seeds every declared name on /metrics', () => {
    const start = GAMESERVER_SRC.indexOf('# TYPE poker_maintenance_unparked_tables gauge');
    expect(start).toBeGreaterThan(-1);
    const seed = GAMESERVER_SRC.slice(start, GAMESERVER_SRC.indexOf('];', start));
    const names = new Set<string>();
    for (const [key, b] of Object.entries(REGISTRY)) {
      names.add(key);
      if (b.scope === 'lifetime') names.add(b.never);
    }
    for (const n of names) expect(seed, n).toContain(`'${n}',`);
  });

  // ── NEGATIVE PROOF ──────────────────────────────────────────────────────
  it('goes red for an unbounded reason planted above the running skip', () => {
    const skip = 'if (!engine.isRunning()) continue;';
    const planted = BREAK_SRC.replace(
      skip,
      `if (engine.hasPlantedStall?.()) { out.push(tableId); count('planted_unbounded'); continue; }\n        ${skip}`
    );
    expect(planted).not.toBe(BREAK_SRC);
    const v = audit(planted, engineSources(), REGISTRY).violations.join('\n');
    expect(v).toContain('planted_unbounded: asked of a non-running engine');
    expect(v).toContain('planted_unbounded: not declared');
  });

  it('goes red for an engine that invents an undeclared reason', () => {
    const engines = [
      ...engineSources(),
      "class X {\n  maintenanceDurabilityReason(): string | null {\n    return 'planted_engine_reason';\n  }\n}\n",
    ];
    const v = audit(BREAK_SRC, engines, REGISTRY).violations.join('\n');
    expect(v).toContain('planted_engine_reason: not declared');
  });

  it('goes red for a lifetime declaration with no bound or no distinct never', () => {
    const bad = {
      ...REGISTRY,
      stopped_bank_custody_unwritten: {
        scope: 'lifetime',
        boundMs: Number.POSITIVE_INFINITY,
        never: 'stopped_bank_custody_unwritten',
        neverHoldsGate: true,
      },
    } as Record<string, UnparkedReasonBound>;
    const v = audit(BREAK_SRC, engineSources(), bad).violations.join('\n');
    expect(v).toContain('stopped_bank_custody_unwritten: no finite positive bound');
    expect(v).toContain('stopped_bank_custody_unwritten: its never-name must be distinct');
  });

  it('keeps every bank and custody name out of the release allow-list', () => {
    const sh = read('../../scripts/engine-release-transaction.sh');
    const allow = sh.match(/^PREPARATION_ONLY=\{(.*)\}$/m);
    expect(allow, 'the allow-list must stay a literal set').toBeTruthy();
    expect(allow![1]).not.toMatch(/bank|custody/);
  });
});
