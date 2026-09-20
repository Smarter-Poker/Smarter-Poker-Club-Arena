/**
 * LAW: the Diamond tournament lifecycle cases run against production's own
 * trigger chain, and the fixture never opens an arena switch to make a case
 * pass.
 * ═══════════════════════════════════════════════════════════════════════════
 * `the-diamond-tournament-doors-are-the-installed-doors` holds the 79 doors
 * the Diamond tournament money path CALLS. This law holds the second half: the
 * 22 functions production FIRES when the create door writes its row, and the
 * lifecycle cases built on top of them.
 *
 * The historical base and production disagree there. Measured read-only on
 * 2026-09-20: production attaches 60 triggers to public.tournaments naming 58
 * distinct functions; 34 are byte-identical in the base, 13 render to
 * different text and 11 are absent. A fixture loaded against the base alone
 * would certify a creation guard 165 bytes shorter than the installed one and
 * would never run nine refusals production runs.
 *
 * This law holds the arrangement from the repository side alone - it opens no
 * database and needs no credential:
 *
 *   1. every `-- @@PIN md5=` in the lifecycle capture equals the md5 of the
 *      definition printed under it, so the file cannot be hand-edited and stay
 *      valid, and its manifest names exactly those doors;
 *   2. the trigger definitions the capture installs are the ones its manifest
 *      records, and every trigger production carries that the capture does NOT
 *      install is named in the manifest with its reason - a trigger cannot
 *      drop out of the fixture quietly;
 *   3. the runner loads the base, both deltas, both captures, the seed and the
 *      cases, in that order, and nothing else;
 *   4. NEITHER ARENA SWITCH IS EVER OPENED. No fixture file under tests/sql
 *      that this runner loads may set cash_games_enabled or tournaments_enabled
 *      true, and the runner must assert both are closed when the cases finish.
 *      The arena's release gate is Dan's to open, never a fixture's, and the
 *      closed switch is itself the thing case 6 asserts;
 *   5. no md5 comparison in the lifecycle capture has been turned into a
 *      comparison against NULL - the same assertion the first law carries, on
 *      the second file.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SQL = join(ROOT, 'tests', 'sql');
const CAPTURE = join(SQL, 'diamond-tournament-lifecycle-doors.sql');
const MANIFEST = join(SQL, 'diamond-tournament-lifecycle-doors.manifest.json');
const RUNNER = join(SQL, 'run-diamond-tournament-lifecycle.py');
const SEED = join(SQL, 'diamond-tournament-lifecycle-seed.sql');
const CASES = join(SQL, 'diamond-tournament-lifecycle-cases.sql');
const DELTA = join(SQL, 'diamond-tournament-lifecycle-schema.sql');

/** The files the runner loads, in the order it must load them. */
const LOAD_ORDER = [
  '00-roles.sql',
  '10-historical-schema.sql',
  'diamond-tournament-fixture-schema.sql',
  'diamond-tournament-doors-captured.sql',
  'diamond-tournament-lifecycle-schema.sql',
  'diamond-tournament-lifecycle-doors.sql',
  'diamond-tournament-lifecycle-seed.sql',
  'diamond-tournament-lifecycle-cases.sql',
];

interface Door {
  identity: string;
  md5: string;
  len: number;
  body: string;
}

function readDoors(): Door[] {
  const text = readFileSync(CAPTURE, 'utf8');
  const re =
    /-- @@DOOR ([^\n]+)\n-- @@PIN md5=([0-9a-f]{32}) len=(\d+) owner=\S+\n([\s\S]*?);\nALTER FUNCTION /g;
  const out: Door[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ identity: m[1], md5: m[2], len: Number(m[3]), body: `${m[4]}\n` });
  }
  return out;
}

describe('the Diamond tournament lifecycle runs the installed doors', () => {
  const doors = readDoors();
  const capture = readFileSync(CAPTURE, 'utf8');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    doors: { identity: string; md5: string; bytes_from: string }[];
    tournaments_trigger_definitions_installed_here: string[];
    tournaments_triggers_named_and_not_installed: string[];
    tournaments_triggers_dropped_from_the_base: string[];
  };

  it('carries the trigger-chain doors the base does not already have', () => {
    expect(doors.length).toBeGreaterThanOrEqual(20);
  });

  it('every captured door matches the md5 pinned above it', () => {
    const wrong = doors.filter(
      (d) => createHash('md5').update(d.body).digest('hex') !== d.md5 || d.body.length !== d.len
    );
    expect(wrong.map((d) => d.identity)).toEqual([]);
  });

  it('the manifest names exactly the doors the capture carries, and where each came from', () => {
    expect(manifest.doors.map((d) => d.identity).sort()).toEqual(
      doors.map((d) => d.identity).sort()
    );
    expect(manifest.doors.map((d) => d.md5).sort()).toEqual(doors.map((d) => d.md5).sort());
    for (const d of manifest.doors) {
      expect(d.bytes_from.length, `${d.identity} needs a provenance, not a blank`).toBeGreaterThan(
        8
      );
    }
  });

  it('installs exactly the triggers its manifest records, and names the ones it does not', () => {
    const installed = [...capture.matchAll(/^CREATE TRIGGER [^\n]+?(?=;$)/gm)].map((m) => m[0]);
    expect(installed.sort()).toEqual(
      manifest.tournaments_trigger_definitions_installed_here.slice().sort()
    );
    // Every trigger production carries that this fixture does NOT stand up is
    // named with its reason, and so is every base trigger it drops.
    expect(manifest.tournaments_triggers_named_and_not_installed.length).toBeGreaterThan(0);
    for (const line of [
      ...manifest.tournaments_triggers_named_and_not_installed,
      ...manifest.tournaments_triggers_dropped_from_the_base,
    ]) {
      expect(line, 'a trigger left out needs its reason in brackets').toMatch(/\(.+\)/);
    }
  });

  it('the runner loads the base, both deltas, both captures, the seed and the cases, in order', () => {
    const runner = readFileSync(RUNNER, 'utf8');
    const block = /\nLOAD = \[([\s\S]*?)\n\]/.exec(runner);
    expect(block, 'the runner must declare its load list as LOAD = [ ... ]').not.toBeNull();
    const listed = [...(block as RegExpExecArray)[1].matchAll(/'([^']+\.sql)'/g)].map((m) => m[1]);
    expect(listed).toEqual(LOAD_ORDER);
  });

  it('no fixture file this runner loads ever opens an arena switch', () => {
    const offenders: string[] = [];
    for (const file of [DELTA, CAPTURE, SEED, CASES]) {
      const sql = readFileSync(file, 'utf8');
      // Any write that could set either switch true, in any statement shape.
      if (
        /(?:cash_games_enabled|tournaments_enabled)\s*(?::?=)\s*(?:true|'t')/i.test(sql) ||
        /\bSET\b[^;]*\b(?:cash_games_enabled|tournaments_enabled)\s*=\s*(?:true|'t')/i.test(sql)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the runner refuses to pass if a switch is open when the cases finish', () => {
    const runner = readFileSync(RUNNER, 'utf8');
    expect(runner).toContain('cash_games_enabled OR tournaments_enabled');
    expect(runner).toContain('the fixture opened an arena switch; it must never do that');
  });

  it('no md5 comparison in the lifecycle capture is a comparison against NULL', () => {
    expect(/md5\s*\([^)]*\)\s*(?:<>|=|IS(?:\s+NOT)?\s+DISTINCT\s+FROM)\s*NULL/i.test(capture)).toBe(
      false
    );
  });
});
