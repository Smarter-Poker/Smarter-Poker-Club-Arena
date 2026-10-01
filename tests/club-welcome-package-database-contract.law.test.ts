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

describe('prospective lifetime-first club welcome package database contract', () => {
  it('installs atomically with the reviewed hot-relation lock window', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '15s';");
    expect(sql).not.toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('mints entitlement only from a new creation receipt and never backfills', () => {
    expect(sql).toContain('CREATE TRIGGER trg_offer_lifetime_first_club_welcome');
    expect(sql).toContain('public.fn_club_membership_lock(NEW.user_id)');
    expect(sql).toContain('club_owner_creation_history');
    expect(sql).toContain("false,'historical'");
    expect(sql).toContain("true,'prospective'");
    expect(sql).toContain('trg_remember_club_owner_transfer');
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
    expect(sql).toContain('trg_fence_welcome_package_schedule_spawn');
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
    expect(sql).toContain('club_welcome_allocation ledger context');
    expect(sql).toContain('Diamond Spins remain owner-acceptance-required');
  });

  it('does not mutate tagline, membership, wallets or historical ledgers', () => {
    expect(sql).not.toMatch(/UPDATE public\.clubs SET[^;]*tagline/is);
    expect(sql).not.toMatch(
      /(INSERT INTO|UPDATE|DELETE FROM) public\.(club_members|club_wallets|wallets|chip_ledger|chip_transactions|hand_history)/
    );
  });

  it('prepares only an unused reserved certification welcome fixture before the old retirement door', () => {
    expect(sql).toContain('public.fn_ca_prepare_unused_welcome_certification_fixture');
    expect(sql).toContain('WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED');
    expect(sql).toContain('WELCOME_CERTIFICATION_FIXTURE_MEMBER_OR_AGENT_REFUSED');
    expect(sql).toContain('WELCOME_CERTIFICATION_HAS_NONPACKAGE_GAMES');
    expect(sql).toContain('WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY');
    expect(sql).toContain("LIKE 'club-create-cert-%@smarter-poker.invalid'");
    expect(sql).toContain("LIKE 'ca-customization-cert-postdeploy-%@example.invalid'");
    expect(sql).toContain('v_item_count<>10');
    expect(sql).toContain('cardinality(v_cash)<>9');
    expect(sql).toContain('DELETE FROM public.tables WHERE id=ANY(v_tables)');
    expect(sql).toContain('DELETE FROM public.cash_games WHERE id=ANY(v_cash)');
    expect(sql).toContain('DELETE FROM public.tournament_schedules WHERE id=ANY(v_schedules)');
    expect(sql).toContain(
      'PERFORM public.fn_ca_prepare_unused_welcome_certification_fixture(p_club_id)'
    );
    expect(sql.indexOf('WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY')).toBeLessThan(
      sql.indexOf('DELETE FROM public.tables WHERE id=ANY(v_tables)')
    );
  });
});
