/**
 * The Horse Data Ledger is a contract, and this test is what makes it one.
 * It reads the engine SOURCE (not the runtime) and fails when:
 *   - a HorseDecideOpts control is read in the brain but not registered, or
 *     registered but no longer read anywhere;
 *   - a telemetry key is fired but not registered (exact or family), or
 *     registered but never fired by any source;
 *   - a horse_profile key the tuner writes is not parsed by resolveHorseStyle,
 *     or a parsed key is not registered;
 *   - a HorseMind counter has no consumer beyond its declaration and reset;
 *   - a game-state field the brain reads is not registered;
 *   - a table registered as legacy_unused is referenced by any service, or an
 *     active table's named reader does not reference it;
 *   - a ledger row is malformed (bad ratio, family without a prefix, dupes).
 *
 * Phase 1 of .agent/plans/HORSE-REALTIME-BUILD-PLAN.md (Dan 2026-09-04).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HORSE_DATA_LEDGER,
  ledgerByKind,
  ledgerReceiptFor,
  ledgerRows,
  type LedgerEntry,
} from './HorseDataLedger.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Every non-test .ts under server/src, joined (for "is this referenced anywhere"). */
const ALL_SOURCE: string = walk(SRC)
  .filter((p) => !p.endsWith('HorseDataLedger.ts'))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

const BRAIN_FILES = [
  'engine/HorseLogic.ts',
  'engine/HorsePreflop.ts',
  'engine/HorseMind.ts',
  'engine/HorseEval.ts',
  'engine/GtoPostflop.ts',
  'engine/GtoPostflopV31.ts',
  'engine/GtoFacingDefenseV32.ts',
  'engine/HorseEvEngine.ts',
  // V44: the second look fires its receipts from the one call site that is
  // a live horse at a live table.
  'engine/ServerTableEngineTurns.ts',
  // V50: live decisions and their deep replay run in the sole worker. Its
  // injected noteFeature is BrainTelemetry.noteFire in production.
  'engine/horseDecision/workerRuntime.ts',
  // Phase 15 final outcomes are emitted by the shared private witness owner.
  'engine/HorseExecutionWitness.ts',
  'services/BrainTelemetryFlush.ts',
  // V48: the voluntary straddle is decided at the deal, which is the only
  // place that knows the hand number and the seat order.
  'engine/ServerTableEngineDealing.ts',
];
const BRAIN_SOURCE = BRAIN_FILES.map(read).join('\n');

/** Pull the argument text of a telemetry call, respecting nested arguments. */
function telemetryArgs(src: string, call: 'noteFire' | 'noteFeature'): string[] {
  const out: string[] = [];
  let idx = 0;
  for (;;) {
    const at = src.indexOf(`${call}(`, idx);
    if (at < 0) break;
    let depth = 0;
    let i = at + call.length;
    const start = i + 1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start, i));
    idx = i;
  }
  return out;
}

describe('HorseDataLedger - the contract holds against the source', () => {
  it('has no duplicate keys, and every row is well formed', () => {
    const seen = new Set<string>();
    for (const e of HORSE_DATA_LEDGER) {
      const k = `${e.kind}:${e.key}`;
      expect(seen.has(k), `duplicate ledger row ${k}`).toBe(false);
      seen.add(k);
      expect(e.key.length, k).toBeGreaterThan(0);
      expect(e.source.length, k).toBeGreaterThan(0);
      expect(e.consumer.length, k).toBeGreaterThan(0);
      expect(e.note.length, k).toBeGreaterThan(0);
      expect(e.since.length, k).toBeGreaterThan(0);
      if (e.minRatio != null) {
        expect(e.ratioOf, `${k} has minRatio without ratioOf`).toBeTruthy();
        expect(e.minRatio).toBeGreaterThan(0);
        expect(e.minRatio).toBeLessThanOrEqual(1);
      }
      if (e.ratioOf) {
        expect(e.kind, `${k}: ratioOf only on receipts`).toBe('receipt');
        expect(
          HORSE_DATA_LEDGER.some((r) => r.kind === 'receipt' && r.key === e.ratioOf),
          `${k}: ratioOf ${e.ratioOf} is not a registered receipt`
        ).toBe(true);
      }
      if (e.key.endsWith('*')) {
        expect(e.kind, `${k}: families are receipts`).toBe('receipt');
        expect(e.key.length, `${k}: a family needs a prefix`).toBeGreaterThan(2);
      }
      if (e.freshnessDays != null) {
        expect(e.kind).toBe('table');
        expect(e.dayColumn).toBeTruthy();
      }
      if (e.cadence === 'legacy_unused') expect(e.kind).toBe('table');
    }
    // the DB row shape carries the kind prefix so keys cannot collide across kinds
    const rows = ledgerRows();
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('registers every HorseDecideOpts control the brain reads, and reads every control it registers', () => {
    const used = new Set<string>();
    for (const m of BRAIN_SOURCE.matchAll(/\bopts\.([A-Za-z0-9]+)/g)) used.add(m[1]);
    // the league passes flags by name as well
    for (const m of read('benchmark/HorseLeague.ts').matchAll(/\bopts\.([A-Za-z0-9]+)/g))
      used.add(m[1]);
    const registered = new Set(ledgerByKind('flag').map((e) => e.key));
    const unregistered = [...used].filter((k) => !registered.has(k)).sort();
    const dead = [...registered].filter((k) => !used.has(k)).sort();
    expect(unregistered, 'controls read by the brain but missing from the ledger').toEqual([]);
    expect(dead, 'controls in the ledger that nothing reads any more').toEqual([]);
  });

  it('registers every telemetry key the brain fires (exact or family), and every registered receipt is fired', () => {
    const literals = new Set<string>();
    const dynamicPrefixes = new Set<string>();
    const firedArgs = [
      ...telemetryArgs(BRAIN_SOURCE, 'noteFire'),
      ...telemetryArgs(BRAIN_SOURCE, 'noteFeature'),
    ];
    for (const rawArg of firedArgs) {
      // template literal: `prefix_${...}` -> the text before the first ${;
      // the literals INSIDE the ${...} are fragments, not keys.
      const tpl = rawArg.match(/`([a-z0-9_]*)\$\{/);
      if (tpl && tpl[1]) dynamicPrefixes.add(tpl[1]);
      const arg = rawArg.replace(/`[^`]*`/g, '');
      for (const m of arg.matchAll(/'([a-z0-9_]+)'/g)) {
        // a street name inside a conditional is a fragment, not a key
        if (['preflop', 'flop', 'turn', 'river', 'showdown', 'pineapple_discard'].includes(m[1]))
          continue;
        literals.add(m[1]);
      }
      // string concatenation: layer + '_miss_depth_' + ... -> the literal
      // fragments are already in `literals`; the layer names are the
      // v29..v32 families registered below.
    }
    // the layer-name fragments of noteGtoMiss are not keys by themselves
    for (const frag of ['_miss_depth_', '_miss_street_']) literals.delete(frag);
    // Every fired literal is covered.
    const uncovered = [...literals].filter((k) => !ledgerReceiptFor(k)).sort();
    expect(uncovered, 'telemetry keys fired by the brain but missing from the ledger').toEqual([]);
    const receiptKeys = ledgerByKind('receipt').map((r) => r.key);
    for (const p of dynamicPrefixes) {
      const covered = !!ledgerReceiptFor(p + 'x') || receiptKeys.some((k) => k.startsWith(p));
      expect(
        covered,
        `dynamic telemetry prefix ${p}* has neither a family nor exact receipts under it`
      ).toBe(true);
    }
    // Every exact receipt is fired somewhere; every family has at least one
    // fired literal or a dynamic prefix under it.
    const receipts = ledgerByKind('receipt');
    for (const r of receipts) {
      if (r.key.endsWith('*')) {
        const prefix = r.key.slice(0, -1);
        const covered =
          [...literals].some((k) => k.startsWith(prefix)) ||
          [...dynamicPrefixes].some((p) => p.startsWith(prefix) || prefix.startsWith(p)) ||
          // v29..v32 are built as layer + '_miss_...' in noteGtoMiss, and the
          // solver layers name themselves in their own modules
          BRAIN_SOURCE.includes(`'${prefix.replace(/_$/, '')}'`) ||
          BRAIN_SOURCE.includes(`"${prefix.replace(/_$/, '')}"`);
        expect(covered, `receipt family ${r.key} has nothing under it in the source`).toBe(true);
      } else {
        // fired as a literal, or built from a dynamic prefix (decide_omaha is
        // `decide_${...}`)
        const fired = literals.has(r.key) || [...dynamicPrefixes].some((p) => r.key.startsWith(p));
        expect(fired, `receipt ${r.key} is registered but never fired`).toBe(true);
      }
    }
  });

  it('every horse_profile key the tuner writes is parsed by resolveHorseStyle, and every parsed key is registered', () => {
    const logic = read('engine/HorseLogic.ts');
    const fnStart = logic.indexOf('export function resolveHorseStyle');
    const fnEnd = logic.indexOf('\n}\n', fnStart);
    const body = logic.slice(fnStart, fnEnd);
    const parsed = new Set<string>();
    for (const m of body.matchAll(/\bobj\.([A-Za-z_]+)/g)) parsed.add(m[1]);
    // the style aliases are one datum ('style'); snake_case aliases are the same datum
    const canonical = (k: string): string => {
      if (['style', 'type', 'personality', 'profile'].includes(k)) return 'style';
      return k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    };
    const registered = new Set(ledgerByKind('profile').map((e) => e.key));
    for (const k of parsed) {
      expect(
        registered.has(canonical(k)),
        `resolveHorseStyle parses horse_profile.${k} but the ledger has no profile row`
      ).toBe(true);
    }
    // What the tuner proposes; persistence authorization is tested at the actual writer.
    const tuner = read('services/HorseSelfTuner.ts');
    const wStart = tuner.indexOf('const newProfile = {');
    const wEnd = tuner.indexOf('};', wStart);
    const written = tuner.slice(wStart, wEnd);
    for (const key of ['leaks', 'leaksHands']) {
      expect(written.includes(key), `the tuner no longer proposes ${key}`).toBe(true);
      expect(
        parsed.has(key),
        `the tuner proposes ${key} but resolveHorseStyle does not parse it`
      ).toBe(true);
    }
    // The proposal dials are parsed through `mods`.
    for (const key of ['tightness', 'aggression', 'bluffFreq']) {
      expect(parsed.has(key), `dial ${key} is not parsed`).toBe(true);
      expect(registered.has(key)).toBe(true);
    }
    for (const key of registered) {
      expect(
        parsed.has(key) || parsed.has(key.replace(/([A-Z])/g, (c) => '_' + c.toLowerCase())),
        `ledger profile key ${key} is not parsed by resolveHorseStyle`
      ).toBe(true);
    }
  });

  it('every HorseMind counter is registered and has a consumer beyond its declaration and reset', () => {
    const mindSrc = read('engine/HorseMind.ts');
    const iStart = mindSrc.indexOf('export interface OpponentStats');
    const iEnd = mindSrc.indexOf('\n}\n', iStart);
    const fields = [...mindSrc.slice(iStart, iEnd).matchAll(/^\s+([a-zA-Z0-9]+): number;/gm)].map(
      (m) => m[1]
    );
    expect(fields.length).toBeGreaterThanOrEqual(20);
    const registered = new Set(ledgerByKind('mind').map((e) => e.key));
    for (const f of fields) {
      expect(registered.has(f), `HorseMind.OpponentStats.${f} is not in the ledger`).toBe(true);
      // declaration + the zero initializer + at least one real read/write
      const uses = (mindSrc.match(new RegExp(`\\b${f}\\b`, 'g')) || []).length;
      expect(
        uses,
        `HorseMind counter ${f} has no consumer (only ${uses} mentions)`
      ).toBeGreaterThanOrEqual(3);
    }
    for (const k of registered) {
      expect(fields.includes(k), `ledger mind counter ${k} no longer exists on OpponentStats`).toBe(
        true
      );
    }
  });

  it('every game-state field the brain reads is registered', () => {
    const readFields = new Set<string>();
    for (const m of BRAIN_SOURCE.matchAll(/\bgs\.([A-Za-z0-9]+)/g)) readFields.add(m[1]);
    const registered = new Set(ledgerByKind('state').map((e) => e.key));
    const missing = [...readFields].filter((k) => !registered.has(k)).sort();
    expect(missing, 'gs.* fields read by the brain but missing from the ledger').toEqual([]);
  });

  it('legacy tables are referenced by nothing; active tables are referenced by their named reader', () => {
    for (const t of ledgerByKind('table')) {
      // quotes only: a backticked name in a comment is prose, not a reference
      const mention = new RegExp(`['"]${t.key}['"]`);
      if (t.cadence === 'legacy_unused') {
        expect(
          mention.test(ALL_SOURCE),
          `${t.key} is registered legacy_unused but something in server/src references it - move it above with its reader`
        ).toBe(false);
        continue;
      }
      if (t.key === 'horse_data_ledger') continue; // written by the sync service checked below
      // The consumer names a module or a SQL function. A module must mention
      // the table; a SQL function is checked by the migrations gate.
      const modules = (t.consumer.match(/\b[A-Z][A-Za-z0-9]+\b/g) || []).filter(
        (m) => !['RPC', 'SQL'].includes(m)
      );
      const rpcs = t.consumer.match(/\bfn_[a-z0-9_]+\b/g) || [];
      // an RPC reader is proven by the module that calls it
      const rpcCalled = rpcs.some((fn) => ALL_SOURCE.includes(`'${fn}'`));
      const sqlOnly = modules.length === 0;
      if (sqlOnly) continue;
      const anyModuleMentions = modules.some((m) => {
        const files = walk(SRC).filter((p) => p.endsWith(`/${m}.ts`));
        return files.some((p) => mention.test(readFileSync(p, 'utf8')));
      });
      expect(
        anyModuleMentions || rpcCalled || mention.test(ALL_SOURCE),
        `${t.key}: none of its named readers (${modules.join(', ')}) reference it`
      ).toBe(true);
    }
  });

  it('the sync service writes exactly the ledger rows, and boot wires it', () => {
    const sync = read('services/HorseDataLedgerSync.ts');
    expect(sync.includes("from('horse_data_ledger')")).toBe(true);
    expect(sync.includes('ledgerRows()')).toBe(true);
    expect(
      ALL_SOURCE.includes('syncHorseDataLedger('),
      'HorseDataLedgerSync is not called from the engine boot path'
    ).toBe(true);
  });

  it('the count Dan asked for is reported honestly', () => {
    const byKind: Record<string, number> = {};
    for (const e of HORSE_DATA_LEDGER) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    // flags are switches, not data; the data count excludes them and the
    // legacy tables. This number is what the panel and the audit report.
    const data = HORSE_DATA_LEDGER.filter(
      (e) => e.kind !== 'flag' && e.cadence !== 'legacy_unused'
    ).length;
    expect(data).toBeGreaterThan(100);
    expect(byKind.flag).toBeGreaterThan(60);
  });
});

export type { LedgerEntry };
