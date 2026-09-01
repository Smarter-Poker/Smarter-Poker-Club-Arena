import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');
const migration = read(
  'supabase/migrations/20260902110000_published_game_contracts_are_promises.sql'
);
const managementPage = read('src/pages/GameManagementPage.tsx');
const managementService = read('src/services/GameManagementService.ts');
const guaranteeMigration = read(
  'supabase/migrations/20260831234713_a_guarantee_is_a_promise_and_something_finally_checks_it.sql'
);

describe('published game contracts are append-only promises', () => {
  it('stores an immutable hash and monotonically increasing version for every game', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.managed_game_contract_versions');
    expect(migration).toContain('UNIQUE (game_kind, game_id, version)');
    expect(migration).toContain('UNIQUE (game_kind, game_id, contract_hash)');
    expect(migration).toContain(
      "extensions.digest(convert_to(p_contract::text, 'UTF8'), 'sha256')"
    );
    expect(migration).toContain('COALESCE(v_version, 0) + 1');
    expect(migration).not.toMatch(/UPDATE public\.managed_game_contract_versions/i);
    expect(migration).not.toMatch(/DELETE FROM public\.managed_game_contract_versions/i);
  });

  it('captures existing games, new games, and every changed advertised contract', () => {
    expect(migration).toContain("SELECT 'table', t.id, t.club_id, t.union_id, 1");
    expect(migration).toContain("SELECT 'tournament', t.id, t.club_id, t.union_id, 1");
    expect(migration).toContain('trg_tables_capture_management_contract');
    expect(migration).toContain('trg_tournaments_capture_management_contract');
    expect(migration).toContain('AFTER INSERT OR UPDATE ON public.tables');
    expect(migration).toContain('AFTER INSERT OR UPDATE ON public.tournaments');
  });

  it('locks operator edits at the first registration without excluding horses', () => {
    const guard = migration.slice(
      migration.indexOf('public.fn_guard_registered_tournament_contract'),
      migration.indexOf('public.fn_tournament_management_readiness')
    );
    expect(guard).toContain('auth.uid() IS NOT NULL');
    expect(guard).toContain('FROM public.tournament_players tp');
    expect(guard).not.toContain('tp.user_id IS NOT NULL');
    expect(guard).toContain('Tournament contract cannot be modified after a player has registered');
  });

  it('keeps contract rows private and exposes only governed operator RPCs', () => {
    expect(migration).toContain(
      'ALTER TABLE public.managed_game_contract_versions ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.managed_game_contract_versions FROM PUBLIC, anon, authenticated'
    );
    expect(migration).toContain('public.fn_can_create_games(v_club, v_uid)');
    expect(migration).toContain('cardinality(p_game_ids) > 500');
    expect(migration).toContain('LIMIT 50');
  });
});

describe('guarantee readiness is visible before cards fly', () => {
  it('calculates exposure against the bank that actually funds the overlay', () => {
    expect(migration).toContain("v_bank_type := 'union'");
    expect(migration).toContain('FROM public.union_wallets uw');
    expect(migration).toContain("v_bank_type := 'club'");
    expect(migration).toContain('other_live_exposure');
    expect(migration).toContain('overlay_required');
    expect(migration).toContain("WHEN v_enforce AND v_short > 0 THEN 'funding_blocked'");
  });

  it('refuses a RUNNING transition when the published promise is not ready', () => {
    expect(migration).toContain('trg_tournaments_publish_readiness');
    expect(migration).toContain('Tournament cannot be published because its guarantee is short by');
    expect(migration).toContain('trg_tournaments_start_readiness');
    expect(migration).toContain("upper(NEW.status::text) = 'RUNNING'");
    expect(migration).toContain("v_readiness ->> 'can_start'");
    expect(migration).toContain('Tournament cannot start because its guarantee is short by');
  });

  it('retains the completion-time guarantee detector as the settlement backstop', () => {
    expect(guaranteeMigration).toContain('public.fn_tournament_guarantee_check');
    expect(guaranteeMigration).toContain('public.tournament_payouts');
    expect(guaranteeMigration).toContain('short_of_guarantee');
  });
});

describe('operators can inspect contract state and history', () => {
  it('loads summaries and version history through the management service', () => {
    expect(managementService).toContain("rpc('fn_get_managed_game_contracts'");
    expect(managementService).toContain("rpc('fn_get_managed_game_contract_history'");
    expect(managementService).toContain('contractLocked');
    expect(managementService).toContain('overlayRequired');
    expect(managementService).toContain('shortBy');
  });

  it('shows version, lock, readiness, funding shortfall, and the full revision record', () => {
    expect(managementPage).toContain('Published Contract History');
    expect(managementPage).toContain('Contract V{game.contract.version}');
    expect(managementPage).toContain('game.contract.contractLocked');
    expect(managementPage).toContain('Funding Short');
    expect(managementPage).toContain('SHA-256');
    expect(managementPage).toContain('JSON.stringify(version.contract, null, 2)');
  });
});
