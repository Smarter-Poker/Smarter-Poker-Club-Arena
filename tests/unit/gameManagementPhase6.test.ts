import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');
const migration = read(
  'supabase/migrations/20260902210000_table_management_scale_and_scheduling.sql'
);
const service = read('src/services/GameManagementService.ts');
const page = read('src/pages/GameManagementPage.tsx');

describe('Table Management Phase 6 scheduling authority', () => {
  it('stores one pending close per game and processes due work without overlap', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.managed_game_schedules');
    expect(migration).toContain('idx_managed_game_schedules_one_pending_close');
    expect(migration).toContain("status IN ('scheduled','executing')");
    expect(migration).toContain(
      "pg_try_advisory_xact_lock(hashtext('run-due-managed-game-schedules'))"
    );
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).toContain('LIMIT LEAST(100,GREATEST(1,COALESCE(p_batch_size,50)))');
  });

  it('reuses the exactly-once gateway and therefore all lifecycle guards', () => {
    expect(migration).toContain('public.fn_execute_managed_game_command(');
    expect(migration).not.toContain('public.fn_close_managed_game(');
    expect(migration).toContain('expected_version=p_expected_version');
    expect(migration).toContain("'reason','stale_contract_version'");
    expect(migration).toContain("status=CASE WHEN COALESCE((v_result->>'ok')::boolean,false)");
  });

  it('keeps scheduling operator-authorized and execution service-only', () => {
    expect(migration).toContain('public.fn_can_create_games(v_club,v_uid)');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_run_due_managed_game_schedules(integer) FROM PUBLIC,anon,authenticated'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_schedule_managed_game_close(text,uuid,integer,timestamptz) TO authenticated,service_role'
    );
    expect(migration).toContain("cron.schedule('managed-game-schedules-minute','* * * * *'");
  });

  it('wires accessible schedule and cancel controls into the game board', () => {
    expect(service).toContain("rpc('fn_schedule_managed_game_close'");
    expect(service).toContain("rpc('fn_cancel_managed_game_schedule'");
    expect(page).toContain('function ScheduleCloseDialog');
    expect(page).toContain('aria-labelledby="schedule-close-title"');
    expect(page).toContain("toast.success('Guarded close scheduled.')");
    expect(page).toContain("toast.success('Scheduled close cancelled.')");
  });

  it('uses the engine authority for safe pause and resume instead of a status write', () => {
    expect(service).toContain('`${ENGINE_BASE_URL}/admin/${action}`');
    expect(service).toContain("action: 'pause' | 'resume'");
    expect(page).toContain('await gameManagementService.resume(game.id)');
    expect(page).toContain('await gameManagementService.pause(game.id)');
    expect(page).toContain('Table will pause after this hand.');
  });
});

describe('Table Management Phase 6 scale and retention', () => {
  it('uses an authorized keyset read model capped at 100 rows', () => {
    expect(migration).toContain('public.fn_list_managed_games');
    expect(migration).toContain('public.fn_game_creation_access(p_scope_id)');
    expect(migration).toContain("v_access->>'union_id' IS NOT NULL");
    expect(migration).toContain('(g.sort_at,g.kind,g.id)>(p_cursor,p_cursor_kind,p_cursor_id)');
    expect(migration).toContain('LEAST(100,GREATEST(1,COALESCE(p_limit,100)))');
    expect(migration).toContain('idx_tables_management_scope_club_page');
    expect(migration).toContain('t.club_id=ANY(v_scope_clubs)');
    expect(service).toContain("rpc('fn_list_managed_games'");
    expect(service).toContain('p_limit: 100');
    expect(page).toContain('Load More · ${games.length} Of ${counts.total}');
    expect(page).not.toContain('.limit(500)');
  });

  it('prunes only old realtime invalidations in bounded non-overlapping batches', () => {
    expect(migration).toContain('public.fn_prune_game_management_events');
    expect(migration).toContain("now()-interval '7 days'");
    expect(migration).toContain('LIMIT LEAST(10000,GREATEST(1,COALESCE(p_batch_size,5000)))');
    expect(migration).toContain("current_setting('app.game_management_retention',true)");
    expect(migration).toContain("cron.schedule('game-management-events-retention','17 4 * * *'");
    expect(migration).not.toMatch(/DELETE FROM public\.managed_game_command_receipts/);
  });

  it('surfaces scoped scheduler and retention health to operators', () => {
    expect(migration).toContain('public.fn_get_game_management_scale_health');
    expect(service).toContain("rpc('fn_get_game_management_scale_health'");
    expect(page).toContain('Pending Schedules');
    expect(page).toContain('Schedule Rejects');
    expect(page).toContain('Realtime Events');
  });

  it('is one transactional migration with private maintenance functions', () => {
    expect(migration.trimStart().startsWith('-- Table Management Scale And Scheduling')).toBe(true);
    expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;/);
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_prune_game_management_events(timestamptz,integer) FROM PUBLIC,anon,authenticated'
    );
  });
});
