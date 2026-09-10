/** Late registration and the manager share one serialized capacity authority. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const MIGRATION = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260908042200_late_registration_can_build_its_first_table.sql'
  ),
  'utf8'
);
const MANAGER = readFileSync(
  join(process.cwd(), 'src', 'tournament', 'TournamentManager.ts'),
  'utf8'
);
const BASE = readFileSync(
  join(process.cwd(), 'src', 'tournament', 'TournamentManagerBase.ts'),
  'utf8'
);
const ELIMINATIONS = readFileSync(
  join(process.cwd(), 'src', 'tournament', 'TournamentManagerEliminations.ts'),
  'utf8'
);

const fn = (name: string): string => {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = MIGRATION.indexOf('$function$;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return MIGRATION.slice(start, end);
};

describe('late-registration capacity authority', () => {
  it('uses one SQL gate for level and minutes windows', () => {
    const gate = fn('fn_tournament_late_registration_open');
    expect(gate).toContain("t.status='RUNNING'");
    expect(gate).toContain('NOT COALESCE(t.prize_pool_finalized,false)');
    expect(gate).toContain(
      'COALESCE(t.current_level,0)<COALESCE(t.late_reg_levels,t.rebuy_levels,0)'
    );
    expect(gate).toContain('clock_timestamp()<t.started_at+make_interval(mins=>t.late_reg_mins)');
    expect(gate).toContain('FROM public.tournament_players');
  });

  it('serializes and re-checks active demand on the tournament row', () => {
    const capacity = fn('fn_ensure_late_registration_capacity');
    expect(capacity).toMatch(/FROM public\.tournaments t[\s\S]*FOR UPDATE/);
    expect(capacity).toContain('fn_tournament_late_registration_open');
    expect(capacity).toContain("tp.status IN ('registered','playing')");
    expect(capacity).toContain('v_unseated_entries+p_reserved_entries');
    expect(capacity).toContain('v_required_open_seats<=v_open_seats');
    expect(capacity).toContain('IF p_reserved_entries>0');
    expect(capacity).toContain("tb.status IN ('running','waiting','active')");
    expect(capacity).toContain('COALESCE(NULLIF(tb.max_players,0),v_cap)');
    expect(capacity).toContain('s.left_at IS NULL');
    expect(capacity).toContain('s.user_id=tp.user_id');
    expect(capacity).toContain("'occupied_seats',v_occupied_seats");
  });

  it('bootstraps from tournament configuration with no sibling table', () => {
    const capacity = fn('fn_ensure_late_registration_capacity');
    expect(capacity).not.toMatch(/SELECT \* INTO v_template FROM public\.tables/);
    expect(capacity).not.toContain('No live tournament table exists to clone safely');
    expect(capacity).toContain('public.fn_tournament_current_blinds(p_tournament_id)');
    expect(capacity).toContain('INSERT INTO public.tables');
  });

  it('resolves persisted and past-end blinds in the database without clamping', () => {
    const resolver = fn('fn_resolve_tournament_blinds');
    expect(resolver).toContain('IF v_index<v_len');
    expect(resolver).toContain('v_index-v_len+1');
    expect(resolver).toContain('v_tail_count-1');
    expect(resolver).toContain('LEAST(1.6,GREATEST(1.15,v_ratio))');
    expect(resolver).toContain('LEAST(GREATEST(1,v_index-v_len+1),40)');
    expect(resolver).toContain('p_total_chips/20');
    expect(resolver).not.toMatch(/LEAST\([\s\S]{0,80}p_current_level[\s\S]{0,80}v_len-1/);

    const current = fn('fn_tournament_current_blinds');
    expect(current).toContain("wt.category='rebuy'");
    expect(current).toContain("wt.category='addon'");
    expect(current).toContain('fn_resolve_tournament_blinds');
  });

  it('pins generic, capped, and Spin overflow with executable migration fixtures', () => {
    expect(MIGRATION).toContain("'small_blind')::numeric<>112.5");
    expect(MIGRATION).toContain("'big_blind')::numeric<>225");
    expect(MIGRATION).toContain("'big_blind')::numeric<>200");
    expect(MIGRATION).toContain("'blind_capped')::boolean IS NOT TRUE");
    expect(MIGRATION).toContain("'small_blind')::numeric<>145");
    expect(MIGRATION).toContain("'big_blind')::numeric<>290");
  });

  it('preserves table rules and applies the deck-safe seat ceiling', () => {
    const capacity = fn('fn_ensure_late_registration_capacity');
    expect(capacity).toMatch(/tournament_type,''\)\)='SPIN'[\s\S]{0,500}THEN 3/);
    expect(capacity).toContain("WHEN 'plo5' THEN 9");
    expect(capacity).toContain("WHEN 'plo6' THEN 7");
    for (const field of [
      'action_time_seconds',
      'big_blind_ante_enabled',
      'all_in_or_fold',
      'allow_rabbit_hunt',
    ]) {
      expect(capacity).toContain(field);
    }
    expect(capacity).not.toMatch(/status,blind_structure,action_time_seconds/);
    expect(capacity).toContain('fn_tournament_current_blinds');
  });

  it('exposes the one primitive to the engine service and never to browsers', () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ensure_late_registration_capacity\(uuid,integer\)[\s\S]*?FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ensure_late_registration_capacity\(uuid,integer\)[\s\S]*?TO service_role;/
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_tournament_late_registration_open\(uuid\)[\s\S]*?TO service_role;/
    );
    expect(MIGRATION).toContain(
      'DROP FUNCTION IF EXISTS public.fn_create_late_registration_capacity(uuid)'
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ack_tournament_capacity_tables\(uuid,uuid\[\]\)[\s\S]*?TO service_role;/
    );
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON TABLE public\.tournament_capacity_table_receipts[\s\S]*?FROM PUBLIC,anon,authenticated,service_role;/
    );
  });

  it('makes registration reserve its pending entrant through the same primitive', () => {
    const register = fn('fn_register_for_tournament');
    expect(register).toContain('fn_ensure_late_registration_capacity(p_tournament_id,1)');
    expect(register).toContain('fn_register_for_tournament_before_atomic_capacity_20260907');
    expect(register).toContain('fn_emit_tournament_manager_wake');
  });

  it('replays behind the downstream lifecycle gate without restoring its internal default', () => {
    expect(MIGRATION).toContain(
      "'public.fn_register_for_tournament_before_atomic_lifecycle_gate(uuid,boolean)'"
    );
    expect(MIGRATION).toContain(
      "v_target := 'fn_register_for_tournament_before_atomic_lifecycle_gate'"
    );
    expect(MIGRATION).toContain(
      "p.oid='public.fn_register_for_tournament(uuid,boolean)'::regprocedure"
    );
    expect(MIGRATION).toContain('p.pronargdefaults<>0');
    expect(MIGRATION).toContain(
      'ordered migration replay restored a default on the downstream registration lifecycle gate'
    );
  });

  it('makes the manager use only the locked capacity primitive', () => {
    const start = MANAGER.indexOf('protected async checkDynamicTableExpansion');
    const end = MANAGER.indexOf('protected async', start + 20);
    const expansion = MANAGER.slice(start, end > start ? end : undefined);
    expect(expansion).toContain("'fn_ensure_late_registration_capacity'");
    expect(expansion).toContain('p_reserved_entries: 0');
    expect(expansion).not.toContain(".from('tables')");
    expect(expansion).not.toContain(".from('tournament_players')");
    expect(expansion).not.toContain("'fn_tournament_late_registration_open'");
    expect(expansion).not.toContain('assignTournamentPlayerSeatAtomically');
    expect(expansion).not.toContain('ensureLateRegSeated');
    expect(expansion).toContain('this.createManagedTableEngine(tableId)');
    expect(expansion).toContain('TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE');
    expect(expansion).toContain('this.requestUrgentEliminationSweepAfter(0)');
  });

  it('keeps every database-created table pending until a manager admits it', () => {
    const capacity = fn('fn_ensure_late_registration_capacity');
    const acknowledge = fn('fn_ack_tournament_capacity_tables');
    expect(MIGRATION).toContain(
      'CREATE TABLE IF NOT EXISTS public.tournament_capacity_table_receipts'
    );
    expect(capacity).toContain('INSERT INTO public.tournament_capacity_table_receipts');
    expect(capacity).toContain(
      "fn_emit_tournament_manager_wake(\n    p_tournament_id,'late_registration')"
    );
    expect(capacity).toContain("'pending_table_ids',v_pending_table_ids");
    expect(acknowledge).toContain('FOR UPDATE');
    expect(acknowledge).toContain('manager_admitted_at=COALESCE');

    const start = MANAGER.indexOf('protected async checkDynamicTableExpansion');
    const end = MANAGER.indexOf('protected async', start + 20);
    const expansion = MANAGER.slice(start, end > start ? end : undefined);
    expect(expansion).toContain('result.pending_table_ids');
    expect(expansion).toContain("'fn_ack_tournament_capacity_tables'");
    expect(expansion.indexOf('this.admitManagedTableEngine')).toBeLessThan(
      expansion.indexOf("'fn_ack_tournament_capacity_tables'")
    );
    expect(expansion).not.toContain('adoptEnginelessTables');
  });

  it('retires the minute repair cron once registration and seating are atomic', () => {
    const retirement = MIGRATION.slice(MIGRATION.indexOf('DO $retire_seatless_cron$'));
    expect(MIGRATION).toContain("jobname='sweep-seatless-late-registrants'");
    expect(MIGRATION).toContain("command LIKE '%public.fn_sweep_seatless_late_registrants()%'");
    expect(MIGRATION).toContain('PERFORM cron.unschedule(v_job.jobid)');
    expect(MIGRATION).toContain('seatless late-registration repair cron remains scheduled');
    expect(MIGRATION).toContain(
      'DROP FUNCTION IF EXISTS public.fn_sweep_seatless_late_registrants();'
    );
    expect(MIGRATION).toContain('seatless late-registration repair function remains callable');
    expect(MIGRATION).not.toContain('cron.schedule(');
    // cron.unschedule owns the catalog mutation. SELECT FOR UPDATE would
    // require direct UPDATE privilege on the extension-owned cron.job table.
    expect(retirement).not.toContain('FOR UPDATE');
  });

  it('installs capacity, seating, cron retirement and legacy-door removal atomically', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('closes minutes-only entry from one locked DB-relative deadline', () => {
    const close = fn('fn_close_tournament_entry_window');
    expect(close).toMatch(/FROM public\.tournaments t[\s\S]*FOR UPDATE/);
    expect(close).toContain('COALESCE(v_t.late_reg_levels,v_t.rebuy_levels,0)>0');
    expect(close).toContain("v_mode := 'minutes'");
    expect(close).toContain('v_t.started_at+make_interval(mins=>v_t.late_reg_mins)');
    expect(close).toContain('v_deadline-clock_timestamp()');
    expect(close).toContain("'retry_after_ms',v_retry_ms");
    expect(close).not.toContain('Date.now');
    expect(close.indexOf("v_mode := 'levels'")).toBeLessThan(close.indexOf("v_mode := 'minutes'"));
  });

  it('commits final field, funded pool, receipt, and durable wake together', () => {
    const finalize = fn('fn_finalize_tournament_entry_pool_locked');
    expect(MIGRATION).toContain(
      'CREATE TABLE IF NOT EXISTS public.tournament_entry_close_receipts'
    );
    expect(finalize).toContain('FOR UPDATE');
    expect(finalize).toContain('public.fn_ca_payout_structure');
    expect(finalize).toContain('public.fn_apply_prize_guarantee');
    expect(finalize).toContain('INSERT INTO public.tournament_entry_close_receipts');
    expect(finalize).toMatch(
      /fn_emit_tournament_manager_wake\(\s*p_tournament_id,'late_registration'\)/
    );
    expect(finalize.indexOf('public.fn_ca_payout_structure')).toBeLessThan(
      finalize.indexOf('public.fn_apply_prize_guarantee')
    );
    expect(finalize.indexOf('public.fn_apply_prize_guarantee')).toBeLessThan(
      finalize.indexOf('INSERT INTO public.tournament_entry_close_receipts')
    );
  });

  it('stores the canonical satellite ladder without cash-repricing satellite finishers', () => {
    const finalize = fn('fn_finalize_tournament_entry_pool_locked');
    expect(finalize).toContain('v_is_satellite');
    expect(finalize).toContain('public.fn_ca_payout_structure');
    expect(finalize).toContain('CASE WHEN v_is_satellite THEN clock_timestamp() ELSE NULL END');
    expect(finalize).toContain("'reprice_pending',NOT v_is_satellite");
    expect(finalize.indexOf('public.fn_ca_payout_structure')).toBeLessThan(
      finalize.indexOf('CASE WHEN v_is_satellite THEN clock_timestamp() ELSE NULL END')
    );
  });

  it('keeps the close receipt pending until exact database proof succeeds', () => {
    const complete = fn('fn_complete_tournament_entry_reprice');
    const exactPrize = fn('fn_tournament_place_prize_exact');
    expect(exactPrize).toContain('v_remaining := v_pool_cents');
    expect(exactPrize).toContain('IF r.place=v_last_place');
    expect(complete).toContain('FOR UPDATE');
    expect(complete).toContain('fn_tournament_place_prize_exact');
    expect(complete).toContain('FROM public.tournament_payouts p');
    expect(complete).toContain('p.user_id=tp.user_id');
    expect(complete).toContain('tp.position IS NULL');
    expect(complete).not.toContain('AND tp.position IS NOT NULL');
    expect(complete).toContain("'reason','reprice_incomplete'");
    expect(complete).toContain('SET reprice_completed_at=clock_timestamp()');
    const tournamentLock = complete.indexOf('FROM public.tournaments t');
    const receiptLock = complete.indexOf('FROM public.tournament_entry_close_receipts r');
    expect(tournamentLock).toBeGreaterThan(-1);
    expect(receiptLock).toBeGreaterThan(tournamentLock);
  });

  it('retires a legitimately broken table from the active hand-for-hand generation', () => {
    const successfulBreak = sliceMethod(
      MANAGER,
      'protected async closeBrokenTableAndReleaseEngine('
    );
    const stopAt = successfulBreak.indexOf('await engine.stop()');
    const retireAt = successfulBreak.indexOf('this.retireManagedTableFromHandForHand(tableId)');
    const deleteAt = successfulBreak.indexOf('this.tableEngines.delete(tableId)');
    expect(stopAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(stopAt);
    expect(retireAt).toBeGreaterThan(deleteAt);
    expect(successfulBreak.match(/retireManagedTableFromHandForHand\(tableId\)/g)).toHaveLength(1);
  });

  it('arms start and resume once and consumes durable close receipts before wake ack', () => {
    expect(BASE).toContain("reconcileTournamentEntryWindow('engine.start')");
    expect(BASE).toContain("reconcileTournamentEntryWindow('engine.resume')");
    expect(BASE).toContain("reconcileTournamentEntryWindow('engine.level_change')");
    expect(BASE).toContain("reconcileTournamentEntryWindow('engine.entry_window_deadline')");
    expect(BASE).toContain('armTournamentEntryCloseTimer(retryAfterMs)');
    expect(BASE).toContain("supabase.rpc('fn_close_tournament_entry_window'");
    expect(BASE).toContain("'fn_complete_tournament_entry_reprice'");
    const closed = BASE.slice(
      BASE.indexOf('protected isLateRegClosed()'),
      BASE.indexOf('private clearTournamentEntryCloseTimer')
    );
    expect(closed).toContain('this.tournamentEntryWindowClosed');
    expect(closed).not.toContain('late_reg_levels');
    expect(closed).not.toContain('Date.now');

    const closeBeforeSweep = ELIMINATIONS.indexOf(
      "reconcileTournamentEntryWindow('engine.manager_wake')"
    );
    const ackAfterSweep = ELIMINATIONS.lastIndexOf('await acknowledgeCapturedWakes()');
    expect(closeBeforeSweep).toBeGreaterThan(-1);
    expect(ackAfterSweep).toBeGreaterThan(closeBeforeSweep);
    expect(ELIMINATIONS).toContain("reason === 'late_registration'");
  });

  it('does not let a zero-prize early finisher disappear from reprice proof', () => {
    const start = ELIMINATIONS.indexOf('protected async recalculateEliminatedPrizes');
    const end = ELIMINATIONS.indexOf('protected tournamentFinished', start);
    const reprice = ELIMINATIONS.slice(start, end);
    expect(reprice).toContain(".eq('status', 'eliminated')");
    expect(reprice).not.toContain(".gt('prize', 0)");
    expect(reprice).toContain('Promise<boolean>');
    expect(reprice).toContain('return complete');
  });

  it('uses the immutable satellite entitlement depth for hand-for-hand', () => {
    const h4h = ELIMINATIONS.slice(
      ELIMINATIONS.indexOf('handForHandStage:'),
      ELIMINATIONS.indexOf('if (completedStage(9))')
    );
    const satelliteBranch = h4h.indexOf('if (isSatellite)');
    const genericPayoutParse = h4h.indexOf(
      'parsePayoutStructure(this.tournamentCache.payout_structure)'
    );
    expect(satelliteBranch).toBeGreaterThan(-1);
    expect(h4h).toContain("'fn_get_tournament_satellite_entitlement_depth'");
    expect(h4h).toContain('entitlement?.ready !== true');
    expect(h4h).toContain('payoutCount = awardDepth');
    expect(h4h).toContain('if (awardDepth === 0)');
    expect(h4h).toContain("reason: 'satellite_has_no_awards'");
    expect(h4h).toContain('Tournament.satellite_entitlement_depth_unavailable');
    expect(h4h).toContain('requestUrgentEliminationSweepAfter');
    expect(satelliteBranch).toBeLessThan(genericPayoutParse);
  });

  it('requeues every unreadable committed-close contract until its durable wake can finish', () => {
    const reconcile = BASE.slice(
      BASE.indexOf('private async reconcileTournamentEntryWindowOnce'),
      BASE.indexOf(
        '// ═══════════════════════════════════════════════════════════════════',
        BASE.indexOf('private async reconcileTournamentEntryWindowOnce')
      )
    );
    for (const label of [
      'Tournament.entry_window_close_contract_invalid',
      'Tournament.entry_window_close_result_unreadable',
    ]) {
      expect(reconcile).toMatch(
        new RegExp(
          `${label.replaceAll('.', '\\.')}'\\s*\\);[\\s\\S]{0,180}` +
            'requestUrgentEliminationSweepAfter\\(TournamentManagerBase\\.UNRESOLVED_BUST_RETRY_MS\\);'
        )
      );
    }
  });
});
