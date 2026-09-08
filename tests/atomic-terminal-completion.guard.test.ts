import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => resolve(__dirname, '..', path);
const migration = '20260908045932_non_satellite_terminal_settlement_commits_one_stored_receipt.sql';
const sql = readFileSync(root(`supabase/migrations/${migration}`), 'utf8');

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
    ]) {
      expect(rollingComponents).toContain(`public.${signature}`);
    }
    expect(rollingComponents).toContain(lock);
    expect(collectBounty).toContain(lock);
    expect(collectBounty).toMatch(
      /v_begin_replacement[\s\S]*?BEGIN\s+PERFORM pg_advisory_xact_lock\([\s\S]*?p_collector_user_id IS NULL/
    );
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
    expect(sql).toContain('terminal_closed_at timestamptz');
    expect(sql).toContain('closed_table_ids uuid[]');
    expect(sql).toContain('released_seat_ids uuid[]');
    expect(receipt).toContain('public.tables tb');
    expect(receipt).toContain('public.table_seats s');
    expect(receipt).toContain('tb.terminal_closed_at IS DISTINCT FROM v_h.completed_at');
    expect(receipt).toContain("'closed_table_ids',to_jsonb(v_h.closed_table_ids)");
    expect(receipt).toContain("'released_seat_ids',to_jsonb(v_h.released_seat_ids)");
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

  it('covers a positive overlay, active mystery, nonzero rake and exact replay', () => {
    expect(closureProbe).toContain("'guaranteed_prize',40");
    expect(closureProbe).toContain("'mystery_bounty_stage','active'");
    expect(closureProbe).toContain('AUDIT_TEST_PASS: injected table closure failure');
    expect(closureProbe).toContain('v_first::text IS DISTINCT FROM v_replay::text');
    expect(closureProbe).toContain('g.amount=10');
    expect(closureProbe).toContain('e.overlay_in IS DISTINCT FROM 10::numeric');
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
    expect(rollingLockProbe).toContain('dblink_is_busy');
  });
});
