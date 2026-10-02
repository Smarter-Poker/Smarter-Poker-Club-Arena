import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261001154709_prospective_lifetime_first_club_welcome_package.sql'
  ),
  'utf8'
);
const cleanupSql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261001212300_welcome_certification_cleanup_runs_after_core.sql'
  ),
  'utf8'
);
const ledgerCounterpartyRepairSql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261002002030_welcome_allocations_use_the_declared_opening_clearing_store.sql'
  ),
  'utf8'
);
const ledgerCategoryRepairSql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261002010726_welcome_allocations_use_the_declared_opening_category.sql'
  ),
  'utf8'
);
const derivedTableCleanupSql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261002021610_welcome_certification_retires_package_derived_cash_tables.sql'
  ),
  'utf8'
);
const authoritativeLeaseRepairSql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261002030900_welcome_certification_reads_the_authoritative_engine_lease.sql'
  ),
  'utf8'
);
const hotTriggerSql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261001224720_welcome_schedule_spawn_trigger_runs_after_core.sql'
  ),
  'utf8'
);
const clubHistorySql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261001232445_welcome_club_owner_history_runs_after_core.sql'
  ),
  'utf8'
);
const requestActivationSql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261001232452_welcome_request_activation_runs_last.sql'
  ),
  'utf8'
);

describe('prospective lifetime-first club welcome package database contract', () => {
  it('installs the core atomically without cross-hot-table prelocks', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '15s';");
    expect(sql).not.toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).not.toMatch(
      /LOCK TABLE (auth\.users|public\.(club_creation_requests|clubs|tournaments))/
    );
    expect(sql).not.toContain('fn_ca_prepare_unused_welcome_certification_fixture');
    expect(sql).not.toContain('CREATE TRIGGER trg_fence_welcome_package_schedule_spawn');
    expect(sql).not.toContain('CREATE TRIGGER trg_offer_lifetime_first_club_welcome');
    expect(sql).not.toContain('CREATE TRIGGER trg_remember_club_owner_transfer');
    expect(sql).not.toContain('REFERENCES public.clubs');
    expect(sql).not.toContain('REFERENCES public.club_creation_requests');
    expect(sql).not.toMatch(
      /INSERT INTO public\.club_owner_creation_history\s+\(owner_id,first_club_id,welcome_eligible,provenance,recorded_at\)/
    );
    expect(hotTriggerSql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(hotTriggerSql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(hotTriggerSql).toContain("SET LOCAL lock_timeout = '15s';");
    expect(hotTriggerSql).toContain('CREATE TRIGGER trg_fence_welcome_package_schedule_spawn');
    expect(hotTriggerSql).not.toContain('trg_offer_lifetime_first_club_welcome');
    expect(hotTriggerSql).not.toContain('trg_remember_club_owner_transfer');
    expect(hotTriggerSql).not.toMatch(/LOCK TABLE/);
    expect(clubHistorySql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(clubHistorySql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(clubHistorySql).toContain("SET LOCAL lock_timeout = '15s';");
    expect(clubHistorySql).toContain('CREATE TRIGGER trg_remember_club_owner_transfer');
    expect(clubHistorySql).toContain('ADD CONSTRAINT club_welcome_entitlements_club_fkey');
    expect(clubHistorySql).not.toContain('trg_offer_lifetime_first_club_welcome');
    expect(clubHistorySql).not.toContain('trg_fence_welcome_package_schedule_spawn');
    expect(requestActivationSql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(requestActivationSql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(requestActivationSql).toContain("SET LOCAL lock_timeout = '15s';");
    expect(requestActivationSql).toContain(
      'ADD CONSTRAINT club_welcome_entitlements_owner_request_fkey'
    );
    expect(requestActivationSql).toContain('CREATE TRIGGER trg_offer_lifetime_first_club_welcome');
    expect(requestActivationSql.indexOf('ADD CONSTRAINT')).toBeLessThan(
      requestActivationSql.indexOf('CREATE TRIGGER')
    );
    expect(requestActivationSql).not.toContain('trg_fence_welcome_package_schedule_spawn');
    expect(requestActivationSql).not.toContain('trg_remember_club_owner_transfer');
    expect(cleanupSql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(cleanupSql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(cleanupSql).not.toMatch(/LOCK TABLE/);
  });

  it('mints entitlement only from a new creation receipt and never backfills', () => {
    expect(requestActivationSql).toContain('CREATE TRIGGER trg_offer_lifetime_first_club_welcome');
    expect(sql).toContain('public.fn_club_membership_lock(NEW.user_id)');
    expect(sql).toContain('club_owner_creation_history');
    expect(sql).toContain("false,'historical'");
    expect(sql).toContain("true,'prospective'");
    expect(clubHistorySql).toContain('trg_remember_club_owner_transfer');
    expect(sql).toContain(
      'public.fn_provision_first_club_welcome_package(NEW.club_id,NEW.request_id)'
    );
    expect(sql).toContain('owner_id uuid NOT NULL UNIQUE');
    expect(sql).not.toMatch(
      /INSERT INTO public\.club_welcome_entitlements[\s\S]*SELECT[\s\S]*club_creation_requests/
    );
  });

  it('owns the exact audited welcome-v1 game matrix in one helper', () => {
    for (const slot of [
      'classic_nlh_050_100',
      'classic_flh_050_100',
      'classic_plo4_050_100',
      'classic_plo5_050_100',
      'classic_plo6_050_100',
      'classic_plo8_050_100',
      'classic_flo8_050_100',
      'classic_short_deck_050_100',
      'classic_pineapple_050_100',
      'daily_25_freezeout_1900',
    ])
      expect(sql).toContain(`'${slot}'`);
    expect(sql.match(/'small_blind'|0\.5,1,/g)?.length).toBeTruthy();
    expect(sql).toContain("'time_zone',NULL");
    expect(sql).toContain("'display_time_label','7:00 PM UTC'");
    expect(sql).toContain("'name','Daily $25 Freezeout'");
    expect(sql).toContain("'buyIn',25");
    expect(sql).not.toContain("'feePercent'");
    expect(sql).toContain("'startingStack',10000");
    expect(sql).toContain("'maxPlayers',10000");
    expect(sql).toContain("'gameVariant','nlh'");
    expect(sql).toContain("'blindPreset','STANDARD'");
    expect(sql).toContain("'payoutPreset','THREE'");
    expect(sql).toContain("'lateRegistrationLevels',0");
    expect(sql).toContain("'recurrenceCadence','daily'");
    expect(sql).toContain("'synchronizedBreaks',true");
  });

  it('keeps Diamond consent separate and uses the existing private cash authority', () => {
    expect(sql).toContain("'diamond_spins_status','owner_acceptance_required'");
    expect(sql).not.toMatch(/diamond[^\n]*(accept|consent)[^\n]*(INSERT|UPDATE)/i);
    expect(sql).toContain('public.fn_cash_game_create_impl_20260905');
    expect(sql).toContain('public.fn_upsert_tournament_schedule');
    expect(sql).not.toContain("'spin'::text,'tournament_schedule'");
  });

  it('has owner-only idempotent receipts and package-resource-only soft reset', () => {
    const resetStart = sql.indexOf('CREATE FUNCTION public.fn_remove_first_club_welcome_games');
    const resetEnd = sql.indexOf(
      'REVOKE ALL ON FUNCTION public.fn_remove_first_club_welcome_games',
      resetStart
    );
    const resetSql = sql.slice(resetStart, resetEnd);
    for (const fn of [
      'fn_get_club_welcome_package',
      'fn_get_club_welcome_package_reset_impact',
      'fn_remove_first_club_welcome_games',
      'fn_provision_first_club_welcome_package',
    ])
      expect(sql).toContain(`public.${fn}`);
    expect(sql).toContain('WHERE operation_id=p_operation_id');
    expect(sql).toContain("v_prior.result||jsonb_build_object('replayed',true)");
    expect(sql).toContain("entity_kind='cash_game'");
    expect(sql).toContain("entity_kind='tournament_schedule'");
    expect(sql).toContain("SET enabled=false,state='dormant'");
    expect(sql).toContain('SET active=false');
    expect(sql).toContain("'fn_remove_first_club_welcome_games'");
    expect(sql).toContain('WELCOME_RESET_SETTLEMENT_LANE_DOCTRINE_FAILED');
    expect(hotTriggerSql).toContain('trg_fence_welcome_package_schedule_spawn');
    expect(sql).toContain('t.schedule_id=ANY(v_schedules)');
    expect(sql).toContain("'hand_history',v_hands");
    expect(resetSql).not.toMatch(
      /DELETE FROM public\.(cash_games|tables|tournaments|club_members|clubs|chip_ledger|chip_transactions)/
    );
  });

  it('reuses welcome BBJ and Spin principal during later opening setup', () => {
    expect(sql).toContain('WELCOME_SETUP_PATCH_RECEIPT_DRIFT');
    expect(sql).toContain('v_welcome.club_id IS NULL');
    expect(sql).toContain('Welcome BBJ And Poker Spins Are Already Seeded');
    expect(sql).toContain('v_bbj_seed := 0');
    expect(sql).toContain('v_spin_seed := 0');
    expect(sql).toContain('club_welcome_package_funding');
  });

  it('registers the private seeded-balance writer before production can create it', () => {
    const registry = sql.indexOf("'fn_apply_club_welcome_economics','approved'");
    const creation = sql.indexOf('CREATE FUNCTION public.fn_apply_club_welcome_economics');
    expect(registry).toBeGreaterThan(0);
    expect(registry).toBeLessThan(creation);
    expect(sql).toContain('club_opening_allocation ledger context');
    expect(sql).toContain("set_config('app.ledger_category','club_opening_allocation',true)");
    expect(sql).not.toContain("set_config('app.ledger_category','club_welcome_allocation',true)");
    expect(sql).toContain('Diamond Spins remain owner-acceptance-required');
    expect(sql).toContain("set_config('app.ledger_counterparty','opening_setup',true)");
    expect(sql).not.toContain("set_config('app.ledger_counterparty','welcome_package',true)");
    expect(ledgerCounterpartyRepairSql).toContain('replace(v_def,v_anchor,v_replacement)');
    expect(ledgerCounterpartyRepairSql).toContain("store='opening_setup' AND treatment='counted'");
    expect(ledgerCounterpartyRepairSql).not.toContain('INSERT INTO public.ca_chip_store_coverage');
    expect(ledgerCategoryRepairSql).toContain('replace(v_def,v_anchor,v_replacement)');
    expect(ledgerCategoryRepairSql).toContain("conname='chip_ledger_category_check'");
    expect(ledgerCategoryRepairSql).not.toContain('DROP CONSTRAINT chip_ledger_category_check');
  });

  it('does not mutate tagline, membership, wallets or historical ledgers', () => {
    expect(sql).not.toMatch(/UPDATE public\.clubs SET[^;]*tagline/is);
    expect(sql).not.toMatch(
      /(INSERT INTO|UPDATE|DELETE FROM) public\.(club_members|club_wallets|wallets|chip_ledger|chip_transactions|hand_history)/
    );
  });

  it('prepares only an unused reserved certification welcome fixture before the old retirement door', () => {
    expect(cleanupSql).toContain('public.fn_ca_prepare_unused_welcome_certification_fixture');
    expect(cleanupSql).toContain('WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED');
    expect(cleanupSql).toContain('WELCOME_CERTIFICATION_FIXTURE_MEMBER_OR_AGENT_REFUSED');
    expect(cleanupSql).toContain('WELCOME_CERTIFICATION_HAS_NONPACKAGE_GAMES');
    expect(cleanupSql).toContain('WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY');
    expect(cleanupSql).toContain("LIKE 'club-create-cert-%@smarter-poker.invalid'");
    expect(cleanupSql).toContain("LIKE 'ca-customization-cert-postdeploy-%@example.invalid'");
    expect(cleanupSql).toContain('v_item_count<>10');
    expect(cleanupSql).toContain('cardinality(v_cash)<>9');
    expect(cleanupSql).toContain('DELETE FROM public.tables WHERE id=ANY(v_tables)');
    expect(cleanupSql).toContain('DELETE FROM public.cash_games WHERE id=ANY(v_cash)');
    expect(cleanupSql).toContain(
      'DELETE FROM public.tournament_schedules WHERE id=ANY(v_schedules)'
    );
    expect(cleanupSql).toContain(
      'PERFORM public.fn_ca_prepare_unused_welcome_certification_fixture(p_club_id)'
    );
    expect(cleanupSql).toContain(
      'RETURN public.fn_ca_retire_certification_club(p_club_id,p_reason)'
    );
    expect(cleanupSql.indexOf('WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY')).toBeLessThan(
      cleanupSql.indexOf('DELETE FROM public.tables WHERE id=ANY(v_tables)')
    );
  });

  it('retires every idle package-derived cash table and all 100,000 opening chips', () => {
    expect(derivedTableCleanupSql).toContain('v_initial_tables <@ v_tables');
    expect(derivedTableCleanupSql).toContain('t.cluster_id=ANY(v_cash)');
    expect(derivedTableCleanupSql).toContain("t.role NOT IN('main','feeder')");
    expect(derivedTableCleanupSql).toContain(
      "t.lifecycle NOT IN('opening','live','breaking','closed')"
    );
    expect(derivedTableCleanupSql).toContain('t.created_by IS NOT NULL');
    expect(derivedTableCleanupSql).not.toContain('t.engine_lease_owner IS NOT NULL');
    expect(derivedTableCleanupSql).not.toContain('t.engine_lease_expires_at IS NOT NULL');
    expect(derivedTableCleanupSql).toContain('public.engine_table_leases');
    expect(authoritativeLeaseRepairSql).toContain('FROM public.engine_table_leases l');
    expect(authoritativeLeaseRepairSql).toContain(
      'WELCOME_CERTIFICATION_AUTHORITATIVE_LEASE_GUARD_NOT_INSTALLED'
    );
    expect(derivedTableCleanupSql).toContain('public.cash_game_roster');
    expect(derivedTableCleanupSql).toContain('public.table_pending_addons');
    expect(derivedTableCleanupSql).toContain('DELETE FROM public.cash_cluster_events');
    expect(derivedTableCleanupSql).toContain("'cert-retire-bbj:'||p_club_id::text");
    expect(derivedTableCleanupSql).toContain("'cert-retire-spin:'||p_club_id::text");
    expect(derivedTableCleanupSql).toContain("l.kind='seed'");
    expect(derivedTableCleanupSql).toContain("l.kind='activation'");
    expect(derivedTableCleanupSql).toContain("VALUES(p_club_id,'adjustment',-v_spin_seed,0");
    expect(derivedTableCleanupSql).toContain('WELCOME_CERTIFICATION_PHYSICAL_GRAPH_REFUSED');
    expect(derivedTableCleanupSql).toContain('WELCOME_CERTIFICATION_RETIREMENT_REFUSED');
    expect(derivedTableCleanupSql).toContain("'child_chips_retired',v_child_retired");
    expect(derivedTableCleanupSql).toContain(
      "round(COALESCE((v_retired->>'chips_retired')::numeric,0)+v_child,2)"
    );
    expect(derivedTableCleanupSql.indexOf('FROM public.cash_games')).toBeLessThan(
      derivedTableCleanupSql.indexOf('FROM public.clubs WHERE id=p_club_id FOR UPDATE')
    );
  });
});
