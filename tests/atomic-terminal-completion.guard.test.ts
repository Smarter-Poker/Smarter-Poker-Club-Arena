import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => resolve(__dirname, '..', path);
const migration = '20260908153329_non_satellite_terminal_settlement_commits_one_stored_receipt.sql';
const sql = readFileSync(root(`supabase/migrations/${migration}`), 'utf8');
const satelliteSql = readFileSync(
  root('supabase/migrations/20260908153207_satellite_settlement_has_one_atomic_authority.sql'),
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

const settle = taggedBody('complete_terminal');
const receipt = taggedBody('terminal_receipt');
const outcome = taggedBody('terminal_outcome');
const handHardening = taggedBody('harden_hand_stack_lock_order');
const rollingComponents = taggedBody('serialize_rolling_terminal_components');
const collectBounty = taggedBody('harden_collect_bounty_terminal_lock');
const mysteryEvidence = taggedBody('mystery_completion_evidence');
const terminalMarker = taggedBody('terminal_marker_transition');
const terminalStamp = taggedBody('stamp_terminal_evidence_markers');
const terminalEvidenceGuard = taggedBody('terminal_evidence_guard');
const terminalParentGuard = taggedBody('receipted_tournament_guard');

describe('non-satellite terminal completion is one database transaction', () => {
  it('calls exactly one selected cash authority and has no catch-and-continue', () => {
    expect(settle.match(/public\.fn_settle_tournament_places\(/g)).toHaveLength(1);
    expect(settle.match(/public\.fn_settle_tournament_final_table_deal\(/g)).toHaveLength(1);
    expect(settle).toContain("IF v_mode = 'places' THEN");
    expect(settle).toContain("v_mode NOT IN ('places','final_table_deal')");
    expect(settle).not.toMatch(/EXCEPTION\s+WHEN/i);
    expect(settle).toContain("upper(COALESCE(v_cash->>'status','')) <> 'COMPLETING'");
    expect(settle).toContain("COALESCE((v_cash->>'fully_settled')::boolean,false) IS NOT TRUE");
  });

  it('serializes wrapper, satellite and rolling component callers on one global lock', () => {
    const lock = 'ca:tournament-terminal-settlement:v1';
    expect(settle).toContain(lock);
    expect(settle.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      settle.indexOf('SELECT t.* INTO v_t FROM public.tournaments')
    );
    for (const signature of [
      'fn_settle_tournament_places(uuid,uuid)',
      'fn_settle_tournament_final_table_deal(uuid)',
      'fn_finalize_bounty_pool(uuid,uuid)',
      'fn_mystery_bounty_settle(uuid,uuid)',
      'fn_settle_tournament_rake(uuid,text)',
      'fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
    ]) {
      expect(rollingComponents).toContain(`public.${signature}`);
    }
    expect(rollingComponents).toContain(lock);
    expect(collectBounty).toContain(lock);
    expect(collectBounty).toMatch(
      /v_begin_replacement[\s\S]*?BEGIN\s+PERFORM pg_advisory_xact_lock\([\s\S]*?p_collector_user_id IS NULL/
    );
    expect(sql).toContain('rolling satellite award lost its target-before-source row-lock order');
    expect(sql).toContain("position('WHERE id = p_target_id' IN v_satellite_award_source) >");
  });

  it('settles mystery, bounty and rake before one completed receipt', () => {
    const mystery = settle.indexOf('public.fn_mystery_bounty_settle(');
    const bounty = settle.indexOf('public.fn_finalize_bounty_pool(');
    const rake = settle.indexOf('public.fn_settle_tournament_rake(');
    const completed = settle.indexOf("SET status = 'COMPLETED'");
    const stored = settle.indexOf('INSERT INTO public.tournament_terminal_settlements');

    expect(mystery).toBeGreaterThan(-1);
    expect(bounty).toBeGreaterThan(mystery);
    expect(rake).toBeGreaterThan(bounty);
    expect(completed).toBeGreaterThan(rake);
    expect(stored).toBeGreaterThan(completed);
    expect(settle).toContain('v_rake.attributed_at IS NULL');
    expect(settle).toContain('v_rake.attribution_error IS NOT NULL');
    expect(settle).toContain('v_rake.attributed_users < 1');
  });

  it('rejects satellites, ambiguous winners, residual debt and nonzero escrow', () => {
    expect(settle).toContain("lower(COALESCE(v_t.variant::text,'')) = 'satellite'");
    expect(settle).toContain("upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'");
    expect(settle).toContain('v_t.satellite_target_id IS NOT NULL');
    expect(settle).toContain('v_t.satellite_target IS NOT NULL');
    expect(settle).toContain('v_winner_count <> 1');
    expect(settle).toContain('v_bounty_total IS DISTINCT FROM v_t.bounty_pool');
    expect(settle).toContain('o.amount_paid IS DISTINCT FROM o.amount_owed');
    expect(settle).toContain("c.status NOT IN ('paid','void')");
    expect(settle).toContain("a.status NOT IN ('completed','void')");
    expect(settle).toContain('v_e.prize_balance IS DISTINCT FROM 0::numeric');
    expect(settle).toContain('v_e.bounty_balance IS DISTINCT FROM 0::numeric');
    expect(settle).toContain('v_e.fee_balance IS DISTINCT FROM 0::numeric');
    expect(settle).toContain('FROM public.tournament_guarantee_overlays g');
    expect(settle).toContain('ORDER BY g.tournament_id FOR UPDATE');
  });

  it('makes replay cross the immutable verifier before any payer', () => {
    const replay = settle.indexOf(
      'RETURN public.fn_ca_tournament_terminal_receipt(\n      p_tournament_id,p_observed_winner_id)'
    );
    const firstCash = Math.min(
      settle.indexOf('public.fn_settle_tournament_places('),
      settle.indexOf('public.fn_settle_tournament_final_table_deal(')
    );
    expect(replay).toBeGreaterThan(-1);
    expect(replay).toBeLessThan(firstCash);
    expect(settle.slice(0, replay)).not.toMatch(
      /fn_settle_tournament_places|fn_settle_tournament_final_table_deal|fn_mystery_bounty_settle|fn_finalize_bounty_pool|fn_settle_tournament_rake/
    );
    expect(settle.slice(0, replay)).toContain('h.settlement_mode = v_mode');
    expect(settle.slice(0, replay)).toContain('h.winner_id = p_observed_winner_id');
  });

  it('makes the hand writer the atomic final-stack and zero-seat boundary', () => {
    const playerLock = handHardening.indexOf('ORDER BY tp.user_id,tp.id');
    const tableLock = handHardening.indexOf('PERFORM 1 FROM public.tables tb');
    const seatLock = handHardening.indexOf('ORDER BY ts.id');
    const playerMirror = handHardening.indexOf('UPDATE public.tournament_players tp');
    const seatVacate = handHardening.indexOf('SET left_at = v_zero_stack_vacated_at');
    expect(playerLock).toBeGreaterThan(-1);
    expect(tableLock).toBeGreaterThan(playerLock);
    expect(seatLock).toBeGreaterThan(tableLock);
    expect(playerMirror).toBeGreaterThan(seatLock);
    expect(seatVacate).toBeGreaterThan(playerMirror);
    expect(handHardening).toContain("tp.status::text = 'playing'");
    expect(handHardening).toContain("md5(v_definition) <> '027f6ca632a9aca339efd1c896e7f6a6'");
    expect(sql).toContain('20260908045608 zero-delta departed-seat refinement');
    expect(handHardening).toContain('jsonb_array_elements(v_canonical)');
    expect(handHardening).not.toContain('jsonb_array_elements(p_stacks)');
    expect(handHardening).toContain("'request', v_request");
    expect(handHardening).toContain('target.value::numeric = 0');
    expect(handHardening).toContain("status = 'left'");
    expect(handHardening).toContain("'tournament_zero_stack_seat_count'");
    expect(handHardening).toContain("'tournament_zero_stack_seat_ids'");
    expect(handHardening).toContain("'tournament_zero_stack_user_ids'");
    expect(handHardening).toContain("'tournament_table_live_seat_count'");
  });

  it('proves rolling mystery credits as one exact legacy and obligation partition', () => {
    expect(mysteryEvidence).toContain("'mb:' || a.id::text || ':' || r.user_id::text");
    expect(mysteryEvidence).toContain("'mb-residual:' || p_tournament_id::text");
    expect(mysteryEvidence).toContain("':obl:' || o.id::text || ':%'");
    expect(mysteryEvidence).toContain('expected_start_cents');
    expect(mysteryEvidence).toContain('v_legacy_credit_cents + v_obligation_cents');
    expect(mysteryEvidence).toContain("THEN 'mixed'");
    expect(settle).toContain('public.fn_ca_mystery_bounty_completion_evidence(');
    expect(receipt).toContain('public.fn_ca_mystery_bounty_completion_evidence(');
    expect(receipt).toContain("v_h.mystery_receipt->'payment_evidence'");
  });
});

describe('the stored terminal receipt is immutable and exact', () => {
  it('stores the cash authority result and all terminal totals under closed checks', () => {
    expect(sql).toContain('CREATE TABLE public.tournament_terminal_settlements');
    expect(sql).toContain("CHECK (settlement_mode IN ('places','final_table_deal'))");
    expect(sql).toContain('CHECK (cash_payout_total = prize_pool)');
    expect(sql).toContain('CHECK (bounty_payout_total = bounty_pool)');
    expect(sql).toContain('receipt_version = 1');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON public.tournament_terminal_settlements');
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE public\.tournament_terminal_settlements[\s\S]*?service_role;/
    );
  });

  it('uses a STABLE owner-only verifier with no data-changing statement', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_ca_tournament_terminal_receipt[\s\S]*?LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER/
    );
    expect(receipt).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|CALL|PERFORM)\b/i);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_tournament_terminal_receipt\(uuid,uuid\)[\s\S]*?service_role;/
    );
  });

  it('re-proves durable cash, bounty, rake, escrow and lifecycle state', () => {
    for (const evidence of [
      'public.tournament_payouts',
      'public.wallet_credit_idempotency',
      'public.tournament_obligations',
      'public.wallet_transactions',
      'public.tournament_bounty_chests',
      'public.tournament_bounty_awards',
      'public.tournament_rake_settlements',
      'public.rake_records',
      'public.tournament_escrow',
    ]) {
      expect(receipt).toContain(evidence);
    }
    expect(receipt).toContain("upper(COALESCE(v_t.status::text, '')) <> 'COMPLETED'");
    expect(receipt).toContain('v_t.ended_at IS DISTINCT FROM v_h.completed_at');
    expect(receipt).toContain('v_r.attributed_at IS DISTINCT FROM v_h.rake_attributed_at');
    expect(receipt).toContain('v_r.attribution_error IS NOT NULL');
    expect(receipt).toContain('v_e.closed_at IS DISTINCT FROM v_h.escrow_closed_at');
    expect(receipt).toContain('v_e.close_note IS DISTINCT FROM v_h.escrow_close_note');
  });

  it('captures the cutover behind a write barrier and never classifies history by clock', () => {
    expect(sql).toContain('LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('preexisting_completed_ids         uuid[] NOT NULL');
    expect(sql).toContain('array_position(preexisting_completed_ids, NULL) IS NULL');
    expect(sql).toContain('clock_timestamp(), ARRAY(');
    expect(sql).not.toContain('preexisting_non_satellite_count');
  });

  it('freezes every receipt-owned evidence surface and retires the escrow close watcher', () => {
    for (const fn of [
      'fn_terminal_tournament_evidence_is_immutable',
      'fn_terminal_tournament_seat_is_immutable',
      'fn_receipted_tournament_is_immutable',
      'fn_terminal_bounty_recipient_is_immutable',
      'fn_terminal_wallet_transaction_is_immutable',
      'fn_terminal_credit_key_is_immutable',
      'fn_terminal_tournament_escrow_is_immutable',
      'fn_satellite_target_player_provenance_is_immutable',
      'fn_satellite_target_rake_is_immutable',
      'fn_satellite_transfer_ledger_is_immutable',
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${fn}()`);
    }
    expect(sql).toContain('DROP TRIGGER IF EXISTS zz_ca_escrow_close ON public.tournaments');
    expect(sql).toContain("g.tgname = 'zz_ca_escrow_close'");
    expect(sql).toContain("g.tgname = 'terminal_tournament_evidence_is_immutable'");
    expect(sql).toContain('NEW.id IS DISTINCT FROM OLD.id');
    expect(sql).toContain('UPDATE OF id,tournament_id,status,current_players');
  });

  it('uses row-owned terminal markers to close queued child and parent snapshot races', () => {
    expect(sql.match(/ADD COLUMN terminal_closed_at timestamptz;/g)).toHaveLength(13);
    expect(terminalMarker).toContain("p_new - 'terminal_closed_at'");
    expect(terminalMarker).toContain("p_old - 'terminal_closed_at'");
    expect(terminalMarker).toContain('isfinite(t.ended_at)');
    expect(terminalMarker).toContain('IS NOT DISTINCT FROM t.ended_at');

    for (const evidence of [
      'tournament_players',
      'tournament_obligations',
      'tournament_payouts',
      'tournament_rake_settlements',
      'rake_records',
      'tournament_bounty_chests',
      'tournament_bounty_awards',
      'tournament_guarantee_overlays',
      'table_seats',
      'wallet_transactions',
      'tournament_bounty_award_recipients',
      'tournament_escrow',
      'spin_reserve_ledger',
    ]) {
      expect(terminalStamp).toContain(`UPDATE public.${evidence}`);
    }
    expect(terminalStamp).toContain("kind NOT IN ('contribution','jackpot_draw')");
    expect(terminalStamp).toContain('terminal_closed_at IS DISTINCT FROM v_terminal_at');
    expect(terminalStamp).not.toMatch(/EXCEPTION\s+WHEN/i);

    const oldMarker = terminalEvidenceGuard.indexOf('v_old_marker IS NOT NULL');
    const parentLookup = terminalEvidenceGuard.indexOf("SELECT upper(COALESCE(t.status::text,''))");
    expect(oldMarker).toBeGreaterThan(-1);
    expect(parentLookup).toBeGreaterThan(oldMarker);
    expect(terminalEvidenceGuard).toContain('fn_ca_terminal_marker_transition_is_exact(');
    expect(terminalEvidenceGuard).toContain("AND (TG_OP = 'INSERT' OR v_receipted)");
    expect(terminalEvidenceGuard).toContain('FOR SHARE');
    expect(terminalEvidenceGuard).not.toContain('FOR KEY SHARE');
    expect(terminalParentGuard).toContain("upper(COALESCE(OLD.status::text,'')) IN");
    expect(terminalParentGuard).not.toContain('tournament_terminal_settlements');

    expect(receipt).toContain('mutable evidence lacks its exact terminal marker');
    expect(receipt).toContain('s.terminal_closed_at IS DISTINCT FROM v_h.completed_at');
    expect(sql).toContain("g.tgname='stamp_tournament_terminal_evidence_markers'");
    expect(sql).toContain('AND g.tgtype=21');
    expect(sql).toContain("AND g.tgtype=31 AND g.tgattr::text=''");
    expect(sql).toContain("g.tgenabled='O'");
    expect(sql).toContain("a.atttypid = 'timestamptz'::regtype");
    expect(sql).toContain('a.attacl IS NULL');
    expect(sql).toContain('aclexplode(');
    expect(sql).toContain('privilege.grantee<>p.proowner');
    expect(sql).toContain("'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)'");
    expect(sql).toContain("'public.fn_stamp_tournament_terminal_evidence_markers()'");
    expect(sql).toContain('g.tgattr::text=a.attnum::text');
    expect(sql).toContain("g.tgattr::text='') <> 15");
    expect(sql).toContain("('tables','tournament_table_terminal_close_is_irreversible'");
  });

  it('returns the explicit caller contract from only stored and verified evidence', () => {
    for (const key of [
      'ok',
      'fully_settled',
      'status',
      'tournament_id',
      'winner_id',
      'mode',
      'settlement_mode',
      'payouts',
      'deal_shares',
      'winner_amount',
      'bubble_protection',
      'cash',
      'mystery_bounty',
      'bounty',
      'closed_table_count',
      'source_seat_count',
      'released_seat_count',
      'table_closure',
      'rake',
      'escrow',
      'cash_payout_total',
      'bounty_payout_total',
      'receipt_version',
      'settled_at',
    ]) {
      expect(receipt).toContain(`'${key}'`);
    }
    expect(receipt).toContain("'attributed',true");
  });

  it('stores and re-proves exact table membership and seat closure', () => {
    expect(satelliteSql).toContain('ADD COLUMN terminal_closed_at timestamptz');
    expect(sql).toContain('closed_table_ids uuid[]');
    expect(sql).toContain('source_seat_ids uuid[]');
    expect(sql).toContain('released_seat_ids uuid[]');
    expect(sql).toContain('CHECK (released_seat_ids <@ source_seat_ids)');
    expect(receipt).toContain('public.tables tb');
    expect(receipt).toContain('public.table_seats s');
    expect(receipt).toContain('tb.terminal_closed_at IS DISTINCT FROM v_h.completed_at');
    expect(receipt).toContain("'closed_table_ids',to_jsonb(v_h.closed_table_ids)");
    expect(receipt).toContain("'source_seat_ids',to_jsonb(v_h.source_seat_ids)");
    expect(receipt).toContain("'released_seat_ids',to_jsonb(v_h.released_seat_ids)");
    expect(receipt).toContain('v_durable_seat_ids IS DISTINCT FROM v_h.source_seat_ids');
    expect(receipt).toContain('s.is_away IS DISTINCT FROM false');
    expect(receipt).toContain('s.sit_out_at IS NOT NULL');
    expect(receipt).toContain('s.scheduled_leave_hands IS NOT NULL');
  });

  it('resolves an ambiguous transport result only after the same serialized lock', () => {
    expect(outcome).toContain('ca:tournament-terminal-settlement:v1');
    expect(outcome.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      outcome.indexOf('SELECT t.* INTO v_t FROM public.tournaments')
    );
    expect(outcome).toContain("'terminal_committed',true");
    expect(outcome).toContain("'definitively_not_committed',true");
    expect(outcome).toContain('public.fn_ca_tournament_terminal_receipt(');
    expect(outcome).not.toMatch(/public\.fn_settle_/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_resolve_tournament_terminal_outcome\([\s\S]*?TO service_role;/
    );
  });

  it('exposes only the terminal wrapper to service role', () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_complete_tournament_terminal\(uuid,uuid,text\)\s+TO service_role;/
    );
    expect(sql).toContain("has_function_privilege('anon',");
    expect(sql).toContain("has_function_privilege('authenticated',");
    expect(sql).toContain("has_table_privilege('service_role',");
  });
});

describe('real database probes pin late rollback and hand-boundary replay', () => {
  const closureProbe = readFileSync(
    root('scripts/ci/probes/atomic-terminal-closure-rollback.sql'),
    'utf8'
  );
  const handProbe = readFileSync(
    root('scripts/ci/probes/atomic-tournament-hand-boundary.sql'),
    'utf8'
  );
  const mixedMysteryProbe = readFileSync(
    root('scripts/ci/probes/atomic-terminal-mixed-mystery-replay.sql'),
    'utf8'
  );
  const rollingLockProbe = readFileSync(
    root('scripts/ci/probes/atomic-terminal-rolling-lock-order.sql'),
    'utf8'
  );
  const satelliteOutcomeWaitProbe = readFileSync(
    root('scripts/ci/probes/atomic-satellite-outcome-serialization.sql'),
    'utf8'
  );
  const terminalMarkerRaceProbe = readFileSync(
    root('scripts/ci/probes/atomic-terminal-evidence-marker-race.sql'),
    'utf8'
  );

  it('covers a positive overlay, active mystery, nonzero rake and exact replay', () => {
    expect(closureProbe).toContain("'guaranteed_prize',40");
    expect(closureProbe).toContain("'mystery_bounty_stage','active'");
    expect(closureProbe).toContain('AUDIT_TEST_PASS: injected table closure failure');
    expect(closureProbe).toContain('v_first::text IS DISTINCT FROM v_replay::text');
    expect(closureProbe).toContain('g.amount=10');
    expect(closureProbe).toContain('e.overlay_in IS DISTINCT FROM 10::numeric');
    expect(closureProbe).toContain(
      'live table accepted a caller-supplied terminal marker through a forged closed update'
    );
    expect(closureProbe).toContain(
      'live tournament accepted a forged terminal-marker table or changed its original table'
    );
    expect(closureProbe).toContain(
      'live tournament player accepted a caller-supplied terminal marker'
    );
    expect(closureProbe).toContain(
      'terminal table current_players changed from exact zero to NULL'
    );
    expect(closureProbe).toContain('terminal table marker changed after successful completion');
    expect(closureProbe).toContain('terminal table identity changed after successful completion');
    expect(closureProbe).toContain(
      'terminal guarantee evidence changed after successful completion'
    );
    expect(closureProbe).toContain('x.terminal_closed_at IS DISTINCT FROM v_completed_at');
    expect(closureProbe).toContain(
      "(v_first->'rake'->>'amount')::numeric IS DISTINCT FROM 2::numeric"
    );
  });

  it('injects a zero-seat write failure then proves mirror, vacate and replay', () => {
    expect(handProbe).toContain('injected zero-stack seat vacate failure');
    expect(handProbe).toContain('v_after IS DISTINCT FROM v_before');
    expect(handProbe).toContain("'tournament_zero_stack_seat_count'");
    expect(handProbe).toContain("'tournament_zero_stack_seat_ids'");
    expect(handProbe).toContain("'tournament_zero_stack_user_ids'");
    expect(handProbe).toContain("(v_replay - 'replay') IS DISTINCT FROM v_result");
    expect(handProbe).toContain('AUDIT_TEST_PASS: the tournament hand authority');
  });

  it('covers mixed-era mystery replay and rolling direct-authority serialization', () => {
    expect(mixedMysteryProbe).toContain("'evidence_mode' IS DISTINCT FROM 'mixed'");
    expect(mixedMysteryProbe).toContain("'legacy_credit_cents')::bigint <> 500");
    expect(mixedMysteryProbe).toContain("'obligation_cents')::bigint <> 500");
    expect(mixedMysteryProbe).toContain('a missing mixed-era mystery credit key was accepted');
    expect(mixedMysteryProbe).toContain('v_first::text IS DISTINCT FROM v_replay::text');
    expect(rollingLockProbe).toContain('fn_settle_tournament_rake(');
    expect(rollingLockProbe).toContain('fn_collect_bounty(');
    expect(rollingLockProbe).toContain('fn_award_satellite_seat(');
    expect(rollingLockProbe).toContain('dblink_is_busy');
    expect(satelliteOutcomeWaitProbe).toContain('fn_resolve_satellite_settlement_outcome(');
    expect(satelliteOutcomeWaitProbe).toContain('ca:tournament-terminal-settlement:v1');
    expect(satelliteOutcomeWaitProbe).toContain('dblink_is_busy');
  });

  it('proves queued child update and delete see the committed tuple marker', () => {
    expect(terminalMarkerRaceProbe).toContain("a.wait_event='PgSleep'");
    expect(terminalMarkerRaceProbe).toContain("public.dblink_send_query('terminal_marker_update'");
    expect(terminalMarkerRaceProbe).toContain("public.dblink_send_query('terminal_marker_delete'");
    expect(terminalMarkerRaceProbe).toContain("public.dblink_is_busy('terminal_marker_update')");
    expect(terminalMarkerRaceProbe).toContain("public.dblink_is_busy('terminal_marker_delete')");
    expect(terminalMarkerRaceProbe).toContain("a.wait_event_type='Lock'");
    expect(terminalMarkerRaceProbe).toContain('v_blocked_waiters<>2');
    expect(terminalMarkerRaceProbe).toContain("IF v_state='55000'");
    expect(terminalMarkerRaceProbe).toContain('v_total<>2 OR v_marked<>2 OR v_pristine<>2');
    expect(terminalMarkerRaceProbe).toContain(
      'queued child UPDATE and DELETE both waited behind committed tuple markers'
    );
  });
});
