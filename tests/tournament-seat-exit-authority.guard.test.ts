import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from './helpers/sourceWindow';

const root = (path: string) => resolve(__dirname, '..', path);
const readMigration = (file: string): string =>
  readFileSync(root(`supabase/migrations/${file}`), 'utf8');
const seatMoveHotfixSql = readMigration(
  '20260910051447_the_seat_move_door_the_engine_calls_exists.sql'
);
const expansionSql = readMigration('20260910055856_stage_b_forward_authority_expansion.sql');
const repairSql = readMigration('20260910055909_stage_b_exact_precondition_repairs.sql');
const contractionSql = readMigration('20260910055955_stage_b_current_postimage_contraction.sql');
const sql = `${expansionSql}\n${repairSql}\n${contractionSql}`;
const eliminationProbe = readFileSync(
  root('scripts/ci/probes/tournament-elimination-seat-exit-authority.sql'),
  'utf8'
);
const seatExitProbe = readFileSync(
  root('scripts/ci/probes/tournament-seat-exit-authority.sql'),
  'utf8'
);
const crossClubUnregisterProbe = readFileSync(
  root('scripts/ci/probes/tournament-unregistration-cross-club.sql'),
  'utf8'
);
const manager = readFileSync(root('server/src/tournament/TournamentManager.ts'), 'utf8');
const moveRpc = readFileSync(root('server/src/tournament/tournamentSeatMoveRpc.ts'), 'utf8');
const tournamentService = readFileSync(root('src/services/TournamentService.ts'), 'utf8');

function taggedBody(source: string, tag: string): string {
  const delimiter = `$${tag}$`;
  const first = source.indexOf(delimiter);
  const second = source.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return source.slice(first + delimiter.length, second);
}

const seatGuard = taggedBody(contractionSql, 'seat_exit_guard');
const handSeatOpener = taggedBody(contractionSql, 'open_hand_seat_exit_authority');
const handStackWrapper = taggedBody(contractionSql, 'accepted_hand_stack_with_seat_authority');
const managerWake = taggedBody(contractionSql, 'manager_wake_with_accepted_hand_bust');
const terminalOrphanCutover = taggedBody(repairSql, 'terminal_orphan_cutover');
const cutoverPlayerLockPrefix = taggedBody(repairSql, 'cutover_player_lock_prefix');
const cutoverReceiptsAppendOnly = taggedBody(expansionSql, 'cutover_receipts_append_only');
const atomicMove = taggedBody(contractionSql, 'atomic_tournament_move');
const spinExpiry = taggedBody(contractionSql, 'expire_unfilled_without_reconciler');
const cancellation = taggedBody(contractionSql, 'cancel_with_seat_authority');
const elimination = taggedBody(contractionSql, 'elimination_with_seat_authority');
const bountyElimination = taggedBody(contractionSql, 'bounty_elimination_with_seat_authority');
const lateSeat = taggedBody(contractionSql, 'late_seat_without_reconciler');
const managedUpdate = taggedBody(contractionSql, 'managed_update_without_reconciler');
const reconcilerPreflight = taggedBody(contractionSql, 'legacy_reconciler_preflight');
const cashPlayerLeave = taggedBody(contractionSql, 'cash_player_leave');
const globalWalletCheck = taggedBody(
  contractionSql,
  'global_wallet_check_without_legacy_unregister'
);
const unionMoneyPath = taggedBody(contractionSql, 'union_money_path_without_legacy_unregister');
const unionOverload = taggedBody(contractionSql, 'union_overload_without_legacy_unregister');
const walletGuard = taggedBody(contractionSql, 'wallet_guard_without_legacy_unregister');
const legacyPreflight = taggedBody(contractionSql, 'legacy_unregister_preflight');
const legacyPublicExitPreflight = taggedBody(contractionSql, 'legacy_public_exit_preflight');
const legacyCutoverProof = taggedBody(contractionSql, 'legacy_unregister_cutover_proof');
const chipSyncPreflight = taggedBody(contractionSql, 'legacy_chip_sync_preflight');

describe('tournament seat exits have one hard authority', () => {
  it('fails closed if the production lock trough is missed', () => {
    const begin = repairSql.indexOf('BEGIN;');
    const firstLock = repairSql.indexOf('pg_advisory_xact_lock(', begin);
    expect(begin).toBeGreaterThan(-1);
    expect(repairSql.indexOf("SET LOCAL lock_timeout = '10s';", begin)).toBeGreaterThan(begin);
    expect(repairSql.indexOf("SET LOCAL statement_timeout = '120s';", begin)).toBeGreaterThan(
      begin
    );
    expect(repairSql.indexOf("SET LOCAL transaction_timeout = '150s';", begin)).toBeGreaterThan(
      begin
    );
    expect(repairSql.indexOf("SET LOCAL lock_timeout = '10s';", begin)).toBeLessThan(firstLock);
    expect(repairSql.indexOf("SET LOCAL statement_timeout = '120s';", begin)).toBeLessThan(
      firstLock
    );
    expect(repairSql.indexOf("SET LOCAL transaction_timeout = '150s';", begin)).toBeLessThan(
      firstLock
    );
  });

  it('repairs the exact historical terminal backlog once under a write barrier', () => {
    expect(sql).toContain('LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('LOCK TABLE public.tournament_players IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('LOCK TABLE public.tables IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('LOCK TABLE public.table_seats IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain(
      "SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'))"
    );
    expect(sql).not.toContain('LOCK TABLE cron.job');
    const repairReconcilerLock = repairSql.indexOf(
      "SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'))"
    );
    const retirementRootLock = contractionSql.indexOf(
      "SELECT pg_advisory_xact_lock(\n  hashtextextended('ca:tournament-terminal-settlement:v1',0));"
    );
    const retirementMaintenanceLock = contractionSql.indexOf(
      'SELECT pg_advisory_xact_lock_shared(530090,1);',
      retirementRootLock
    );
    const retirementReconcilerLock = contractionSql.indexOf(
      "SELECT pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'))",
      retirementMaintenanceLock
    );
    const reconcilerUnschedule = contractionSql.indexOf('PERFORM cron.unschedule(j.jobid)');
    const reconcilerAbsenceProof = contractionSql.indexOf(
      "RAISE EXCEPTION 'tournament denormal reconciler cron survived unschedule'"
    );
    expect(repairReconcilerLock).toBeGreaterThan(-1);
    expect(retirementRootLock).toBeGreaterThan(-1);
    expect(retirementMaintenanceLock).toBeGreaterThan(retirementRootLock);
    expect(retirementReconcilerLock).toBeGreaterThan(retirementMaintenanceLock);
    expect(reconcilerUnschedule).toBeGreaterThan(retirementReconcilerLock);
    expect(reconcilerAbsenceProof).toBeGreaterThan(reconcilerUnschedule);
    expect(terminalOrphanCutover).toContain('public.fn_ca_has_committed_tournament_receipt(t.id)');
    expect(terminalOrphanCutover).toContain('s.left_at IS NULL');
    expect(terminalOrphanCutover).toContain(
      'SET left_at=COALESCE(t.ended_at,transaction_timestamp())'
    );
    expect(terminalOrphanCutover).toContain("status='left'");
    expect(terminalOrphanCutover).toContain('SET current_players=0');
    const terminalCloseOnly = terminalOrphanCutover.slice(
      0,
      terminalOrphanCutover.indexOf('-- A later knockout generation')
    );
    expect(terminalCloseOnly).not.toMatch(/SET[\s\S]*?stack\s*=/);
    expect(terminalOrphanCutover).toContain(
      'INSERT INTO public.tournament_seat_exit_authority_cutover'
    );
  });

  it('takes the terminal root before every cutover lock and reuses private seating cores', () => {
    const globalLock = repairSql.indexOf(
      "hashtextextended('ca:tournament-terminal-settlement:v1',0)"
    );
    const maintenanceLock = repairSql.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    const reconcilerLock = repairSql.indexOf(
      "pg_advisory_xact_lock(hashtext('reconcile-tournament-denormals'))"
    );
    const playerLocks = repairSql.indexOf('$cutover_player_lock_prefix$');
    const relationLocks = repairSql.indexOf(
      'LOCK TABLE public.tournament_launch_receipts IN SHARE ROW EXCLUSIVE MODE'
    );

    expect(globalLock).toBeGreaterThan(-1);
    expect(maintenanceLock).toBeGreaterThan(globalLock);
    expect(reconcilerLock).toBeGreaterThan(maintenanceLock);
    expect(playerLocks).toBeGreaterThan(reconcilerLock);
    expect(relationLocks).toBeGreaterThan(playerLocks);
    expect(cutoverPlayerLockPrefix).toContain('public.fn_lock_daily_mission_user(v_user_id)');
    expect(terminalOrphanCutover).toContain('public.fn_ca_choose_tournament_seat_locked(');
    expect(terminalOrphanCutover).toContain('public.fn_ca_assign_tournament_player_seat_locked(');
    expect(terminalOrphanCutover).not.toContain('public.fn_assign_tournament_player_seat_atomic(');
  });

  it('classifies every paid knockout generation from exact immutable evidence', () => {
    const windows = repairSql.slice(
      repairSql.indexOf('CREATE TEMP TABLE ca_cutover_candidate_windows'),
      repairSql.indexOf('CREATE TEMP TABLE ca_cutover_candidate_rebuy_payments')
    );
    const ordinals = repairSql.slice(
      repairSql.indexOf('CREATE TEMP TABLE ca_cutover_rebuy_entitlement_ordinals'),
      repairSql.indexOf('CREATE TEMP TABLE ca_cutover_candidate_rebuy_payments')
    );
    const payments = repairSql.slice(
      repairSql.indexOf('CREATE TEMP TABLE ca_cutover_candidate_rebuy_payments'),
      repairSql.indexOf('CREATE TEMP TABLE ca_cutover_paid_candidates')
    );

    expect(windows).toContain('lead(c.id) OVER generation_order');
    expect(windows).toContain('lead(c.created_at) OVER generation_order');
    // hand_number is allocated by the global hand-number sequence. table_id
    // remains part of each physical-hand join, never a chronology substitute.
    expect(windows).toContain('ORDER BY c.hand_number,c.id');
    expect(windows).toContain('h.table_id=c.table_id AND h.hand_number=c.hand_number');
    expect(windows).toContain('WHERE c.stack_after=0');
    expect(windows).toContain("c.state='pending' OR (");
    expect(windows).toContain("c.state='rebought' AND c.next_candidate_id IS NULL");
    expect(windows).toContain('c.resolved_at IS NOT NULL');
    expect(windows).toContain('public.hand_atomic_commits');
    expect(windows).toContain('public.settlement_idempotency_keys');
    expect(windows).toContain('k.result IS NOT DISTINCT FROM h.stack_result');
    expect(payments).toContain('public.tournament_refund_entitlements');
    expect(payments).toContain('public.chip_ledger');
    expect(payments).toContain('public.wallet_transactions');
    expect(payments).toContain('public.wallet_credit_idempotency');
    expect(payments).toContain('l.created_at IS NOT DISTINCT FROM e.created_at');
    expect(payments).toContain("VALUES ('rebuy'::text),('reentry'::text)");
    expect(payments).toContain("kind.purchase_type||':'||w.user_id::text||':%'");
    expect(payments).toContain("tx.description LIKE 'Tournament '||idem.purchase_type||':%'");
    expect(payments).toContain("e.evidence_kind='cutover_wallet_charge'");
    expect(payments).toContain("idem.purchase_type='rebuy'");
    expect(payments).toContain('idem.purchase_amount=0');
    expect(ordinals).toContain('row_number() OVER (');
    expect(ordinals).toContain('ORDER BY l.chain_seq,e.id');
    expect(ordinals).toContain("e.entitlement_kind='wallet_charge'");
    expect(payments).toContain("w.user_id::text||':#'||ordinal.purchase_ordinal::text");
    expect(payments).toContain(') IS TRUE');
    expect(payments).not.toMatch(/idem\.purchase_amount\s*=\s*0[\s\S]*?e\.gross\s*>\s*0/);
    expect(terminalOrphanCutover).toContain('JOIN ca_cutover_candidate_windows w');
    expect(terminalOrphanCutover).toContain('WHERE w.next_candidate_id IS NOT NULL');
    expect(terminalOrphanCutover).toContain('AND NOT p.exact_rebuy');
    expect(terminalOrphanCutover).toContain(
      "OR (p.next_candidate_id IS NULL AND tp.status<>'playing')"
    );
    expect(seatExitProbe).toContain("e.evidence_kind='cutover_wallet_charge'");
    expect(seatExitProbe).toContain("evidence.purchase_type='rebuy'");
    expect(seatExitProbe).toContain('i.amount=0');
    expect(seatExitProbe).toContain('evidence.purchase_ordinal IS DISTINCT FROM (');
    expect(seatExitProbe).toContain('(earlier_ledger.chain_seq,earlier.id)<');
    expect(seatExitProbe).toContain("r.user_id::text||':#'||");
    expect(seatExitProbe).toContain('evidence.purchase_ordinal::text');
    expect(seatExitProbe).toContain(') IS NOT TRUE');
    expect(terminalOrphanCutover).toContain(
      "SET state='rebought',resolved_at=v_item.first_paid_at"
    );
    expect(terminalOrphanCutover).toContain('later.hand_number>p.zero_hand_number');
    expect(sql).toContain('CREATE TEMP TABLE ca_cutover_paid_hand_continuations');
    expect(terminalOrphanCutover).toContain("v_item.candidate_state_before='rebought'");
    expect(terminalOrphanCutover).toContain('v_item.candidate_resolved_at_before');
    expect(terminalOrphanCutover).not.toContain('later.committed_at>p.first_paid_at');
  });

  it('repairs only exact paid seat generations and receipts every source identity', () => {
    expect(terminalOrphanCutover).toContain('count(*)::bigint*v_item.rebuy_chips::bigint');
    expect(terminalOrphanCutover).toContain('SET chips=v_expected_stack::integer');
    expect(terminalOrphanCutover).toContain("v_action:='stranded_stack_seated'");
    expect(terminalOrphanCutover).toContain("v_action:='live_generation_rotated'");
    expect(terminalOrphanCutover).toContain("v_action:='candidate_closed'");
    expect(terminalOrphanCutover).toContain('FROM ca_cutover_paid_hand_continuations continuation');
    expect(terminalOrphanCutover).toContain('SET joined_at=v_item.first_paid_at');
    expect(terminalOrphanCutover).toContain(
      'INSERT INTO public.tournament_paid_candidate_cutover_receipts'
    );
    for (const evidence of [
      'zero_hac_hand_id',
      'zero_settlement_hand_id',
      'entitlement_ids',
      'source_ledger_ids',
      'source_ledger_chain_seqs',
      'source_ledger_row_hashes',
      'wallet_transaction_ids',
      'purchase_idempotency_keys',
      'purchase_ordinals',
      'purchase_types',
    ]) {
      expect(sql).toContain(evidence);
    }
    expect(terminalOrphanCutover).toContain("WHERE reentry.purchase_type='reentry'");
  });

  it('proves every occupant-owned field after a vacated chair is reused', () => {
    expect(terminalOrphanCutover).toContain(
      'assignment core normalizes it. That core writes an identical complete'
    );
    expect(terminalOrphanCutover).toContain(
      'v_item.user_id,v_target_table_id,v_item.roster_club_id'
    );
    expect(terminalOrphanCutover).toContain(
      "'stranded rebuy chair retained state from a departed occupant'"
    );
    for (const field of [
      'seat_row_reused',
      'destination_seat_id_before',
      'destination_user_id_before',
      'destination_horse_id_before',
      'destination_club_id_before',
      'destination_time_bank_remaining_before',
      'destination_time_bank_uses_remaining_before',
      'seat_player_id',
      'seat_member_id',
      'seat_horse_id',
      'seat_club_id',
      'seat_is_sitting_out',
      'seat_is_away',
      'seat_sit_out_at',
      'seat_scheduled_leave_hands',
      'seat_left_at',
      'seat_status',
      'seat_leave_pending',
      'seat_auto_rebuy',
      'seat_time_bank_remaining',
      'seat_time_bank_uses_remaining',
      'seat_entry_hold',
      'seat_entry_post_agreed',
    ]) {
      expect(sql).toContain(field);
    }
  });

  it('reseats both accepted-hand survivor classes through one database-chosen chair', () => {
    const positiveRepair = terminalOrphanCutover.slice(
      terminalOrphanCutover.indexOf('-- Every remaining positive seatless roster'),
      terminalOrphanCutover.indexOf(
        'SELECT COALESCE(array_agg(r.source_seat_id ORDER BY r.source_seat_id)'
      )
    );
    expect(positiveRepair).toContain('WITH positive_seatless AS MATERIALIZED');
    expect(positiveRepair).toContain('LEFT JOIN ca_cutover_paid_hand_continuations continuation');
    expect(positiveRepair).toContain("THEN 'accepted_hand_no_ko'");
    expect(positiveRepair).toContain("ELSE 'accepted_hand_after_paid_rebuy'");
    expect(positiveRepair).toContain('continuation.candidate_id IS NOT NULL OR NOT EXISTS');
    expect(positiveRepair).not.toContain('SELECT count(*) FROM public.table_seats history');
    expect(positiveRepair).not.toContain(
      "lower(COALESCE(tb.status,'')) IN ('running','waiting','active')"
    );
    expect(positiveRepair).toContain("s.status='active'");
    expect(positiveRepair).toContain('h.committed_at>=s.joined_at');
    expect(positiveRepair).toContain('ORDER BY committed.hand_number DESC,committed.table_id');
    expect(positiveRepair).toContain('later_global.hand_number>h.hand_number');
    expect(positiveRepair).toContain('k.result IS NOT DISTINCT FROM h.stack_result');
    expect(positiveRepair).toContain('s.left_at>GREATEST(');
    expect(positiveRepair).toContain('public.fn_ca_choose_tournament_seat_locked(');
    expect(positiveRepair).toContain('v_target_table_id,v_target_seat_number);');
    expect(positiveRepair).toContain("'positive accepted-hand survivor did not reseat exactly: %'");
    expect(positiveRepair).toContain(
      'INSERT INTO public.tournament_positive_orphan_cutover_receipts'
    );
    expect(positiveRepair).toContain(
      "'positive accepted-hand reseat did not preserve its own state exactly'"
    );
    expect(sql).toContain('source_time_bank_remaining');
    expect(sql).toContain('revived_time_bank_remaining');
    expect(sql).toContain('revived_table_id');
    expect(sql).toContain('revived_seat_number');
    expect(sql).toContain('evidence_class');
    expect(sql).toContain('paid_candidate_id');
    expect(sql).toContain('destination_seat_id_before');
    expect(sql).toContain('revived_left_at');
    expect(sql).toContain('revived_status');
    expect(sql).toContain('revived_leave_pending');
    expect(terminalOrphanCutover).toContain(
      "'live tournament chip cutover found an ambiguous or missing positive seat'"
    );
  });

  it('vacates only exact unpaid pending-zero legacy reseats before chip mirroring', () => {
    const classificationStart = repairSql.indexOf(
      'CREATE TEMP TABLE ca_cutover_pending_zero_seats'
    );
    const mirrorStart = repairSql.indexOf('WITH exact_live AS (');
    const classification = repairSql.slice(
      classificationStart,
      repairSql.indexOf('-- The old process-start sweep', classificationStart)
    );
    const zeroRepair = terminalOrphanCutover.slice(
      terminalOrphanCutover.indexOf('-- A playing zero roster is already committed'),
      terminalOrphanCutover.indexOf('-- Retire the minute reconciler')
    );
    const exactLive = terminalOrphanCutover.slice(
      terminalOrphanCutover.indexOf('WITH exact_live AS ('),
      terminalOrphanCutover.indexOf('WITH live_seat AS (')
    );

    expect(classificationStart).toBeGreaterThan(-1);
    expect(classificationStart).toBeLessThan(mirrorStart);
    for (const predicate of [
      'w.next_candidate_id IS NULL',
      "w.candidate_state_before='pending'",
      'w.candidate_resolved_at_before IS NULL',
      'w.zero_committed_at IS NOT NULL',
      "c.stack_after=0 AND c.state='pending' AND c.resolved_at IS NULL",
      "tp.status='playing' AND tp.chips=0",
      's.joined_at IS NOT NULL AND s.joined_at>=w.zero_committed_at',
      'live.player_live_seat_count=1',
      'funding.post_zero_entitlement_count=0',
      'funding.post_zero_chip_ledger_count=0',
      'funding.post_zero_wallet_transaction_count=0',
      'funding.post_zero_wallet_idempotency_count=0',
      'later.later_accepted_hand_count=0',
    ]) {
      expect(classification).toContain(predicate);
    }
    expect(classification).toContain('tb.id=tp.table_id AND tb.tournament_id=w.tournament_id');
    expect(classification).toContain('s.table_id=tp.table_id AND s.seat_number=tp.seat_number');
    expect(classification).not.toContain('s.id=w.zero_seat_id');
    expect(classification).toContain('w.zero_seat_id,w.zero_seat_joined_at');
    expect(classification).toContain('s.id AS vacated_seat_id');
    expect(classification).toContain('public.tournament_refund_entitlements');
    expect(classification).toContain('public.chip_ledger');
    expect(classification).toContain('public.wallet_transactions');
    expect(classification).toContain('public.wallet_credit_idempotency');
    expect(classification).toContain("('rebuy','reentry','addon')");
    expect(classification).toContain("':(rebuy|reentry|addon):'||w.user_id::text");
    expect(classification).toContain('payment.candidate_id=w.candidate_id');
    expect(classification).toContain('accepted.committed_at>w.zero_committed_at');
    expect(classification).toContain("accepted.stack_result->'written' ? w.user_id::text");
    expect(classification).not.toContain('accepted.hand_number>w.zero_hand_number');

    expect(zeroRepair).toContain('without one exact unpaid pending-zero candidate');
    expect(zeroRepair).toContain('WHERE s.id=v_item.vacated_seat_id');
    expect(zeroRepair).toContain('AND s.joined_at=v_item.vacated_joined_at');
    expect(zeroRepair).toContain(
      "SET stack=0,left_at=v_vacated_at,status='left',leave_pending=false"
    );
    expect(zeroRepair).toContain('v_table_live_seats_after<>v_table_live_seats_before-1');
    expect(zeroRepair).toContain('SET current_players=v_table_live_seats_after');
    expect(zeroRepair).toContain(
      'INSERT INTO public.tournament_pending_zero_seat_cutover_receipts'
    );
    expect(zeroRepair).toContain('v_pending_zero_candidate_ids');
    expect(sql).toContain('pending_zero_candidate_count,pending_zero_candidate_ids');
    expect(sql).toContain('pending_zero_seat_ids');
    expect(zeroRepair).not.toMatch(
      /UPDATE public\.tournament_(?:players|knockout_candidates)[\s\S]*?SET/
    );
    expect(exactLive).toContain('AND tp.chips>0 AND s.stack>0');
  });

  it('keeps every detailed cutover receipt owner-only and append-only', () => {
    for (const table of [
      'tournament_pending_zero_seat_cutover_receipts',
      'tournament_paid_candidate_cutover_receipts',
      'tournament_positive_orphan_cutover_receipts',
    ]) {
      expect(sql).toContain(`ALTER TABLE public.${table}\n  ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE TRIGGER ${table}_append_only`);
      expect(sql).toContain(`ON public.${table}`);
    }
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.tournament_pending_zero_seat_cutover_receipts,'
    );
    expect(cutoverReceiptsAppendOnly).toContain(
      'tournament seat-exit cutover receipts are append-only'
    );
    expect(seatExitProbe).toContain('FAIL paid candidate cutover evidence changed');
    expect(seatExitProbe).toContain('FAIL positive-orphan cutover evidence changed');
    expect(seatExitProbe).toContain('FAIL pending-zero cutover evidence changed');
    expect(seatExitProbe).toContain('FAIL a zero-chip playing roster still has a live seat');
    expect(seatExitProbe).toContain('FAIL cutover detail receipts are not append-only');
    expect(seatExitProbe).toContain(
      "'service_role','public.tournament_paid_candidate_cutover_receipts','SELECT'"
    );
    expect(seatExitProbe).toContain(
      "'public.tournament_pending_zero_seat_cutover_receipts'::regclass"
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

  it('rechecks an unfilled Spin only after locking its current parent row', () => {
    const parentLock = spinExpiry.indexOf('FOR UPDATE SKIP LOCKED');
    const freshRead = spinExpiry.indexOf('INTO v_current', parentLock);
    const cancel = spinExpiry.indexOf('atomic_cancel_tournament', freshRead);

    expect(parentLock).toBeGreaterThan(-1);
    expect(freshRead).toBeGreaterThan(parentLock);
    expect(cancel).toBeGreaterThan(freshRead);
    expect(spinExpiry).toContain('v_current.live_seats>=v_current.max_players');
    expect(spinExpiry).toContain('v_current.spin_multiplier IS NOT NULL');
    expect(spinExpiry).toContain('v_current.has_booked_draw');
    expect(spinExpiry).toContain("(v_result->>'total_refunded')::numeric");
    expect(spinExpiry).toContain("'skipped_raced',v_skipped");
    expect(spinExpiry).not.toContain('fn_sync_seat_first_player_count');
    expect(spinExpiry).not.toContain('chips_refunded_estimate');
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
    expect(seatMoveHotfixSql).toContain(
      'BEFORE UPDATE OR DELETE ON public.tournament_seat_move_receipts'
    );
    expect(expansionSql).toContain('stage_b_move_receipt_preimage');
    expect(contractionSql).toContain('stage_b_contraction_move_receipt_preimage');
    expect(contractionSql).toContain(
      'Stage-B contraction changed an immutable seat-move receipt preimage'
    );
    const receiptLock = contractionSql.indexOf(
      'LOCK TABLE public.tournament_seat_exit_authorizations,'
    );
    const firstMoveReplacement = contractionSql.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_open_tournament_seat_exit_authority('
    );
    expect(receiptLock).toBeGreaterThan(-1);
    expect(receiptLock).toBeLessThan(firstMoveReplacement);
    expect(contractionSql.slice(receiptLock, firstMoveReplacement)).toContain(
      'IN SHARE MODE NOWAIT;'
    );
    expect(contractionSql).not.toMatch(/receipt_count\s*=\s*(?:44|60)\b/);
  });

  it('makes the manager call one retry-safe RPC instead of split writes', () => {
    const wrapper = sliceMethod(manager, 'protected executePlayerMoves(');
    const owned = sliceMethod(manager, 'private async executePlayerMovesOwned(');
    const boundary = sliceMethod(manager, 'private requestTournamentSeatMoveAtBoundary(');

    expect(wrapper).toContain('runWithTournamentSeatMoveAuthority');
    expect(wrapper).toContain('this.executePlayerMovesOwned(moves)');
    expect(owned).toContain('this.requestTournamentSeatMoveAtBoundary(input, boundary)');
    expect(boundary).toContain('moveTournamentPlayerAtomically');
    for (const method of [wrapper, owned, boundary]) {
      expect(method).not.toMatch(/\.from\(['"](?:table_seats|tournament_players|tables)['"]\)/);
    }
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

  it('retires unkeyed and unused public exits after proving they have no caller', () => {
    const retired = [
      'public.fn_unregister_from_tournament(uuid)',
      'public.fn_leave_seat_and_refund(uuid)',
      'public.fn_admin_remove_tournament_player(uuid,uuid)',
    ];
    for (const signature of retired) {
      const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(sql.match(new RegExp(`DROP FUNCTION ${escaped} RESTRICT;`, 'g'))).toHaveLength(1);
      expect(legacyPublicExitPreflight).toContain(signature);
      expect(legacyCutoverProof).toContain(signature);
      expect(seatExitProbe).toContain(signature);
    }
    expect(legacyPublicExitPreflight).toContain('pg_depend');
    expect(legacyPublicExitPreflight).toContain(
      'a stored function still calls obsolete tournament exit'
    );
    expect(legacyCutoverProof).toContain('obsolete public tournament exit still exists');
    expect(seatExitProbe).toContain('FAIL obsolete public tournament exit still exists');

    expect(tournamentService).toMatch(
      /rpc\('fn_unregister_from_tournament',[\s\S]*?p_request_id: requestId/
    );
    expect(tournamentService).toMatch(
      /rpc\('fn_leave_seat_and_refund',[\s\S]*?p_request_id: requestId/
    );
    expect(tournamentService).not.toContain("rpc('fn_admin_remove_tournament_player'");
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

  it('refuses revoked sessions at every player-facing tournament exit', () => {
    expect(legacyCutoverProof).toContain('public.fn_caller_session_is_live()');
    expect(legacyCutoverProof).toContain('tournament exit RPC no longer refuses a revoked session');
    expect(seatExitProbe).toContain('FAIL tournament exit RPC admits a missing or revoked session');
    expect(seatExitProbe).toContain("'request.jwt.claims'");
    expect(seatExitProbe).toContain("EXECUTE 'SET LOCAL ROLE authenticated'");
    expect(seatExitProbe).toContain("EXCEPTION WHEN SQLSTATE '28000'");
    expect(seatExitProbe).toContain('FAIL missing or revoked session reached tournament exit');
    for (const signature of [
      'public.fn_unregister_from_tournament(uuid,uuid)',
      'public.fn_leave_seat_and_refund(uuid,uuid)',
    ]) {
      expect(legacyCutoverProof).toContain(signature);
      expect(seatExitProbe).toContain(signature);
    }
  });

  it('pins fee refunds to the original recipient instead of the funding club', () => {
    for (const proof of [legacyCutoverProof, seatExitProbe]) {
      expect(proof).toContain('v_fee_source_rake_record_ids');
      expect(proof).toContain('GROUP BY r.club_id');
      expect(proof).toContain('fee_recipient_club_id');
      expect(proof).toContain('original_rake_record_ids');
      expect(proof).toContain('fee_reversal_ids');
      expect(proof).toContain('fees_reversed');
      expect(proof).toContain('original.club_id=reversal.club_id');
      expect(proof).toContain('tournament_unregistration_rake_evidence_is_immutable');
      expect(proof).toContain('GROUP BY e.refund_wallet_club_id');
    }
    expect(seatExitProbe).toContain(
      'FAIL tournament unregistration substitutes funding club for fee recipient'
    );
    expect(seatExitProbe).toContain(
      'FAIL a committed unregistration fee reversal changed provenance'
    );
    expect(seatExitProbe).toContain('receipt.fee_source_rake_record_ids IS DISTINCT FROM ARRAY(');
    expect(seatExitProbe).toContain('original.club_id=reversal.club_id');
    expect(crossClubUnregisterProbe).toContain('public.fn_register_for_tournament(');
    expect(crossClubUnregisterProbe).toContain(
      'public.fn_ca_process_tournament_chip_purchase_money_v1('
    );
    expect(crossClubUnregisterProbe).toContain('public.fn_unregister_from_tournament(');
    expect(crossClubUnregisterProbe).toContain('v_receipt.source_wallet_club_ids');
    expect(crossClubUnregisterProbe).toContain('v_receipt.fee_source_rake_record_ids');
    expect(crossClubUnregisterProbe).toContain('v_receipt.fee_reversal_ids');
    expect(crossClubUnregisterProbe).toContain('reversal.rake_amount=-15');
    expect(crossClubUnregisterProbe).toContain('ROLLBACK;');
    expect(crossClubUnregisterProbe).toContain('AUDIT_TEST_PASS');
  });
});
