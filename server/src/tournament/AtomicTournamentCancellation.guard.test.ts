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
    '../../../supabase/migrations/20260908034440_tournament_cancellation_commits_one_stored_receipt.sql'
  ),
  'utf8'
);
const RECOVERY = readFileSync(resolve(__dirname, './tournamentRecovery.ts'), 'utf8');

function executable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');
}

describe('tournament cancellation has one replayable database owner', () => {
  it('persists an append-only receipt keyed by tournament', () => {
    expect(MIGRATION).toMatch(/CREATE TABLE public\.tournament_cancellation_receipts/);
    expect(MIGRATION).toMatch(/tournament_id\s+uuid\s+PRIMARY KEY/);
    expect(MIGRATION).toMatch(/tournament_cancellation_receipts_append_only/);
    expect(MIGRATION).toMatch(/BEFORE UPDATE OR DELETE/);
  });

  it('locks first and returns the stored receipt on replay', () => {
    const wholeSql = executable(MIGRATION);
    const sql = wholeSql.slice(
      wholeSql.indexOf('CREATE OR REPLACE FUNCTION public.atomic_cancel_tournament')
    );
    const lockAt = sql.indexOf('FOR UPDATE;');
    const replayAt = sql.indexOf('RETURN v_stored.receipt;');
    const moneyAt = sql.indexOf('fn_settle_tournament_obligation(');
    expect(lockAt).toBeGreaterThan(-1);
    expect(replayAt).toBeGreaterThan(lockAt);
    expect(moneyAt).toBeGreaterThan(replayAt);
  });

  it('replays only while every stored refund still has exact durable backing', () => {
    const sql = executable(MIGRATION);
    const replay = sql.slice(
      sql.indexOf('SELECT * INTO v_stored'),
      sql.indexOf('RETURN v_stored.receipt;')
    );
    expect(replay).toMatch(/jsonb_to_recordset/);
    expect(replay).toMatch(/tournament_obligations/);
    expect(replay).toMatch(/wallet_credit_idempotency/);
    expect(replay).toMatch(/wallet_transactions/);
    expect(replay).toMatch(/tournament_fee_refund/);
    expect(replay).toMatch(/spin_rake_refund/);
    expect(replay).toMatch(/original_rake_record_id/);
    expect(replay).toMatch(/v_stored\.fees_reversed/);
    expect(replay).toMatch(/refund_rows IS DISTINCT FROM/);
    expect(replay).toMatch(/contains orphan fee evidence/);
    expect(replay).toMatch(/amount_owed IS DISTINCT FROM line\.gross_paid/);
    expect(replay).toMatch(/amount_paid IS DISTINCT FROM line\.amount_refunded/);
    expect(replay).toMatch(/entry_payment\.gross/);
    expect(replay).toMatch(/'tournament_buyin','rebuy','addon'/);
  });

  it('derives refund totals from entry-payment evidence and requires every obligation paid', () => {
    const sql = executable(MIGRATION);
    expect(sql).toMatch(/wallet_transactions/);
    expect(sql).toMatch(/tournament_buyin','rebuy','addon/);
    expect(sql).toMatch(/fn_settle_tournament_obligation\(/);
    expect(sql).toMatch(/fully_settled/);
    expect(sql).toMatch(/amount_paid/);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*refund obligation/);
  });

  it('reverses fees and closes tournament, player, and table rows before storing proof', () => {
    const sql = executable(MIGRATION);
    const feeAt = sql.indexOf('INSERT INTO public.rake_records');
    const playersAt = sql.indexOf('UPDATE public.tournament_players');
    const tablesAt = sql.indexOf('UPDATE public.tables');
    const receiptAt = sql.indexOf('INSERT INTO public.tournament_cancellation_receipts');
    expect(feeAt).toBeGreaterThan(-1);
    expect(playersAt).toBeGreaterThan(feeAt);
    expect(tablesAt).toBeGreaterThan(playersAt);
    expect(receiptAt).toBeGreaterThan(tablesAt);
    expect(sql).toMatch(/UPDATE public\.tournaments[\s\S]*status\s*=\s*'CANCELLED'/);
  });

  it('fails closed when prior fee reversals exceed their positive fee evidence', () => {
    const sql = executable(MIGRATION);
    expect(sql).toMatch(/v_fee_net[\s\S]{0,160}< 0[\s\S]{0,220}invalid fee evidence/);
  });

  it('fails closed when the aggregate Spin fee row net would go negative', () => {
    const sql = executable(MIGRATION);
    expect(sql).toMatch(/invalid fee evidence for Spin fee row/);
    expect(sql.match(/invalid fee evidence for Spin fee row/g) ?? []).toHaveLength(1);
  });

  it('retains terminal-status, admin, satellite-seat, and aggregate Spin safeguards', () => {
    expect(MIGRATION).toMatch(/is_club_admin/);
    expect(MIGRATION).toMatch(/'COMPLETED','CANCELLED','CANCELED','COMPLETING'/);
    expect(MIGRATION).toMatch(/tp\.status IN \('registered', 'playing'\)/);
    expect(MIGRATION).toMatch(/COALESCE\(tp\.prize, 0\) <= 0/);
    expect(MIGRATION).toMatch(/is_satellite_qualifier/);
    expect(MIGRATION).toMatch(/source_satellite_id/);
    expect(MIGRATION).toMatch(/fn_spin_book_entry/);
    expect(MIGRATION).toMatch(/fn_spin_settle_game/);
  });

  it('leaves process-side survivor inspection read-only and issues one RPC', () => {
    const helper = executable(RECOVERY).slice(
      executable(RECOVERY).indexOf('export async function refundAndCloseCancelledTournament'),
      executable(RECOVERY).indexOf('export async function recoverStuckCompletingTournaments')
    );
    expect(helper).toMatch(/cancel_refund_open_rows_unreadable/);
    expect(helper).toMatch(/atomic_cancel_tournament/);
    expect(helper).not.toMatch(/settleTournamentObligation/);
    expect(helper).not.toMatch(/\.update\(/);
    expect(helper).not.toMatch(/\.insert\(/);
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
  });

  it('keeps the live legacy doors available during the database-first cutover', () => {
    const sql = executable(MIGRATION);
    expect(sql).not.toMatch(/DROP FUNCTION[\s\S]*atomic_cancel_tournament/i);
    expect(sql).not.toMatch(
      /REVOKE[\s\S]{0,160}fn_settle_tournament_obligation[\s\S]{0,160}service_role/i
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.atomic_cancel_tournament\(uuid,uuid\)\s+TO service_role;/
    );
  });
});
