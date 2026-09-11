import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceSqlStatement } from './helpers/sourceWindow';

const migrationsDirectory = resolve(process.cwd(), 'supabase/migrations');
function stageBMigration(suffix: string): string {
  const matches = readdirSync(migrationsDirectory).filter(
    (file) => file.endsWith(`_${suffix}.sql`) || file.endsWith(`_${suffix}.sql.pending`)
  );
  if (matches.length !== 1) throw new Error(`Stage-B ${suffix} migration is ambiguous`);
  return resolve(migrationsDirectory, matches[0]);
}
const expansionMigration = stageBMigration('stage_b_forward_authority_expansion');
const finalMigration = stageBMigration('stage_b_current_postimage_contraction');
const expansionSql = readFileSync(expansionMigration, 'utf8');
const finalSql = readFileSync(finalMigration, 'utf8');
const repriceHotfixSql = readFileSync(
  resolve(migrationsDirectory, '20260911090347_the_prize_reprice_door_the_engine_calls_exists.sql'),
  'utf8'
);
const sql = `${expansionSql}\n${finalSql}`;

function taggedBodyIn(source: string, tag: string): string {
  const delimiter = `$${tag}$`;
  const first = source.indexOf(delimiter);
  const second = source.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return source.slice(first + delimiter.length, second);
}

function taggedBody(tag: string): string {
  return taggedBodyIn(sql, tag);
}

describe('the final tournament seat authority converges after M6', () => {
  it('captures only the later satellite implementation', () => {
    const capture = taggedBody('capture_final_late_cores');
    expect(capture).toContain('fn_settle_satellite_tournament_pre_seat_guard');
    expect(capture).toContain('fn_settle_satellite_tournament_seat_exit_core_v2');
    expect(capture).toContain('ALTER FUNCTION public.fn_settle_satellite_tournament(');
    expect(capture).not.toContain('fn_ca_unregister_tournament_player_exact');
    expect(capture).not.toMatch(
      /atomic_cancel_tournament|fn_complete_tournament_terminal|fn_eliminate_tournament_player_atomic|fn_claim_tournament_bounty_elimination|fn_ca_settle_hand_stacks_absolute/
    );
  });

  it('emits the binding ticket-only exact-unregistration core statically', () => {
    const core = taggedBody('ticket_only_unregister_seat_exit_core_v2');
    expect(finalSql).toContain(
      'CREATE FUNCTION public.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2('
    );
    expect(core).toContain('v_ticket jsonb;');
    expect(core).toContain('satellite-funded registration % can return only a tournament ticket');
    expect(core).toContain('fn_ca_return_satellite_entitlement_as_ticket');
    expect(core).toContain("WHERE e.entitlement_kind='wallet_charge'");
    expect(core).toContain("e.entitlement_kind IN ('satellite_seat','tournament_ticket')");
    expect(core).toContain('v_wallet_refunds_before+v_wallet_amount');
    expect(core).not.toContain('returns the same escrow value in cash');
    expect(core).not.toContain('wallet_chips_from_satellite_entitlements');
  });

  it('leaves both v2 cores owner-only behind explicit capability wrappers', () => {
    const unregister = taggedBody('unregister_with_final_seat_authority');
    const satellite = taggedBody('satellite_with_final_seat_authority');
    for (const body of [unregister, satellite]) {
      expect(body).toContain('fn_ca_open_tournament_seat_exit_authority');
      expect(body).toContain('fn_ca_close_tournament_seat_exit_authority');
    }
    expect(unregister).toContain('fn_ca_unregister_tournament_player_exact_seat_exit_core_v2');
    expect(satellite).toContain('fn_settle_satellite_tournament_seat_exit_core_v2');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.fn_ca_unregister_tournament_player_exact_seat_exit_core_v2\([\s\S]*?FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.fn_settle_satellite_tournament_seat_exit_core_v2\(uuid,uuid\)\s+FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS\s+public\.fn_ca_unregister_tournament_player_exact_pre_seat_guard\(/
    );
    expect(sql).toMatch(
      /DROP FUNCTION IF EXISTS\s+public\.fn_settle_satellite_tournament_pre_seat_guard\(uuid,uuid\) RESTRICT;/
    );
  });

  it('seats every RUNNING-target satellite award inside the settlement transaction', () => {
    const satellite = taggedBody('satellite_with_final_seat_authority');
    const terminalRoot = satellite.indexOf('public.fn_ca_lock_settlement_lane_global()');
    const missionLock = satellite.indexOf('fn_lock_daily_mission_user', terminalRoot);
    const exitAuthority = satellite.indexOf(
      'fn_ca_open_tournament_seat_exit_authority',
      missionLock
    );
    const core = satellite.indexOf(
      'fn_settle_satellite_tournament_seat_exit_core_v2',
      exitAuthority
    );
    const assignment = satellite.indexOf('fn_assign_tournament_player_seat_atomic', core);

    expect(terminalRoot).toBeGreaterThan(-1);
    expect(missionLock).toBeGreaterThan(terminalRoot);
    expect(exitAuthority).toBeGreaterThan(missionLock);
    expect(core).toBeGreaterThan(exitAuthority);
    expect(assignment).toBeGreaterThan(core);
    expect(satellite).toContain('SELECT DISTINCT tp.user_id');
    expect(satellite).toContain('ORDER BY tp.user_id');
    expect(satellite).toContain('v_was_already_settled:=FOUND');
    expect(satellite).toContain('IF NOT v_was_already_settled THEN');
    expect(satellite).toContain("IF NOT v_was_already_settled AND v_target_status='RUNNING' THEN");
    expect(satellite).toContain("award.delivery_kind='seat'");
    expect(satellite).toContain('ORDER BY award.user_id,award.place');
    expect(satellite).toContain('tp.id=v_award.registration_id');
    expect(satellite).toContain("tp.status::text='playing'");
    expect(satellite).toContain('COALESCE(tp.chips,0)>0');
    expect(satellite).toContain('tp.source_satellite_id=p_tournament_id');
    expect(satellite).toContain('target_table.tournament_id=v_target_id');
    expect(satellite).toContain('seat.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric');
    expect(satellite).toContain('exact_table.tournament_id=v_target_id');
    expect(satellite).toContain('exact_seat.left_at IS NULL)=1');
    expect(satellite).toContain('v_assigned_count<>v_seat_award_count');
    expect(satellite).not.toMatch(/watch|reconcil|retry/i);
  });
});

describe('late ticket admission uses the one capacity owner and proves its chair', () => {
  const admission = taggedBody('ticket_admission_for');

  it('removes the dropped helper and verifies even an ambiguous seat response', () => {
    expect(admission).not.toContain('fn_create_late_registration_capacity');
    expect(
      admission.match(/fn_ensure_late_registration_capacity\(p_tournament_id,1\)/g)
    ).toHaveLength(2);
    const ambiguity = admission.indexOf('already_seated_or_missing');
    const proof = admission.indexOf(
      'Late ticket admission has no exact positive roster-seat generation'
    );
    expect(ambiguity).toBeGreaterThan(-1);
    expect(proof).toBeGreaterThan(ambiguity);
    expect(admission.slice(ambiguity, proof)).toContain('COALESCE(tp.chips,0)>0');
    expect(admission.slice(ambiguity, proof)).toContain(
      's.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric'
    );
  });
});

describe('pending accepted zero stacks cannot be resurrected from a stale chair', () => {
  it('contains no downstream repair and fails closed if M6 left one behind', () => {
    const proof = taggedBody('prove_no_pending_zero_live_seat_survived');
    expect(proof).toContain("c.state='pending'");
    expect(proof).toContain('c.resolved_at IS NULL');
    expect(proof).toContain('c.stack_after=0');
    expect(proof).toContain('s.left_at IS NULL');
    expect(proof).toContain('a pending accepted zero-stack candidate still has a live seat');
    expect(sql).not.toContain('ca_pending_zero_seat_repairs');
    expect(sql).not.toContain('vacate_proven_pending_zero_seats');
    expect(sql).not.toContain('INSERT INTO public.tournament_pending_zero_seat_cutover_receipts');
    expect(sql).not.toMatch(/UPDATE\s+public\.tournament_pending_zero_seat_cutover_receipts/i);
    expect(proof).not.toContain('fn_emit_tournament_manager_wake');
    expect(proof).not.toMatch(/\b(?:UPDATE|INSERT|DELETE)\b/);
    expect(sql).toContain(
      'LOCK TABLE public.tournament_knockout_candidates\n  IN SHARE ROW EXCLUSIVE MODE;'
    );
  });
});

describe('RUNNING roster and chair state is one deferred commit fact', () => {
  const invariant = taggedBody('running_roster_seat_invariant');

  it('requires exact positive roster coordinates and stack in both directions', () => {
    expect(invariant).toContain("='registered'");
    expect(invariant).toContain('COALESCE(tp.chips,0)<=0');
    expect(invariant).toContain('COALESCE(tp.chips,0)>0');
    expect(invariant).toContain('tp.table_id=s.table_id');
    expect(invariant).toContain('tp.seat_number=s.seat_number');
    expect(invariant).toContain('tp.chips::numeric IS NOT DISTINCT FROM s.stack::numeric');
    expect(invariant).toContain('s.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric');
    expect(invariant).toContain('RUNNING_TOURNAMENT_ROSTER_SEAT_MISMATCH');
  });

  it('arms deferred constraint triggers on roster, chair and RUNNING transition', () => {
    for (const name of [
      'tournament_players_match_live_seat_at_commit',
      'tournament_live_seats_match_roster_at_commit',
      'running_tournament_roster_seat_match_at_commit',
    ]) {
      const statement = sliceSqlStatement(sql, `CREATE CONSTRAINT TRIGGER ${name}`);
      expect(statement).toContain('DEFERRABLE INITIALLY DEFERRED');
    }
    expect(sql).toContain('DO $assert_existing_running_roster_seat_state$');
  });

  it('makes ambiguous late-seat success fail at commit', () => {
    expect(invariant).toContain('positive playing roster has no exact live seat mirror');
    expect(invariant).toContain('live seat has no exact positive playing roster mirror');
  });
});

describe('periodic tournament mutation is retired at its root', () => {
  it('statically re-emits the detector without the removed absent-player entry', () => {
    const sweep = taggedBody('conservation_sweep_without_absent_mutation');
    expect(sweep).not.toContain('fn_ca_absent_tournament_players');
    expect(sweep).toContain('fn_ca_stranded_tournament_players');
    expect(sweep).toContain("0,NULL,v_n::numeric,'ledger',c.check_name");
    expect(sweep).toContain('INSERT INTO public.ca_detector_runs');
  });

  it('commits fail-closed bodies and disabling before final drain and drop', () => {
    const fence = taggedBody('commit_retired_tournament_mutator_schedule_fence');
    const broke = taggedBody('retired_broke_seat_mutator_fence');
    expect(finalSql).toContain(
      "hashtextextended('ca:job:eliminate-absent-tournament-players:v1',0)"
    );
    expect(broke).toContain("hashtextextended('ca:job:release-broke-seats:v1',0)");
    expect(fence).toContain('cron.alter_job(job_id=>r.jobid,active=>false)');
    expect(fence).toContain('cardinality(v_job_ids)<>2');
    expect(expansionSql).toContain(
      'CREATE TABLE public.tournament_mutator_scheduler_retirement_receipts'
    );
    expect(finalSql).toContain('array_agg(j.jobid ORDER BY j.jobid)');
    const drain = taggedBody('drain_pre_tombstone_tournament_mutator_invocations');
    expect(drain).toContain('FROM public.tournament_mutator_scheduler_retirement_receipts r');
    expect(drain).toContain('LEFT JOIN cron.job_run_details d');
    expect(drain).toContain('FROM pg_stat_activity a');
    expect(drain).toContain('d.jobid=ANY(v_job_ids)');
    expect(drain).toContain('d.end_time IS NULL');
    expect(drain).not.toContain("d.status='running'");
    expect(drain).toContain('pg_stat_clear_snapshot()');
    const unschedule = taggedBody('unschedule_disabled_tournament_mutator_jobs');
    expect(unschedule).toContain('AND j.active');
    expect(unschedule).toContain('cron.unschedule(r.jobid)');
    expect(sql).not.toContain('LOCK TABLE cron.job');
    expect(expansionSql).toContain('cardinality(job_ids)=2');
    expect(expansionSql).toContain('jsonb_array_length(jobs)=2');
    for (const field of [
      'jobid',
      'jobname',
      'command',
      'schedule',
      'database',
      'username',
      'nodename',
      'nodeport',
      'active',
    ]) {
      expect(finalSql).toContain(`'${field}',j.${field}`);
    }
    expect(sql).toContain("'ca-eliminate-absent-players','ca-release-broke-seats'");
    expect(finalSql).toContain('$commit_retired_tournament_mutator_schedule_fence$;');
    expect(expansionMigration < finalMigration).toBe(true);
    expect(finalSql).not.toContain(
      'DROP FUNCTION public.fn_ca_eliminate_absent_tournament_players('
    );
    expect(finalSql).toContain('the owner-only felt-aware eliminator was lost');
    expect(finalSql).toContain('felt-aware eliminator is not owner-only');
    expect(finalSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_eliminate_absent_tournament_players\([\s\S]*?FROM PUBLIC,anon,authenticated,service_role;/
    );
    expect(sql).toContain('DROP FUNCTION public.fn_ca_absent_tournament_players(integer)');
    expect(sql).toContain('DROP FUNCTION public.fn_ca_release_broke_seats(');
    expect(sql).toContain('DROP TABLE public.ca_broke_seat_sightings RESTRICT');
    expect(sql).toContain(
      "DELETE FROM public.ca_detector_registry\n WHERE source='fn_ca_conservation_sweep:fn_ca_absent_tournament_players'"
    );
  });
});

describe('prize repricing has one service-only compare-and-set door', () => {
  const reprice = taggedBodyIn(repriceHotfixSql, 'reprice_unpaid_tournament_place');

  it('locks the terminal root and refuses every prepared or paid boundary', () => {
    const root = reprice.indexOf(
      'public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)'
    );
    const parent = reprice.indexOf('FROM public.tournaments t', root);
    const roster = reprice.indexOf('FROM public.tournament_players tp', parent);
    expect(root).toBeGreaterThan(-1);
    expect(parent).toBeGreaterThan(root);
    expect(roster).toBeGreaterThan(parent);
    expect(reprice).toContain("v_tournament_status<>'RUNNING'");
    expect(reprice).toContain('tournament_place_settlement_batches');
    expect(reprice).toContain('tournament_satellite_settlement_batches');
    expect(reprice).toContain('tournament_terminal_settlements');
    expect(reprice).toContain('tournament_cancellation_receipts');
    expect(reprice).toContain('tournament_obligations');
    expect(reprice).toContain('tournament_payouts');
    expect(reprice).not.toContain('o.amount_paid');
    expect(reprice).not.toContain('o.user_id=p_user_id');
    const payoutEvidence = reprice.slice(
      reprice.indexOf('FROM public.tournament_payouts p'),
      reprice.indexOf('THEN', reprice.indexOf('FROM public.tournament_payouts p'))
    );
    expect(payoutEvidence).not.toContain('p.user_id=p_user_id');
    expect(payoutEvidence).not.toContain('COALESCE(p.amount,0)<>0');
    expect(reprice).toContain('tp.prize IS NOT DISTINCT FROM p_expected_prize');
  });

  it('removes raw service writes and grants only the narrow RPC', () => {
    expect(sql).toContain(
      'REVOKE INSERT,UPDATE,DELETE ON TABLE public.tournament_players\n  FROM service_role;'
    );
    expect(repriceHotfixSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_reprice_unpaid_tournament_place\([\s\S]*?FROM PUBLIC,anon,authenticated;[\s\S]*?GRANT EXECUTE ON FUNCTION public\.fn_ca_reprice_unpaid_tournament_place\([\s\S]*?TO service_role;/
    );
    expect(finalSql).not.toContain('$reprice_unpaid_tournament_place$');
    expect(finalSql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_ca_reprice_unpaid_tournament_place/
    );
    expect(finalSql).toContain("md5(p.prosrc)='691a3f79a0a36e48f822832d98e12052'");
    expect(finalSql).toContain("'b9df97fa4e796726443bffd8d51da248'");
    expect(finalSql).toContain(
      "'7248ae3fe0700331c9ef45ea028acb7d320662617736ed83c714f684c3416830'"
    );
    expect(finalSql).toContain(
      "'3273dca6e3606a7ec94533255e7e090492a6d282d31939b947ee33ec2c5593c2'"
    );
    expect(sql).toContain(
      "has_table_privilege(\n       'service_role','public.tournament_players','UPDATE')"
    );
  });
});

describe('both irreversible phases stay inside the pinned maintenance freeze', () => {
  it('takes the shared freeze root after the terminal root and rechecks before commit', () => {
    const phaseB = finalSql;
    const terminalRoot = phaseB.indexOf(
      "hashtextextended('ca:tournament-terminal-settlement:v1',0)"
    );
    const freezeRoot = phaseB.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    expect(terminalRoot).toBeGreaterThan(-1);
    expect(freezeRoot).toBeGreaterThan(terminalRoot);
    expect(taggedBody('phase_a_freeze_still_held')).toContain(
      'fn_entry_purchases_frozen() IS NOT TRUE'
    );
    expect(taggedBody('phase_b_freeze_still_held')).toContain(
      'fn_entry_purchases_frozen() IS NOT TRUE'
    );
  });
});

describe('Spin expiry uses only fresh locked state and an exact cancellation receipt', () => {
  const expiry = taggedBody('expire_unfilled_from_exact_cancellation_receipt');

  it('rechecks every launch and funding boundary after the parent lock', () => {
    expect(expiry).toContain('FOR UPDATE SKIP LOCKED');
    expect(expiry).toContain('v_current.started_at IS NOT NULL');
    expect(expiry).toContain('v_current.live_seats>=v_current.max_players');
    expect(expiry).toContain('v_current.spin_multiplier IS NOT NULL');
    expect(expiry).toContain('v_current.has_booked_draw');
    expect(expiry).toContain("v_result->>'total_refunded'");
    expect(expiry).toContain("'skipped_raced'");
    expect(expiry).not.toContain('buy_in_amount');
  });
});
