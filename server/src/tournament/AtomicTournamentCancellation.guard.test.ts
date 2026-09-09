/**
 * Source guard for the database half of cancellation. Runtime receipt tests
 * cover hostile transport values; this pins the atomic ownership and replay
 * contract in the migration that creates it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260909014444_tournament_cancellation_commits_one_stored_receipt.sql'
  ),
  'utf8'
);
const LATEST_MANAGED_CLOSE = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260909192240_managed_close_preserves_cash_occupancy_and_atomic_tournament_cancellation.sql'
  ),
  'utf8'
);
const MANAGED_CANCELLATION_PROBE = readFileSync(
  resolve(__dirname, '../../../scripts/ci/probes/managed-tournament-cancellation-authority.sql'),
  'utf8'
);
function executable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');
}

const SQL = executable(MIGRATION);
const ATOMIC = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament'),
  SQL.indexOf(
    '$cancel$;',
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament')
  )
);
const REPLAY = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_tournament_cancellation_receipt'),
  SQL.indexOf(
    '$cancellation_receipt_v2$;',
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_tournament_cancellation_receipt')
  )
);
const MANAGED_CLOSE = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_close_managed_game'),
  SQL.indexOf(
    '$managed_close$;',
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_close_managed_game')
  )
);
const MANAGED_TOURNAMENT = MANAGED_CLOSE.slice(
  MANAGED_CLOSE.indexOf("ELSIF p_kind = 'tournament' THEN")
);
const LATEST_MANAGED_CLOSE_SQL = executable(LATEST_MANAGED_CLOSE);
const LATEST_MANAGED_CLOSE_BODY = LATEST_MANAGED_CLOSE_SQL.slice(
  LATEST_MANAGED_CLOSE_SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_close_managed_game'),
  LATEST_MANAGED_CLOSE_SQL.indexOf(
    '$managed_close$;',
    LATEST_MANAGED_CLOSE_SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_close_managed_game')
  )
);
const LATEST_CASH_CLOSE = cashTableBranch(
  LATEST_MANAGED_CLOSE_BODY,
  LATEST_MANAGED_CLOSE_BODY.indexOf('CREATE OR REPLACE FUNCTION public.fn_close_managed_game')
);
const LATEST_TOURNAMENT_CLOSE = LATEST_MANAGED_CLOSE_BODY.slice(
  LATEST_MANAGED_CLOSE_BODY.indexOf("ELSIF p_kind = 'tournament' THEN")
);
const MANAGED_GATEWAY = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_execute_managed_game_command'),
  SQL.indexOf(
    '$managed_command$;',
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_execute_managed_game_command')
  )
);
const MANAGED_SCHEDULE_RUNNER = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_run_due_managed_game_schedules'),
  SQL.indexOf(
    '$managed_schedule_runner$;',
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_run_due_managed_game_schedules')
  )
);

function cashTableBranch(source: string, functionStart: number): string {
  const start = source.indexOf("  IF p_kind = 'table' THEN", functionStart);
  const end = source.indexOf("  ELSIF p_kind = 'tournament' THEN", start);
  if (start < 0 || end < 0) throw new Error('managed close cash-table branch is absent');
  return source.slice(start, end);
}

describe('tournament cancellation has one replayable database owner', () => {
  it('persists one append-only receipt for chip and ticket dispositions', () => {
    expect(MIGRATION).toMatch(/CREATE TABLE public\.tournament_cancellation_receipts/);
    expect(MIGRATION).toMatch(/tournament_id\s+uuid\s+PRIMARY KEY/);
    expect(MIGRATION).toMatch(/refund_line_count integer NOT NULL/);
    expect(MIGRATION).toMatch(/ticket_return_count integer NOT NULL/);
    expect(MIGRATION).toMatch(/ticket_return_ids uuid\[\] NOT NULL/);
    expect(MIGRATION).toMatch(/total_ticket_returned numeric\(15,2\) NOT NULL/);
    expect(MIGRATION).toMatch(/tournament_cancellation_receipts_append_only/);
    expect(MIGRATION).toMatch(/BEFORE UPDATE OR DELETE/);
  });

  it('takes the global terminal lock before rows and verifies stored replay', () => {
    const globalAt = ATOMIC.indexOf('pg_advisory_xact_lock');
    const tournamentAt = ATOMIC.indexOf('FOR UPDATE;');
    const replayAt = ATOMIC.indexOf('fn_ca_tournament_cancellation_receipt');
    const chipAt = ATOMIC.indexOf('fn_settle_tournament_refund_exact');
    expect(globalAt).toBeGreaterThan(-1);
    expect(tournamentAt).toBeGreaterThan(globalAt);
    expect(replayAt).toBeGreaterThan(tournamentAt);
    expect(chipAt).toBeGreaterThan(replayAt);
  });

  it('replay verifies every immutable money and ticket identity', () => {
    expect(REPLAY).toMatch(/jsonb_to_recordset\(v_h\.receipt->'refunds'\)/);
    expect(REPLAY).toMatch(/jsonb_to_recordset\(v_h\.receipt->'ticket_returns'\)/);
    expect(REPLAY).toMatch(/tournament_refund_entitlements/);
    expect(REPLAY).toMatch(/tournament_refund_tranches/);
    expect(REPLAY).toMatch(/wallet_credit_idempotency/);
    expect(REPLAY).toMatch(/tournament_tickets/);
    expect(REPLAY).toMatch(/tournament_entry_only/);
    expect(REPLAY).toMatch(/source_satellite_id/);
    expect(REPLAY).toMatch(/chip_ledger/);
    expect(REPLAY).toMatch(/chip_transactions/);
    expect(REPLAY).toMatch(/tournament_spin_cancellation_unwinds/);
    expect(REPLAY).toMatch(/RETURN v_h\.receipt/);
  });

  it('returns wallet charges through only the nine-argument exact payer', () => {
    expect(ATOMIC).toMatch(/entitlement_kind='wallet_charge'/);
    expect(ATOMIC).toMatch(
      /fn_settle_tournament_refund_exact\(\s*p_tournament_id,v_player\.user_id,\s*v_entitlement\.refund_wallet_club_id,v_total_owed,\s*v_entitlement\.refund_prize,v_entitlement\.refund_bounty,\s*v_entitlement\.refund_fee,'atomic_cancel_tournament'/
    );
    expect(ATOMIC).toMatch(/fully_settled/);
    expect(ATOMIC).toMatch(/entitlement_id/);
    expect(ATOMIC).not.toMatch(/fn_settle_tournament_obligation\s*\(/);
  });

  it('returns both noncash entitlement kinds as entry-only tickets', () => {
    expect(ATOMIC).toMatch(
      /entitlement_kind IN \(\s*'satellite_seat','tournament_ticket'\)[\s\S]*?fn_ca_return_satellite_entitlement_as_ticket/
    );
    expect(ATOMIC).toMatch(/'entitlement_kind',v_entitlement\.entitlement_kind/);
    expect(ATOMIC).toMatch(/'source_satellite_id',v_entitlement\.source_satellite_id/);
    expect(REPLAY).toMatch(/e\.entitlement_kind NOT IN \('satellite_seat','tournament_ticket'\)/);
    expect(REPLAY).toMatch(/e\.entitlement_kind IS DISTINCT FROM line\.entitlement_kind/);
  });

  it('reverses fees and closes tournament, player, and table rows before storing proof', () => {
    const feeAt = ATOMIC.indexOf('INSERT INTO public.rake_records');
    const playersAt = ATOMIC.indexOf('UPDATE public.tournament_players');
    const tablesAt = ATOMIC.indexOf('UPDATE public.tables');
    const receiptAt = ATOMIC.indexOf('INSERT INTO public.tournament_cancellation_receipts');
    expect(feeAt).toBeGreaterThan(-1);
    expect(playersAt).toBeGreaterThan(feeAt);
    expect(tablesAt).toBeGreaterThan(playersAt);
    expect(receiptAt).toBeGreaterThan(tablesAt);
    expect(ATOMIC).toMatch(/UPDATE public\.tournaments[\s\S]*status='CANCELLED'/);
  });

  it('fails closed unless fee cache, evidence, and reversals close to zero', () => {
    expect(ATOMIC).toMatch(/total_rake[\s\S]*v_total_rake_before/);
    expect(ATOMIC).toMatch(/unreceipted cancellation rake evidence already exists/);
    expect(ATOMIC).toMatch(/v_total_rake_after IS DISTINCT FROM 0::numeric/);
    expect(ATOMIC).toMatch(/v_fees_reversed IS DISTINCT FROM v_total_rake_before/);
    expect(REPLAY).toMatch(/original_rake_record_ids/);
    expect(REPLAY).toMatch(/original_rake_record_id/);
  });

  it('uses the union-aware governed authority and retains terminal safeguards', () => {
    expect(ATOMIC).toMatch(/fn_can_create_games\(v_t\.club_id,v_uid\)/);
    expect(ATOMIC).not.toMatch(/is_club_admin\(v_t\.club_id,v_uid\)/);
    expect(ATOMIC).toMatch(/'COMPLETED','CANCELLED','CANCELED','COMPLETING'/);
    expect(ATOMIC).toMatch(/fn_ca_tournament_refund_plan/);
    expect(ATOMIC).toMatch(/source_satellite_id/);
    expect(ATOMIC).toMatch(/draw_reversal/);
    expect(ATOMIC).toMatch(/contribution_reversal/);
    expect(ATOMIC).toMatch(/tournament_spin_cancellation_unwinds/);
  });

  it('routes an empty managed tournament through cancellation receipt authority', () => {
    const globalAt = MANAGED_TOURNAMENT.indexOf('pg_advisory_xact_lock');
    const tournamentAt = MANAGED_TOURNAMENT.indexOf('FROM public.tournaments');
    expect(globalAt).toBeGreaterThan(-1);
    expect(tournamentAt).toBeGreaterThan(globalAt);
    expect(MANAGED_TOURNAMENT).toMatch(/fn_can_create_games\(v_club, v_uid\)/);
    expect(MANAGED_TOURNAMENT).toMatch(/FROM public\.tournament_players tp[\s\S]*FOR UPDATE/);
    expect(MANAGED_TOURNAMENT).toMatch(/'reason', 'players_registered'/);
    expect(MANAGED_TOURNAMENT).toMatch(
      /v_cancel := public\.atomic_cancel_tournament\(p_game_id, v_uid\)/
    );
    expect(MANAGED_TOURNAMENT).toMatch(
      /set_config\('app\.managed_game_lifecycle', 'on', true\)[\s\S]*atomic_cancel_tournament[\s\S]*set_config\('app\.managed_game_lifecycle', '', true\)/
    );
    expect(MANAGED_TOURNAMENT).toMatch(/v_cancel->>'fully_settled'/);
    expect(MANAGED_TOURNAMENT).toMatch(/RETURN jsonb_build_object\('ok', true\)/);
    expect(MANAGED_TOURNAMENT).not.toMatch(/UPDATE public\.tournaments/i);
  });

  it('preserves the latest cash-table close branch exactly', () => {
    const currentStart = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_close_managed_game');
    expect(cashTableBranch(SQL, currentStart)).toBe(LATEST_CASH_CLOSE);
  });

  it('keeps the later native cash-occupancy close contract in the final declaration', () => {
    expect(LATEST_CASH_CLOSE).toMatch(/v_initial_cluster/);
    expect(LATEST_CASH_CLOSE).toMatch(
      /FROM public\.cash_games[\s\S]*id = v_initial_cluster[\s\S]*FOR UPDATE/
    );
    expect(LATEST_CASH_CLOSE).toMatch(
      /v_cluster IS DISTINCT FROM v_initial_cluster[\s\S]*STALE_GAME_CONTEXT/
    );
    expect(LATEST_CASH_CLOSE).toMatch(
      /FROM public\.table_seats ts[\s\S]*ts\.left_at IS NULL[\s\S]*LIMIT 1/
    );
    expect(LATEST_CASH_CLOSE).toMatch(/UPDATE public\.cash_games[\s\S]*state = 'dormant'/);
  });

  it('keeps atomic tournament cancellation in the final managed-close declaration', () => {
    const terminalLock = LATEST_TOURNAMENT_CLOSE.indexOf('ca:tournament-terminal-settlement:v1');
    const tournamentLock = LATEST_TOURNAMENT_CLOSE.indexOf('FROM public.tournaments');
    const cancellation = LATEST_TOURNAMENT_CLOSE.indexOf(
      'v_cancel := public.atomic_cancel_tournament(p_game_id, v_uid)'
    );
    expect(terminalLock).toBeGreaterThan(-1);
    expect(tournamentLock).toBeGreaterThan(terminalLock);
    expect(cancellation).toBeGreaterThan(tournamentLock);
    expect(LATEST_TOURNAMENT_CLOSE).toMatch(/v_cancel->>'fully_settled'/);
    expect(LATEST_TOURNAMENT_CLOSE).not.toMatch(/UPDATE public\.tournaments/i);
    expect(LATEST_MANAGED_CLOSE_SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_close_managed_game\(text, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/
    );
    expect(LATEST_MANAGED_CLOSE_SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_close_managed_game\(text, uuid\)[\s\S]*TO service_role/
    );
  });

  it('refuses every managed-close baseline except the exact known before and after bodies', () => {
    expect(LATEST_MANAGED_CLOSE_SQL).toMatch(
      /md5\(v_definition\) NOT IN \(\s*'96be8943f1b86538d2b825c894d21f7a',\s*'0ad2e40801bb235892305071e9bc78cb'\s*\)/
    );
    expect(LATEST_MANAGED_CLOSE_SQL).not.toMatch(
      /md5\(v_definition\)[\s\S]*AND NOT \([\s\S]*position\(/
    );
    expect(LATEST_MANAGED_CLOSE_SQL).toMatch(
      /IF md5\(v_definition\) <> '0ad2e40801bb235892305071e9bc78cb'[\s\S]*managed close composition did not install exactly/
    );
  });

  it('takes the terminal lock in the public command path before its row lock', () => {
    const sessionAt = MANAGED_GATEWAY.indexOf('public.fn_caller_session_is_live()');
    const hashAt = MANAGED_GATEWAY.indexOf('public.fn_managed_game_command_hash(');
    const globalAt = MANAGED_GATEWAY.indexOf('ca:tournament-terminal-settlement:v1');
    const tournamentAt = MANAGED_GATEWAY.indexOf('FROM public.tournaments');
    expect(sessionAt).toBeGreaterThan(-1);
    expect(hashAt).toBeGreaterThan(sessionAt);
    expect(MANAGED_GATEWAY).toMatch(
      /p_kind = 'tournament' AND p_action = 'close'[\s\S]*pg_advisory_xact_lock/
    );
    expect(globalAt).toBeGreaterThan(-1);
    expect(tournamentAt).toBeGreaterThan(globalAt);
    expect(MANAGED_GATEWAY).toMatch(/fn_close_managed_game\(p_kind, p_game_id\)/);
  });

  it('rejects missing and revoked browser sessions before the managed command can write', () => {
    expect(MANAGED_CANCELLATION_PROBE).toContain('INSERT INTO auth.sessions');
    expect(MANAGED_CANCELLATION_PROBE).toContain("'session_id'");
    expect(MANAGED_CANCELLATION_PROBE).toContain('missing_session_refused');
    expect(MANAGED_CANCELLATION_PROBE).toContain('revoked_session_refused');
    expect(MANAGED_CANCELLATION_PROBE).toContain("EXCEPTION WHEN SQLSTATE '28000'");
    expect(MANAGED_CANCELLATION_PROBE).toContain(
      'FAIL missing or revoked session reached the managed cancellation gateway'
    );
    expect(MANAGED_CANCELLATION_PROBE).toContain(
      'FAIL live-session managed close did not commit one exact cancellation receipt'
    );
  });

  it('keeps durable scheduled closes on their service-role rail', () => {
    expect(MANAGED_SCHEDULE_RUNNER).toContain(
      "'request.jwt.claim.sub',v_schedule.actor_id::text,true"
    );
    expect(MANAGED_SCHEDULE_RUNNER).not.toContain('request.jwt.claim.role');
    expect(MANAGED_SCHEDULE_RUNNER).toContain('fn_execute_managed_game_command(');
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_run_due_managed_game_schedules\(integer\)\s+FROM PUBLIC, anon, authenticated;/
    );
    expect(MANAGED_CANCELLATION_PROBE).toContain('scheduled_service_role_success');
    expect(MANAGED_CANCELLATION_PROBE).toContain(
      'FAIL service-role scheduled close did not reach live-session-hardened gateway'
    );
  });

  it('freezes all receipt evidence and requires it at commit', () => {
    expect(SQL).toMatch(/cancelled_tournament_evidence_is_immutable/);
    expect(SQL).toMatch(/tournament_refund_entitlements','tournament_refund_tranches/);
    expect(SQL).toMatch(/cancelled_tournament_seat_is_immutable/);
    expect(SQL).toMatch(/cancelled_tournament_wallet_is_immutable/);
    expect(SQL).toMatch(/cancelled_tournament_parent_is_immutable/);
    expect(SQL).toMatch(/CREATE CONSTRAINT TRIGGER tournaments_cancel_must_refund/);
    expect(SQL).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
  });

  it('is one migration transaction and exposes only the service-role door', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.trim().endsWith('COMMIT;')).toBe(true);
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.atomic_cancel_tournament\(uuid,uuid\)\s+FROM PUBLIC, anon, authenticated;/
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.atomic_cancel_tournament\(uuid,uuid\)\s+TO service_role;/
    );
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_close_managed_game\(text,\s*uuid\)\s+FROM PUBLIC,\s*anon,\s*authenticated;/
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_close_managed_game\(text,\s*uuid\)\s+TO service_role;/
    );
  });

  it('contains one cancellation and one replay implementation without stubs', () => {
    expect(
      MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.atomic_cancel_tournament\(/g)
    ).toHaveLength(1);
    expect(
      MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.fn_ca_tournament_cancellation_receipt\(/g)
    ).toHaveLength(1);
    const forbiddenPlaceholder = new RegExp(['TO', 'DO|FIX', 'ME|stub'].join(''), 'i');
    expect(MIGRATION).not.toMatch(forbiddenPlaceholder);
  });
});
