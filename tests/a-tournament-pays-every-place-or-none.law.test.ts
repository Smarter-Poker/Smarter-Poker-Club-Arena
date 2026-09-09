/**
 * A TOURNAMENT PAYS EVERY PLACE OR NONE.
 *
 * Normal place prizes used to cross one HTTP/database transaction per place,
 * followed by a separate COMPLETED write and a non-fatal reconciler. That
 * construction admitted both partially paid and zero-paid completed events.
 *
 * This law pins the replacement at its durable boundaries: a no-money prepare
 * commit, one immutable exact-cent plan, one settlement subtransaction, a
 * post-read after every child payment, and a database gate on COMPLETED. It
 * also pins the negative space: browser roles cannot enter the money door,
 * satellites and final-table deals keep their own contracts. During rolling
 * Stage A, old-engine database doors remain callable while every new-engine
 * caller already uses the atomic contract.
 *
 * Registry: docs/laws.d/a-tournament-pays-every-place-or-none.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod, sliceSqlStatement, sliceDollarQuoted } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const migrationFiles = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('_tournament_places_settle_and_complete_atomically.sql'))
  .sort();
const migration = migrationFiles.at(-1);
const SQL = migration ? readFileSync(join(MIGRATIONS, migration), 'utf8') : '';
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
const PLACE_AUTHORITY = CURRENT_CASH_SQL
  ? sliceSqlStatement(
      CURRENT_CASH_SQL,
      'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places('
    )
  : '';
const TERMINAL_AUTHORITY = CURRENT_TERMINAL_SQL
  ? sliceSqlStatement(
      CURRENT_TERMINAL_SQL,
      'CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal('
    )
  : '';

/** Comments describe the old failure in detail; they cannot satisfy a pin. */
const executableSql = SQL.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const sqlStatement = (anchor: string): string =>
  executableSql ? sliceSqlStatement(executableSql, anchor) : '';

const TABLE = sqlStatement('CREATE TABLE IF NOT EXISTS public.tournament_place_settlement_batches');
const PREPARE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.fn_prepare_tournament_place_obligations('
);
const NORMALIZE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.fn_normalize_tournament_final_standings('
);
const SETTLE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places_atomic('
);
const FREEZE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_freeze_batched_tournament_place('
);
const RESULT_FREEZE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_freeze_batched_tournament_result()'
);
const GUARD = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_tournament_atomic_place_completion_guard('
);
const STATUS_LOCK = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_lock_atomic_place_tournament_status()'
);
const GUARANTEE = sqlStatement('CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(');
const POOL_WINDOW_GUARD = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_tournament_pool_finalization_window_guard('
);
const CONTRACT_FREEZE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_freeze_registered_tournament_settlement_contract('
);
const FINALIZED_POOL_FREEZE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_freeze_finalized_tournament_prize_pool('
);
const REGISTRATION_GATE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.fn_register_for_tournament('
);
const REBUY_SEAT_CORE = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.process_tournament_rebuy_before_one_minute_addon('
);
const REBUY_GATE = sqlStatement('CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(');
const ROLLING_SINGLE_OBLIGATION = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation('
);
const COMPLETED_INSERT_GUARD = sqlStatement(
  'CREATE OR REPLACE FUNCTION public.trg_refuse_normal_tournament_completed_insert()'
);
const STAGE_A_ASSERT = sliceDollarQuoted(executableSql, '$assert$');

const stripTsComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const CLIENT = stripTsComments(
  readFileSync(join(ROOT, 'src/services/TournamentService.ts'), 'utf8')
);
const FINALIZER = sliceMethod(CLIENT, 'async finalizeTournament(tournamentId: string)');
const ENGINE = stripTsComments(
  readFileSync(join(ROOT, 'server/src/tournament/TournamentManagerEliminations.ts'), 'utf8')
);
const FINISH = sliceMethod(ENGINE, 'finishTournament(winnerId: string): Promise<void>');
const ELIMINATE = sliceMethod(
  ENGINE,
  `eliminatePlayer(
    userId: string,
    position: number,
    allowCompletingClaim = false
  ): Promise<boolean>`
);
const REPRICE = sliceMethod(
  ENGINE,
  'recalculateEliminatedPrizes(finalPrizePool: number): Promise<boolean>'
);
const ENGINE_BASE = stripTsComments(
  readFileSync(join(ROOT, 'server/src/tournament/TournamentManagerBase.ts'), 'utf8')
);
const FINALIZE_AFTER_ADD_ON = sliceMethod(ENGINE_BASE, 'finalizeAfterAddOn(): Promise<boolean>');
const OPEN_ADD_ON = sliceMethod(ENGINE_BASE, 'triggerAddOnPeriod(): Promise<void>');
const TABLE_PAGE = stripTsComments(readFileSync(join(ROOT, 'src/pages/TablePage.tsx'), 'utf8'));
const ADD_ON_PRESENTER = TABLE_PAGE.slice(
  TABLE_PAGE.indexOf('const presentAddOnOffer = async'),
  TABLE_PAGE.indexOf(
    "data?.type === 'TOURNAMENT_STARTING'",
    TABLE_PAGE.indexOf('const presentAddOnOffer = async')
  )
);
const ADD_ON_MODAL = stripTsComments(
  readFileSync(join(ROOT, 'src/components/table/AddOnModal.tsx'), 'utf8')
);
const RECOVERY = stripTsComments(
  readFileSync(join(ROOT, 'server/src/tournament/tournamentRecovery.ts'), 'utf8')
);
const RECOVER = sliceMethod(RECOVERY, 'export async function recoverStuckCompletingTournaments(');
const TERMINAL_CLIENT = stripTsComments(
  readFileSync(join(ROOT, 'server/src/tournament/terminalSettlementRpc.ts'), 'utf8')
);
const REQUEST_TERMINAL = sliceMethod(
  TERMINAL_CLIENT,
  'export async function requestTournamentTerminalReceipt('
);
const RECOGNIZED_PAYOUT_SOURCES = [
  'structure',
  'reconcile',
  'hu_shortfall',
  'late_reg_adjustment',
  'clawback',
  'spin_backpay',
  'overlay_backpay',
];

describe('a tournament pays every place or none', () => {
  it('has exactly one reserved Stage-A migration carrying the rolling contract', () => {
    expect(migrationFiles).toHaveLength(1);
    expect(migration).toBeTruthy();
    expect(executableSql.trimStart()).toMatch(/^BEGIN;/);
    expect(executableSql.trimEnd()).toMatch(/COMMIT;$/);
  });

  it('keeps the old single-obligation finish path valid only during Stage A', () => {
    expect(ROLLING_SINGLE_OBLIGATION).toMatch(
      /RETURN public\.fn_settle_tournament_obligation_before_atomic_batch_gate\(/
    );
    expect(ROLLING_SINGLE_OBLIGATION).not.toContain('atomic_batch_required');
    expect(ROLLING_SINGLE_OBLIGATION).not.toContain('FOR UPDATE');
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard[\s\S]*?ALTER TABLE public\.tournaments\s+DISABLE TRIGGER zzzz_tournaments_atomic_place_completion_guard/
    );
    expect(STAGE_A_ASSERT).toMatch(
      /tgname = 'zzzz_tournaments_atomic_place_completion_guard'[\s\S]*?tgenabled = 'D'/
    );
    expect(STAGE_A_ASSERT).toMatch(
      /position\('atomic_batch_required' IN v_single_obligation_source\) > 0/
    );
    expect(STAGE_A_ASSERT).toMatch(
      /fn_tournament_payout_reconcile\(uuid,boolean\)[\s\S]*?fn_pay_backed_payout_shortfalls\(boolean,integer\)[\s\S]*?fn_tournament_payout_sweep\(integer,boolean,integer\)[\s\S]*?fn_backpay_hu_winner_shortfalls\(integer\)[\s\S]*?Stage-A old-engine tournament payout RPC compatibility is incomplete/
    );
  });

  it('prepares one exact immutable batch after the complete obligation set', () => {
    expect(TABLE).toMatch(/tournament_id\s+uuid PRIMARY KEY/);
    expect(TABLE).toMatch(/plan_fingerprint\s+text NOT NULL/);
    expect(TABLE).toMatch(/place_count\s+integer NOT NULL/);
    expect(TABLE).toMatch(/amount_owed\s+numeric\(15,2\) NOT NULL/);
    expect(TABLE).toMatch(/bubble_contract_required\s+boolean NOT NULL/);
    expect(TABLE).toMatch(/bubble_obligation_id\s+uuid/);
    expect(TABLE).toMatch(/bubble_user_id\s+uuid/);
    expect(TABLE).toMatch(/bubble_source\s+text/);
    expect(TABLE).toMatch(/bubble_amount_owed\s+numeric\(15,2\) NOT NULL/);
    expect(TABLE).toMatch(/bubble_amount_paid_before\s+numeric\(15,2\) NOT NULL/);

    expect(PREPARE).toMatch(/v_plan_fingerprint\s*:=\s*md5\(v_plan::text\)/);
    expect(PREPARE).toMatch(/'place'.*r\.place.*'user_id'.*v_holder.*'cents'.*v_expected_cents/s);
    expect(PREPARE).toContain("'reason', 'prepared_plan_is_immutable'");

    const obligations = PREPARE.indexOf('INSERT INTO public.tournament_obligations');
    const exactSetProof = PREPARE.indexOf(
      'the written obligation set does not match its frozen plan'
    );
    const batch = PREPARE.indexOf('INSERT INTO public.tournament_place_settlement_batches');
    expect(obligations).toBeGreaterThan(-1);
    expect(exactSetProof).toBeGreaterThan(obligations);
    expect(batch).toBeGreaterThan(exactSetProof);

    const batchWrite = sliceSqlStatement(
      PREPARE,
      'INSERT INTO public.tournament_place_settlement_batches'
    );
    expect(batchWrite).not.toMatch(/ON CONFLICT|DO UPDATE/);
  });

  it('preparation moves no chips', () => {
    expect(PREPARE).not.toMatch(
      /\b(?:fn_settle_tournament_obligation|fn_credit_and_log|credit_player_wallet|debit_player_wallet)\s*\(/i
    );
    expect(PREPARE).not.toMatch(
      /\b(?:INSERT INTO|UPDATE)\s+public\.(?:wallets|wallet_transactions|chip_ledger|tournament_payouts|tournament_escrow)\b/i
    );
  });

  it('freezes every place and Bubble obligation mutation after the batch exists', () => {
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
      /CREATE TRIGGER zzzz_freeze_batched_tournament_place\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.tournament_obligations\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.trg_freeze_batched_tournament_place\(\)/
    );
    expect(FREEZE).toMatch(/TG_OP IN \('UPDATE', 'DELETE'\)[\s\S]*?OLD\.tournament_id/);
    expect(FREEZE).toMatch(/TG_OP IN \('INSERT', 'UPDATE'\)[\s\S]*?NEW\.tournament_id/);
    expect(FREEZE).toMatch(/OLD\.kind IN \('place', 'bubble_protection'\)/);
    expect(FREEZE).toMatch(/NEW\.kind IN \('place', 'bubble_protection'\)/);
    expect(FREEZE).toMatch(
      /b\.tournament_id = OLD\.tournament_id[\s\S]*?b\.tournament_id = NEW\.tournament_id/
    );
    expect(FREEZE).toMatch(
      /current_setting\('app\.atomic_tournament_place_batch', true\)[\s\S]*?v_gate <> OLD\.tournament_id::text/
    );
    expect(FREEZE).toMatch(/RAISE EXCEPTION[\s\S]*?tournament obligations for tournament/);
    expect(FREEZE).toMatch(
      /OLD\.kind = 'bubble_protection'[\s\S]*?NEW\.source IS DISTINCT FROM OLD\.source/
    );
    expect(SETTLE).toMatch(
      /PERFORM set_config\('app\.atomic_tournament_place_batch', p_tournament_id::text, true\)[\s\S]*?fn_settle_tournament_obligation_before_atomic_batch_gate\(/
    );
    expect(SETTLE.match(/set_config\('app\.atomic_tournament_place_batch'/g)).toHaveLength(3);
    expect(
      SETTLE.match(/set_config\('app\.atomic_tournament_place_batch', '', true\)/g)
    ).toHaveLength(2);
  });

  it('can replay after the deal migration without weakening either result freeze', () => {
    for (const wrapper of [
      'fn_settle_tournament_obligation',
      'fn_apply_prize_guarantee',
      'process_tournament_rebuy',
    ]) {
      expect(executableSql).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${wrapper}\\(`)
      );
    }

    expect(RESULT_FREEZE).toContain("to_regclass('public.tournament_final_table_deal_batches')");
    expect(RESULT_FREEZE).toMatch(
      /EXECUTE[\s\S]*?tournament_final_table_deal_batches[\s\S]*?tournament_id = \$1[\s\S]*?INTO v_old_final_table_deal_batched[\s\S]*?USING OLD\.tournament_id/
    );
    expect(RESULT_FREEZE).toMatch(
      /EXECUTE[\s\S]*?tournament_final_table_deal_batches[\s\S]*?tournament_id = \$1[\s\S]*?INTO v_new_final_table_deal_batched[\s\S]*?USING NEW\.tournament_id/
    );
    expect(RESULT_FREEZE).toMatch(
      /NEW\.chips[\s\S]*?NEW\.registered_at[\s\S]*?NEW\.rebuys[\s\S]*?NEW\.add_on[\s\S]*?IS DISTINCT FROM[\s\S]*?OLD\.chips[\s\S]*?OLD\.registered_at[\s\S]*?OLD\.rebuys[\s\S]*?OLD\.add_on/
    );
    expect(executableSql).toContain(
      'atomic result freeze is not replay-safe across place and final-table-deal batches'
    );
  });

  it('derives the exact Bubble promise only from the closed, finalized and normalized field', () => {
    expect(executableSql).not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION public\.trg_record_bubble_obligation_with_elimination|CREATE TRIGGER zzzz_record_bubble_obligation_with_elimination/
    );
    expect(executableSql).toMatch(
      /DROP TRIGGER IF EXISTS zzzz_record_bubble_obligation_with_elimination[\s\S]*?DROP FUNCTION IF EXISTS public\.trg_record_bubble_obligation_with_elimination\(\)/
    );

    const finalizedGate = PREPARE.indexOf('IF NOT v_t.prize_pool_finalized');
    const normalized = PREPARE.indexOf(
      'v_normalized := public.fn_normalize_tournament_final_standings(p_tournament_id)'
    );
    const finalHolder = PREPARE.indexOf('tp.position = v_expected_count + 1');
    const derive = PREPARE.indexOf('IF v_bubble_obligations = 0 AND NOT v_bubble_evidence_exists');
    const completedWithoutBatch = PREPARE.indexOf(
      "'reason', 'completed_event_has_no_exact_atomic_batch'",
      derive
    );
    const write = PREPARE.indexOf('IF v_bubble_needs_insert THEN', completedWithoutBatch);
    const batch = PREPARE.indexOf('INSERT INTO public.tournament_place_settlement_batches', write);

    expect(finalizedGate).toBeGreaterThan(-1);
    expect(normalized).toBeGreaterThan(finalizedGate);
    expect(finalHolder).toBeGreaterThan(normalized);
    expect(derive).toBeGreaterThan(finalHolder);
    expect(completedWithoutBatch).toBeGreaterThan(derive);
    expect(write).toBeGreaterThan(completedWithoutBatch);
    expect(batch).toBeGreaterThan(write);
    expect(PREPARE.slice(write, batch)).toMatch(
      /INSERT INTO public\.tournament_obligations[\s\S]*?v_bubble_obligation_id[\s\S]*?'bubble_protection'[\s\S]*?v_bubble_user[\s\S]*?v_bubble_owed, 0, v_bubble_source/
    );
    expect(PREPARE).toMatch(
      /v_bubble_source := 'engine\.atomicPlaceSettlement'[\s\S]*?v_bubble_owed := v_t\.buy_in_amount/
    );
    expect(PREPARE).not.toMatch(
      /fn_settle_tournament_obligation|fn_credit_and_log|INSERT INTO public\.tournament_payouts|UPDATE public\.harness_wallets/
    );
  });

  it('irreversibly freezes the pool, guarantee and structure inputs after finalization', () => {
    expect(FINALIZED_POOL_FREEZE).toMatch(
      /OLD\.prize_pool_finalized[\s\S]*?NEW\.payout_structure IS DISTINCT FROM OLD\.payout_structure[\s\S]*?NEW\.spin_multiplier IS DISTINCT FROM OLD\.spin_multiplier/
    );
    expect(FINALIZED_POOL_FREEZE).toMatch(
      /OLD\.prize_pool_finalized[\s\S]*?NOT COALESCE\(NEW\.prize_pool_finalized, false\)[\s\S]*?prize pool cannot be reopened/
    );
    expect(FINALIZED_POOL_FREEZE).toMatch(/NEW\.guaranteed_prize[\s\S]*?OLD\.guaranteed_prize/);
    expect(FINALIZED_POOL_FREEZE).not.toContain('app.atomic_guarantee_funding');
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool[\s\S]*?BEFORE UPDATE OF prize_pool, guaranteed_prize, prize_pool_finalized,[\s\S]*?payout_structure, spin_multiplier ON public\.tournaments/
    );
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool[\s\S]*?ALTER TABLE public\.tournaments\s+DISABLE TRIGGER zzzz_freeze_finalized_tournament_prize_pool/
    );
  });

  it('rejects recognized payout evidence for a wrong recipient or a place outside the plan', () => {
    const wrongRecipientScan = PREPARE.indexOf('SELECT count(*) INTO v_wrong_recipients');
    const wrongRecipientRefusal = PREPARE.indexOf(
      "'reason', 'legacy_place_paid_to_wrong_player'",
      wrongRecipientScan
    );
    expect(wrongRecipientScan).toBeGreaterThan(-1);
    expect(wrongRecipientRefusal).toBeGreaterThan(wrongRecipientScan);
    const wrongRecipientProof = PREPARE.slice(wrongRecipientScan, wrongRecipientRefusal);
    expect(wrongRecipientProof).toMatch(/tpo\.position = r\.place/);
    expect(wrongRecipientProof).toMatch(/tpo\.user_id IS DISTINCT FROM r\.user_id/);
    for (const source of RECOGNIZED_PAYOUT_SOURCES) {
      expect(wrongRecipientProof).toContain(`'${source}'`);
    }
    expect(wrongRecipientProof).toMatch(
      /fn_tournament_payout_key_is_place_evidence\(\s*tpo\.tournament_id, tpo\.idempotency_key\)/
    );
    expect(wrongRecipientProof).toMatch(
      /GROUP BY tpo\.user_id\s+HAVING abs\(round\(sum\(tpo\.amount\), 2\)\) > 0\.005/
    );

    const outsidePlanRefusal = PREPARE.indexOf("'reason', 'legacy_paid_place_is_outside_plan'");
    const outsidePlanScan = PREPARE.lastIndexOf(
      'SELECT count(*) INTO v_conflicts',
      outsidePlanRefusal
    );
    expect(outsidePlanScan).toBeGreaterThan(wrongRecipientRefusal);
    expect(outsidePlanRefusal).toBeGreaterThan(outsidePlanScan);
    const outsidePlanProof = PREPARE.slice(outsidePlanScan, outsidePlanRefusal);
    expect(outsidePlanProof).toMatch(/FROM public\.tournament_payouts tpo/);
    for (const source of RECOGNIZED_PAYOUT_SOURCES) {
      expect(outsidePlanProof).toContain(`'${source}'`);
    }
    expect(outsidePlanProof).toMatch(
      /fn_tournament_payout_key_is_place_evidence\(\s*tpo\.tournament_id, tpo\.idempotency_key\)/
    );
    expect(outsidePlanProof).toMatch(
      /NOT EXISTS \([\s\S]*?jsonb_array_elements\(v_plan\)[\s\S]*?\(p->>'place'\)::integer = tpo\.position/
    );
    expect(outsidePlanProof).toMatch(
      /GROUP BY tpo\.position, tpo\.user_id\s+HAVING abs\(round\(sum\(tpo\.amount\), 2\)\) > 0\.005/
    );
  });

  it('classifies generic obligation keys by their exact durable kind and refuses orphans', () => {
    expect(executableSql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_tournament_payout_key_is_place_evidence\([\s\S]*?o\.kind = 'place'[\s\S]*?'tourney:' \|\| p_tournament_id::text \|\| ':obl:' \|\| o\.id::text/
    );
    expect(NORMALIZE).toContain("'reason', 'unattributed_obligation_key_evidence'");
    expect(NORMALIZE).toMatch(
      /p\.idempotency_key LIKE\s*'tourney:' \|\| p_tournament_id::text \|\| ':obl:%'[\s\S]*?NOT EXISTS \([\s\S]*?public\.tournament_obligations/
    );
    expect(PREPARE).toMatch(/fn_normalize_tournament_final_standings\(p_tournament_id\)/);
  });

  it('rejects positive result prizes that are not represented by the exact place plan', () => {
    const resultRefusal = PREPARE.indexOf("'reason', 'recorded_prize_is_outside_structure'");
    const resultScan = PREPARE.lastIndexOf('SELECT count(*) INTO v_conflicts', resultRefusal);
    expect(resultScan).toBeGreaterThan(-1);
    expect(resultRefusal).toBeGreaterThan(resultScan);
    const resultProof = PREPARE.slice(resultScan, resultRefusal);
    expect(resultProof).toMatch(/FROM public\.tournament_players tp/);
    expect(resultProof).toMatch(/round\(COALESCE\(tp\.prize, 0\) \* 100\)::bigint > 0/);
    expect(resultProof).toMatch(
      /NOT EXISTS \([\s\S]*?jsonb_array_elements\(v_plan\)[\s\S]*?\(p->>'place'\)::integer = tp\.position/
    );

    for (const [fn, variable] of [
      [SETTLE, 'v_extra_prize_count'],
      [GUARD, 'v_extra_prizes'],
    ] as const) {
      const scan = fn.indexOf(`SELECT count(*) INTO ${variable}`);
      const refusal = fn.indexOf(`OR ${variable} > 0`, scan);
      expect(scan).toBeGreaterThan(-1);
      expect(refusal).toBeGreaterThan(scan);
      const proof = fn.slice(scan, refusal);
      expect(proof).toMatch(/FROM public\.tournament_players tp/);
      expect(proof).toMatch(/round\(COALESCE\(tp\.prize, 0\) \* 100\)::bigint > 0/);
      expect(proof).toMatch(/NOT EXISTS \(/);
      expect(proof).toMatch(/o\.kind = 'place'/);
      expect(proof).toMatch(/o\.place = tp\.position AND o\.user_id = tp\.user_id/);
    }
  });

  it('will not prepare, settle or complete below a finalized advertised guarantee', () => {
    for (const fn of [PREPARE, SETTLE]) {
      expect(fn).toMatch(/round\(COALESCE\(t\.guaranteed_prize,\s*0\),\s*2\) AS guaranteed_prize/);
      expect(fn).toMatch(/COALESCE\(t\.prize_pool_finalized,\s*false\) AS prize_pool_finalized/);
      expect(fn).toMatch(
        /IF\s+NOT\s+v_t\.prize_pool_finalized\s+OR\s+v_t\.prize_pool\s*\+\s*0\.005\s*<\s*v_t\.guaranteed_prize\s+THEN[\s\S]*?'reason',\s*'prize_pool_is_not_funded_and_finalized'/i
      );
    }
    expect(GUARD).toMatch(
      /IF NOT COALESCE\(NEW\.prize_pool_finalized, false\)[\s\S]*?NEW\.prize_pool[\s\S]*?< round\(COALESCE\(NEW\.guaranteed_prize, 0\), 2\)[\s\S]*?RAISE EXCEPTION/
    );
  });

  it('funds a guarantee only when the bank, claim, journal, escrow and floor prove one transaction', () => {
    expect(GUARANTEE).toMatch(/BEGIN[\s\S]*?EXCEPTION WHEN OTHERS/);
    expect(GUARANTEE).toContain('finalized_guarantee_is_below_published_floor');
    expect(GUARANTEE).not.toMatch(/SET prize_pool_finalized = false/);
    expect(GUARANTEE).toMatch(
      /v_bank_before[\s\S]*?fn_apply_prize_guarantee_before_atomic_proof[\s\S]*?v_bank_after[\s\S]*?v_bank_before - v_overlay/
    );
    expect(GUARANTEE).toMatch(
      /'bank_after',[\s\S]*?v_bank_after[\s\S]*?'treasury_after',[\s\S]*?v_bank_after/
    );
    expect(GUARANTEE).toMatch(
      /IF v_bank_before \+ 0\.005 < v_overlay THEN[\s\S]*?guarantee bank holds/
    );
    expect(GUARANTEE).toContain('t.union_id');
    expect(GUARANTEE).toContain('COALESCE(t.is_private, false) AS is_private');
    expect(GUARANTEE).toContain(
      'v_union := CASE WHEN v_t.is_private THEN NULL ELSE v_t.union_id END'
    );
    expect(GUARANTEE).not.toContain('SELECT c.union_id');
    expect(GUARANTEE).toContain('v_bank_row_found := FOUND');
    expect(GUARANTEE).toMatch(
      /INSERT INTO public\.chip_ledger[\s\S]*?'prize_liability'[\s\S]*?':guarantee_overlay'/
    );
    expect(GUARANTEE).toMatch(
      /v_escrow_after[\s\S]*?v_escrow_before[\s\S]*?- v_overlay\) > 0\.005/
    );
    expect(GUARANTEE).toMatch(
      /NOT v_after\.finalized[\s\S]*?abs\(v_after\.pool - v_final\)[\s\S]*?v_after\.pool \+ 0\.005 < v_after\.guarantee/
    );
    expect(executableSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_apply_prize_guarantee_before_atomic_proof\(uuid, text\)[\s\S]*?PUBLIC, anon, authenticated, service_role/
    );
    expect(executableSql).toMatch(
      /REVOKE ALL ON public\.tournament_guarantee_overlays[\s\S]*?PUBLIC, anon, authenticated, service_role[\s\S]*?GRANT SELECT ON public\.tournament_guarantee_overlays TO service_role/
    );
    expect(executableSql).toMatch(
      /has_table_privilege\('service_role',[\s\S]*?'public\.tournament_guarantee_overlays', 'TRUNCATE'\)/
    );
  });

  it('cannot hide a durable Bubble Protection promise by clearing its display flag', () => {
    for (const fn of [PREPARE, SETTLE, GUARD]) {
      expect(fn).toMatch(
        /v_bubble_evidence_exists[\s\S]*?kind = 'bubble_protection'[\s\S]*?source = 'bubble_protection'/
      );
      expect(fn).toMatch(/v_bubble_required[\s\S]*?v_bubble_evidence_exists/);
    }
    expect(PREPARE).toContain('bubble_protection_evidence_has_no_valid_contract');
    expect(SETTLE).toContain('bubble_protection_evidence_has_no_valid_contract');
    expect(GUARD).toContain('Bubble Protection evidence with no valid published contract');
  });

  it('creates or adopts one exact Bubble row and includes its open cents in the batch', () => {
    expect(PREPARE).toMatch(
      /v_bubble_obligations = 0 AND NOT v_bubble_evidence_exists[\s\S]*?gen_random_uuid\(\)[\s\S]*?'engine\.atomicPlaceSettlement'[\s\S]*?v_bubble_needs_insert := true/
    );
    expect(PREPARE).toContain("'reason', 'bubble_protection_obligation_is_not_exact'");
    expect(PREPARE).toMatch(
      /o\.kind = 'bubble_protection'[\s\S]*?o\.place IS NULL AND o\.user_id = v_bubble_user[\s\S]*?FOR UPDATE/
    );
    expect(PREPARE).toMatch(
      /COALESCE\(v_bubble_source, ''\) NOT IN \('engine\.eliminatePlayer', 'engine\.atomicPlaceSettlement'\)[\s\S]*?abs\(v_bubble_owed - v_t\.buy_in_amount\)/
    );
    expect(PREPARE).toMatch(
      /v_total_required_unpaid_cents := v_required_unpaid_cents \+ v_bubble_unpaid_cents/
    );
    expect(PREPARE).toMatch(
      /INSERT INTO public\.tournament_place_settlement_batches[\s\S]*?bubble_contract_required, bubble_obligation_id, bubble_user_id,[\s\S]*?bubble_source, bubble_amount_owed, bubble_amount_paid_before/
    );
    expect(PREPARE).toMatch(
      /v_expected_total_cents \/ 100\.0, v_total_required_unpaid_cents \/ 100\.0/
    );
  });

  it('freezes settlement classification, Bubble Protection and buy-in after the first entrant', () => {
    expect(CONTRACT_FREEZE).toMatch(
      /ROW\(NEW\.variant, NEW\.tournament_type, NEW\.satellite_target_id,[\s\S]*?NEW\.bubble_protection[\s\S]*?NEW\.buy_in_amount/
    );
    expect(CONTRACT_FREEZE).not.toMatch(/NEW\.payout_structure|NEW\.spin_multiplier/);
    expect(CONTRACT_FREEZE).toMatch(
      /FROM public\.tournament_players tp[\s\S]*?tp\.tournament_id = OLD\.id[\s\S]*?RAISE EXCEPTION/
    );
    expect(CONTRACT_FREEZE).toMatch(/OLD\.status[\s\S]*?'COMPLETING', 'COMPLETED'/);
    expect(CONTRACT_FREEZE).toMatch(/NEW\.guaranteed_prize[\s\S]*?OLD\.guaranteed_prize/);
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzz_freeze_registered_tournament_settlement_contract[\s\S]*?BEFORE UPDATE OF variant, tournament_type, satellite_target_id,[\s\S]*?bubble_protection, buy_in_amount/
    );
  });

  it('registration fails closed on unknown clocks and keeps the seat-first escape hatch private', () => {
    expect(REGISTRATION_GATE).toMatch(/FROM public\.tournaments[\s\S]*?FOR UPDATE/);
    expect(REGISTRATION_GATE).toMatch(
      /SELECT t\.status, t\.late_reg_levels, t\.rebuy_levels,[\s\S]*?v_level_cap := COALESCE\(v_t\.late_reg_levels, v_t\.rebuy_levels, 0\)/
    );
    expect(REGISTRATION_GATE).toMatch(
      /v_t\.current_level IS NULL[\s\S]*?'registration_state_unknown'/
    );
    expect(REGISTRATION_GATE).toMatch(
      /v_t\.started_at IS NULL[\s\S]*?'registration_state_unknown'/
    );
    expect(REGISTRATION_GATE).toMatch(/v_t\.finalized[\s\S]*?'registration_closed'/);
    expect(executableSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_register_for_tournament\(uuid, boolean\)[\s\S]*?FROM PUBLIC, anon, authenticated;[\s\S]*?GRANT EXECUTE[\s\S]*?TO service_role;/
    );
    expect(executableSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_register_for_tournament_before_atomic_lifecycle_gate\(uuid, boolean\)[\s\S]*?PUBLIC, anon, authenticated, service_role/
    );
    expect(executableSql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_register_for_tournament\([\s\S]{0,120}p_seat_first_internal boolean DEFAULT/
    );
  });

  it('an unexpired promised add-on blocks finalization and a stale flag cannot buy chips', () => {
    expect(POOL_WINDOW_GUARD).toMatch(
      /v_addon_open boolean := COALESCE\(NEW\.add_on_available, false\)[\s\S]*?clock_timestamp\(\) < NEW\.addon_period_ends_at/
    );
    expect(POOL_WINDOW_GUARD).toMatch(/IF v_addon_open THEN[\s\S]*?promised add-on window closes/);
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard[\s\S]*?ALTER TABLE public\.tournaments\s+DISABLE TRIGGER zzzz_tournament_pool_finalization_window_guard/
    );
    expect(REBUY_GATE).toMatch(
      /v_addon_open := COALESCE\(v_t\.add_on_available, false\)[\s\S]*?COALESCE\(v_t\.addon_period_triggered, false\)[\s\S]*?IF p_rebuy_type = 'addon' THEN[\s\S]*?IF NOT v_addon_open THEN/
    );
    expect(REBUY_GATE).toMatch(
      /FROM public\.tournament_players tp[\s\S]*?tp\.tournament_id = p_tournament_id[\s\S]*?tp\.user_id = p_user_id[\s\S]*?FOR UPDATE;[\s\S]*?v_player\.status IS DISTINCT FROM 'playing'/
    );
    expect(REBUY_GATE).toMatch(
      /COALESCE\(v_player\.add_on, false\)[\s\S]*?already purchased an add-on/
    );
    expect(REBUY_SEAT_CORE).toMatch(
      /FROM public\.tournaments t[\s\S]*?FOR UPDATE;[\s\S]*?FROM public\.tournament_players tp[\s\S]*?FOR UPDATE;[\s\S]*?FROM public\.table_seats s[\s\S]*?s\.left_at IS NULL[\s\S]*?FOR UPDATE OF s;/
    );
    expect(REBUY_SEAT_CORE).toMatch(
      /UPDATE public\.table_seats s[\s\S]*?s\.id = v_seat\.id[\s\S]*?s\.left_at IS NULL[\s\S]*?RETURNING s\.stack INTO v_stack_after;[\s\S]*?IF NOT FOUND/
    );
  });

  it('announces an add-on only after a matched write and exact read-back proof', () => {
    const write = OPEN_ADD_ON.indexOf(".eq('addon_period_triggered', false)");
    const read = OPEN_ADD_ON.indexOf('.select(projection)', write + 1);
    const latch = OPEN_ADD_ON.indexOf('this.addOnPeriodTriggered = true', read);
    const broadcast = OPEN_ADD_ON.indexOf("this.broadcast('ADDON_PERIOD_START'", latch);
    expect(OPEN_ADD_ON).toContain('this.addOnPeriodOpening = true');
    expect(write).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(write);
    expect(latch).toBeGreaterThan(read);
    expect(broadcast).toBeGreaterThan(latch);
    expect(OPEN_ADD_ON).toContain('durationSeconds');
    expect(OPEN_ADD_ON).not.toMatch(/durationSeconds:\s*60/);
    expect(OPEN_ADD_ON).toMatch(
      /catch \(err\)[\s\S]*?this\.addOnPeriodTriggered = false[\s\S]*?finally[\s\S]*?this\.addOnPeriodOpening = false/
    );
  });

  it('renders the persisted add-on deadline instead of inventing a 60-second client window', () => {
    const eventStart = TABLE_PAGE.indexOf("data?.type === 'ADDON_PERIOD_START'");
    const eventEnd = TABLE_PAGE.indexOf("data?.type === 'ADDON_PERIOD_END'", eventStart);
    const eventHandler = TABLE_PAGE.slice(eventStart, eventEnd);
    expect(eventStart).toBeGreaterThan(-1);
    expect(eventEnd).toBeGreaterThan(eventStart);
    expect(eventHandler).toMatch(/presentAddOnOffer\(/);
    expect(ADD_ON_PRESENTER).toMatch(/addonData\.endsAt/);
    expect(ADD_ON_PRESENTER).toMatch(/remainingSeconds <= 0[\s\S]*?return/);
    expect(ADD_ON_PRESENTER).toMatch(/endsAtMs: resolvedEndMs/);
    expect(eventHandler).not.toMatch(/timeRemaining:\s*60/);
    expect(ADD_ON_MODAL).toMatch(/endsAtMs[\s\S]*?Date\.now\(\)/);
    expect(ADD_ON_MODAL).toMatch(/setInterval\(tick, 1000\)/);
  });

  it('settles and completes inside one exception subtransaction', () => {
    const child = SETTLE.indexOf(
      'v_result := public.fn_settle_tournament_obligation_before_atomic_batch_gate('
    );
    const innerBegin = SETTLE.lastIndexOf('\n  BEGIN', child);
    const childRefusal = SETTLE.indexOf("v_result->>'ok'", child);
    const paidPostRead = SETTLE.indexOf('SELECT o.amount_paid INTO v_after_paid', child);
    const partialRefusal = SETTLE.indexOf('IF v_after_paid + 0.005 < r.amount_owed', paidPostRead);
    const completion = SETTLE.indexOf("SET status = 'COMPLETED'", partialRefusal);
    const tableClose = SETTLE.indexOf("SET status = 'closed', current_players = 0", completion);
    const liveSeatProof = SETTLE.indexOf('s.left_at IS NULL', tableClose);
    const rollbackBoundary = SETTLE.indexOf('EXCEPTION WHEN OTHERS', completion);

    expect(innerBegin).toBeGreaterThan(-1);
    expect(child).toBeGreaterThan(innerBegin);
    expect(childRefusal).toBeGreaterThan(child);
    expect(paidPostRead).toBeGreaterThan(childRefusal);
    expect(partialRefusal).toBeGreaterThan(paidPostRead);
    expect(completion).toBeGreaterThan(partialRefusal);
    expect(tableClose).toBeGreaterThan(completion);
    expect(liveSeatProof).toBeGreaterThan(tableClose);
    expect(rollbackBoundary).toBeGreaterThan(liveSeatProof);

    const failureResult = SETTLE.slice(rollbackBoundary);
    expect(failureResult).toMatch(/'reason',\s*'atomic_settlement_aborted'[\s\S]*?'paid',\s*0/);
    expect(SETTLE).toMatch(/'already_completed',\s*true/);
  });

  it('pins every database seat lifecycle trigger needed by atomic completion', () => {
    for (const trigger of [
      'trg_release_seats_on_tournament_finish',
      'trg_clear_seats_on_game_end',
      'trg_no_live_seat_on_finished_game',
    ]) {
      expect(executableSql).toMatch(new RegExp(`${trigger}[\\s\\S]*?tgenabled <> 'D'`));
    }
  });

  it('settles the frozen Bubble row and all places under one combined escrow proof', () => {
    const innerBegin = SETTLE.indexOf('\n  BEGIN', SETTLE.indexOf("status, '') <> 'COMPLETING'"));
    const gate = SETTLE.indexOf(
      "set_config('app.atomic_tournament_place_batch', p_tournament_id::text, true)",
      innerBegin
    );
    const bubbleChild = SETTLE.indexOf(
      "p_tournament_id, 'bubble_protection', NULL, v_batch.bubble_user_id",
      gate
    );
    const placeLoop = SETTLE.indexOf("o.kind = 'place'", bubbleChild);
    const escrowDelta = SETTLE.indexOf('round(v_total_required_unpaid * 100)::bigint', placeLoop);
    const completed = SETTLE.indexOf("SET status = 'COMPLETED'", escrowDelta);
    const rollback = SETTLE.indexOf('EXCEPTION WHEN OTHERS', completed);
    expect(innerBegin).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(innerBegin);
    expect(bubbleChild).toBeGreaterThan(gate);
    expect(placeLoop).toBeGreaterThan(bubbleChild);
    expect(escrowDelta).toBeGreaterThan(placeLoop);
    expect(completed).toBeGreaterThan(escrowDelta);
    expect(rollback).toBeGreaterThan(completed);
    expect(SETTLE).toMatch(
      /NULLIF\(v_result->>'obligation_id', ''\)::uuid[\s\S]*?v_batch\.bubble_obligation_id/
    );
    expect(SETTLE).toMatch(
      /v_paid_this_call[\s\S]*?v_total_required_unpaid[\s\S]*?'atomic_settlement_aborted'/
    );
  });

  it('the database refuses a normal COMPLETED write without that exact paid batch', () => {
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard[\s\S]*?BEFORE UPDATE ON public\.tournaments[\s\S]*?WHEN \(NEW\.status = 'COMPLETED' AND OLD\.status IS DISTINCT FROM 'COMPLETED'\)[\s\S]*?EXECUTE FUNCTION public\.trg_tournament_atomic_place_completion_guard\(\)/
    );
    expect(GUARD).toMatch(/v_batch\.settled_at IS NULL/);
    expect(GUARD).toMatch(/v_open <> 0/);
    expect(GUARD).toMatch(/v_fingerprint <> v_batch\.plan_fingerprint/);
    expect(GUARD).toMatch(/v_mismatches > 0/);
    expect(GUARD).toMatch(/v_extra_prizes > 0/);
    expect(GUARD).toMatch(/v_batch\.amount_owed[\s\S]*?NEW\.prize_pool/);
    expect(GUARD).toMatch(/v_bubble_obligation_id IS DISTINCT FROM v_batch\.bubble_obligation_id/);
    expect(GUARD).toMatch(/v_bubble_paid \+ 0\.005 < v_bubble_owed/);
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzz_refuse_normal_tournament_completed_insert[\s\S]*?BEFORE INSERT ON public\.tournaments[\s\S]*?WHEN \(NEW\.status = 'COMPLETED'\)/
    );
    expect(COMPLETED_INSERT_GUARD).toMatch(
      /variant[\s\S]*?tournament_type[\s\S]*?satellite_target_id[\s\S]*?RETURN NEW[\s\S]*?cannot be inserted already completed/
    );
    expect(executableSql).toMatch(
      /CREATE TRIGGER zzzy_lock_atomic_place_tournament_status[\s\S]*?BEFORE UPDATE OF status ON public\.tournaments[\s\S]*?WHEN \(NEW\.status IS DISTINCT FROM OLD\.status\)/
    );
    expect(STATUS_LOCK).toMatch(/OLD\.status = 'COMPLETED'[\s\S]*?is terminal and cannot return/);
    expect(STATUS_LOCK).toMatch(
      /tournament_place_settlement_batches[\s\S]*?v_settled_at IS NULL[\s\S]*?OLD\.status IS DISTINCT FROM 'COMPLETING'[\s\S]*?NEW\.status IS DISTINCT FROM 'COMPLETED'/
    );
  });

  it('retires the applying Heads-Up single-place loop from every engine caller', () => {
    expect(ENGINE_BASE).not.toContain('fn_backpay_hu_winner_shortfalls');
    const gameServer = stripTsComments(
      readFileSync(join(ROOT, 'server/src/GameServer.ts'), 'utf8')
    );
    expect(gameServer).not.toContain('fn_backpay_hu_winner_shortfalls');
    expect(gameServer).not.toContain('lastHuBackpayAt');
    expect(executableSql).not.toContain('$retire_applying_rpc_authority$');
    expect(executableSql).not.toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_backpay_hu_winner_shortfalls\(integer\) RESTRICT;/
    );
  });

  it('satellites and final-table deals are rejected by both place RPCs and bypass the normal gate', () => {
    for (const fn of [PREPARE, SETTLE]) {
      expect(fn).toContain("'reason', 'satellite_has_its_own_settlement'");
      expect(fn).toContain("'reason', 'final_table_deal_has_its_own_settlement'");
      expect(fn).toMatch(/lower\(COALESCE\(v_t\.variant, ''\)\) = 'satellite'/);
    }
    const exclusion = GUARD.indexOf("lower(COALESCE(NEW.variant, '')) = 'satellite'");
    const batchGate = GUARD.indexOf('FROM public.tournament_place_settlement_batches');
    expect(exclusion).toBeGreaterThan(-1);
    expect(GUARD).toMatch(/p\.source = 'final_table_deal'/);
    expect(exclusion).toBeLessThan(batchGate);
    expect(ELIMINATE).toMatch(
      /String\(\(tournament as any\)\?\.variant \?\? ''\)\.toLowerCase\(\) === 'satellite'/
    );
    expect(FINISH).toMatch(
      /String\(tournament\.variant \?\? ''\)\.toLowerCase\(\) === 'satellite'/
    );
    for (const source of [ELIMINATE, FINISH]) {
      expect(source).toMatch(/tournament_type[\s\S]*?SATELLITE/);
      expect(source).toMatch(/satellite_target_id/);
    }
  });

  it('browser roles cannot enter or bypass the settlement door', () => {
    expect(executableSql).toMatch(
      /ALTER TABLE public\.tournament_place_settlement_batches ENABLE ROW LEVEL SECURITY/
    );
    expect(executableSql).toMatch(
      /REVOKE ALL ON public\.tournament_place_settlement_batches FROM PUBLIC, anon, authenticated/
    );
    expect(executableSql).toMatch(
      /REVOKE ALL ON public\.tournament_place_settlement_batches FROM service_role[\s\S]*?GRANT SELECT ON public\.tournament_place_settlement_batches TO service_role/
    );
    expect(executableSql).toMatch(
      /has_table_privilege\('service_role',[\s\S]*?'public\.tournament_place_settlement_batches', 'TRUNCATE'\)/
    );
    for (const fn of [
      'fn_prepare_tournament_place_obligations\\(uuid, text\\)',
      'fn_settle_tournament_places_atomic\\(uuid, text\\)',
    ]) {
      expect(executableSql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\s+FROM PUBLIC, anon, authenticated`)
      );
      expect(executableSql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\s+TO service_role`)
      );
    }
    expect(executableSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.trg_tournament_atomic_place_completion_guard\(\)\s+FROM PUBLIC, anon, authenticated/
    );
    expect(executableSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.trg_freeze_batched_tournament_place\(\)\s+FROM PUBLIC, anon, authenticated/
    );
    expect(FINALIZER).not.toMatch(/\.from\('tournaments'\)/);
    expect(FINALIZER).toMatch(/return \{ success: false \};/);
  });

  it('normal finish and recovery fund and prove the guarantee before pricing or settlement', () => {
    const funding = PLACE_AUTHORITY.indexOf(
      'v_guarantee_result := public.fn_apply_prize_guarantee('
    );
    const proof = PLACE_AUTHORITY.indexOf(
      'COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE',
      funding
    );
    const floor = PLACE_AUTHORITY.indexOf(
      'v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)',
      proof
    );
    const pricing = PLACE_AUTHORITY.indexOf(
      'public.fn_ca_tournament_place_amounts(p_tournament_id)',
      floor
    );
    const settlement = PLACE_AUTHORITY.indexOf(
      'INSERT INTO public.tournament_obligations',
      pricing
    );
    expect(funding).toBeGreaterThan(-1);
    expect(proof).toBeGreaterThan(funding);
    expect(floor).toBeGreaterThan(proof);
    expect(pricing).toBeGreaterThan(floor);
    expect(settlement).toBeGreaterThan(pricing);

    const terminalPlace = TERMINAL_AUTHORITY.indexOf(
      'v_cash := public.fn_settle_tournament_places('
    );
    const terminalProof = TERMINAL_AUTHORITY.indexOf(
      "COALESCE((v_cash->>'fully_settled')::boolean,false) IS NOT TRUE",
      terminalPlace
    );
    expect(terminalPlace).toBeGreaterThan(-1);
    expect(terminalProof).toBeGreaterThan(terminalPlace);
  });

  it('reprices eliminated zero-prize standings after funding and never pre-stamps add-on finalization', () => {
    expect(REPRICE).toMatch(/\.eq\('status', 'eliminated'\)/);
    expect(REPRICE).not.toMatch(/\.(?:gt|gte|neq)\('prize'/);
    expect(REPRICE).toMatch(/resolvePayoutStructure\(/);
    expect(REPRICE).toMatch(
      /computePlacePrize\(finalPrizePool, payouts, Number\(player\.position\)\)/
    );
    expect(REPRICE).toMatch(/correctPrize - \(player\.prize \|\| 0\)/);
    expect(REPRICE).toMatch(/\.update\(\{ prize: correctPrize \}\)/);

    const addOnFunding = FINALIZE_AFTER_ADD_ON.indexOf("'fn_close_tournament_addon_period'");
    const addOnReprice = FINALIZE_AFTER_ADD_ON.indexOf(
      "this.reconcileTournamentEntryWindow('engine.addon_period_reprice')",
      addOnFunding
    );
    expect(addOnFunding).toBeGreaterThan(-1);
    expect(addOnReprice).toBeGreaterThan(addOnFunding);
    const durableCloseProof = FINALIZE_AFTER_ADD_ON.indexOf('if (error || result.ok !== true)');
    const cachedFinalization = FINALIZE_AFTER_ADD_ON.indexOf(
      'this.prizePoolFinalized = true',
      durableCloseProof
    );
    expect(durableCloseProof).toBeGreaterThan(addOnFunding);
    expect(cachedFinalization).toBeGreaterThan(durableCloseProof);
    expect(addOnReprice).toBeGreaterThan(cachedFinalization);
    expect(FINALIZE_AFTER_ADD_ON).not.toMatch(/prize_pool_finalized\s*:\s*true/);
    expect(FINALIZE_AFTER_ADD_ON).not.toMatch(/\.from\('tournaments'\)[\s\S]*?\.update\(/);
  });

  it('normal finish and recovery use the atomic door and require completion proof', () => {
    expect(FINISH).toMatch(
      /receipt = await requestTournamentTerminalReceipt\(this\.tournamentId, 'places', winnerId\)/
    );
    expect(RECOVER).toMatch(
      /const receipt = await requestTournamentTerminalReceipt\([\s\S]*?hasDeal \? 'final_table_deal' : 'places'/
    );
    for (const path of [FINISH, RECOVER]) {
      expect(path).not.toMatch(/fn_tournament_payout_reconcile/);
      expect(path).not.toMatch(/fn_settle_tournament_obligation/);
      expect(path).not.toMatch(/settleTournamentPlacesAtomically\(/);
      expect(path).not.toMatch(/settleTournamentObligation\(/);
    }
    expect(REQUEST_TERMINAL).toContain("supabase.rpc('fn_complete_tournament_terminal'");
    expect(REQUEST_TERMINAL).toContain('verifyTournamentCompletionReceipt(');
    expect(REQUEST_TERMINAL).toContain("supabase.rpc('fn_resolve_tournament_terminal_outcome'");
    expect(REQUEST_TERMINAL).toMatch(/if \(receipt\) return receipt/);
  });
});
