import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimManagedGameWork,
  managedGameKey,
  releaseManagedGameWork,
} from '../../src/pages/gameManagementIdentity';

const ROOT = resolve(__dirname, '../..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const RECERTIFICATION = '20260906132537_phase_3_managed_command_integrity_recertified.sql';
const EVIDENCE_INVARIANT = '20260906135711_phase_3_command_receipt_evidence_is_self_consistent.sql';
const recertification = readFileSync(resolve(MIGRATIONS, RECERTIFICATION), 'utf8');
const evidenceInvariant = readFileSync(resolve(MIGRATIONS, EVIDENCE_INVARIANT), 'utf8');
const service = readFileSync(resolve(ROOT, 'src/services/GameManagementService.ts'), 'utf8');
const page = readFileSync(resolve(ROOT, 'src/pages/GameManagementPage.tsx'), 'utf8');
const migrationSources = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, source: readFileSync(resolve(MIGRATIONS, file), 'utf8') }));

function latestDefinition(functionName: string): { file: string; source: string } {
  let latest: { file: string; source: string } | null = null;
  const marker = `CREATE OR REPLACE FUNCTION public.${functionName}`;

  for (const { file, source } of migrationSources) {
    const start = source.lastIndexOf(marker);
    if (start < 0) continue;
    const tail = source.slice(start);
    const opening = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(tail);
    if (!opening) throw new Error(`${functionName} in ${file} has no body delimiter`);
    const delimiter = opening[1];
    const bodyStart = opening.index + opening[0].length;
    const bodyEnd = tail.indexOf(delimiter, bodyStart);
    if (bodyEnd < 0) throw new Error(`${functionName} in ${file} has no body terminator`);
    latest = { file, source: tail.slice(0, bodyEnd + delimiter.length) };
  }

  if (!latest) throw new Error(`No migration defines ${functionName}`);
  return latest;
}

function latestAuthenticatedPrivilege(functionName: string): string {
  let latest = '';
  for (const { source } of migrationSources) {
    for (const statement of source.split(';')) {
      const normalized = statement.replace(/\s+/g, ' ').trim().toLowerCase();
      if (
        normalized.includes(functionName.toLowerCase()) &&
        normalized.includes('authenticated') &&
        (normalized.includes('grant execute on function') ||
          normalized.includes('revoke all on function'))
      ) {
        latest = normalized;
      }
    }
  }
  if (!latest) throw new Error(`No authenticated privilege statement found for ${functionName}`);
  return latest;
}

describe('Table Management Phase 3 remains exactly once', () => {
  it('serializes the global command identity before reading its receipt', () => {
    const latest = latestDefinition('fn_execute_managed_game_command(');
    const commandLock = latest.source.indexOf('pg_advisory_xact_lock');
    const receiptRead = latest.source.indexOf('SELECT * INTO v_existing');

    expect(latest.file).toBe(RECERTIFICATION);
    expect(commandLock).toBeGreaterThan(0);
    expect(receiptRead).toBeGreaterThan(commandLock);
    expect(latest.source).toContain("'managed-game-command:' || p_command_id::text");
    expect(latest.source).toContain("'reason', 'idempotency_conflict'");
  });

  it('keeps distinct commands for one game serialized on the canonical row', () => {
    const latest = latestDefinition('fn_execute_managed_game_command(').source;
    expect(latest).toContain('FROM public.tables');
    expect(latest).toContain('FROM public.tournaments');
    expect(latest).toContain('FOR UPDATE;');
    expect(latest).toContain('p_expected_version <> v_before');
  });

  it('reasserts one browser mutation door', () => {
    expect(recertification).toContain(
      'REVOKE ALL ON FUNCTION public.fn_update_managed_game(text, uuid, jsonb)'
    );
    expect(recertification).toContain(
      'REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid)'
    );
    expect(recertification).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_execute_managed_game_command('
    );
    expect(recertification).toContain('TO authenticated, service_role;');
    expect(latestAuthenticatedPrivilege('fn_execute_managed_game_command')).toContain(
      'grant execute on function'
    );
    expect(latestAuthenticatedPrivilege('fn_update_managed_game')).toContain(
      'revoke all on function'
    );
    expect(latestAuthenticatedPrivilege('fn_close_managed_game')).toContain(
      'revoke all on function'
    );
  });

  it('makes terminal receipt evidence self-consistent in the database', () => {
    expect(evidenceInvariant).toContain(
      'ADD CONSTRAINT managed_game_command_receipt_evidence_consistent'
    );
    expect(evidenceInvariant).toContain("'ok', status = 'succeeded'");
    expect(evidenceInvariant).toContain("'command_id', command_id");
    expect(evidenceInvariant).toContain("'command_status', status");
    expect(evidenceInvariant).toContain("'expected_version', expected_version");
    expect(evidenceInvariant).toContain("'version_before', contract_version_before");
    expect(evidenceInvariant).toContain("'version_after', contract_version_after");
    expect(evidenceInvariant).toContain('VALIDATE CONSTRAINT');
  });

  it('accepts no successful browser response without terminal receipt evidence', () => {
    expect(service).toContain('isTerminalCommandResult(result, commandId, expectedVersion)');
    expect(service).toContain("result.command_status === 'succeeded'");
    expect(service).toContain("result.command_status === 'rejected'");
    expect(service).toContain('result.command_id === commandId');
    expect(service).toContain('result.expected_version === expectedVersion');
    expect(service).toContain("result?.ok === true && result.command_status === 'succeeded'");
    expect(service).toContain("result?.ok === false && result.command_status === 'rejected'");
    expect(service).toContain('The command response did not contain terminal receipt evidence.');
  });

  it('treats thrown requests and partial receipts as ambiguous, then reconciles', () => {
    expect(service).toContain('requestError = error;');
    expect(service).toContain(
      'isTerminalCommandResult(result.receipt, commandId, expectedVersion)'
    );
    expect(service).toContain('for (let attempt = 0; attempt < 2; attempt += 1)');
    expect(service).toContain(
      'const reconciled = await reconcileCommand(commandId, expectedVersion)'
    );
    expect(service).toContain('await withCommandTimeout(');
    expect(service).toContain('MANAGED_GAME_COMMAND_TIMEOUT_MS = 15_000');
  });

  it('keys in-flight row commands by game kind and UUID', () => {
    expect(page).toContain('const [busyKeys, setBusyKeys]');
    expect(page).toContain('claimManagedGameWork(busyKeysRef.current, game)');
    expect(page).toContain('busyKeys.has(managedGameKey(game))');
    expect(page).toContain('busyKeys.has(managedGameKey(editing))');
    expect(page).toContain('busyKeys.has(managedGameKey(scheduling))');
    expect(page).not.toContain('busyId === game.id');
    expect(page).not.toContain('setBusyId(game.id)');
  });

  it('rejects a same-game double tap synchronously while allowing distinct games', () => {
    expect(page).toContain('if (!beginGameWork(game)) return;');
    expect(page).toContain('if (!beginGameWork(editing)) return;');
    expect(page).toContain('if (!beginGameWork(scheduling)) return;');

    const inFlight = new Set<string>();
    const table = { kind: 'table' as const, id: 'shared-uuid' };
    const tournament = { kind: 'tournament' as const, id: 'shared-uuid' };

    expect(managedGameKey(table)).not.toBe(managedGameKey(tournament));
    expect(claimManagedGameWork(inFlight, table)).toBe(true);
    expect(claimManagedGameWork(inFlight, table)).toBe(false);
    expect(claimManagedGameWork(inFlight, tournament)).toBe(true);
    releaseManagedGameWork(inFlight, table);
    expect(claimManagedGameWork(inFlight, table)).toBe(true);
  });
});
