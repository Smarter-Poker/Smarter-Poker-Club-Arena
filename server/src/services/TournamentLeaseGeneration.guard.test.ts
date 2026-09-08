import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const migration = readFileSync(
  join(
    repo,
    'supabase',
    'migrations',
    '20260908021000_tournament_leases_have_fencing_generations.sql'
  ),
  'utf8'
);
const leaseService = readFileSync(join(here, 'tournamentLease.ts'), 'utf8');
const gameServerSource = readFileSync(join(here, '..', 'GameServer.ts'), 'utf8');
const managerSource = readFileSync(
  join(here, '..', 'tournament', 'TournamentManagerBase.ts'),
  'utf8'
);

function sqlFunction(signature: string, nextMarker: string): string {
  const start = migration.indexOf(signature);
  const end = migration.indexOf(nextMarker, start + signature.length);
  expect(start, `${signature} is missing`).toBeGreaterThan(-1);
  expect(end, `${nextMarker} is missing after ${signature}`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('one tournament manager carries one database fencing generation', () => {
  it('applies the entire protocol transition atomically', () => {
    expect(migration.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
    expect(migration.indexOf('BEGIN;')).toBeLessThan(
      migration.indexOf('ALTER TABLE public.engine_tournament_leases')
    );
    expect(migration.lastIndexOf('COMMIT;')).toBeGreaterThan(
      migration.indexOf('$assert_tournament_lease_generation_fence$;')
    );
  });

  it('binds one caller-selected generation to one causal admission retry', () => {
    const claim = sqlFunction(
      'CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2(',
      'REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2'
    );
    expect(claim).toContain('p_requested_generation');
    expect(claim).toContain('lease_generation = EXCLUDED.lease_generation');
    expect(claim).toContain('protocol_version = 2');
    expect(claim).toContain('lease_generation uuid');
    expect(claim).toMatch(
      /l\.protocol_version = 2\s+AND l\.instance_id = EXCLUDED\.instance_id\s+AND l\.lease_generation = EXCLUDED\.lease_generation/
    );
    expect(claim).toMatch(/l\.protocol_version < 2\s+AND l\.instance_id = EXCLUDED\.instance_id/);
    expect(claim).not.toMatch(/WHERE l\.instance_id = EXCLUDED\.instance_id\s+OR l\.heartbeat_at/);
    expect(claim).toContain('p_stale_seconds IS DISTINCT FROM 30');

    const legacyClaim = sqlFunction(
      'CREATE OR REPLACE FUNCTION public.claim_tournament_lease(',
      '/* Old heartbeat and release doors self-close'
    );
    expect(legacyClaim).toContain('l.protocol_version < 2');
    expect(legacyClaim).toContain('p_stale_seconds IS DISTINCT FROM 30');
    expect(legacyClaim).toContain("interval '30 seconds'");
  });

  it('heartbeats an exact tournament and generation pair', () => {
    const heartbeat = sqlFunction(
      'CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v3(',
      'REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v3'
    );
    expect(heartbeat).toContain("(item ->> 'lease_generation')::uuid");
    expect(heartbeat).toContain('l.lease_generation = a.requested_generation');
    expect(heartbeat).toContain("WHEN l.tournament_id IS NULL THEN 'missing'");
    expect(heartbeat).toContain("l.heartbeat_at >= clock_timestamp() - interval '30 seconds'");
    expect(heartbeat).toContain(
      "WHEN l.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN 'stale'"
    );
    expect(heartbeat).toContain('p_stale_seconds IS DISTINCT FROM 30');

    expect(leaseService).toContain("supabase.rpc('heartbeat_tournament_leases_v3'");
    expect(leaseService).toContain('lease_generation: claim.leaseGeneration');
    expect(leaseService).toMatch(/row\.state === 'kept'[\s\S]{0,100}exactGeneration/);

    const legacyHeartbeat = sqlFunction(
      'CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v2(',
      'CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases('
    );
    expect(legacyHeartbeat).toContain('p_stale_seconds IS DISTINCT FROM 30');
    expect(legacyHeartbeat).toContain("interval '30 seconds'");
  });

  it('fails the whole exact-release request closed on duplicate tournament claims', () => {
    const release = sqlFunction(
      'CREATE OR REPLACE FUNCTION public.release_tournament_leases_v2(',
      'REVOKE ALL ON FUNCTION public.release_tournament_leases_v2'
    );
    expect(release).toContain(
      "RAISE EXCEPTION 'release_tournament_leases_v2 refuses duplicate tournaments'"
    );
    const duplicateGuard = release.indexOf('HAVING count(*) <> 1');
    const deletion = release.indexOf('DELETE FROM public.engine_tournament_leases');
    expect(duplicateGuard).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(duplicateGuard);
    expect(release).not.toContain('HAVING count(*) = 1');
  });

  it('keeps receipt identity immutable with one balanced identity guard', () => {
    const trigger = sqlFunction(
      'CREATE OR REPLACE FUNCTION public.trg_tournament_launch_receipt_is_immutable()',
      'CREATE TRIGGER tournament_launch_receipt_is_immutable'
    );
    expect(
      trigger.match(/IF NEW\.tournament_id IS DISTINCT FROM OLD\.tournament_id/g) ?? []
    ).toHaveLength(1);
    expect(trigger).toMatch(
      /IF NEW\.tournament_id IS DISTINCT FROM OLD\.tournament_id[\s\S]*?RAISE EXCEPTION 'tournament launch receipt identity is immutable'[\s\S]*?END IF;\s*\n\s*IF OLD\.completed_at/
    );
  });

  it('holds the lease row through both durable launch edges', () => {
    const begin = sqlFunction(
      'CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(\n  p_tournament_id uuid,\n  p_launch_id uuid,\n  p_started_at timestamptz,\n  p_lease_generation uuid',
      'CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic('
    );
    const complete = sqlFunction(
      'CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(\n  p_tournament_id uuid,\n  p_launch_id uuid,\n  p_lease_generation uuid',
      'REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic('
    );
    for (const [name, body, delegate] of [
      ['begin', begin, 'fn_begin_tournament_launch_before_lease_generation'],
      ['complete', complete, 'fn_complete_tournament_launch_before_lease_generation'],
    ] as const) {
      const leaseLock = body.indexOf('FROM public.engine_tournament_leases l');
      const forUpdate = body.indexOf('FOR UPDATE', leaseLock);
      const core = body.indexOf(delegate);
      expect(leaseLock, `${name} lease lookup`).toBeGreaterThan(-1);
      expect(forUpdate, `${name} lease lock`).toBeGreaterThan(leaseLock);
      expect(core, `${name} core delegate`).toBeGreaterThan(forUpdate);
      expect(body).toContain('v_current_generation IS DISTINCT FROM p_lease_generation');
      expect(body).toContain("v_heartbeat_at < clock_timestamp() - interval '30 seconds'");
    }
    expect(complete).toContain('v_receipt_generation IS DISTINCT FROM p_lease_generation');
  });

  it('carries the exact claim from admission through manager RPCs and heartbeats', () => {
    const admission = sliceMethod(
      gameServerSource,
      'private async performTournamentManagerAdmission('
    );
    expect(admission).toContain('claimTournamentLease(tournamentId, requestedLeaseGeneration)');
    expect(admission).toMatch(
      /new TournamentManager\([\s\S]{0,160}lease\.leaseGeneration,[\s\S]{0,80}lease\.proofDeadlineMonotonicMs/
    );
    expect(admission).toContain('this.tournamentManagerPendingLeaseReleases.set(');
    expect(admission).toContain('await this.awaitTournamentManagerLeaseRelease(tournamentId)');
    expect(admission).toContain('leaseGeneration: uncertainLeaseGeneration');
    expect(gameServerSource).toContain('manager.getTournamentLeaseGeneration()');
    expect(gameServerSource).toContain('const heartbeat = await heartbeatTournaments(');
    expect(gameServerSource).toContain('leaseGeneration: candidate.leaseGeneration');
    expect(managerSource).toContain('protected readonly tournamentLeaseGeneration: string | null;');
    expect(
      managerSource.match(/p_lease_generation: this\.tournamentLeaseGeneration/g) ?? []
    ).toHaveLength(2);
    expect(managerSource).toContain('engine.renewEngineLeaseProof(authority)');
  });

  it('serializes a successor admission behind exact-generation teardown', () => {
    expect(gameServerSource).toContain(
      'private tournamentManagerLeaseReleaseOperations = new Map<string, Promise<boolean>>()'
    );
    expect(gameServerSource).toContain(
      'private tournamentManagerPendingLeaseReleases = new Map<string, string>()'
    );
    const stop = sliceMethod(gameServerSource, 'private async stopTournamentManagerIfOwned(');
    expect(stop).toContain('manager.getTournamentLeaseGeneration()');
    expect(stop).toContain('releaseTournaments([{ tournamentId, leaseGeneration }])');
    expect(stop).toContain("release.status !== 'confirmed'");
    expect(stop).toContain('this.tournamentManagerPendingLeaseReleases.set(');
    expect(stop).toContain('this.tournamentManagerLeaseReleaseOperations.set(');
    const releaseWait = sliceMethod(
      gameServerSource,
      'private async awaitTournamentManagerLeaseRelease('
    );
    expect(releaseWait).toContain('this.tournamentManagerPendingLeaseReleases.get(');
    expect(releaseWait).toContain('releaseTournaments([{ tournamentId, leaseGeneration }])');
    expect(releaseWait).toContain("outcome.status !== 'confirmed'");
    const admission = sliceMethod(
      gameServerSource,
      'private async performTournamentManagerAdmission('
    );
    expect(admission).toContain('await this.awaitTournamentManagerLeaseRelease(tournamentId)');
  });
});
