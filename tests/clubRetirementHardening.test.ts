import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20261002152925_club_retirement_safe_unwind.sql'),
  'utf8'
).toLowerCase();
const welcomeUnwindMigration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261002152207_new_clubs_open_complete_and_reset_to_zero.sql'
  ),
  'utf8'
).toLowerCase();
const sync = readFileSync(resolve(__dirname, '../src/services/PostgresSyncHooks.ts'), 'utf8');
const settings = readFileSync(resolve(__dirname, '../src/pages/ClubSettingsPage.tsx'), 'utf8');
const rules = readFileSync(resolve(__dirname, '../src/utils/clubSettingsRules.ts'), 'utf8');
const schemaFragment = JSON.parse(
  readFileSync(
    resolve(__dirname, '../scripts/ci/schema-manifest.d/club-retirement-hardening.json'),
    'utf8'
  )
) as { functions?: string[] };

describe('retained-club retirement hardening', () => {
  it('composes the owner door with the authoritative unused-welcome unwind and exact opening burn', () => {
    expect(welcomeUnwindMigration).toContain(
      'create function public.fn_unwind_unused_first_club_welcome_package('
    );
    expect(migration).toContain('club_retirement_requires_20261002152207_welcome_unwind');
    expect(migration).toContain(
      'public.fn_unwind_unused_first_club_welcome_package(p_club_id,v_operation_id)'
    );
    expect(migration).toContain("t.transaction_type='club_opening_grant'");
    expect(migration).toContain("m.op_id='club-opening-grant:'||p_club_id::text");
    expect(migration).toContain("'club-owner-retire-opening:'||p_club_id::text");
    expect(migration).toContain("public.fn_ca_declare_ledger('burn','chip_retirement'");
    expect(migration).toContain('v_opening_tx_count<>1 or v_opening_mint_count<>1');
    expect(migration).toContain("'pristine_welcome_retire_available',v_pristine_welcome");
    expect(migration).toContain('v_reset := public.fn_get_club_welcome_package_reset_impact');
  });

  it('lets only the authoritative pristine-welcome flag arm the visible Retire action', () => {
    expect(settings).toContain('pristine_welcome_retire_available?: unknown');
    expect(settings).toContain("typeof pristineWelcomeRetireAvailable !== 'boolean'");
    expect(settings).toContain('pristineWelcomeRetireAvailable,');
    expect(rules).toContain('if (impact.pristineWelcomeRetireAvailable) return null');
  });

  it('keeps the real-club contract soft, audited, idempotent and record preserving', () => {
    const start = migration.indexOf('create function public.fn_retire_settled_club(');
    const end = migration.indexOf('$function$;', start);
    const body = migration.slice(start, end);
    expect(body).toContain("v_club.lifecycle_status='retired'");
    expect(body).toContain('fn_retire_settled_club_core_20260906');
    expect(body).toContain("'already_retired',true");
    expect(body).not.toContain('delete from public.clubs');
    expect(body).not.toContain('delete from public.club_members');
  });

  it('declares both private core identities in the branch schema manifest', () => {
    expect(schemaFragment.functions).toEqual([
      'fn_club_retirement_impact_core_20260906',
      'fn_retire_settled_club_core_20260906',
    ]);
  });

  it('freezes cash, tournament schedule, spawn and delayed-command writers after retirement', () => {
    for (const table of [
      'cash_games',
      'tournament_schedules',
      'tournament_schedule_spawns',
      'managed_game_schedules',
      'club_opening_checklists',
      'club_welcome_entitlements',
      'club_welcome_package_items',
      'wheel_configs',
      'wheel_pools',
      'diamond_game_configs',
      'diamond_game_pools',
    ]) {
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain("c.lifecycle_status = 'active'");
    expect(migration).toContain('for key share');
    expect(migration).toContain("'active_cash_games'");
    expect(migration).toContain("'active_tournament_schedules'");
    expect(migration).toContain("'pending_managed_commands'");
    expect(migration).toContain("'active_diamond_games'");
  });

  it('emits recipient-visible retirement invalidations and refreshes global client state', () => {
    expect(migration).toContain("'club_identity_changed',p_club_id,null,v_recipient");
    expect(sync).toContain("row.event_type === 'club_identity_changed'");
    expect(sync).toContain("masterBus.emit('CLUB_LEFT', { clubId })");
    expect(sync).toContain(
      "this.debouncedEmit(`membership_${clubId}`, 'CLUB_UPDATED', { clubId })"
    );
  });
});
