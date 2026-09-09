import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => resolve(__dirname, '..', path);
const migration = '20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql';
const sql = readFileSync(root(`supabase/migrations/${migration}`), 'utf8');
const eliminationProbe = readFileSync(
  root('scripts/ci/probes/tournament-elimination-seat-exit-authority.sql'),
  'utf8'
);
const manager = readFileSync(root('server/src/tournament/TournamentManager.ts'), 'utf8');
const moveRpc = readFileSync(root('server/src/tournament/tournamentSeatMoveRpc.ts'), 'utf8');

function taggedBody(tag: string): string {
  const delimiter = `$${tag}$`;
  const first = sql.indexOf(delimiter);
  const second = sql.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return sql.slice(first + delimiter.length, second);
}

const seatGuard = taggedBody('seat_exit_guard');
const handSeatOpener = taggedBody('open_hand_seat_exit_authority');
const handStackWrapper = taggedBody('accepted_hand_stack_with_seat_authority');
const managerWake = taggedBody('manager_wake_with_accepted_hand_bust');
const terminalOrphanCutover = taggedBody('terminal_orphan_cutover');
const atomicMove = taggedBody('atomic_tournament_move');
const cancellation = taggedBody('cancel_with_seat_authority');
const elimination = taggedBody('elimination_with_seat_authority');
const bountyElimination = taggedBody('bounty_elimination_with_seat_authority');
const lateSeat = taggedBody('late_seat_without_reconciler');
const managedUpdate = taggedBody('managed_update_without_reconciler');
const reconcilerPreflight = taggedBody('legacy_reconciler_preflight');
const cashPlayerLeave = taggedBody('cash_player_leave');
const globalWalletCheck = taggedBody('global_wallet_check_without_legacy_unregister');
const unionMoneyPath = taggedBody('union_money_path_without_legacy_unregister');
const unionOverload = taggedBody('union_overload_without_legacy_unregister');
const walletGuard = taggedBody('wallet_guard_without_legacy_unregister');
const legacyPreflight = taggedBody('legacy_unregister_preflight');
const legacyCutoverProof = taggedBody('legacy_unregister_cutover_proof');
const chipSyncPreflight = taggedBody('legacy_chip_sync_preflight');

describe('tournament seat exits have one hard authority', () => {
  it('repairs the exact historical terminal backlog once under a write barrier', () => {
    expect(sql).toContain('LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('LOCK TABLE public.tournament_players IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('LOCK TABLE public.table_seats IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain(
      "SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'))"
    );
    expect(sql).toContain('LOCK TABLE cron.job IN SHARE ROW EXCLUSIVE MODE');
    expect(terminalOrphanCutover).toContain('public.fn_ca_has_committed_tournament_receipt(t.id)');
    expect(terminalOrphanCutover).toContain('s.left_at IS NULL');
    expect(terminalOrphanCutover).toContain(
      'SET left_at=COALESCE(t.ended_at,transaction_timestamp())'
    );
    expect(terminalOrphanCutover).toContain("status='left'");
    expect(terminalOrphanCutover).toContain('SET current_players=0');
    expect(terminalOrphanCutover).not.toMatch(/SET[\s\S]*?stack\s*=/);
    expect(terminalOrphanCutover).toContain(
      'INSERT INTO public.tournament_seat_exit_authority_cutover'
    );
  });

  it('guards every destructive live-seat field before update or delete', () => {
    expect(sql).toContain('BEFORE DELETE OR UPDATE OF table_id,user_id,seat_number,left_at,status');
    expect(seatGuard).toContain('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY');
    expect(seatGuard).toContain("current_setting('app.tournament_seat_exit_token',true)");
    expect(seatGuard).toContain('public.tournament_seat_exit_authorizations');
    expect(seatGuard).not.toContain('tournament_players');
    expect(seatGuard).not.toMatch(/OLD\.stack\s*=\s*0[\s\S]*?RETURN NEW/);
  });

  it('lets only the accepted-hand stack core mint an exact zero-seat capability', () => {
    expect(handSeatOpener).toContain("'hand_settlement'");
    expect(handSeatOpener).toContain('s.table_id=p_table_id');
    expect(handSeatOpener).toContain('s.user_id=ANY(p_user_ids)');
    expect(handSeatOpener).not.toContain('pg_advisory_xact_lock');
    expect(handStackWrapper).toContain('fn_ca_open_tournament_hand_seat_exit_authority');
    expect(handStackWrapper).toContain('fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority');
    expect(handStackWrapper).toContain('fn_ca_close_tournament_seat_exit_authority');
    expect(handStackWrapper).toContain('v_expected_vacated<>v_consumed');
    expect(handStackWrapper).toContain(
      "fn_emit_tournament_manager_wake(\n            v_tournament_id,'accepted_hand_bust')"
    );
    expect(managerWake).toContain("'accepted_hand_bust'");
    expect(managerWake).toContain('FOR SHARE');
    expect(sql).toContain("'bounty_settled','accepted_hand_bust'))");
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.fn_ca_open_tournament_hand_seat_exit_authority\(uuid,uuid,uuid\[\]\)\s+FROM PUBLIC,anon,authenticated,service_role;/
    );
  });

  it('wraps every exact terminal owner in a transaction-local seat capability', () => {
    for (const owner of [
      'fn_ca_unregister_tournament_player_exact',
      'atomic_cancel_tournament',
      'fn_settle_satellite_tournament',
      'fn_complete_tournament_terminal',
    ]) {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${owner}(`);
      const next = sql.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1);
      const body = sql.slice(start, next < 0 ? undefined : next);
      expect(start, owner).toBeGreaterThan(-1);
      expect(body).toContain('fn_ca_open_tournament_seat_exit_authority');
      expect(body).toContain('fn_ca_close_tournament_seat_exit_authority');
      expect(body).toMatch(/EXCEPTION WHEN OTHERS[\s\S]*?RAISE;/);
    }
  });

  it('wraps both rolling-window elimination owners in the same capability', () => {
    for (const body of [elimination, bountyElimination]) {
      expect(body).toContain("'elimination'");
      expect(body).toContain('fn_ca_open_tournament_seat_exit_authority');
      expect(body).toContain('fn_ca_close_tournament_seat_exit_authority');
      expect(body).toContain('fn_caller_is_engine');
      expect(body).toMatch(/EXCEPTION WHEN OTHERS[\s\S]*?RAISE;/);
      expect(body).not.toContain('UPDATE public.table_seats');
    }
    expect(elimination).toContain('fn_eliminate_tournament_player_atomic_pre_seat_guard');
    expect(bountyElimination).toContain('fn_claim_tournament_bounty_elimination_pre_seat_guard');
    expect(sql).toContain('fn_eliminate_player_legacy_candidate_20260907');
    expect(sql).toContain('fn_claim_bounty_legacy_candidate_20260907');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.fn_eliminate_tournament_player_atomic_pre_seat_guard\([\s\S]*?FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.fn_claim_tournament_bounty_elimination_pre_seat_guard\([\s\S]*?FROM PUBLIC,anon,authenticated,service_role;/
    );
  });

  it('executes both old-pod elimination shapes and proves replay', () => {
    expect(eliminationProbe).toContain('fn_eliminate_tournament_player_atomic(');
    expect(eliminationProbe).toContain('fn_claim_tournament_bounty_elimination(');
    expect(eliminationProbe).toContain('settlement_idempotency_keys');
    expect(eliminationProbe).toContain('tournament_bounty_obligations');
    expect(eliminationProbe).toContain('v_plain_replay');
    expect(eliminationProbe).toContain('v_bounty_replay');
    expect(eliminationProbe).toContain('SET CONSTRAINTS ALL IMMEDIATE');
    expect(eliminationProbe).toContain('AUDIT_TEST_PASS');
  });

  it('keeps authenticated managed close on its exact in-transaction receipt rail', () => {
    expect(cancellation).toContain("current_setting('app.managed_game_lifecycle',true)");
    expect(cancellation).toContain('public.managed_game_command_receipts');
    expect(cancellation).toContain("r.game_kind='tournament'");
    expect(cancellation).toContain("r.command_action='close'");
    expect(cancellation).toContain("r.status='processing'");
    expect(cancellation).toContain('p_admin_id IS NOT DISTINCT FROM v_uid');
    expect(cancellation).toContain('NOT public.fn_caller_is_engine()');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.atomic_cancel_tournament\(uuid,uuid\)\s+FROM PUBLIC,anon,authenticated;/
    );
  });

  it('hard-refuses tournament tables at every generic cash seat-exit door', () => {
    for (const owner of [
      'atomic_seat_cashout_locked',
      'fn_admin_kick_player',
      'fn_clear_table_seats',
      'force_close_table_and_refund',
      'player_leave_table',
    ]) {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${owner}(`);
      const next = sql.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1);
      const body = sql.slice(start, next < 0 ? undefined : next);
      expect(start, owner).toBeGreaterThan(-1);
      expect(body).toContain('TOURNAMENT_SEAT_EXIT_REQUIRES_TOURNAMENT_AUTHORITY');
      expect(body).toContain('tournament_id');
    }
    expect(cashPlayerLeave.match(/player_leave_table_pre_tournament_guard\(/g)).toHaveLength(1);
  });

  it('moves source, destination, roster, counts, and receipt atomically', () => {
    const catchBlock = atomicMove.match(/EXCEPTION WHEN OTHERS THEN([\s\S]*?)\n\s*END;/)?.[1];
    expect(catchBlock).toBeDefined();
    expect(catchBlock).toContain('RAISE;');
    expect(catchBlock).not.toContain('RETURN');
    expect(atomicMove).toContain('UPDATE public.table_seats');
    expect(atomicMove).toContain('UPDATE public.tournament_players');
    expect(atomicMove).toContain('UPDATE public.tables');
    expect(atomicMove).toContain('INSERT INTO public.tournament_seat_move_receipts');
    expect(atomicMove).toContain('fn_ca_open_tournament_seat_exit_authority');
    expect(atomicMove).toContain('fn_ca_close_tournament_seat_exit_authority');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON public.tournament_seat_move_receipts');
  });

  it('makes the manager call one retry-safe RPC instead of split writes', () => {
    const start = manager.indexOf('protected async executePlayerMoves(');
    const next = manager.indexOf('\n  protected ', start + 1);
    const method = manager.slice(start, next < 0 ? undefined : next);

    expect(start).toBeGreaterThan(-1);
    expect(method).toContain('moveTournamentPlayerAtomically');
    expect(method).not.toMatch(/\.from\(['"](?:table_seats|tournament_players|tables)['"]\)/);
    expect(moveRpc).toContain("rpc('fn_move_tournament_player'");
    expect(moveRpc).toContain('p_request_id: input.requestId');
    expect(moveRpc.match(/fn_move_tournament_player/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(moveRpc).not.toMatch(/\.from\(['"](?:table_seats|tournament_players|tables)['"]\)/);
  });

  it('removes delayed seat cleanup and spin-board repair owners', () => {
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_clear_seats_on_game_end');
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.fn_clear_seats_on_game_end()');
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.fn_spin_reap_stale_boards(');
    expect(sql).not.toContain('fn_sync_seat_first_player_count(');
  });

  it('retires the tournament denormal reconciler and terminal status watcher', () => {
    expect(reconcilerPreflight).toContain("jobname='reconcile-tournament-denormals'");
    expect(reconcilerPreflight).toContain('cron.unschedule(j.jobid)');
    expect(reconcilerPreflight).toContain('pg_depend');
    expect(reconcilerPreflight).toContain('v_release_trigger');
    expect(reconcilerPreflight).toContain('tgtype=17');
    expect(sql).toContain(
      'DROP TRIGGER trg_release_seats_on_tournament_finish ON public.tournaments;'
    );
    expect(sql).toContain('DROP FUNCTION public.fn_release_seats_on_tournament_finish() RESTRICT;');
    expect(sql).toContain('DROP FUNCTION public.fn_reconcile_tournament_denormals() RESTRICT;');
    expect(sql).not.toMatch(
      /DROP (?:TRIGGER|FUNCTION)[^;]*(?:trg_release_seats_on_tournament_finish|fn_release_seats_on_tournament_finish|fn_reconcile_tournament_denormals)[^;]*CASCADE/
    );
  });

  it('repairs the chip mirror once and drops both stale-snapshot reconciler doors', () => {
    expect(terminalOrphanCutover).toContain('v_chip_roster_ids');
    expect(terminalOrphanCutover).toContain('tp.chips IS DISTINCT FROM live.chips');
    expect(terminalOrphanCutover).toContain(
      'live tournament chip cutover found an ambiguous or missing positive seat'
    );
    expect(chipSyncPreflight).toContain('fn_sync_tournament_live_seat_chips');
    expect(chipSyncPreflight).toContain('fn_sync_tournament_chips');
    expect(sql).toContain(
      'DROP FUNCTION public.fn_sync_tournament_live_seat_chips(uuid) RESTRICT;'
    );
    expect(sql).toContain('DROP FUNCTION public.fn_sync_tournament_chips(uuid,jsonb) RESTRICT;');
  });

  it('hard-codes every remaining denormal at the writer that owns it', () => {
    expect(lateSeat).toContain('INSERT INTO public.tables(');
    expect(lateSeat).toContain('stakes,blind_structure,status,current_players');
    expect(lateSeat).toContain("trim_scale(v_sb)::text||'/'||trim_scale(v_bb)::text");
    expect(managedUpdate).toContain('small_blind=v_sb,big_blind=v_bb');
    expect(managedUpdate).toContain("stakes=trim_scale(v_sb)::text||'/'||trim_scale(v_bb)::text");
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.fn_seat_late_registrant_before_maintenance_gate\(uuid,uuid\)\s+FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_update_managed_game\(text,uuid,jsonb\)\s+FROM PUBLIC,anon,authenticated;/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_update_managed_game\(text,uuid,jsonb\)\s+TO service_role;/
    );
    for (const receiptColumn of [
      'repaired_roster_ids',
      'repaired_stakes_table_ids',
      'closed_duplicate_table_ids',
      'repaired_player_count_tournament_ids',
    ]) {
      expect(sql).toContain(receiptColumn);
    }
  });

  it('drops both amount-trusting unregister signatures without cascade', () => {
    const atomicDrops = sql.match(
      /DROP FUNCTION public\.atomic_tournament_unregister\(uuid,uuid,numeric\);/g
    );
    const counterDrops = sql.match(
      /DROP FUNCTION public\.fn_tournament_unregister_counter\(uuid,numeric\);/g
    );

    expect(atomicDrops).toHaveLength(1);
    expect(counterDrops).toHaveLength(1);
    expect(atomicDrops?.[0]).not.toContain('CASCADE');
    expect(counterDrops?.[0]).not.toContain('CASCADE');
    expect(sql).toContain('$legacy_unregister_preflight$');
    expect(sql).toContain('$legacy_unregister_cutover_proof$');
  });

  it('re-emits every current audit and balance guard without the dead name', () => {
    for (const body of [globalWalletCheck, unionMoneyPath, unionOverload, walletGuard]) {
      expect(body).not.toContain('atomic_tournament_unregister');
      expect(body).not.toContain('fn_tournament_unregister_counter');
    }

    expect(globalWalletCheck).toContain("'atomic_tournament_register'");
    expect(globalWalletCheck).toContain("'atomic_cancel_tournament'");
    expect(unionMoneyPath).toContain("('atomic_tournament_register')");
    expect(unionMoneyPath).toContain("('atomic_cancel_tournament')");
    expect(unionOverload).toContain("'process_tournament_rebuy'");
    expect(unionOverload).toContain("'record_tournament_buyin_rake'");
    expect(walletGuard).toContain("'atomic_tournament_register'");
    expect(walletGuard).toContain("'atomic_cancel_tournament'");
    expect(walletGuard).toContain("'fn_mint_chips_from_diamonds'");

    for (const retired of [
      'atomic_seat_horse',
      'atomic_table_withdraw',
      'distribute_tournament_prizes',
    ]) {
      expect(walletGuard).not.toContain(retired);
      expect(legacyPreflight).toContain(retired);
      expect(legacyCutoverProof).toContain(retired);
    }
  });

  it('keeps diagnostics service-only and removes raw service roster deletion', () => {
    for (const fn of [
      'fn_club_arena_global_wallet_check',
      'fn_union_money_path_check',
      'fn_union_overload_check',
    ]) {
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(\\)\\s+FROM PUBLIC,anon,authenticated;`)
      );
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(\\)\\s+TO service_role;`)
      );
    }

    expect(sql).toContain('REVOKE DELETE ON TABLE public.tournament_players FROM service_role;');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.guard_wallet_balance_write\(\)\s+FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(sql).toContain(
      "has_table_privilege(\n       'service_role','public.tournament_players','DELETE')"
    );
    expect(sql).toContain(
      "'public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)'"
    );
  });
});
