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
});
