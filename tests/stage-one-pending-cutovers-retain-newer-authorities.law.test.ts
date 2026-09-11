import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '..', 'supabase', 'migrations');
const read = (file: string): string => {
  if (file.endsWith('.sql')) return readFileSync(resolve(migrations, file), 'utf8');
  const matches = readdirSync(migrations).filter(
    (candidate) =>
      candidate.endsWith(`_${file}.sql`) || candidate.endsWith(`_${file}.sql.pending`)
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${file} migration, found ${matches.length}`);
  }
  return readFileSync(resolve(migrations, matches[0]), 'utf8');
};

const cancellation = read('20260909014444_tournament_cancellation_commits_one_stored_receipt.sql');
const spinActualStart = read(
  '20260909183657_seat_first_unregistration_uses_actual_start_truth.sql'
);
const rakeRetry = read(
  '20260909202824_tournament_rake_attribution_retries_inside_its_own_transaction.sql'
);
const stageBExpansion = read('stage_b_forward_authority_expansion');
const seatExit = read('stage_b_current_postimage_contraction');

function between(sql: string, start: string, end: string): string {
  const startAt = sql.indexOf(start);
  const endAt = sql.indexOf(end, startAt + start.length);
  expect(startAt, start).toBeGreaterThan(-1);
  expect(endAt, end).toBeGreaterThan(startAt);
  return sql.slice(startAt, endAt);
}

describe('pending stage-one cutovers retain newer installed authorities', () => {
  it('keeps cash close lock ordering while adding atomic tournament cancellation', () => {
    const close = between(
      cancellation,
      'CREATE OR REPLACE FUNCTION public.fn_close_managed_game(',
      'CREATE OR REPLACE FUNCTION public.fn_execute_managed_game_command('
    );
    const clusterLock = close.indexOf('FROM public.cash_games');
    const tableLock = close.indexOf('SELECT club_id, status, cluster_id, role');
    const terminalBranch = close.indexOf("ELSIF p_kind = 'tournament' THEN");

    expect(close).toContain('v_initial_cluster uuid;');
    expect(clusterLock).toBeGreaterThan(-1);
    expect(tableLock).toBeGreaterThan(clusterLock);
    expect(close).toContain('v_cluster IS DISTINCT FROM v_initial_cluster');
    expect(close).toContain('STALE_GAME_CONTEXT: table changed games while closing');
    expect(close).toContain('LIMIT 1;');
    expect(terminalBranch).toBeGreaterThan(tableLock);
    expect(close.slice(terminalBranch)).toContain(
      'v_cancel := public.atomic_cancel_tournament(p_game_id, v_uid)'
    );
    expect(close.slice(terminalBranch)).toContain(
      'managed tournament close did not return its exact atomic cancellation receipt'
    );
  });

  it('keeps both the seat-first Spin exception and exact cancellation unwind', () => {
    const contract = between(
      spinActualStart,
      'CREATE OR REPLACE FUNCTION public.fn_spin_tournament_contract_is_draw()',
      'REVOKE ALL ON FUNCTION public.fn_spin_tournament_contract_is_draw()'
    );

    expect(contract).toContain('public.tournament_spin_cancellation_unwinds');
    expect(contract).toMatch(/IF\s+v_count\s*=\s*0/);
    expect(contract).toContain("IN ('ANNOUNCED','REGISTERING')");
    expect(contract).toContain('OLD.started_at IS NULL');
    expect(contract).toContain('NEW.started_at IS NULL');
    expect(contract).toContain('public.tournament_launch_receipts');
    expect(contract).toContain("r.kind IN ('contribution','jackpot_draw')");
  });

  it('keeps bounded in-transaction rake retries inside the current scoped lane', () => {
    const rake = between(
      rakeRetry,
      'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(',
      'DO $$'
    );
    const tournamentLock = rake.indexOf('SELECT t.id, t.status, t.club_id');
    const attribution = rake.indexOf('LOOP');

    expect(tournamentLock).toBeGreaterThan(-1);
    expect(attribution).toBeGreaterThan(tournamentLock);
    expect(stageBExpansion).toContain(
      "('fn_settle_tournament_rake', 'fn_ca_lock_settlement_lane_global')"
    );
    expect(rake).toContain('WHEN deadlock_detected OR lock_not_available THEN');
    expect(rake).toContain('IF v_attempt >= 4 THEN');
    expect(rake).toContain('pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END)');
    expect(rake).toContain("'sqlstate', v_state, 'attempts', v_attempt");
    expect(rake).toContain("'attribution_attempts', v_attempts");
  });

  it('rechecks an expiry candidate after the parent lock without reviving a reconciler', () => {
    const expiry = between(
      seatExit,
      'CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled(',
      'REVOKE ALL ON FUNCTION public.fn_spin_expire_unfilled(integer)'
    );
    const terminalRoot = expiry.indexOf('public.fn_ca_lock_settlement_lane_global()');
    const parentLock = expiry.indexOf('FOR UPDATE SKIP LOCKED');
    const freshRead = expiry.indexOf('SELECT t.status,t.variant,t.started_at');
    const cancellationCall = expiry.indexOf('v_result:=public.atomic_cancel_tournament(g.id,NULL)');

    expect(terminalRoot).toBeGreaterThan(-1);
    expect(parentLock).toBeGreaterThan(terminalRoot);
    expect(freshRead).toBeGreaterThan(parentLock);
    expect(cancellationCall).toBeGreaterThan(freshRead);
    expect(expiry).toContain('v_current.live_seats>=v_current.max_players');
    expect(expiry).toContain('v_current.started_at IS NOT NULL');
    expect(expiry).toContain('v_current.spin_multiplier IS NOT NULL');
    expect(expiry).toContain('v_current.has_booked_draw');
    expect(expiry).toContain("'skipped_raced',v_skipped");
    expect(expiry).toContain("(v_result->>'success')::boolean");
    expect(expiry).toContain("(v_result->>'total_refunded')::numeric");
    expect(expiry).not.toContain('fn_sync_seat_first_player_count');
  });

  it('nests the M7 money-path authority inside the M13 seat authority', () => {
    const seatWrapper = between(
      seatExit,
      'CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament(',
      'REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid)'
    );

    expect(seatExit).toContain('RENAME TO fn_settle_satellite_tournament_pre_seat_guard');
    expect(seatWrapper).toContain('public.fn_settle_satellite_tournament_pre_seat_guard(');
    expect(seatExit).toContain(
      "('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure,"
    );
    expect(seatExit).toContain(
      "'public.fn_settle_satellite_tournament_pre_money_path_gate('"
    );
    expect(seatExit).toContain('satellite seat-exit core lost its global-lane money core');
  });
});
