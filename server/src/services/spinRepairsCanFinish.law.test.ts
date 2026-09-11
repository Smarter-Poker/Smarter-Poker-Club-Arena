/**
 * A root settlement authority makes the old Spin repair payer unnecessary.
 * The engine must not call it. During the rolling stage-one deployment the
 * old RPCs remain available to the old engine, while the new engine uses the
 * combined authority. Repairs for unrelated rake attribution remain bounded.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SPIN_TIERS } from '../config/spinSpec.js';

const gameServer = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');
const executableGameServer = gameServer
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const stageOne = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260909205412_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
  ),
  'utf8'
);
const paidJournalCloseout = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260909210018_complete_known_spin_journal_adoption_after_freeze.sql'
  ),
  'utf8'
);
const currentOverlayFixture = readFileSync(
  join(__dirname, '../../../scripts/dev/fixtures/spin-stage-one-current-overlay-pg17.sql'),
  'utf8'
);
describe('the Spin payout repair fleet has one stage-one replacement', () => {
  it('separates a new draw admission from immutable replay after chips move', () => {
    const entryAt = stageOne.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_spin_book_entry(p_tournament_id uuid)'
    );
    const entryEnd = stageOne.indexOf('$spin_entry$;', entryAt);
    const entry = stageOne.slice(entryAt, entryEnd);
    const authorityAt = stageOne.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle('
    );
    const authorityEnd = stageOne.indexOf('$spin_authority$;', authorityAt);
    const authority = stageOne.slice(authorityAt, authorityEnd);

    expect(entry).toContain('v_entry_existed boolean := false');
    expect(entry).toMatch(/IF \(NOT v_entry_existed AND \([\s\S]*?v_exact_seat_stacks <> 3/);
    expect(entry).toMatch(
      /OR v_roster_users <> 3 OR v_paid_users <> 3[\s\S]*?OR v_buyin_debits <> 3/
    );

    const drawRead = authority.indexOf("r.kind = 'jackpot_draw'");
    const strictAdmission = authority.indexOf('IF NOT v_draw_existed', drawRead);
    const bookEntry = authority.indexOf('v_book := public.fn_spin_book_entry', strictAdmission);
    const replayEvidence = authority.indexOf('IF v_draw_existed THEN', bookEntry);
    const replayEvidenceEnd = authority.indexOf('\n  END IF;\n\n  IF NOT EXISTS', replayEvidence);
    const drawBranch = authority.indexOf('IF v_booked_multiplier IS NULL THEN', replayEvidenceEnd);
    const drawBranchElse = authority.indexOf('\n  ELSE\n', drawBranch);
    const replayEnvelopeEnd = authority.indexOf('\n  END IF;\n\n  IF COALESCE', drawBranchElse);
    expect(drawRead).toBeGreaterThan(-1);
    expect(strictAdmission).toBeGreaterThan(drawRead);
    expect(bookEntry).toBeGreaterThan(strictAdmission);
    expect(replayEvidence).toBeGreaterThan(bookEntry);
    expect(replayEvidenceEnd).toBeGreaterThan(replayEvidence);
    expect(drawBranch).toBeGreaterThan(replayEvidenceEnd);
    expect(drawBranchElse).toBeGreaterThan(drawBranch);
    expect(replayEnvelopeEnd).toBeGreaterThan(drawBranchElse);
    expect(authority.slice(drawRead, strictAdmission)).not.toMatch(
      /v_exact_seat_stacks <> 3|v_exact_roster_stacks <> 3/
    );
    expect(authority.slice(replayEvidence, replayEvidenceEnd)).not.toMatch(
      /fn_spin_book_entry|fn_spin_settle_game/
    );
    expect(authority.slice(drawBranchElse, replayEnvelopeEnd)).not.toMatch(
      /fn_spin_book_entry|fn_spin_settle_game/
    );
    expect(authority.slice(drawBranchElse, replayEnvelopeEnd)).toContain(
      "'reason','already_settled'"
    );
    expect(authority).toContain('does not have exactly three immutable paid identities');
    expect(authority).toContain('tournament contract did not read back exactly');
    expect(authority).toContain('v_canonical_tiers constant jsonb');
    expect(authority).toContain('IF NOT v_draw_existed AND (');
    expect(authority).toContain('p_tiers IS DISTINCT FROM v_canonical_tiers');
    expect(authority).toContain('jsonb_array_elements(v_canonical_tiers)');
    expect(authority).not.toContain('jsonb_array_elements(p_tiers)');
    const canonicalLiteral = authority.match(
      /v_canonical_tiers constant jsonb := '(\[[\s\S]*?\])'::jsonb;/
    );
    expect(canonicalLiteral).not.toBeNull();
    expect(JSON.parse(canonicalLiteral![1])).toEqual(
      SPIN_TIERS.map(({ multiplier, freq, reserveThresholdX }) => ({
        multiplier,
        freq,
        reserveThresholdX,
      }))
    );
  });

  it('has no GameServer winner-backpay caller or timer', () => {
    expect(executableGameServer).not.toMatch(/fn_backpay_spin_unpaid_winners/);
    expect(executableGameServer).not.toMatch(/lastSpinBackpayAt/);
  });

  it('records the production cohort before either historical correction', () => {
    const marker = stageOne.indexOf('CREATE TABLE public.tournament_spin_settlement_cutover');

    expect(marker).toBeGreaterThan(-1);
    expect(stageOne).not.toContain('DO $adopt_paid_781cc0ee_journal$');
    expect(paidJournalCloseout).toContain('DO $adopt_paid_781cc0ee_journal$');
    expect(paidJournalCloseout).toContain("c.migration_version = '20260909014433'");
    expect(paidJournalCloseout).toContain('v_tid = ANY(c.audited_tournament_ids)');
    expect(paidJournalCloseout).toContain('IF v_journal_id IS NULL THEN');
    expect(paidJournalCloseout).toContain(
      'existing draw journal does not exactly match the adopted receipt'
    );
    expect(stageOne).toContain('transaction_timestamp()');
    expect(stageOne).toContain('production_requires_receipt boolean GENERATED ALWAYS AS');
    expect(stageOne).toContain('781cc0ee-6a1d-4e31-acaf-4e737661bba1');
    expect(stageOne).toContain('6d688095-c3c5-4d40-a5a0-952934667732');
    expect(stageOne).toMatch(
      /REVOKE ALL ON public\.tournament_spin_settlement_cutover[\s\S]*?service_role;/
    );
  });

  it('accepts the published 10.00 draw plus 1.40 overlay without moving money again', () => {
    const acceptanceAt = stageOne.indexOf('DO $accept_6d688095$');
    const acceptanceEnd = stageOne.indexOf('$accept_6d688095$;', acceptanceAt);
    const acceptance = stageOne.slice(acceptanceAt, acceptanceEnd);

    expect(acceptanceAt).toBeGreaterThan(-1);
    expect(acceptanceEnd).toBeGreaterThan(acceptanceAt);
    expect(acceptance).toContain('e.reserve_in = 10 AND e.overlay_in = 1.40');
    expect(acceptance).toContain('e.prize_out = 11.40');
    expect(acceptance).toContain('v_total_before <> 11.40 OR v_wallet_before <> 11.40');
    expect(acceptance).toContain("l.idempotency_key = 'spin-ladder-overlay:'");
    expect(acceptance).toContain('o.amount_paid = 2.00');
    expect(acceptance).toContain("v_alert constant uuid := '514fdb44-0433-4602-bb5e-4ddf4597b4b0'");
    expect(acceptance).not.toContain('UPDATE public.ca_drift_incidents');
    expect(acceptance).not.toContain('UPDATE public.union_wallets');
    expect(acceptance).not.toContain('fn_settle_tournament_obligation(');
    expect(acceptance).not.toContain('fn_ca_escrow_apply(');

    expect(currentOverlayFixture).toContain(
      "'spin-ladder-overlay:6d688095-c3c5-4d40-a5a0-952934667732'"
    );
    expect(currentOverlayFixture).toContain('3, 0.24, 1.40, 11.40, 0.24');
    expect(currentOverlayFixture).toContain("'bbcaaed4-92b3-4ad7-86ee-7770bb36751a', 2, 2");
  });

  it('consumes the globally strict auto-ledger without redefining it', () => {
    expect(stageOne).toContain("to_regprocedure('public.fn_ca_autoledger()') IS NULL");
    expect(stageOne).toContain('Do not replace fn_ca_autoledger here');
    expect(stageOne).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_autoledger\(\)/);
    expect(stageOne).not.toContain("v_strict := TG_TABLE_NAME = 'spin_bonus_pools'");
  });

  it('keeps the old engine doors available only for the rolling cutover', () => {
    for (const signature of [
      'public.fn_spin_draw_multiplier(',
      'public.fn_spin_settle_game(',
      'public.fn_spin_book_entry(uuid)',
    ]) {
      expect(stageOne).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION ${signature.replace(/[().]/g, '\\$&')}[\\s\\S]*?TO service_role`
        )
      );
    }
    expect(stageOne).toContain('ROLLING CUTOVER, STAGE 1');
    expect(stageOne).toContain('lower-level Spin RPC revocations');
    expect(stageOne).not.toMatch(/DROP FUNCTION IF EXISTS public\.fn_spin_sweep_unbooked/);
    expect(stageOne).not.toMatch(/DROP FUNCTION IF EXISTS public\.fn_backpay_spin_unpaid_winners/);
    expect(stageOne).toContain('cron.unschedule(v_job.jobid)');
    const creditorLock = stageOne.indexOf(
      "pg_advisory_xact_lock(hashtext('credit-stalled-seat-first-stacks'))"
    );
    const reschedulerProof = stageOne.indexOf(
      'a stored function can still recreate or call the stack repair',
      creditorLock
    );
    const unschedule = stageOne.indexOf('cron.unschedule(v_job.jobid)', reschedulerProof);
    expect(creditorLock).toBeGreaterThan(-1);
    expect(reschedulerProof).toBeGreaterThan(creditorLock);
    expect(unschedule).toBeGreaterThan(reschedulerProof);
    const retirementEnd = stageOne.indexOf('$retire_stack_repair$;', unschedule);
    const dropRepair = stageOne.indexOf(
      'DROP FUNCTION public.fn_credit_stalled_seat_first_stacks() RESTRICT',
      retirementEnd
    );
    expect(retirementEnd).toBeGreaterThan(unschedule);
    expect(dropRepair).toBeGreaterThan(retirementEnd);
    expect(stageOne.slice(0, dropRepair)).not.toMatch(/EXECUTE\s+'DROP FUNCTION/i);
  });

  it('uses one lock order and never retries a deadlock inside the money transaction', () => {
    const rootAt = stageOne.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_lock_tournament_seat_acquisition('
    );
    const rootEnd = stageOne.indexOf('$seat_acquisition_lock$;', rootAt);
    const root = stageOne.slice(rootAt, rootEnd);
    const authority = root.indexOf('ca:tournament-terminal-settlement:v1');
    const maintenance = root.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    const mission = root.indexOf('public.fn_lock_daily_mission_user(p_user_id)');
    const launch = root.indexOf('FROM public.tournament_launch_receipts r');
    const tournament = root.indexOf('FROM public.tournaments t', launch);

    const syncAt = stageOne.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count('
    );
    const syncEnd = stageOne.indexOf('$seat_count$;', syncAt);
    const sync = stageOne.slice(syncAt, syncEnd);

    expect(authority).toBeGreaterThan(-1);
    expect(maintenance).toBeGreaterThan(authority);
    expect(mission).toBeGreaterThan(maintenance);
    expect(launch).toBeGreaterThan(mission);
    expect(tournament).toBeGreaterThan(launch);
    expect(root).not.toMatch(/NOWAIT|deadlock_detected|lock_not_available|pg_sleep|v_attempt/i);
    expect(sync).not.toContain('ca:tournament-terminal-settlement:v1');
    expect(stageOne).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_sync_seat_first_player_count\(uuid\)[\s\S]*?service_role;/
    );
    expect(stageOne).toContain('TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY');
  });

  it('preserves observability and the unfilled-game refund lifecycle in stage one', () => {
    expect(gameServer).toContain('this.spinMetrics.start()');
    expect(gameServer).toContain('...this.spinMetrics.toPrometheus()');
    expect(executableGameServer).toContain("supabase.rpc('fn_spin_expire_unfilled'");
    expect(executableGameServer).toContain('`${exp.chips_refunded} chips returned');
    expect(executableGameServer).not.toContain('chips_refunded_estimate');
    expect(stageOne).not.toMatch(/DROP FUNCTION IF EXISTS public\.fn_spin_expire_unfilled/);
    expect(stageOne).not.toMatch(/DROP FUNCTION IF EXISTS public\.fn_ca_spin_cancel_returns_draw/);
  });

  it('reports a refused or partial expiry batch before any clean-success log', () => {
    const callAt = executableGameServer.indexOf("supabase.rpc('fn_spin_expire_unfilled'");
    const response = executableGameServer.slice(callAt, callAt + 1_800);
    const refusalAt = response.indexOf('exp?.ok === false || Number(exp?.failed) > 0');
    const failureReportAt = response.indexOf("'GameServer.spin_expire_unfilled_failed'", refusalAt);
    const successLogAt = response.indexOf('`[GameServer] Unfilled-spin expiry:', refusalAt);

    expect(callAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(-1);
    expect(failureReportAt).toBeGreaterThan(refusalAt);
    expect(successLogAt).toBeGreaterThan(failureReportAt);
    expect(response.slice(refusalAt, successLogAt)).toContain('else if');
  });
});

describe('terminal rake repair timers retire with the atomic receipt path', () => {
  it('does not drive either historical rake-attribution repair from GameServer', () => {
    for (const retired of [
      'fn_repair_tournament_rake_attribution',
      'fn_backpay_tournament_rake_attribution',
      'lastRakeAttributionRepairAt',
    ]) {
      expect(executableGameServer).not.toContain(retired);
    }
  });
});
