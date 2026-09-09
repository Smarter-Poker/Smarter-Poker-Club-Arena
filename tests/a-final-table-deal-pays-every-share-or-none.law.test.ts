/**
 * A FINAL-TABLE DEAL PAYS EVERY EARNED PLACE AND EVERY LIVE SHARE, OR NONE.
 *
 * A deal combines two liability classes: structure prizes already earned by
 * eliminated players and chip-proportional shares for the live players. This
 * law pins the single database transaction that owns both classes. A prize
 * cache is never payment evidence, unrelated payouts are never subtracted,
 * and no COMPLETED transition can escape without an immutable, fully paid,
 * escrow-backed batch.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod, sliceSqlStatement } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const migrationFiles = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('_a_final_table_deal_pays_every_share_or_none.sql'))
  .sort();
const migration = migrationFiles.at(-1);
const SQL = migration ? readFileSync(join(MIGRATIONS, migration), 'utf8') : '';
const executableSql = SQL.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const sqlStatement = (anchor: string): string =>
  executableSql ? sliceSqlStatement(executableSql, anchor) : '';
const currentCashMigration = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('_tournament_cash_settlement_has_one_atomic_authority.sql'))
  .sort()
  .at(-1);
const currentTerminalMigration = readdirSync(MIGRATIONS)
  .filter((name) =>
    name.endsWith('_non_satellite_terminal_settlement_commits_one_stored_receipt.sql')
  )
  .sort()
  .at(-1);
const CURRENT_CASH_SQL = currentCashMigration
  ? readFileSync(join(MIGRATIONS, currentCashMigration), 'utf8')
  : '';
const CURRENT_TERMINAL_SQL = currentTerminalMigration
  ? readFileSync(join(MIGRATIONS, currentTerminalMigration), 'utf8')
  : '';
const CURRENT_DEAL = CURRENT_CASH_SQL
  ? sliceSqlStatement(
      CURRENT_CASH_SQL,
      'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_final_table_deal('
    )
  : '';
const CURRENT_TERMINAL = CURRENT_TERMINAL_SQL
  ? sliceSqlStatement(
      CURRENT_TERMINAL_SQL,
      'CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal('
    )
  : '';

const TABLE = sqlStatement('CREATE TABLE IF NOT EXISTS public.tournament_final_table_deal_batches');
const CHECK = sqlStatement('CREATE OR REPLACE FUNCTION public.fn_check_atomic_final_table_deal(');
const SETTLE = sqlStatement('CREATE OR REPLACE FUNCTION public.fn_settle_final_table_deal_atomic(');
const FREEZE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_freeze_atomic_final_table_deal_obligation()'
);
const RESULT_FREEZE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_freeze_batched_tournament_result()'
);
const GUARD = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_atomic_final_table_deal_completion_guard()'
);
const STATUS_LOCK = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_lock_atomic_final_table_deal_status()'
);
const WRAPPER = sqlStatement('CREATE OR REPLACE FUNCTION public.fn_final_table_deal(');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const ENGINE = stripComments(
  readFileSync(join(ROOT, 'server/src/tournament/TournamentManagerEliminations.ts'), 'utf8')
);
const CHECK_DEAL = sliceMethod(ENGINE, 'checkFinalTableDeal(): Promise<boolean>');
const COMPLETE_DEAL = sliceMethod(ENGINE, 'private async completeFinalTableDealAtBoundary(');
const DEAL_TAIL = sliceMethod(ENGINE, 'private async settleFinalTableDeal(');

describe('a final-table deal pays every share or none', () => {
  it('ships as one transactional migration with an immutable exact-cent batch', () => {
    expect(migrationFiles).toHaveLength(1);
    expect(executableSql.trimStart()).toMatch(/^BEGIN;/);
    expect(executableSql.trimEnd()).toMatch(/COMMIT;$/);
    expect(TABLE).toMatch(/tournament_id\s+uuid PRIMARY KEY/);
    expect(TABLE).toMatch(/plan_fingerprint\s+text NOT NULL/);
    expect(TABLE).toMatch(/plan\s+jsonb NOT NULL/);
    expect(TABLE).toMatch(/prior_standings_fingerprint\s+text NOT NULL/);
    expect(TABLE).toMatch(/live_input_snapshot\s+jsonb NOT NULL/);
    expect(TABLE).toMatch(/live_input_fingerprint\s+text NOT NULL/);
    expect(TABLE).toMatch(/amount_owed\s+numeric\(15,2\) NOT NULL/);
    expect(TABLE).toMatch(/amount_moved\s+numeric\(15,2\) NOT NULL/);
    expect(TABLE).toMatch(/escrow_prize_before\s+numeric\(15,2\) NOT NULL/);
    expect(TABLE).toMatch(/escrow_prize_after\s+numeric\(15,2\)/);
    expect(TABLE).toMatch(/deal_table_id\s+uuid NOT NULL/);
    expect(TABLE).toMatch(/bubble_contract_required\s+boolean NOT NULL/);
    expect(TABLE).toMatch(/bubble_obligation_id\s+uuid/);
    expect(TABLE).toMatch(/bubble_user_id\s+uuid/);
    expect(TABLE).toMatch(/bubble_source\s+text/);
    expect(TABLE).toMatch(/bubble_amount_owed\s+numeric\(15,2\) NOT NULL/);
    expect(TABLE).toMatch(/bubble_amount_paid_before\s+numeric\(15,2\) NOT NULL/);
    expect(executableSql).toMatch(
      /REVOKE ALL ON public\.tournament_final_table_deal_batches FROM service_role[\s\S]*?GRANT SELECT ON public\.tournament_final_table_deal_batches TO service_role/
    );
    expect(executableSql).toMatch(
      /has_table_privilege\('service_role',[\s\S]*?'public\.tournament_final_table_deal_batches', 'TRUNCATE'\)/
    );
  });

  it('proves one physical final table with the exact live seat set under locks', () => {
    const tableLock = SETTLE.indexOf('FROM public.tables tb');
    const seatLock = SETTLE.indexOf('FROM public.table_seats ts', tableLock);
    const rosterLock = SETTLE.indexOf('FROM public.tournament_players tp', seatLock);
    const seatProof = SETTLE.indexOf('v_seated_active_tables <> 1', rosterLock);
    const firstWrite = SETTLE.indexOf('INSERT INTO public.tournament_obligations', seatProof);
    expect(tableLock).toBeGreaterThan(-1);
    expect(SETTLE.slice(tableLock, seatLock)).toMatch(/FOR UPDATE/);
    expect(SETTLE.slice(seatLock, rosterLock)).toMatch(
      /ts\.left_at IS NULL[\s\S]*?FOR UPDATE OF ts/
    );
    expect(seatProof).toBeGreaterThan(rosterLock);
    expect(firstWrite).toBeGreaterThan(seatProof);
    const proof = SETTLE.slice(rosterLock, firstWrite);
    expect(proof).toMatch(/tb\.status::text IN \('running', 'waiting'\)/);
    expect(proof).toMatch(/v_all_live_seats <> v_live_count/);
    expect(proof).toMatch(/v_active_live_seats <> v_live_count/);
    expect(proof).toMatch(/v_distinct_seat_users <> v_live_count/);
    expect(proof).toMatch(/v_matching_live_users <> v_live_count/);
    expect(proof).toContain("'reason', 'physical_final_table_seat_set_is_not_exact'");
    expect(SETTLE).toMatch(
      /v_plan_fingerprint := md5\(jsonb_build_object\([\s\S]*?'bubble_contract_required', v_bubble_required[\s\S]*?'bubble_obligation_id', v_bubble_obligation_id[\s\S]*?'deal_table_id', v_deal_table_id[\s\S]*?'live_input_fingerprint', v_live_input_fingerprint[\s\S]*?'plan', v_plan/
    );
    expect(CHECK).toMatch(
      /md5\(jsonb_build_object\([\s\S]*?'bubble_contract_required', v_batch\.bubble_contract_required[\s\S]*?'bubble_obligation_id', v_batch\.bubble_obligation_id[\s\S]*?'deal_table_id', v_batch\.deal_table_id[\s\S]*?'live_input_fingerprint', v_batch\.live_input_fingerprint[\s\S]*?'plan', v_batch\.plan\)::text\)/
    );
  });

  it('fingerprints bubble money as canonical cents instead of numeric display scale', () => {
    // PostgreSQL preserves numeric scale in jsonb: to_jsonb(0::numeric) is 0,
    // while a numeric(15,2) batch column reloads as 0.00. Hashing those raw
    // values made a valid no-bubble deal disagree with its own stored plan.
    expect(SETTLE).toMatch(
      /'bubble_amount_owed', round\(COALESCE\(v_bubble_owed, 0\) \* 100\)::bigint/
    );
    expect(SETTLE).toMatch(
      /'bubble_amount_paid_before', round\(COALESCE\(v_bubble_paid, 0\) \* 100\)::bigint/
    );
    expect(CHECK).toMatch(
      /'bubble_amount_owed',\s*round\(COALESCE\(v_batch\.bubble_amount_owed, 0\) \* 100\)::bigint/
    );
    expect(CHECK).toMatch(
      /'bubble_amount_paid_before',\s*round\(COALESCE\(v_batch\.bubble_amount_paid_before, 0\) \* 100\)::bigint/
    );
  });

  it('freezes the exact live chip, seat and deterministic tie-break inputs and re-derives every share', () => {
    const snapshot = SETTLE.indexOf('v_live_input_snapshot');
    const firstWrite = SETTLE.indexOf('INSERT INTO public.tournament_obligations', snapshot);
    expect(snapshot).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(snapshot);
    const preflight = SETTLE.slice(snapshot, firstWrite);
    expect(preflight).toMatch(/ts\.stack IS DISTINCT FROM tp\.chips/);
    expect(preflight).toMatch(/'player_id', tp\.id/);
    expect(preflight).toMatch(/'registered_at_utc', to_char\(/);
    expect(preflight).toMatch(/'rebuys', COALESCE\(tp\.rebuys, 0\)/);
    expect(preflight).toMatch(/'add_on', COALESCE\(tp\.add_on, false\)/);
    expect(preflight).toMatch(/'seat_id', ts\.id/);
    expect(preflight).toMatch(/'seat_stack', ts\.stack/);
    expect(preflight).toMatch(/v_live_input_fingerprint := md5\(v_live_input_snapshot::text\)/);
    expect(SETTLE).toMatch(
      /FROM jsonb_to_recordset\(v_live_input_snapshot\)[\s\S]*?ORDER BY s\.chips DESC, s\.registered_at_utc ASC, s\.user_id ASC/
    );
    expect(CHECK).toMatch(
      /md5\(v_batch\.live_input_snapshot::text\)[\s\S]*?v_batch\.live_input_fingerprint/
    );
    expect(CHECK).toMatch(
      /WITH input AS \([\s\S]*?jsonb_to_recordset\(v_batch\.live_input_snapshot\)[\s\S]*?v_snapshot_share_mismatches/
    );
    expect(RESULT_FREEZE).toMatch(
      /NEW\.chips[\s\S]*?NEW\.registered_at[\s\S]*?NEW\.rebuys[\s\S]*?NEW\.add_on[\s\S]*?IS DISTINCT FROM[\s\S]*?OLD\.chips[\s\S]*?OLD\.registered_at[\s\S]*?OLD\.rebuys[\s\S]*?OLD\.add_on/
    );
  });

  it('uses exact payout evidence, never the prize cache or unrelated payout classes', () => {
    const evidenceStart = SETTLE.indexOf('SELECT round(COALESCE(sum(p.amount), 0), 2)');
    const evidenceEnd = SETTLE.indexOf('v_prior_place_paid_cents :=', evidenceStart);
    const evidence = SETTLE.slice(evidenceStart, evidenceEnd);
    expect(evidenceStart).toBeGreaterThan(-1);
    expect(evidenceEnd).toBeGreaterThan(evidenceStart);
    expect(evidence).toMatch(/p\.position = r\.place AND p\.user_id = r\.user_id/);
    for (const source of [
      'structure',
      'reconcile',
      'hu_shortfall',
      'late_reg_adjustment',
      'clawback',
      'spin_backpay',
      'overlay_backpay',
    ]) {
      expect(evidence).toContain(`'${source}'`);
    }
    expect(evidence).toMatch(/eo\.kind = 'place' AND eo\.place = r\.place/);
    expect(evidence).toMatch(/eo\.user_id = r\.user_id/);
    expect(evidence).toMatch(
      /p\.idempotency_key LIKE\s*'tourney:' \|\| p_tournament_id::text \|\| ':obl:' \|\|\s*eo\.id::text \|\| ':%'/
    );
    expect(evidence).not.toContain("':obl:%'");
    expect(evidence).not.toMatch(/tournament_players|\.prize\b|\bbounty\b|\brefund\b/);
    expect(SETTLE).not.toMatch(/sum\([^)]*\.prize[^)]*\)\s*\+\s*sum\([^)]*\.amount/i);
    expect(SETTLE).toContain("'reason', 'earned_place_evidence_conflicts_with_plan'");
    expect(SETTLE).toContain("'reason', 'paid_place_evidence_is_outside_deal_plan'");
    expect(SETTLE).toMatch(
      /round\(COALESCE\(tp\.prize, 0\) \* 100\)::bigint > 0[\s\S]*?x\.place = tp\.position AND x\.user_id = tp\.user_id[\s\S]*?<= x\.cents/
    );
    expect(SETTLE).toContain("'reason', 'recorded_positive_prize_conflicts_with_deal_plan'");
  });

  it('allocates eliminated entitlements plus all live shares to exactly the pool', () => {
    expect(SETTLE).toMatch(
      /IF r\.place > v_live_count THEN[\s\S]*?'kind', 'place'[\s\S]*?v_place_total_cents/
    );
    expect(SETTLE).toMatch(/floor\(r\.chips \/ v_total_chips \* v_available_cents\)::bigint/);
    expect(SETTLE).toMatch(/CASE WHEN r\.user_id = v_leader THEN v_remainder_cents ELSE 0 END/);
    expect(SETTLE).toMatch(
      /IF v_place_total_cents \+ v_deal_total_cents <> v_pool_cents THEN[\s\S]*?'deal_plan_does_not_allocate_pool'/
    );
    expect(CHECK).toMatch(
      /v_place_cents \+ v_deal_cents <> round\(v_batch\.amount_owed \* 100\)::bigint/
    );
    expect(CHECK).toMatch(
      /round\(v_batch\.amount_owed \* 100\)::bigint <> round\(v_t\.prize_pool \* 100\)::bigint/
    );
    expect(CHECK).toMatch(
      /leader\.kind = 'final_table_deal' AND leader\.rank = 1[\s\S]*?leader\.user_id = v_batch\.chip_leader/
    );
    expect(CHECK).toMatch(
      /x\.kind = 'final_table_deal'[\s\S]*?tp\.position IS DISTINCT FROM x\.rank[\s\S]*?x\.rank = 1 THEN 'winner' ELSE 'eliminated'/
    );
    expect(CHECK).toMatch(/v_standing_mismatches > 0/);
  });

  it('binds the prior eliminated suffix to exact bust-time and id chronology', () => {
    const rosterLock = SETTLE.indexOf('FROM public.tournament_players tp');
    const chronology = SETTLE.indexOf('WITH prior AS (', rosterLock);
    const firstWrite = SETTLE.indexOf('INSERT INTO public.tournament_obligations', chronology);
    expect(chronology).toBeGreaterThan(rosterLock);
    expect(firstWrite).toBeGreaterThan(chronology);
    const preflight = SETTLE.slice(chronology, firstWrite);
    expect(preflight).toMatch(/tp\.status = 'eliminated'/);
    expect(preflight).toMatch(/tp\.eliminated_at IS NULL/);
    expect(preflight).toMatch(
      /v_field_count - \(row_number\(\) OVER \(\s*ORDER BY tp\.eliminated_at ASC, tp\.id ASC/
    );
    expect(preflight).toMatch(/p\.position IS DISTINCT FROM p\.canonical_position/);
    expect(preflight).toContain("'reason', 'prior_eliminated_standings_are_not_canonical'");
    expect(preflight).toMatch(/v_prior_standings_fingerprint/);

    expect(CHECK).toMatch(/tp\.position > v_batch\.live_count/);
    expect(CHECK).toMatch(/p\.eliminated_at IS NULL/);
    expect(CHECK).toMatch(
      /x\.rank = 1 AND tp\.eliminated_at IS NOT NULL[\s\S]*?x\.rank > 1 AND tp\.eliminated_at IS NULL/
    );
    expect(CHECK).toMatch(/v_missing_bust_time > 0/);
    expect(CHECK).toMatch(
      /v_batch\.field_count - \(row_number\(\) OVER \(\s*ORDER BY tp\.eliminated_at ASC, tp\.id ASC/
    );
    expect(CHECK).toMatch(/v_prior_canonical_mismatches > 0/);
    expect(CHECK).toMatch(
      /v_prior_standings_fingerprint IS DISTINCT FROM\s*v_batch\.prior_standings_fingerprint/
    );
    for (const fn of [SETTLE, CHECK]) {
      expect(fn).toMatch(/'eliminated_at_utc', to_char\(\s*p\.eliminated_at AT TIME ZONE 'UTC'/);
      expect(fn).toMatch(/ORDER BY p\.position, p\.id/);
    }
    expect(SETTLE).toMatch(
      /'prior_standings_fingerprint', v_prior_standings_fingerprint[\s\S]*?'plan', v_plan/
    );
    expect(CHECK).toMatch(
      /'prior_standings_fingerprint',[\s\S]*?v_batch\.prior_standings_fingerprint[\s\S]*?'plan', v_batch\.plan/
    );
  });

  it('proves the finalized guarantee and locks enough enforced escrow before writing', () => {
    expect(SETTLE).toMatch(
      /IF NOT v_t\.prize_pool_finalized[\s\S]*?v_t\.prize_pool \+ 0\.005 < v_t\.guaranteed_prize[\s\S]*?'prize_pool_is_not_funded_and_finalized'/
    );
    const escrowLock = SETTLE.indexOf('SELECT * INTO v_escrow');
    const innerWrite = SETTLE.indexOf('INSERT INTO public.tournament_obligations', escrowLock);
    expect(escrowLock).toBeGreaterThan(-1);
    expect(SETTLE.slice(escrowLock, innerWrite)).toMatch(
      /FROM public\.tournament_escrow[\s\S]*?FOR UPDATE/
    );
    expect(SETTLE.slice(escrowLock, innerWrite)).toMatch(/NOT v_escrow\.enforced/);
    expect(SETTLE.slice(escrowLock, innerWrite)).toMatch(
      /v_escrow\.prize_balance \* 100\)::bigint < v_total_unpaid_cents/
    );
    expect(SETTLE).toMatch(/v_unpaid_cents := v_pool_cents - v_prior_place_paid_cents/);
    expect(SETTLE).toMatch(/v_total_unpaid_cents := v_unpaid_cents \+ v_bubble_unpaid_cents/);
    expect(CHECK).toMatch(
      /v_batch\.escrow_prize_before - v_batch\.amount_moved[\s\S]*?- v_batch\.escrow_prize_after/
    );
    expect(CHECK).toMatch(/round\(v_escrow\.prize_balance, 2\)[\s\S]*?v_batch\.escrow_prize_after/);
  });

  it('rolls back every refused or partial child leg and verifies cash before COMPLETED', () => {
    const child = SETTLE.indexOf(
      'v_result := public.fn_settle_tournament_obligation_before_atomic_batch_gate('
    );
    const innerBegin = SETTLE.lastIndexOf('\n  BEGIN', child);
    const refused = SETTLE.indexOf("v_result->>'ok'", child);
    const postRead = SETTLE.indexOf('SELECT o.amount_paid INTO v_after_paid', refused);
    const exactLeg = SETTLE.indexOf('abs(round(v_after_paid, 2) - r.cents / 100.0)', postRead);
    const exactTotal = SETTLE.indexOf('v_paid_this_call - v_total_unpaid_cents / 100.0', exactLeg);
    const escrowDelta = SETTLE.indexOf(
      'v_escrow.prize_balance - v_paid_this_call - v_escrow_after',
      exactTotal
    );
    const verify = SETTLE.indexOf('public.fn_check_atomic_final_table_deal', escrowDelta);
    const completed = SETTLE.indexOf("SET status = 'COMPLETED'", verify);
    const rollback = SETTLE.indexOf('EXCEPTION WHEN OTHERS', completed);
    expect(innerBegin).toBeGreaterThan(-1);
    expect(child).toBeGreaterThan(innerBegin);
    expect(refused).toBeGreaterThan(child);
    expect(postRead).toBeGreaterThan(refused);
    expect(exactLeg).toBeGreaterThan(postRead);
    expect(exactTotal).toBeGreaterThan(exactLeg);
    expect(escrowDelta).toBeGreaterThan(exactTotal);
    expect(verify).toBeGreaterThan(escrowDelta);
    expect(completed).toBeGreaterThan(verify);
    expect(rollback).toBeGreaterThan(completed);
    expect(SETTLE.slice(rollback)).toMatch(
      /'reason', 'atomic_deal_aborted'[\s\S]*?'paid', 0[\s\S]*?'completed', false/
    );
  });

  it('freezes the deal lines and installs the terminal guard dormant for rolling compatibility', () => {
    expect(executableSql).toMatch(
      /REVOKE ALL ON public\.tournament_obligations FROM service_role[\s\S]*?GRANT SELECT ON public\.tournament_obligations TO service_role/
    );
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(executableSql).toMatch(
        new RegExp(
          `has_table_privilege\\('service_role',[\\s\\S]*?'public\\.tournament_obligations', '${privilege}'\\)`
        )
      );
    }
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzzz_freeze_atomic_final_table_deal_obligation\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.tournament_obligations/
    );
    expect(FREEZE).toMatch(/OLD\.kind IN \('place', 'final_table_deal', 'bubble_protection'\)/);
    expect(FREEZE).toMatch(/NEW\.kind IN \('place', 'final_table_deal', 'bubble_protection'\)/);
    expect(FREEZE).toMatch(
      /current_setting\('app\.atomic_final_table_deal_batch', true\)[\s\S]*?v_gate <> OLD\.tournament_id::text/
    );
    expect(RESULT_FREEZE).toMatch(/tournament_place_settlement_batches/);
    expect(RESULT_FREEZE).toMatch(/tournament_final_table_deal_batches/);
    expect(RESULT_FREEZE).toMatch(
      /NEW\.eliminated_at[\s\S]*?IS DISTINCT FROM[\s\S]*?OLD\.eliminated_at/
    );
    expect(RESULT_FREEZE).toMatch(
      /NEW\.chips[\s\S]*?NEW\.registered_at[\s\S]*?NEW\.rebuys[\s\S]*?NEW\.add_on/
    );
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzz_freeze_batched_tournament_result\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.tournament_players/
    );
    expect(executableSql).toMatch(
      /position\('tournament_place_settlement_batches'[\s\S]*?position\('tournament_final_table_deal_batches'[\s\S]*?position\('NEW\.chips'[\s\S]*?position\('NEW\.registered_at'[\s\S]*?position\('NEW\.rebuys'[\s\S]*?position\('NEW\.add_on'[\s\S]*?atomic result freeze does not cover both terminal contracts and their deal inputs/
    );

    // Result stamping happens before the immutable deal batch appears. Once
    // the batch exists, the shared result trigger would (and must) reject the
    // same updates, so this ordering is part of the atomic contract.
    const child = SETTLE.indexOf(
      'v_result := public.fn_settle_tournament_obligation_before_atomic_batch_gate('
    );
    const resultStamp = SETTLE.lastIndexOf('UPDATE public.tournament_players', child);
    const batch = SETTLE.indexOf('INSERT INTO public.tournament_final_table_deal_batches');
    expect(resultStamp).toBeGreaterThan(-1);
    expect(batch).toBeGreaterThan(resultStamp);
    expect(child).toBeGreaterThan(batch);
    expect(SETTLE).not.toContain('public.fn_settle_tournament_obligation(');
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard[\s\S]*?BEFORE UPDATE OF status ON public\.tournaments/
    );
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard[\s\S]*?ALTER TABLE public\.tournaments\s+DISABLE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard/
    );
    expect(GUARD).toMatch(/o\.kind = 'final_table_deal'/);
    expect(GUARD).toMatch(/p\.source = 'final_table_deal'/);
    expect(GUARD).toMatch(/public\.fn_check_atomic_final_table_deal\(NEW\.id\)/);
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzzy_lock_atomic_final_table_deal_status[\s\S]*?BEFORE UPDATE OF status ON public\.tournaments[\s\S]*?WHEN \(NEW\.status IS DISTINCT FROM OLD\.status\)/
    );
    expect(STATUS_LOCK).toMatch(
      /tournament_final_table_deal_batches[\s\S]*?v_settled_at IS NULL[\s\S]*?OLD\.status IS DISTINCT FROM 'COMPLETING'[\s\S]*?NEW\.status IS DISTINCT FROM 'COMPLETED'[\s\S]*?app\.atomic_final_table_deal_batch/
    );
  });

  it('keeps replay idempotent and settles one exact Bubble promise in the same rollback boundary', () => {
    expect(SETTLE).toMatch(/lower\(COALESCE\(v_t\.variant, ''\)\) = 'satellite'/);
    expect(SETTLE).toMatch(
      /IF v_t\.status = 'COMPLETED' THEN[\s\S]*?fn_check_atomic_final_table_deal[\s\S]*?'paid', 0[\s\S]*?'already_completed', true/
    );
    for (const fn of [SETTLE, CHECK]) {
      expect(fn).toMatch(/o\.kind = 'bubble_protection'/);
      expect(fn).toMatch(/p\.source = 'bubble_protection'/);
      expect(fn).toMatch(/v_bubble_obligation_present[\s\S]*?v_bubble_payout_present/);
      expect(fn).toMatch(
        /v_bubble_required :=[\s\S]*?v_bubble_obligation_present OR v_bubble_payout_present/
      );
      expect(fn).toMatch(/v_bubble_paid[\s\S]*?v_bubble_evidence/);
    }
    expect(CHECK).toMatch(/v_batch\.bubble_contract_required IS DISTINCT FROM v_bubble_required/);
    expect(CHECK).toMatch(
      /COALESCE\(v_bubble_source, ''\) NOT IN \('engine\.eliminatePlayer', 'engine\.atomicFinalTableDeal'\)[\s\S]*?v_bubble_paid \+ 0\.005 < v_bubble_owed/
    );
    expect(SETTLE).toMatch(
      /v_bubble_obligations = 0 AND NOT v_bubble_payout_present[\s\S]*?gen_random_uuid\(\)[\s\S]*?'engine\.atomicFinalTableDeal'[\s\S]*?v_bubble_needs_insert := true/
    );
    expect(SETTLE).toMatch(
      /v_structure_places \+ 1 <= v_live_count[\s\S]*?jsonb_to_recordset\(v_live_input_snapshot\)[\s\S]*?ranked\.rank = v_structure_places \+ 1[\s\S]*?ELSE[\s\S]*?tp\.position = v_structure_places \+ 1/
    );
    const innerBegin = SETTLE.indexOf('\n  BEGIN', SETTLE.indexOf('v_plan_fingerprint := md5'));
    const bubbleInsert = SETTLE.indexOf('IF v_bubble_needs_insert THEN', innerBegin);
    const batchInsert = SETTLE.indexOf(
      'INSERT INTO public.tournament_final_table_deal_batches',
      bubbleInsert
    );
    const bubbleChild = SETTLE.indexOf(
      "p_tournament_id, 'bubble_protection', NULL, v_bubble_user",
      batchInsert
    );
    const placeChild = SETTLE.indexOf('p_tournament_id, r.kind, r.place', bubbleChild);
    const rollback = SETTLE.indexOf('EXCEPTION WHEN OTHERS', placeChild);
    expect(innerBegin).toBeGreaterThan(-1);
    expect(bubbleInsert).toBeGreaterThan(innerBegin);
    expect(batchInsert).toBeGreaterThan(bubbleInsert);
    expect(bubbleChild).toBeGreaterThan(batchInsert);
    expect(placeChild).toBeGreaterThan(bubbleChild);
    expect(rollback).toBeGreaterThan(placeChild);
    expect(SETTLE).toMatch(
      /v_bubble_row_found := FOUND[\s\S]*?Bubble Protection is not fully settled with exact payout evidence/
    );
    expect(SETTLE).toContain("'reason', 'bubble_protection_contract_shape_is_invalid'");
    expect(WRAPPER).toMatch(/SELECT public\.fn_settle_final_table_deal_atomic\(p_tournament_id\)/);
  });

  it('closes the physical table and proves every seat terminal inside the deal transaction', () => {
    const completed = SETTLE.indexOf("SET status = 'COMPLETED'");
    const tableClose = SETTLE.indexOf("SET status = 'closed', current_players = 0", completed);
    const liveSeatProof = SETTLE.indexOf('s.left_at IS NULL', tableClose);
    const rollback = SETTLE.indexOf('EXCEPTION WHEN OTHERS', liveSeatProof);
    expect(completed).toBeGreaterThan(-1);
    expect(tableClose).toBeGreaterThan(completed);
    expect(liveSeatProof).toBeGreaterThan(tableClose);
    expect(rollback).toBeGreaterThan(liveSeatProof);
    for (const trigger of [
      'trg_release_seats_on_tournament_finish',
      'trg_clear_seats_on_game_end',
      'trg_no_live_seat_on_finished_game',
    ]) {
      expect(executableSql).toMatch(new RegExp(`${trigger}[\\s\\S]*?tgenabled <> 'D'`));
    }
  });

  it('funds and commits through one terminal receipt, then runs an operational-only tail', () => {
    const fund = CURRENT_DEAL.indexOf('v_guarantee_result := public.fn_apply_prize_guarantee(');
    const fundedPool = CURRENT_DEAL.indexOf(
      'COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE',
      fund
    );
    const firstObligation = CURRENT_DEAL.indexOf(
      'INSERT INTO public.tournament_obligations',
      fundedPool
    );
    expect(fund).toBeGreaterThan(-1);
    expect(fundedPool).toBeGreaterThan(fund);
    expect(firstObligation).toBeGreaterThan(fundedPool);

    const terminalCall = COMPLETE_DEAL.indexOf('requestTournamentTerminalReceipt(');
    const receiptProof = COMPLETE_DEAL.indexOf(
      'receipt.dealShares.length === alive.length',
      terminalCall
    );
    const receiptStored = COMPLETE_DEAL.indexOf(
      'this.committedFinalTableDealReceipt = receipt',
      receiptProof
    );
    const tail = COMPLETE_DEAL.indexOf('this.settleFinalTableDeal(receipt)', receiptStored);
    expect(CHECK_DEAL).toContain('this.completeFinalTableDealAtBoundary(');
    expect(terminalCall).toBeGreaterThan(-1);
    expect(COMPLETE_DEAL.slice(terminalCall, receiptProof)).toContain("'final_table_deal'");
    expect(receiptProof).toBeGreaterThan(terminalCall);
    expect(receiptStored).toBeGreaterThan(receiptProof);
    expect(tail).toBeGreaterThan(receiptStored);

    const terminalDelegate = CURRENT_TERMINAL.indexOf(
      'v_cash := public.fn_settle_tournament_final_table_deal(p_tournament_id)'
    );
    const terminalProof = CURRENT_TERMINAL.indexOf(
      "COALESCE((v_cash->>'fully_settled')::boolean,false) IS NOT TRUE",
      terminalDelegate
    );
    const completed = CURRENT_TERMINAL.indexOf("SET status = 'COMPLETED'", terminalProof);
    const storedReceipt = CURRENT_TERMINAL.indexOf(
      'INSERT INTO public.tournament_terminal_settlements',
      completed
    );
    expect(terminalDelegate).toBeGreaterThan(-1);
    expect(terminalProof).toBeGreaterThan(terminalDelegate);
    expect(completed).toBeGreaterThan(terminalProof);
    expect(storedReceipt).toBeGreaterThan(completed);

    expect(DEAL_TAIL).not.toMatch(/fn_settle_tournament_obligation|fn_final_table_deal/);
    expect(DEAL_TAIL).not.toMatch(
      /fn_finalize_bounty_pool|reconcileMysteryBounty|settleTournamentRake/
    );
    expect(DEAL_TAIL).not.toMatch(/from\('tournaments'\)[\s\S]*?status:\s*'COMPLETED'/);
    expect(DEAL_TAIL).toMatch(/const payoutRows = \[\.\.\.receipt\.dealShares\]/);
    expect(DEAL_TAIL).toMatch(/chipLeader:\s*receipt\.winnerId/);
    expect(DEAL_TAIL).toMatch(/receipt\.tableClosure\.closedTableIds/);

    const claim = SETTLE.indexOf("SET status = 'COMPLETING'");
    const mystery = SETTLE.indexOf('public.fn_mystery_bounty_settle(', claim);
    const bounty = SETTLE.indexOf('public.fn_finalize_bounty_pool(', mystery);
    const rake = SETTLE.indexOf('public.fn_settle_tournament_rake(', bounty);
    const terminal = SETTLE.indexOf("SET status = 'COMPLETED'", rake);
    expect(claim).toBeGreaterThan(-1);
    expect(mystery).toBeGreaterThan(claim);
    expect(bounty).toBeGreaterThan(mystery);
    expect(rake).toBeGreaterThan(bounty);
    expect(terminal).toBeGreaterThan(rake);
  });
});
