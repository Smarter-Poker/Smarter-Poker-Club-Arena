/**
 * DEALING IS NOT A HOUSEKEEPING DEPENDENCY (2026-08-24).
 *
 * The discovery loops are the only thing that attaches an engine to a table,
 * which is to say the only reason the platform deals a hand. They used to be
 * Step 6 of GameServer.start(), behind `await this.horseFleet.start()`.
 *
 * ensureAllTablesExist() inside that bootstrap reads the whole table list, and
 * under load the read times out and retries. While it did, the await held the
 * boot and Step 6 was never reached — so the process ran as a leader with no
 * discovery loop at all:
 *
 *   [HorseFleet.table_lookup_failed] Error: supabase_timeout
 *     at HorseFleetManager.ensureAllTablesExist
 *     at HorseFleetManager.start
 *     at GameServer.start
 *
 * Signature: discoveryLoopStalledMs climbing in exact lockstep with uptime,
 * activeTables pinned at 0, liveness flipping to 'dead' past the startup grace,
 * and the healthcheck killing a container that believed it was booting fine.
 * That was the restart loop that held the fleet at zero tables, and it is why
 * neither the adoption budget nor the leadership fixes cured it — both govern a
 * loop that was never running.
 *
 * Source guards: start() reaches Supabase on every line, so the ordering is
 * asserted structurally rather than by booting a server.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceStatement } from './testHelpers/sourceWindow.js';

const SRC = readFileSync(join(process.cwd(), 'src/GameServer.ts'), 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const start = code.slice(code.indexOf('async start('), code.indexOf('private async discoverCashTables'));

describe('boot order: nothing housekeeping may gate dealing', () => {
  it('starts the cash discovery loop before the horse fleet bootstrap', () => {
    const disc = start.indexOf('this.discoverCashTables()');
    const fleet = start.indexOf('this.horseFleet');
    expect(disc).toBeGreaterThan(-1);
    expect(fleet).toBeGreaterThan(-1);
    expect(disc).toBeLessThan(fleet);
  });

  it('starts the tournament discovery loop before the horse fleet bootstrap', () => {
    expect(start.indexOf('this.discoverTournaments()')).toBeLessThan(start.indexOf('this.horseFleet'));
  });

  it('never awaits the horse fleet bootstrap', () => {
    // THE DEFECT, exactly: `await this.horseFleet.start()`. A housekeeping step
    // that retries a timing-out query must not be able to hold the boot.
    expect(start).not.toMatch(/await\s+this\.horseFleet\.start\(\)/);
    expect(start).toMatch(/void\s+this\.horseFleet[\s\S]{0,40}\.start\(\)/);
  });

  it('reports a fleet bootstrap failure instead of swallowing it', () => {
    const seg = sliceStatement(start, 'this.horseFleet');
    expect(seg).toMatch(/\.catch\(/);
    expect(seg).toMatch(/reportError/);
  });

  it('still awaits stale-data cleanup, which IS a prerequisite', () => {
    // cleanupStaleData deletes stale seats and resets table state. Adopting a
    // table before it runs hands an engine a half-torn-down table, so this one
    // stays awaited and stays ahead of discovery.
    const clean = start.indexOf('await this.cleanupStaleData');
    expect(clean).toBeGreaterThan(-1);
    expect(clean).toBeLessThan(start.indexOf('this.discoverCashTables()'));
  });

  it('leaves the discovery loops fire-and-forget with error reporting', () => {
    expect(start).toMatch(/this\.discoverCashTables\(\)\.catch\(/);
    expect(start).toMatch(/this\.discoverTournaments\(\)\.catch\(/);
  });
});
