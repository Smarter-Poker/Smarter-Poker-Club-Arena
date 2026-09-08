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
 * There is no runtime off switch. An emergency must stop admissions or roll
 * back through an audited release; it may not authorize a second dealer.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const LEASE = readFileSync(path.join(process.cwd(), 'src/services/tableLease.ts'), 'utf8');
const TOURNAMENT_LEASE = readFileSync(
  path.join(process.cwd(), 'src/services/tournamentLease.ts'),
  'utf8'
);
const GAME_SERVER = code(readFileSync(path.join(process.cwd(), 'src/GameServer.ts'), 'utf8'));

describe('two dealers at one table can never happen again', () => {
  it('cash and tournament enforcement cannot be disabled at runtime', () => {
    expect(code(LEASE)).toMatch(/LEASE_ENFORCED\s*:\s*true\s*=\s*true/);
    expect(code(TOURNAMENT_LEASE)).toMatch(/TOURNAMENT_LEASE_ENFORCED\s*:\s*true\s*=\s*true/);
    expect(code(LEASE)).not.toContain('process.env.ENGINE_LEASE_ENFORCE');
    expect(code(TOURNAMENT_LEASE)).not.toContain('process.env.ENGINE_TOURNAMENT_LEASE_ENFORCE');
    expect(code(LEASE)).not.toContain('verified: false');
    expect(code(TOURNAMENT_LEASE)).not.toContain('verified: false');
    expect(GAME_SERVER).not.toContain('verified: false');
    expect(GAME_SERVER).not.toContain('possibleLeaseGeneration');

    const tournamentAdmission = sliceMethod(
      GAME_SERVER,
      'private async performTournamentManagerAdmission('
    );
    expect(tournamentAdmission).toMatch(
      /new TournamentManager\([\s\S]{0,180}lease\.leaseGeneration,[\s\S]{0,80}lease\.proofDeadlineMonotonicMs/
    );
    expect(tournamentAdmission).toContain(
      '{ tournamentId, leaseGeneration: lease.leaseGeneration }'
    );
  });

  it('a lost lease tears the engine down, not just logs', () => {
    // The dedicated ownership lifecycle must synchronously fence every
    // verified cash dealer the typed heartbeat cannot prove, then route the
    // exact object through the shared stop/release/CAS recovery primitive.
    const i = GAME_SERVER.indexOf('this.renewVerifiedCashTableLeaseProofs()');
    expect(i, 'lease renewal missing from discovery loop').toBeGreaterThan(-1);
    const block = sliceEnclosingBlock(GAME_SERVER, 'this.renewVerifiedCashTableLeaseProofs()');
    expect(block).toMatch(/engine\.fenceForEngineLeaseLoss\(/);
    expect(block).toMatch(/this\.recoverDirectTableEngine\(tableId, engine/);
    const recovery = sliceMethod(GAME_SERVER, 'private async performDirectTableEngineRecovery(');
    expect(recovery).toMatch(/await engine\.stop\(\)/);
    expect(recovery).toMatch(/await releaseTables\(\[/);
    expect(recovery).toMatch(/this\.tableEngines\.delete\(tableId\)/);
  });

  it('starting a table asks for the lease first', () => {
    const start = GAME_SERVER.indexOf('private async performCashTableEngineAdmission(');
    const admission = GAME_SERVER.slice(
      start,
      GAME_SERVER.indexOf('/**\n   * Get a table engine by ID', start)
    );
    expect(admission).toContain(
      'const lease = await claimTableLease(tableId, requestedLeaseGeneration);'
    );
    expect(admission).toContain('const engine = new ServerTableEngine(');
    expect(admission).toContain('generation: lease.leaseGeneration');
    expect(admission).toContain('proofDeadlineMonotonicMs: lease.proofDeadlineMonotonicMs');
    expect(admission.indexOf('const engine = new ServerTableEngine(')).toBeGreaterThan(
      admission.indexOf('await claimTableLease(tableId, requestedLeaseGeneration)')
    );
  });

  it('shutdown hands the leases back, so the next deploy does not wait out staleness', () => {
    expect(GAME_SERVER).toContain('await releaseTables(cashLeaseClaims)');
    expect(GAME_SERVER).toContain("authority?.scope === 'cash' && authority.verified");
  });
});
