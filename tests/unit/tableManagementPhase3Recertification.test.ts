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
const recertification = readFileSync(resolve(MIGRATIONS, RECERTIFICATION), 'utf8');
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
  });

  it('accepts no successful browser response without terminal receipt evidence', () => {
    expect(service).toContain('isTerminalCommandResult(result, commandId)');
    expect(service).toContain("result.command_status === 'succeeded'");
    expect(service).toContain("result.command_status === 'rejected'");
    expect(service).toContain('result.command_id === commandId');
    expect(service).toContain('The command response did not contain terminal receipt evidence.');
  });

  it('treats thrown requests and partial receipts as ambiguous, then reconciles', () => {
    expect(service).toContain('requestError = error;');
    expect(service).toContain('isTerminalCommandResult(result.receipt, commandId)');
    expect(service).toContain('for (let attempt = 0; attempt < 2; attempt += 1)');
    expect(service).toContain('const reconciled = await reconcileCommand(commandId)');
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
