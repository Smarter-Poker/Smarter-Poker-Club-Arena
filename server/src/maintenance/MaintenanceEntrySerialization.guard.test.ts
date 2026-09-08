/**
 * LAW: a maintenance announcement and a new paid entry have one durable order.
 *
 * A second clock check cannot close a TOCTOU race. These pins keep the actual
 * transaction boundary: maintenance-row writers take one exclusive advisory
 * lock, while every admission and rebuy path takes the matching shared lock
 * and holds it through commit or rollback.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260908042800_maintenance_announcement_and_entry_purchases_are_serialized.sql'
  ),
  'utf8'
);
const STORE = readFileSync(
  resolve(process.cwd(), 'src', 'maintenance', 'maintenanceBreakStore.ts'),
  'utf8'
);
const SUPABASE_CLIENT = readFileSync(
  resolve(process.cwd(), 'src', 'services', 'supabase', 'client.ts'),
  'utf8'
);

function functionDefinition(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} definition`).toBeGreaterThan(-1);
  const end = SQL.indexOf('$function$;', start);
  expect(end, `${name} terminator`).toBeGreaterThan(start);
  return SQL.slice(start, end + '$function$;'.length);
}

describe('maintenance and new entries share one transaction boundary', () => {
  it('ships as one fail-closed database transaction', () => {
    expect(SQL.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
    expect(SQL.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(SQL).not.toMatch(/cron|watch(?:er|list)?/i);
  });

  it('puts every maintenance-row write behind the exclusive side of the lock', () => {
    expect(functionDefinition('fn_serialize_engine_maintenance_break_write')).toMatch(
      /pg_advisory_xact_lock\(530090, 1\)/
    );
    expect(SQL).toMatch(
      /CREATE TRIGGER aa_serialize_maintenance_break_write[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public\.engine_maintenance_break[\s\S]*?FOR EACH STATEMENT/
    );
    expect(functionDefinition('fn_serialize_engine_maintenance_break_write')).toMatch(
      /IF TG_OP = 'TRUNCATE' THEN[\s\S]*?may not be truncated[\s\S]*?pg_advisory_xact_lock\(530090, 1\)/
    );
    expect(SQL).toMatch(
      /REVOKE TRUNCATE ON TABLE public\.engine_maintenance_break\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL).toContain('CREATE TRIGGER aa_serialize_tournament_player_insert');
    expect(SQL).toContain('DROP TRIGGER IF EXISTS aa_serialize_table_seat_insert');
    expect(SQL).toContain('DROP TRIGGER IF EXISTS aa_serialize_tournament_launch');
    expect(SQL).not.toContain('CREATE TRIGGER aa_serialize_table_seat_insert');
    expect(SQL).not.toContain('CREATE TRIGGER aa_serialize_tournament_launch');
  });

  it('keeps paid entries concurrent but blocks them behind a waiting announcement', () => {
    for (const door of [
      'process_tournament_rebuy',
      'atomic_table_buyin',
      'atomic_table_rebuy',
      'atomic_table_addon',
      'fn_horse_fund_from_treasury',
      'fn_horse_seat_from_treasury',
    ]) {
      const definition = functionDefinition(door);
      expect(definition, door).toMatch(/pg_advisory_xact_lock_shared\(530090, 1\)/);
      expect(definition, door).toMatch(/fn_entry_purchases_frozen\(\)/);
    }
    expect(functionDefinition('fn_refuse_new_entries_while_frozen')).toMatch(
      /pg_try_advisory_xact_lock_shared\(530090, 1\)/
    );
    expect(functionDefinition('process_tournament_rebuy')).toMatch(
      /process_tournament_rebuy_before_maintenance_announcement_gate/
    );
  });

  it('claims a complete immutable receipt before checking freeze or entering a money core', () => {
    expect(SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.entry_purchase_idempotency_receipts[\s\S]*?request jsonb NOT NULL[\s\S]*?response jsonb[\s\S]*?ENABLE ROW LEVEL SECURITY/
    );
    expect(functionDefinition('fn_claim_entry_purchase_receipt')).toMatch(
      /INSERT INTO public\.entry_purchase_idempotency_receipts[\s\S]*?ON CONFLICT \(key_domain, idempotency_key\) DO NOTHING/
    );
    expect(functionDefinition('fn_record_entry_purchase_receipt')).toMatch(
      /FOR UPDATE[\s\S]*?SET response = p_response[\s\S]*?completed_at = transaction_timestamp\(\)/
    );
    expect(functionDefinition('trg_entry_purchase_receipt_is_immutable')).toContain(
      'completed receipts cannot be deleted'
    );

    for (const door of [
      'process_tournament_rebuy',
      'atomic_table_buyin',
      'atomic_table_rebuy',
      'atomic_table_addon',
      'fn_horse_fund_from_treasury',
      'fn_horse_seat_from_treasury',
    ]) {
      const definition = functionDefinition(door);
      const claim = definition.indexOf('fn_claim_entry_purchase_receipt');
      const freeze = definition.indexOf('fn_entry_purchases_frozen');
      expect(claim, `${door} does not claim a receipt`).toBeGreaterThan(-1);
      expect(claim, `${door} checks freeze before a committed replay`).toBeLessThan(freeze);
      expect(definition, `${door} does not complete its receipt`).toContain(
        'fn_record_entry_purchase_receipt'
      );
    }
  });

  it('takes the shared boundary first in every surrounding entry transaction', () => {
    for (const door of [
      'fn_register_for_tournament',
      'fn_register_horse_for_tournament',
      'fn_take_seat_and_buy_in',
      'fn_seat_horse_in_seat_first_game',
      'fn_seat_late_registrant',
      'fn_repair_seat_first_games',
      'fn_cash_seat_move_execute',
      'fn_cash_seat_swap_execute',
      'fn_begin_tournament_launch_atomic',
      'fn_settle_satellite_finish_atomic',
    ]) {
      const definition = functionDefinition(door);
      expect(definition, door).toMatch(/BEGIN\s+PERFORM pg_advisory_xact_lock_shared\(530090, 1\)/);
    }
  });

  it('takes the maintenance boundary before the seat-first repair singleton', () => {
    const repair = functionDefinition('fn_repair_seat_first_games');
    expect(repair).toMatch(
      /BEGIN\s+PERFORM pg_advisory_xact_lock_shared\(530090, 1\)[\s\S]*?fn_entry_purchases_frozen\(\)[\s\S]*?fn_repair_seat_first_games_before_maintenance_gate/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_repair_seat_first_games_before_maintenance_gate\(integer\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
  });

  it('persists and clears maintenance through a longer first-lock writer RPC', () => {
    for (const door of [
      'fn_save_engine_maintenance_break',
      'fn_claim_engine_maintenance_break',
      'fn_clear_engine_maintenance_break',
    ]) {
      const definition = functionDefinition(door);
      expect(definition, door).toMatch(
        /SET statement_timeout = '45s'\s+SET lock_timeout = '40s'[\s\S]*?PERFORM pg_advisory_xact_lock\(530090, 1\)/
      );
    }
    expect(STORE).toContain("maintenanceSupabase.rpc('fn_save_engine_maintenance_break'");
    expect(STORE).toContain("maintenanceSupabase.rpc('fn_clear_engine_maintenance_break'");
    expect(STORE).toContain("maintenanceSupabase.rpc('fn_claim_engine_maintenance_break'");
    expect(STORE).not.toMatch(/\.from\(TABLE\)\.(?:upsert|delete)/);
    expect(functionDefinition('fn_save_engine_maintenance_break')).toMatch(
      /ownership_token = EXCLUDED\.ownership_token[\s\S]*?WHERE public\.engine_maintenance_break\.ownership_token = EXCLUDED\.ownership_token/
    );
    expect(functionDefinition('fn_clear_engine_maintenance_break')).toMatch(
      /MAINTENANCE_OWNERSHIP_REQUIRED[\s\S]*?b\.ownership_token = p_ownership_token/
    );
    expect(functionDefinition('fn_clear_engine_maintenance_break')).not.toContain(
      'p_require_exact'
    );
    expect(STORE).not.toContain('p_require_exact');
    expect(SUPABASE_CLIENT).toMatch(/MAINTENANCE_SUPABASE_TIMEOUT_MS[\s\S]*?50_000/);
    expect(SUPABASE_CLIENT).toMatch(
      /maintenanceSupabase[\s\S]*?createBoundedServiceClient\([\s\S]*?MAINTENANCE_DB_TIMEOUT_MS/
    );
  });

  it('keeps receipt helpers and every renamed money core private to their wrappers', () => {
    for (const helper of [
      'fn_claim_entry_purchase_receipt',
      'fn_record_entry_purchase_receipt',
      'fn_release_entry_purchase_claim',
    ]) {
      expect(SQL).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${helper}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role;`
        )
      );
      expect(SQL).not.toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${helper}\\([\\s\\S]{0,160}?TO service_role;`
        )
      );
    }
    expect(functionDefinition('atomic_table_addon')).toContain('SECURITY DEFINER');
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.atomic_table_addon_before_maintenance_announcement_gate\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.atomic_table_addon_before_maintenance_announcement_gate\([\s\S]{0,180}?TO service_role;/
    );
  });

  it('lets only the atomic satellite settlement deliver an earned seat', () => {
    const entryGuard = functionDefinition('fn_refuse_new_entries_while_frozen');
    expect(entryGuard).toMatch(
      /TG_TABLE_NAME = 'tournament_players'[\s\S]*?is_satellite_qualifier[\s\S]*?source_satellite_id[\s\S]*?app\.atomic_satellite_settlement/
    );
    expect(entryGuard).toMatch(
      /TG_TABLE_NAME = 'tournament_players'[\s\S]*?FROM public\.tournaments t[\s\S]*?NEW\.tournament_id[\s\S]*?FOR UPDATE;[\s\S]*?is_satellite_qualifier/
    );
    expect(SQL).toMatch(/REVOKE INSERT ON TABLE public\.tournament_players FROM service_role;/);
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_award_satellite_seat\(uuid, uuid, uuid, text, integer\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
    const poolGuard = functionDefinition('trg_freeze_finalized_tournament_prize_pool');
    expect(poolGuard).toMatch(
      /app\.atomic_satellite_settlement[\s\S]*?tournament_satellite_settlement_batches[\s\S]*?tournament_satellite_entitlements[\s\S]*?target_player\.source_satellite_id = OLD\.id/
    );
    expect(poolGuard).toMatch(/to_jsonb\(NEW\) - 'prize_pool'/);
    expect(poolGuard).toMatch(/v_candidate_count = 1/);
  });

  it('makes tournament launch one durable atomic status transition', () => {
    expect(SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.tournament_launch_receipts[\s\S]*?launch_id uuid NOT NULL UNIQUE[\s\S]*?completed_at timestamptz[\s\S]*?ENABLE ROW LEVEL SECURITY/
    );
    const begin = functionDefinition('fn_begin_tournament_launch_atomic');
    expect(begin).toMatch(
      /BEGIN\s+PERFORM pg_advisory_xact_lock_shared\(530090, 1\)[\s\S]*?fn_entry_purchases_frozen\(\)[\s\S]*?INSERT INTO public\.tournament_launch_receipts/
    );
    expect(begin).not.toMatch(/SET status = 'RUNNING'/);
    expect(begin).toMatch(
      /p_started_at IS NOT NULL[\s\S]*?v_existing\.launch_id = p_launch_id[\s\S]*?v_existing\.started_at IS DISTINCT FROM p_started_at/
    );
    expect(begin).toMatch(
      /'launch_id', v_existing\.launch_id[\s\S]*?'started_at', v_existing\.started_at/
    );
    const complete = functionDefinition('fn_complete_tournament_launch_atomic');
    expect(complete).toMatch(
      /FOR UPDATE[\s\S]*?set_config\([\s\S]*?app\.atomic_tournament_launch[\s\S]*?UPDATE public\.tournaments[\s\S]*?status = 'RUNNING'[\s\S]*?UPDATE public\.tournament_launch_receipts[\s\S]*?SET completed_at = v_completed_at/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_begin_tournament_launch_atomic\([\s\S]*?FROM PUBLIC, anon, authenticated;/
    );
    expect(functionDefinition('fn_refuse_new_entries_while_frozen')).toContain(
      'TOURNAMENT_LAUNCH_RECEIPT_REQUIRED'
    );
    const clockLock = functionDefinition('trg_lock_tournament_start_time_during_launch');
    expect(clockLock).toMatch(
      /SECURITY DEFINER[\s\S]*?SET search_path = public, pg_temp[\s\S]*?NEW\.start_time IS DISTINCT FROM OLD\.start_time[\s\S]*?completed_at IS NULL/
    );
    expect(SQL).toMatch(
      /CREATE TRIGGER tournament_start_time_locked_during_launch[\s\S]*?BEFORE UPDATE OF start_time ON public\.tournaments/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.trg_lock_tournament_start_time_during_launch\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    );
  });

  it('validates the whole launch under the locked tournament row before RUNNING', () => {
    const complete = functionDefinition('fn_complete_tournament_launch_atomic');
    const rowLock = complete.indexOf('FOR UPDATE;');
    const rosterProof = complete.indexOf("p.status IN ('registered', 'playing')", rowLock);
    const seatProof = complete.indexOf('count(DISTINCT (s.table_id, s.seat_number))', rosterProof);
    const tableProof = complete.indexOf("t.status NOT IN ('running', 'waiting')", seatProof);
    const spinProof = complete.indexOf("l.kind = 'jackpot_draw'", tableProof);
    const privateTransition = complete.indexOf("'app.atomic_tournament_launch'", spinProof);
    const runningWrite = complete.indexOf("status = 'RUNNING'", privateTransition);

    expect(rowLock).toBeGreaterThan(-1);
    expect(rosterProof).toBeGreaterThan(rowLock);
    expect(seatProof).toBeGreaterThan(rosterProof);
    expect(tableProof).toBeGreaterThan(seatProof);
    expect(spinProof).toBeGreaterThan(tableProof);
    expect(privateTransition).toBeGreaterThan(spinProof);
    expect(runningWrite).toBeGreaterThan(privateTransition);
    expect(complete).toMatch(/COALESCE\(p\.chips, 0\) <= 0/);
    expect(complete).toMatch(/COALESCE\(s\.stack, 0\) <= 0/);
    expect(complete).toContain('v_matching_roster_seats <> v_active_count');
    expect(complete).toMatch(
      /LEFT JOIN \([\s\S]*?seats\.table_id IS NULL[\s\S]*?t\.current_players IS DISTINCT FROM seats\.live_count/
    );
    expect(complete).toContain('v_spin_ledger_multiplier IS DISTINCT FROM v_spin_multiplier');
  });

  it('adopts stored T1 for a new T2 request but rejects T2 on the same launch id', () => {
    const begin = functionDefinition('fn_begin_tournament_launch_atomic');
    const mismatch = begin.slice(
      begin.indexOf('IF p_started_at IS NOT NULL'),
      begin.indexOf('SELECT t.status, t.started_at', begin.indexOf('IF p_started_at IS NOT NULL'))
    );
    expect(mismatch).toMatch(/v_existing\.launch_id = p_launch_id/);
    expect(mismatch).toMatch(/v_existing\.started_at IS DISTINCT FROM p_started_at/);
    expect(mismatch).toContain("'reason', 'launch_request_mismatch'");
    expect(begin).toMatch(
      /'launch_id', v_existing\.launch_id[\s\S]*?'started_at', v_existing\.started_at/
    );

    // Completion is receipt-bound. A newly minted invocation that adopts T1
    // must not be compared with the mutable tournament schedule T2.
    const complete = functionDefinition('fn_complete_tournament_launch_atomic');
    expect(complete).not.toContain('start_time');
    expect(complete).toMatch(
      /v_started_at IS DISTINCT FROM v_receipt\.started_at[\s\S]*?status = 'RUNNING'[\s\S]*?started_at = v_receipt\.started_at/
    );
  });

  it('closes the bounded last-hand window only for new entries', () => {
    expect(SQL).toMatch(
      /FUNCTION public\.fn_entry_purchases_frozen\(\)[\s\S]*?phase = 'last_hand'[\s\S]*?announced_at \+ INTERVAL '7 minutes'[\s\S]*?phase = 'counting_down'/
    );
    expect(SQL).toContain('clock_timestamp()');
    expect(SQL).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_platform_frozen/);
    const publicState = functionDefinition('fn_maintenance_break_state');
    expect(publicState).toMatch(
      /WHEN b\.phase = 'last_hand' THEN b\.announced_at \+ INTERVAL '7 minutes'/
    );
    expect(publicState).toMatch(/SECURITY INVOKER/);
  });

  it('leaves already-owned tournament seat moves and in-flight settlement open', () => {
    expect(SQL).toMatch(/IF NOT COALESCE\(v_is_cash, true\) THEN\s+RETURN NEW;/);
    expect(SQL).toMatch(/BEFORE INSERT OR UPDATE OF left_at, user_id ON public\.table_seats/);
    expect(SQL).not.toMatch(/zz_freeze_guard|BEFORE UPDATE OF stack/);
    const guard = functionDefinition('fn_refuse_new_entries_while_frozen');
    expect(guard).toMatch(/TG_TABLE_NAME = 'tournament_players'[\s\S]*?fn_entry_purchases_frozen/);
  });

  it('makes the wrapped money core private and keeps only the canonical door callable', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.process_tournament_rebuy_before_maintenance_announcement_gate\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.process_tournament_rebuy\([\s\S]*?TO authenticated, service_role;/
    );
    expect(SQL).toContain('maintenance rebuy wrapper ACL boundary is not canonical');
  });

  it('preserves the exact execution modes and public ACL shapes of every cash door', () => {
    for (const definerDoor of [
      'atomic_table_buyin',
      'atomic_table_rebuy',
      'atomic_table_addon',
      'fn_horse_fund_from_treasury',
      'fn_horse_seat_from_treasury',
    ]) {
      expect(functionDefinition(definerDoor), definerDoor).toMatch(
        /LANGUAGE plpgsql\s+SECURITY DEFINER/
      );
    }
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.atomic_table_addon\([\s\S]*?TO service_role;/
    );
    expect(SQL).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.atomic_table_addon\([\s\S]*?TO (?:anon|authenticated)/
    );
  });

  it('rejects every cash-wallet door pointed at a tournament table', () => {
    const assertion = functionDefinition('fn_assert_cash_chip_purchase_table');
    expect(assertion).toMatch(/v_tournament_id IS NOT NULL/);
    expect(assertion).toContain('CASH_PURCHASE_ONLY');
    for (const door of [
      'atomic_table_buyin',
      'atomic_table_rebuy',
      'atomic_table_addon',
      'fn_horse_fund_from_treasury',
      'fn_horse_seat_from_treasury',
    ]) {
      expect(functionDefinition(door), door).toMatch(
        /fn_assert_cash_chip_purchase_table\(p_table_id\)/
      );
    }
  });
});
