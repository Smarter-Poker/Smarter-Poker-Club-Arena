/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEASE ENFORCEMENT — PINNED ON. This test is the reason it cannot drift off.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-20 at 23:48Z, two engine instances dealt table eab2e2e1
 * SIMULTANEOUSLY during a deploy overlap, with a HUMAN seated: hands completed
 * in 3.8 seconds, his all-in with KK resolved with no flop ever shown, turns
 * skipped, pots teleported. Enforcement existed and was off, pending evidence.
 * That was the evidence.
 *
 * Dan, the next morning: "obviously you need to have safe guards in place to
 * prevent that from happening ever again, two dealers at one table smh."
 *
 * Three layers now stand between the platform and a recurrence:
 *   1. LEASE_ENFORCED defaults ON            — pinned by THIS test
 *   2. shutdown releases leases (GameServer) — pinned below
 *   3. a DB detector alerts on overlapping   — pages/api/cron/spin-sweep.js
 *      hands per table (World Hub cron)        in the World Hub repo
 *
 * If someone needs enforcement off in an emergency, ENGINE_LEASE_ENFORCE=off
 * exists — as a deliberate, environment-level act, never a quiet code edit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const LEASE = readFileSync(path.join(process.cwd(), 'src/services/tableLease.ts'), 'utf8');
const GAME_SERVER = code(readFileSync(path.join(process.cwd(), 'src/GameServer.ts'), 'utf8'));

describe('two dealers at one table can never happen again', () => {
  it('enforcement is opt-OUT, not opt-in', () => {
    // The exact expression matters: `!== 'off'` is on-by-default;
    // `=== 'on'` was the four-day evidence mode that let 23:48Z happen.
    expect(code(LEASE)).toMatch(
      /LEASE_ENFORCED\s*:\s*boolean\s*=\s*process\.env\.ENGINE_LEASE_ENFORCE\s*!==\s*'off'/
    );
    expect(code(LEASE)).not.toMatch(/ENGINE_LEASE_ENFORCE\s*===\s*'on'/);
  });

  it('a lost lease tears the engine down, not just logs', () => {
    // The discovery loop must stop() the engine and drop it from the map for
    // every table heartbeatTables() reports lost.
    const i = GAME_SERVER.indexOf('heartbeatTables([...this.tableEngines.keys()])');
    expect(i, 'lease renewal missing from discovery loop').toBeGreaterThan(-1);
    const block = sliceEnclosingBlock(GAME_SERVER, 'heartbeatTables([...this.tableEngines.keys()])');
    expect(block).toMatch(/engine\.stop\(\)/);
    expect(block).toMatch(/this\.tableEngines\.delete\(/);
  });

  it('starting a table asks for the lease first', () => {
    expect(GAME_SERVER).toMatch(/if \(!\(await claimTable\(row\.table_id\)\)\) continue;/);
  });

  it('shutdown hands the leases back, so the next deploy does not wait out staleness', () => {
    expect(GAME_SERVER).toMatch(/await releaseTables\(\)/);
  });
});
