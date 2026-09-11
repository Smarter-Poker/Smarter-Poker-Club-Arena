import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => resolve(__dirname, '..', path);
const sql = readFileSync(
  root(
    'supabase/migrations/20260909205412_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
  ),
  'utf8'
);
const manager = readFileSync(root('server/src/tournament/TournamentManager.ts'), 'utf8');
const base = readFileSync(root('server/src/tournament/TournamentManagerBase.ts'), 'utf8');
const recurring = readFileSync(root('server/src/services/TournamentRecurringService.ts'), 'utf8');
const transport = readFileSync(
  root('server/src/tournament/tournamentSeatAssignmentRpc.ts'),
  'utf8'
);
const revokedRegistrationProbe = readFileSync(
  root('scripts/ci/probes/tournament-wallet-registration-revoked-session.sql'),
  'utf8'
);

function taggedBody(tag: string): string {
  const delimiter = `$${tag}$`;
  const first = sql.indexOf(delimiter);
  const second = sql.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return sql.slice(first + delimiter.length, second);
}

function method(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const next = source.indexOf('\n  protected ', start + signature.length);
  return source.slice(start, next < 0 ? undefined : next);
}

const rootLock = taggedBody('seat_acquisition_lock');
const assignment = taggedBody('atomic_tournament_seat_assignment');
const seatCap = taggedBody('tournament_seat_cap');
const lockedAssignment = taggedBody('locked_tournament_seat_assignment');
const seatChoice = taggedBody('choose_tournament_seat_locked');
const knockoutEvidence = taggedBody('latest_committed_knockout_candidate');
const rebuyWindow = taggedBody('tournament_rebuy_window');
const moneyCore = taggedBody('tournament_chip_purchase_money');
const chipPurchase = taggedBody('atomic_tournament_chip_purchase');
const guard = taggedBody('tournament_seat_acquisition_guard');
const sync = taggedBody('seat_count');

describe('tournament seats are acquired below one hard root authority', () => {
  it('takes the complete parent lock prefix before child state without retrying', () => {
    const global = rootLock.indexOf('ca:tournament-terminal-settlement:v1');
    const maintenance = rootLock.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    const mission = rootLock.indexOf('public.fn_lock_daily_mission_user(p_user_id)');
    const launch = rootLock.indexOf('FROM public.tournament_launch_receipts r');
    const tournament = rootLock.indexOf('FROM public.tournaments t');

    expect(global).toBeGreaterThan(-1);
    expect(maintenance).toBeGreaterThan(global);
    expect(mission).toBeGreaterThan(maintenance);
    expect(launch).toBeGreaterThan(mission);
    expect(tournament).toBeGreaterThan(launch);
    expect(rootLock).not.toMatch(/NOWAIT|pg_try_advisory|deadlock_detected|pg_sleep|retry/i);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_lock_tournament_seat_acquisition\([\s\S]*?service_role;/
    );
  });

  it('puts every public create or registration door behind that root', () => {
    for (const tag of [
      'take_seat_terminal_gate',
      'horse_seat_terminal_gate',
      'late_seat_terminal_gate',
      'registration_terminal_gate',
      'ticket_registration_terminal_gate',
      'horse_registration_terminal_gate',
    ]) {
      expect(taggedBody(tag), tag).toContain('fn_ca_lock_tournament_seat_acquisition');
    }
    expect(sql).toContain('fn_take_seat_and_buy_in_before_terminal_seat_gate');
    expect(sql).toContain('fn_register_for_tournament_with_ticket_before_terminal_gate');
    expect(sql).toContain('fn_register_horse_for_tournament_before_terminal_gate');
    expect(taggedBody('registration_terminal_gate_compat')).toContain(
      'public.fn_register_for_tournament(p_tournament_id,false)'
    );
    expect(taggedBody('horse_registration_terminal_gate_compat')).toContain(
      'p_tournament_id,p_user_id,true'
    );
    const walletRegistration = taggedBody('registration_terminal_gate');
    const sessionGate = walletRegistration.indexOf('public.fn_caller_session_is_live()');
    const rootGate = walletRegistration.indexOf('fn_ca_lock_tournament_seat_acquisition');
    expect(sessionGate).toBeGreaterThan(-1);
    expect(walletRegistration).toContain('SESSION_REVOKED');
    expect(rootGate).toBeGreaterThan(sessionGate);
    expect(revokedRegistrationProbe).toContain("WHEN SQLSTATE '28000'");
    expect(revokedRegistrationProbe).toContain(
      'revoked registration created entry or financial evidence'
    );
    expect(revokedRegistrationProbe).toContain('all probe work rolled back');
  });

  it('keeps one service-only wrapper over one owner-only seat/roster/count core', () => {
    const roster = lockedAssignment.indexOf('FROM public.tournament_players tp');
    const table = lockedAssignment.indexOf('FROM public.tables tb');
    const seat = lockedAssignment.indexOf('FROM public.table_seats s');
    expect(assignment).toContain('fn_caller_is_engine');
    expect(assignment).toContain('fn_ca_lock_tournament_seat_acquisition');
    expect(assignment).toContain('fn_ca_assign_tournament_player_seat_locked');
    expect(assignment).not.toMatch(
      /INSERT INTO|UPDATE public\.(?:table_seats|tournament_players|tables)/
    );
    expect(table).toBeGreaterThan(roster);
    expect(seat).toBeGreaterThan(table);
    expect(lockedAssignment).toContain('INSERT INTO public.table_seats');
    expect(lockedAssignment).toContain('UPDATE public.tournament_players tp');
    expect(lockedAssignment).toContain('UPDATE public.tables tb');
    expect(lockedAssignment).toContain('fn_ca_tournament_seat_cap');
    expect(lockedAssignment).toContain("'replayed',true");
    expect(lockedAssignment).toContain("'replayed',false");
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_assign_tournament_player_seat_atomic\([\s\S]*?TO service_role;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_assign_tournament_player_seat_atomic\([\s\S]*?authenticated;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_assign_tournament_player_seat_locked\([\s\S]*?service_role;/
    );
  });

  it('uses one format and deck legal seat cap for choosing and assigning chairs', () => {
    expect(seatCap).toContain("v_format='spin'");
    expect(seatCap).toContain('THEN 3');
    expect(seatCap).toContain("v_format='sng'");
    expect(seatCap).toContain('NULLIF(v_t.max_players,0),6');
    expect(seatCap).toContain('NULLIF(v_t.table_size,0),9');
    expect(seatCap).toContain("WHEN 'plo5' THEN 9");
    expect(seatCap).toContain("WHEN 'plo6' THEN 7");
    expect(seatCap).toContain('RETURN GREATEST(v_cap,2)');
    expect(seatChoice).toContain('fn_ca_tournament_seat_cap');
    expect(lockedAssignment).toContain('fn_ca_tournament_seat_cap');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_tournament_seat_cap\(uuid\)[\s\S]*?service_role;/
    );
  });

  it('revives a physical chair without inheriting any former occupant state', () => {
    expect(lockedAssignment).toContain('v_expected_club_id:=public.fn_seat_club_for_user');
    expect(lockedAssignment).toContain('v_expected_horse_id');
    expect(lockedAssignment).toContain('v_time_bank_uses integer:=4');
    expect(lockedAssignment).toContain('v_time_bank_seconds integer:=30');
    expect(lockedAssignment).toContain('player_id=NULL');
    expect(lockedAssignment).toContain('member_id=NULL');
    expect(lockedAssignment).toContain('horse_id=v_expected_horse_id');
    expect(lockedAssignment).toContain('club_id=v_expected_club_id');
    expect(lockedAssignment).toContain('time_bank_remaining=v_time_bank_seconds');
    expect(lockedAssignment).toContain('time_bank_uses_remaining=v_time_bank_uses');
    expect(lockedAssignment).toContain('s.player_id IS NULL AND s.member_id IS NULL');
    expect(lockedAssignment).toContain('s.club_id IS NOT DISTINCT FROM v_expected_club_id');
  });

  it('commits each rebuy generation, debit, legal chair, mirrors, wake and receipt together', () => {
    expect(seatChoice).toContain('fn_ensure_late_registration_capacity');
    expect(seatChoice).toContain('FOR UPDATE OF tb');
    expect(knockoutEvidence).toContain('FROM public.settlement_idempotency_keys k');
    expect(knockoutEvidence).toContain('FROM public.tournament_knockout_candidates c');
    expect(knockoutEvidence).toContain('FROM public.hand_atomic_commits a');
    expect(knockoutEvidence).toContain('a.hand_id=v_candidate_hand_id');
    expect(knockoutEvidence).toContain("a.stack_result->>'hand_id'");
    expect(knockoutEvidence).toContain('k.hand_id=v_settlement_hand_id');
    expect(knockoutEvidence).toContain("k.status='succeeded'");
    expect(sql).toContain('idx_tournament_knockout_candidates_user_hand');
    expect(knockoutEvidence).toContain('ORDER BY c.hand_number DESC,c.id DESC');
    expect(chipPurchase).toContain('ORDER BY c.hand_number,c.id FOR UPDATE');
    expect(chipPurchase).toContain('(prior.hand_number,prior.id)');
    const historicalReceipt = chipPurchase.indexOf(
      'FROM public.entry_purchase_idempotency_receipts r'
    );
    const currentCandidate = chipPurchase.indexOf('fn_ca_latest_committed_knockout_candidate');
    expect(historicalReceipt).toBeGreaterThan(-1);
    expect(currentCandidate).toBeGreaterThan(historicalReceipt);
    expect(chipPurchase).toContain('RETURN v_existing_response');
    expect(chipPurchase).toContain('length(btrim(p_client_token))>128');
    expect(chipPurchase).toContain('a rebuy prompt token is required');
    expect(chipPurchase).toContain('public.fn_caller_session_is_live()');
    expect(chipPurchase).toContain('SESSION_REVOKED');
    expect(chipPurchase).toContain('fn_claim_entry_purchase_receipt');
    expect(chipPurchase).toContain('fn_ca_latest_committed_knockout_candidate');
    expect(chipPurchase).toContain('fn_ca_process_tournament_chip_purchase_money_v1');
    expect(chipPurchase.match(/atomic-table:/g)).toHaveLength(2);
    expect(chipPurchase).toContain('v_table_id:=v_candidate_peek.table_id');
    expect(chipPurchase).toContain('Add-on live table changed after its atomic-table lock');
    expect(chipPurchase).toContain('UPDATE public.tournament_knockout_candidates c');
    expect(chipPurchase).toContain('SET user_id=p_user_id,player_id=NULL,member_id=NULL');
    expect(chipPurchase).toContain("v_final_seat.status::text<>'active'");
    expect(chipPurchase).toContain('COALESCE(v_final_seat.is_sitting_out,false)');
    expect(chipPurchase).toContain('COALESCE(v_final_seat.leave_pending,false)');
    expect(chipPurchase).toContain('v_final_seat.horse_id IS DISTINCT FROM v_expected_horse_id');
    expect(chipPurchase).toContain('v_final_seat.club_id IS DISTINCT FROM v_expected_club_id');
    expect(chipPurchase).toContain('fn_ca_assign_tournament_player_seat_locked');
    expect(chipPurchase).toContain('fn_emit_tournament_manager_wake');
    expect(chipPurchase).toContain('fn_record_entry_purchase_receipt');
    expect(chipPurchase).toContain("'atomic_tournament_chip_purchase','v1'");
    expect(chipPurchase).not.toMatch(/double_submit_collapsed|process_tournament_rebuy_before_/);
    for (const retired of [
      'process_tournament_rebuy_before_maintenance_announcement_gate',
      'process_tournament_rebuy_before_atomic_pool_gate',
      'process_tournament_rebuy_before_bounty_guard_20260907',
      'process_tournament_rebuy_before_one_minute_addon',
      'fn_after_tournament_rebuy',
    ]) {
      expect(sql).toMatch(new RegExp(`DROP FUNCTION(?:\\s+public\\.)?${retired}`));
    }
  });

  it('re-emits a private exact-token money core with no legacy substitutes', () => {
    expect(moneyCore).toContain('p_client_token IS NULL OR length(btrim(p_client_token))=0');
    expect(moneyCore).toContain('length(btrim(p_client_token))>128');
    expect(moneyCore).toContain('v_club:=v_p.club_id');
    expect(moneyCore).toContain('refusing a substituted wallet');
    expect(moneyCore).toContain('v_was_seated:=true');
    expect(moneyCore).toContain("'seated',v_was_seated");
    expect(moneyCore).toContain('trunc(v_total*v_ratio*100+0.000001)/100');
    expect(moneyCore).toContain('trunc(v_total*0.1*100+0.000001)/100');
    expect(moneyCore).toContain('round(COALESCE(v_t.bounty_amount,0),2)');
    expect(moneyCore).not.toMatch(/GREATEST\s*\(\s*1\s*,\s*round\s*\(\s*v_total/i);
    expect(moneyCore).not.toMatch(/double_submit_collapsed|1500 milliseconds|:#|v_legacy/i);
    expect(moneyCore).not.toContain('fn_player_home_club');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.fn_ca_process_tournament_chip_purchase_money_v1\([\s\S]*?service_role;/
    );
  });

  it('uses one owner-only rebuy-window policy for level, minute, and add-on time', () => {
    expect(rebuyWindow).toContain('NULLIF(v_t.rebuy_levels,0)');
    expect(rebuyWindow).toContain('NULLIF(v_t.late_reg_levels,0)');
    expect(rebuyWindow).toContain('make_interval(mins=>v_t.late_reg_mins)');
    expect(rebuyWindow).toContain('v_t.addon_period_started_at');
    expect(rebuyWindow).toContain('v_t.addon_period_ends_at');
    expect(rebuyWindow).toContain("v_now+interval '30 seconds'");
    expect(chipPurchase).toContain('public.fn_ca_tournament_rebuy_window(p_tournament_id)');
    expect(chipPurchase).not.toMatch(/v_level_cap|v_addon_open/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_tournament_rebuy_window\(uuid\)[\s\S]*?service_role;/
    );
  });

  it('rejects raw service seat creates, revives, and coordinate changes before row work', () => {
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF table_id,user_id,seat_number,left_at');
    expect(guard).toContain('FROM pg_catalog.pg_locks l');
    expect(guard).toContain('l.pid=pg_backend_pid()');
    expect(guard).toContain('l.objsubid=1');
    expect(guard).toContain('TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY');
    expect(guard).not.toMatch(/pg_(?:try_)?advisory/);
  });

  it('keeps the AFTER-seat sync private and removes its late global lock', () => {
    expect(sync).not.toContain('ca:tournament-terminal-settlement:v1');
    expect(sync).toContain('v_book := public.fn_spin_book_entry');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_sync_seat_first_player_count\(uuid\)[\s\S]*?service_role;/
    );
    expect(recurring.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain(
      "supabase.rpc('fn_sync_seat_first_player_count'"
    );
  });

  it('leaves launch under atomic database authority and removes the periodic late-registration writer', () => {
    const launch = method(base, 'protected async createTablesAndSeatPlayers(');
    expect(launch).toContain('await this.materializeTournamentLaunchSeats(');
    expect(launch).toContain('assignTournamentPlayerSeatAtomically({');
    expect(launch).not.toMatch(/from\('table_seats'\)[\s\S]{0,100}\.(?:insert|update|delete)\(/);
    expect(launch).not.toMatch(/\.update\(\{\s*current_players:/);
    expect(manager).not.toContain('ensureLateRegSeated');
    expect(manager).not.toContain('atomic_late_reg_seat');
    expect(manager).not.toContain('for (const player of unseated)');
    expect(manager).not.toContain('assignTournamentPlayerSeatAtomically');
    expect(transport).toContain("supabase.rpc('fn_assign_tournament_player_seat_atomic'");
    expect(transport).not.toMatch(/for\s*\([^)]*attempt|\.from\(/);
  });
});
