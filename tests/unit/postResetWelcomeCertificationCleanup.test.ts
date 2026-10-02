import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20261002210559_post_reset_welcome_certification_cleanup.sql'
  ),
  'utf8'
);

describe('post-reset welcome certification cleanup', () => {
  it('recognizes only the exact successful state-B receipt and custody lineage', () => {
    expect(migration).toContain("(v_result->>'ok')::boolean,false) IS NOT TRUE");
    expect(migration).toContain("opening_grant_unwound')::boolean,true) IS NOT FALSE");
    expect(migration).toContain("'{returned_to_treasury,bbj}'");
    expect(migration).toContain("'{returned_to_treasury,spin}'");
    expect(migration).toContain('v_club.chip_treasury IS DISTINCT FROM 100000::numeric');
    expect(migration).toContain("l.kind='seed_return' AND l.amount=-200");
    expect(migration).toContain("l.kind='deactivation' AND l.amount=0");
    expect(migration).toContain(
      "l.idempotency_key='spin-deactivation-seed-return:'||p_club_id::text||':200'"
    );
    expect(migration).toContain("x.metadata->>'reason'='welcome_package_reset'");
  });

  it('fails closed on activity and consumes the transaction-bound table permits', () => {
    expect(migration).toContain('POST_RESET_CERTIFICATION_ACTIVITY_REFUSED');
    expect(migration).toContain('POST_RESET_CERTIFICATION_UNKNOWN_TOURNAMENT_ACTIVITY');
    expect(migration).toContain('POST_RESET_CERTIFICATION_MANAGED_COMMAND_REFUSED');
    expect(migration).toContain('smarter_private.f06_lease_has_pending_custody');
    expect(migration).toContain(
      'INSERT INTO smarter_private.ca_welcome_certification_table_delete_permits'
    );
    expect(migration).toContain('transaction_id,table_id,tournament_id,club_id');
    expect(migration).toContain('p.transaction_id=pg_current_xact_id()');
    expect(migration).toContain('POST_RESET_CERTIFICATION_TABLE_DELETE_PERMIT_NOT_CONSUMED');
    expect(migration).toContain("set_config('app.game_management_retention','on',true)");
    expect(migration).toContain("set_config('app.managed_game_lifecycle','on',true)");
    expect(migration).toContain('DELETE FROM public.managed_game_schedules');
  });

  it('removes only exact zero-use fixture rows and retains immutable financial evidence', () => {
    const helper = migration.slice(
      migration.indexOf(
        'CREATE FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture'
      ),
      migration.indexOf(
        'REVOKE ALL ON FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture'
      )
    );
    expect(migration).toContain('POST_RESET_CERTIFICATION_DIAMOND_STATE_REFUSED');
    expect(migration).toContain('DELETE FROM public.wheel_pools WHERE host_id=p_club_id');
    expect(migration).toContain('DELETE FROM public.diamond_game_pools WHERE host_id=p_club_id');
    expect(migration).not.toMatch(
      /DELETE FROM public\.(?:wheel_config_history|diamond_game_config_history)/
    );
    expect(helper).toContain('DELETE FROM public.club_welcome_package_funding');
    expect(helper).toContain('DELETE FROM public.club_welcome_package_items');
    expect(helper).toContain('DELETE FROM public.club_welcome_reset_receipts');
    expect(helper).toContain('DELETE FROM public.club_welcome_package_receipts');
    expect(helper).not.toMatch(/DELETE FROM public\.(?:spin_reserve_ledger|chip_ledger)/);
    expect(migration).toContain("'financial_history_preserved',true");
  });

  it('branches state B without changing the established state-A chain or core route', () => {
    const wrapper = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_retire_welcome_certification_club')
    );
    const ordered = [
      'fn_ca_prepare_unused_welcome_certification_board_leases',
      'fn_ca_prepare_unused_welcome_certification_board_origins',
      'fn_ca_prepare_unused_welcome_certification_board_games',
      'fn_ca_prepare_unused_welcome_certification_schedule_spawns',
      'fn_ca_prepare_unused_welcome_certification_fixture',
      'fn_ca_retire_certification_club',
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(wrapper.indexOf(ordered[index - 1])).toBeLessThan(wrapper.indexOf(ordered[index]));
    }
    expect(wrapper).toContain('IF v_post_reset THEN');
    expect(wrapper).toContain('fn_ca_prepare_post_reset_welcome_certification_fixture');
    expect(wrapper).toContain('POST_RESET_CERTIFICATION_PREPARATION_REFUSED');
    expect(wrapper).toContain('v_retired:=public.fn_ca_retire_certification_club');
    expect(migration).toMatch(/^-- @live-proof:/m);
    expect(migration.trim()).toMatch(/COMMIT;$/);
  });

  it('keeps the new preparer private even from service-role RPC callers', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'
    );
    expect(migration).toContain('FROM PUBLIC,anon,authenticated,service_role');
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_prepare_post_reset_welcome_certification_fixture/
    );
  });
});
