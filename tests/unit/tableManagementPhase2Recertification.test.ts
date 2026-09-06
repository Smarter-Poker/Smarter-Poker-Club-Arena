import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');
const original = read(
  'supabase/migrations/20260902110000_published_game_contracts_are_promises.sql'
);
const recertified = read(
  'supabase/migrations/20260906113000_phase_2_published_contracts_recertified.sql'
);
const satelliteRecertified = read(
  'supabase/migrations/20260906123632_table_management_readiness_recognizes_every_satellite_guaran.sql'
);
const completeContracts = read(
  'supabase/migrations/20260906124733_published_tournament_contracts_include_every_creator_promise.sql'
);
const service = read('src/services/GameManagementService.ts');
const managementPage = read('src/pages/GameManagementPage.tsx');

describe('Table Management Phase 2 remains a published promise', () => {
  it('allows a contract to be intentionally republished after an intervening version', () => {
    expect(original).toContain('UNIQUE (game_kind, game_id, contract_hash)');
    expect(recertified).toContain("ARRAY['game_kind', 'game_id', 'contract_hash']::text[]");
    expect(recertified).toContain('DROP CONSTRAINT %I');
    expect(recertified).toContain('idx_managed_game_contract_versions_hash');
    expect(original).toContain('v_last_hash IS NOT DISTINCT FROM v_hash');
    expect(satelliteRecertified).toContain('pg_advisory_xact_lock');
    expect(satelliteRecertified).not.toContain(
      'ON CONFLICT ON CONSTRAINT managed_game_contract_version_game_kind_game_id_contract_ha_key'
    );
  });

  it('enforces append-only history against updates and deletes, including privileged writes', () => {
    expect(recertified).toContain('trg_managed_game_contract_version_immutable');
    expect(recertified).toContain('BEFORE UPDATE OR DELETE');
    expect(recertified).toContain('Published game contract versions are immutable');
    expect(recertified).toContain('Published game contract versions cannot be deleted');
  });

  it('versions every creator-controlled tournament promise and corrects existing ledgers', () => {
    for (const field of [
      'description',
      'payout_percent',
      'free_buy',
      'addon_from_start',
      'satellite_target',
      'mystery_bounty_profile',
      'mystery_bounty_activation',
      'mystery_bounty_activation_value',
      'mystery_bounty_pool_percent',
      'mystery_bounty_regular_pool_percent',
      'mystery_bounty_top_percent',
    ]) {
      expect(completeContracts).toContain(`'${field}', p_row -> '${field}'`);
    }
    expect(completeContracts).toContain("'contract_schema_recertification'");
    expect(completeContracts).toContain('l.contract_hash IS DISTINCT FROM');
  });

  it('evaluates the exact contract row that is transitioning into play', () => {
    const startGuard = recertified.slice(
      recertified.indexOf('public.fn_guard_tournament_start_readiness()'),
      recertified.indexOf('public.fn_guard_tournament_publish_readiness()')
    );
    expect(startGuard).toContain('to_jsonb(NEW)');
    expect(startGuard).toContain("IN ('RUNNING', 'COMPLETING', 'COMPLETED')");
    expect(startGuard).not.toContain('public.fn_tournament_management_readiness(NEW.id)');
  });

  it('serializes simultaneous starts on the bank the overlay trigger debits', () => {
    expect(recertified).toContain('FROM public.union_wallets uw');
    expect(recertified).toContain('FROM public.clubs c WHERE c.id = NEW.club_id FOR UPDATE');
    expect(recertified).toContain('WHERE uw.union_id = NEW.union_id FOR UPDATE');
    expect(recertified).toContain('COALESCE(NEW.is_private, false) OR NEW.union_id IS NULL');
  });

  it('survives text-backed JSON and counts satellite seats as a guarantee', () => {
    expect(recertified).toContain('public.fn_safe_jsonb_array');
    expect(recertified).toContain("jsonb_typeof(p_row -> 'blind_structure') = 'array'");
    expect(recertified).toContain("jsonb_typeof(p_row -> 'payout_structure') = 'array'");
    expect(recertified).toContain("v_variant = 'satellite'");
    expect(recertified).toContain('satellite_seat_guarantee');
    expect(recertified).toContain('v_effective_guarantee := greatest');
  });

  it('recognizes every satellite shape used by the overlay writer', () => {
    expect(satelliteRecertified).toContain("v_variant = 'satellite'");
    expect(satelliteRecertified).toContain("v_tournament_type = 'SATELLITE'");
    expect(satelliteRecertified).toContain('OR v_target IS NOT NULL');
    expect(satelliteRecertified).toContain(
      'COALESCE(t.satellite_target_id, t.satellite_target) IS NOT NULL'
    );
    expect(satelliteRecertified).toContain('NOT v_is_satellite');
  });

  it('rechecks publication when a satellite promise or funding scope changes', () => {
    const trigger = satelliteRecertified.slice(
      satelliteRecertified.indexOf('CREATE TRIGGER trg_tournaments_publish_readiness'),
      satelliteRecertified.indexOf('REVOKE ALL ON FUNCTION')
    );
    for (const field of [
      'guaranteed_prize',
      'club_id',
      'union_id',
      'is_private',
      'variant',
      'tournament_type',
      'satellite_target_id',
      'satellite_target',
      'satellite_seats',
    ]) {
      expect(trigger).toContain(field);
    }
  });

  it('uses the same union-versus-club funding decision as the overlay writer', () => {
    expect(recertified).toContain('v_union := CASE WHEN v_private THEN NULL ELSE v_row_union END;');
    expect(recertified).toContain("v_bank_type := 'union'");
    expect(recertified).toContain("v_bank_type := 'club'");
    expect(recertified).toContain('COALESCE(t.is_private, false) OR t.union_id IS NULL');
  });

  it('shows operators the effective and satellite-seat guarantee values', () => {
    expect(service).toContain('satelliteSeatGuarantee: numberValue(raw?.satellite_seat_guarantee)');
    expect(service).toContain('effectiveGuarantee: numberValue(raw?.effective_guarantee)');
    expect(managementPage).toContain('Effective Guarantee');
    expect(managementPage).toContain('Satellite Seat Value');
    expect(managementPage).toContain('effectiveGuarantee.toLocaleString()');
    expect(managementPage).toContain('satelliteSeatGuarantee.toLocaleString()');
  });

  it('keeps every new definer helper private and asserts the installed shape', () => {
    expect(recertified).toContain(
      'REVOKE ALL ON FUNCTION public.fn_tournament_management_readiness_for_row(jsonb)'
    );
    expect(recertified).toContain("has_function_privilege(\n       'authenticated'");
    expect(recertified).toContain("position('to_jsonb(NEW)' in v_start_source)");
    expect(recertified).toContain("position('fn_safe_jsonb_array' in v_readiness_source)");
  });
});
