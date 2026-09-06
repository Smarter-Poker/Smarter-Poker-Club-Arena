import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');
const migration = read(
  'supabase/migrations/20260902150000_managed_game_commands_are_exactly_once.sql'
);
const service = read('src/services/GameManagementService.ts');
const page = read('src/pages/GameManagementPage.tsx');

describe('managed game commands are durable and exactly once', () => {
  it('stores one governed receipt with a stable request fingerprint', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.managed_game_command_receipts');
    expect(migration).toContain('command_id uuid PRIMARY KEY');
    expect(migration).toContain('request_hash text NOT NULL');
    expect(migration).toContain('public.fn_managed_game_command_hash');
    expect(migration).toContain('extensions.digest(');
    expect(migration.trimStart().startsWith('-- Managed Game Commands Are Exactly Once')).toBe(
      true
    );
    expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });

  it('makes completed receipts immutable and keeps the table private', () => {
    expect(migration).toContain('trg_managed_game_command_receipt_immutable');
    expect(migration).toContain("IF OLD.status <> 'processing'");
    expect(migration).toContain('Completed managed game command receipts are immutable');
    expect(migration).toContain('Managed game command receipts cannot be deleted');
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.managed_game_command_receipts FROM PUBLIC, anon, authenticated'
    );
  });

  it('serializes commands and rejects an editor that reviewed an older contract', () => {
    expect(migration).toContain('FOR UPDATE;');
    expect(migration).toContain('p_expected_version <> v_before');
    expect(migration).toContain("'reason', 'stale_contract_version'");
    expect(migration).toContain('contract_version_before');
    expect(migration).toContain('contract_version_after');
  });

  it('replays the original result and refuses command UUID reuse for different work', () => {
    expect(migration).toContain('v_existing.request_hash <> v_request_hash');
    expect(migration).toContain("'reason', 'idempotency_conflict'");
    expect(migration).toContain("v_existing.result || jsonb_build_object('replayed', true)");
    expect(migration.match(/SELECT \* INTO v_existing/g)).toHaveLength(2);
  });

  it('commits rejected outcomes instead of losing evidence on rule failures', () => {
    expect(migration).toContain('GET STACKED DIAGNOSTICS');
    expect(migration).toContain("WHEN v_sqlstate = '55000' THEN 'contract_rule_blocked'");
    expect(migration).toContain('SET status = v_status, result = v_result');
    expect(migration).toContain('completed_at = now()');
  });

  it('removes the legacy browser bypass and exposes one command gateway', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_update_managed_game(text, uuid, jsonb)'
    );
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid)');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('public.fn_execute_managed_game_command');
    expect(service).toContain("rpc('fn_execute_managed_game_command'");
    expect(service).not.toContain("rpc('fn_update_managed_game'");
    expect(service).not.toContain("rpc('fn_close_managed_game'");
  });
});

describe('ambiguous responses reconcile without polling or duplicate work', () => {
  it('reuses one UUID for a bounded retry and checks the durable receipt', () => {
    expect(service).toContain('const commandId = uuid()');
    expect(service).toContain('for (let attempt = 0; attempt < 2; attempt += 1)');
    expect(service).toContain("rpc('fn_get_managed_game_command_receipt'");
    expect(service).toContain(
      'const reconciled = await reconcileCommand(commandId, expectedVersion)'
    );
    expect(service).toContain('MANAGED_GAME_COMMAND_TIMEOUT_MS = 15_000');
    expect(service).not.toContain('setInterval');
  });

  it('bounds operator receipt reads and applies normal game authority', () => {
    expect(migration).toContain('cardinality(p_game_ids) > 500');
    expect(migration).toContain('public.fn_can_create_games(v.club_id, v_uid)');
    expect(migration).toContain("WHEN av.version IS NULL THEN 'version_drift'");
    expect(service).toContain("rpc('fn_get_managed_game_command_receipts'");
  });

  it('sends the reviewed contract version and shows confirmed command evidence', () => {
    expect(page).toContain('game.contract?.version');
    expect(page).toContain('editing.contract?.version');
    expect(page).toContain("game.lastCommand.status === 'succeeded'");
    expect(page).toContain("game.lastCommand.reconciliationState === 'version_drift'");
    expect(page).toContain('game.lastCommand.commandId.slice(0, 8)');
    expect(page).toContain('game.lastCommand.versionBefore');
    expect(page).toContain('game.lastCommand.versionAfter');
  });
});
