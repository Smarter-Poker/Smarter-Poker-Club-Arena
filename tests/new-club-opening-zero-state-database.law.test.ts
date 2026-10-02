import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261002152207_new_clubs_open_complete_and_reset_to_zero.sql'
  ),
  'utf8'
);
const certificate = readFileSync(
  resolve(__dirname, '../scripts/ci/certify-club-create.mjs'),
  'utf8'
);
const indexedHandChecks = readFileSync(
  resolve(__dirname, '../supabase/migrations/20261002165000_welcome_reset_indexed_hand_checks.sql'),
  'utf8'
);

describe('new club opening package and zero-state database law', () => {
  it('creates a canonical wallet prospectively without historical backfill', () => {
    expect(migration).toContain('CREATE TRIGGER trg_create_canonical_club_wallet');
    expect(migration).toContain('AFTER INSERT ON public.clubs FOR EACH ROW');
    expect(migration).toContain('INSERT INTO public.club_wallets(club_id) VALUES(NEW.id)');
    expect(migration).not.toMatch(/INSERT INTO public\.club_wallets[\s\S]{0,120}SELECT/);
  });

  it('preconfigures every Diamond game but never forges owner acceptance', () => {
    for (const game of ['plinko', 'crash', 'crossing', 'mines']) {
      expect(migration).toContain(`'${game}'`);
    }
    expect(migration).toContain(
      "VALUES(NEW.club_id,'club',true,100,v_version,false,false,NEW.actor_id)"
    );
    expect(migration).toContain("VALUES(NEW.club_id,v_game,'club',true,25,5000");
    expect(migration).not.toMatch(/INSERT INTO public\.diamond_spins_owner_consents/i);
    expect(migration).toContain('fn_diamond_spins_owner_agreed');
  });

  it('serializes recurrence shutdown and conserves both seeded principals', () => {
    expect(migration).toContain("IN('SPIN','SNG')");
    expect(migration).toContain('FOR KEY SHARE');
    expect(migration).toContain('WELCOME_PACKAGE_SPIN_BOARD_RETIRED');
    expect(migration).toContain('fn_spin_deactivate(p_club_id,v_actor)');
    expect(migration).toContain("'treasury_transfer','bbj_pool'");
    expect(migration).toContain("'bbj_promo_sweep'");
    expect(migration).toContain("'opening_grant_unwound',false");
    expect(migration).toContain('WELCOME_UNWIND_LANE_DOCTRINE_REVERSE_SUBSTITUTION_FAILED');
    expect(migration).toContain("'fn_unwind_unused_first_club_welcome_package','approved'");
    expect(migration).not.toMatch(
      /DELETE FROM public\.(chip_|bbj_|spin_|diamond_spins_owner_consents)/
    );
  });

  it('fails closed after use or economic drift and preserves idempotency', () => {
    for (const table of [
      'table_seats',
      'table_sessions',
      'tournament_players',
      'hand_history',
      'bbj_contributions',
      'bbj_payouts',
      'bbj_promo_events',
      'wheel_pools',
      'diamond_game_pools',
    ]) {
      expect(migration).toContain(`public.${table}`);
    }
    expect(migration).toContain('WELCOME_PACKAGE_ECONOMICS_ARE_NOT_PRISTINE');
    expect(migration).toContain("result->>'ok'");
    expect(migration).toContain("'requested_operation_id',p_operation_id");
  });

  it('certifies create readback and a conserved true-zero reset without retrying writes', () => {
    for (const table of [
      'club_wallets',
      'cash_games',
      'tables',
      'tournament_schedules',
      'spin_bonus_pools',
      'diamond_game_configs',
      'diamond_spins_owner_consents',
    ]) {
      expect(certificate).toContain(`.from('${table}')`);
    }
    expect(certificate).toContain("'fn_get_club_welcome_package_reset_impact'");
    expect(certificate).toContain("'fn_remove_first_club_welcome_games'");
    expect(certificate).toContain('Number(resetClubRead.data?.chip_treasury) !== 100000');
    expect(certificate).not.toMatch(
      /retryTransient\([\s\S]{0,300}fn_remove_first_club_welcome_games/
    );
  });

  it('keeps both pristine-history gates on the existing hand-history indexes', () => {
    expect(indexedHandChecks).toContain(
      "to_regprocedure('public.fn_get_club_welcome_package_reset_impact(uuid)')"
    );
    expect(indexedHandChecks).toContain(
      "to_regprocedure('public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)')"
    );
    expect(indexedHandChecks).toContain('h.tournament_id=ANY(v_tournaments)');
    expect(indexedHandChecks).toContain('h.table_id=ANY(v_tables)');
    expect(indexedHandChecks).toContain('h.tournament_id<>ALL(v_tournaments)');
    expect(indexedHandChecks).toContain('IF v_after = v_before THEN');
    expect(indexedHandChecks.match(/v_after := replace\(v_before,v_old,v_new\);/g)).toHaveLength(2);
    expect(indexedHandChecks.match(/EXECUTE v_after;/g)).toHaveLength(3);
  });

  it('reviews retained club retirement as the cross-resource global-lane authority it is', () => {
    expect(indexedHandChecks).toContain("'fn_retire_settled_club'");
    expect(indexedHandChecks).toContain('v_answer:=public.fn_ca_settlement_lane_doctrine()');
    expect(indexedHandChecks).toContain(
      'CLUB_RETIREMENT_LANE_DOCTRINE_REVERSE_SUBSTITUTION_FAILED'
    );
    expect(indexedHandChecks).toContain('CLUB_RETIREMENT_SETTLEMENT_LANE_DOCTRINE_FAILED');
  });
});
