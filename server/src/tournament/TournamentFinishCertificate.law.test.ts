/**
 * COMPLETED is a financial certificate, never an optimistic client write.
 *
 * These are source laws because the contract spans a database trigger, two
 * SECURITY DEFINER RPCs, the obligation ledger and three engine completion
 * tails. The migration is found by name fragment so release-order renumbering
 * cannot silently disable the test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', '..', '..', 'supabase', 'migrations');
const migrationName = readdirSync(migrations).find((name) =>
  name.includes('completed_means_financially_certified')
);
if (!migrationName) throw new Error('financial completion migration is missing');

const SQL = readFileSync(join(migrations, migrationName), 'utf8');
const CODE = SQL.replace(/^\s*--.*$/gm, '');
const strictMigrationNames = readdirSync(migrations).filter((name) =>
  name.endsWith('_stage_b_current_postimage_contraction.sql')
);
expect(
  strictMigrationNames,
  'expected one strict Stage-B tournament-manager cutover migration'
).toHaveLength(1);
const STRICT_SQL = readFileSync(join(migrations, strictMigrationNames[0] ?? ''), 'utf8');
const STRICT_CODE = STRICT_SQL.replace(/^\s*--.*$/gm, '');
const precertificationMigrationNames = readdirSync(migrations).filter((name) =>
  name.endsWith('_stage_b_atomic_finish_precertification.sql')
);
expect(
  precertificationMigrationNames,
  'expected one stopped-engine atomic finish precertification migration'
).toHaveLength(1);
const PRECERT_SQL = readFileSync(join(migrations, precertificationMigrationNames[0] ?? ''), 'utf8');
const PRECERT_CODE = PRECERT_SQL.replace(/^\s*--.*$/gm, '');
const ELIMINATIONS = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
const RECOVERY = readFileSync(join(here, 'tournamentRecovery.ts'), 'utf8');

function functionBody(name: string): string {
  const start = CODE.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} definition`).toBeGreaterThanOrEqual(0);
  const bodyStart = CODE.indexOf('AS $function$', start);
  const end = CODE.indexOf('$function$;', bodyStart);
  expect(bodyStart, `${name} body`).toBeGreaterThan(start);
  expect(end, `${name} terminator`).toBeGreaterThan(bodyStart);
  return CODE.slice(bodyStart, end);
}

describe('the canonical finish claim is durable and unforgeable', () => {
  it('persists one immutable winner and kind behind service-role RPCs', () => {
    expect(CODE).toContain('CREATE TABLE IF NOT EXISTS public.tournament_finish_receipts');
    expect(CODE).toMatch(/winner_user_id uuid NOT NULL/);
    expect(CODE).toMatch(/finish_kind text NOT NULL CHECK/);
    expect(CODE).toContain(
      'ALTER TABLE public.tournament_finish_receipts ENABLE ROW LEVEL SECURITY'
    );
    expect(CODE).toMatch(
      /REVOKE ALL ON TABLE public\.tournament_finish_receipts\s+FROM PUBLIC, anon, authenticated, service_role/
    );
    expect(CODE).toContain(
      'GRANT SELECT ON TABLE public.tournament_finish_receipts TO service_role'
    );
  });

  it('claims RUNNING with an exact one-row CAS and resumes only its immutable receipt', () => {
    const claim = functionBody('fn_claim_tournament_finish');
    expect(claim).toContain("v_t.status = 'COMPLETING'");
    expect(claim).toContain("'winner_user_id',v_receipt.winner_user_id");
    expect(claim).toContain("'candidate_mismatch'");
    expect(claim).toContain("SET status = 'COMPLETING'");
    expect(claim).toContain("WHERE id = p_tournament_id AND status = 'RUNNING'");
    expect(claim).toContain('GET DIAGNOSTICS v_rows = ROW_COUNT');
    expect(claim).toMatch(/IF v_rows <> 1 THEN\s+RAISE EXCEPTION/);
  });
});

describe('the certificate proves every terminal obligation', () => {
  const readiness = functionBody('fn_tournament_finish_readiness');

  it('proves the sole winner, complete standings and exact obligations', () => {
    expect(readiness).toContain("tp.status = 'winner' AND tp.position = 1");
    expect(readiness).toContain("'canonical_winner_not_proven'");
    expect(readiness).toContain("'standings_not_terminal'");
    expect(readiness).toMatch(/amount_paid[\s\S]*?- round\(COALESCE\(o\.amount_owed,0\),2\)/);
    expect(readiness).toContain("'unsettled_obligations'");
    expect(readiness).toContain("'prize_evidence_mismatch'");
    expect(readiness).toContain("'prize_pool_not_fully_obligated'");
    expect(readiness).toContain("'guarantee_not_funded'");
  });

  it('proves escrow and the already-synchronous rake settlement/attribution receipt', () => {
    expect(readiness).toContain("'escrow_not_zero'");
    expect(readiness).toContain('v_escrow.prize_balance');
    expect(readiness).toContain('v_escrow.bounty_balance');
    expect(readiness).toContain('v_escrow.fee_balance');
    expect(readiness).toContain('v_rake_settled_at IS NULL');
    expect(readiness).toContain('v_rake_attributed_at IS NULL');
    expect(readiness).toContain("'rake_not_settled'");

    const certify = functionBody('fn_certify_tournament_finish');
    expect(certify).not.toContain('public.fn_attribute_tournament_rake');
    expect(certify).not.toContain('public.fn_settle_tournament_rake');
    expect(certify).not.toContain('UPDATE public.');
  });

  it('proves bounty, deal and satellite receipts rather than inferred success', () => {
    expect(readiness).toContain('public.fn_tournament_has_unsettled_bounties');
    expect(readiness).toContain('public.tournament_bounty_completion_receipts');
    expect(readiness).toContain('public.tournament_final_table_deal_batches');
    expect(readiness).toContain('public.fn_check_atomic_final_table_deal');
    expect(readiness).toContain('public.tournament_satellite_settlement_batches');
    expect(readiness).toContain('public.fn_check_atomic_satellite_finish');
    expect(readiness).toContain("o.kind = 'final_table_deal'");
    expect(readiness).toContain("po.source = 'satellite_seat'");
    expect(readiness).toContain("po.metadata->>'registration_id'");
    expect(readiness).toContain("'satellite_awards_not_certified'");
  });
});

describe('the only completion door is atomic, retryable and lock bounded', () => {
  it('keeps both finish guards dormant for Stage A and activates both in Stage B', () => {
    for (const trigger of [
      'aa_guard_tournament_completing_claim',
      'zzzzzz_tournaments_financial_certificate',
    ]) {
      expect(CODE).toMatch(
        new RegExp(
          `CREATE TRIGGER ${trigger}[\\s\\S]*?ALTER TABLE public\\.tournaments\\s+DISABLE TRIGGER ${trigger}`
        )
      );
      expect(STRICT_CODE).toMatch(
        new RegExp(`ALTER TABLE public\\.tournaments\\s+ENABLE TRIGGER ${trigger}`)
      );
    }
    expect(CODE).toMatch(
      /tgname IN \([\s\S]*?'aa_guard_tournament_completing_claim'[\s\S]*?'zzzzzz_tournaments_financial_certificate'[\s\S]*?tgenabled = 'D'[\s\S]*?\) <> 2/
    );
    expect(STRICT_CODE).toMatch(
      /tgname IN \([\s\S]*?'aaa_guard_atomic_satellite_completion'[\s\S]*?'aa_guard_tournament_completing_claim'[\s\S]*?'zzzz_tournaments_atomic_place_completion_guard'[\s\S]*?'zzzzz_tournaments_atomic_final_table_deal_completion_guard'[\s\S]*?'zzzzzz_tournaments_financial_certificate'[\s\S]*?'zzzz_tournament_pool_finalization_window_guard'[\s\S]*?'zzzz_freeze_finalized_tournament_prize_pool'[\s\S]*?tgenabled <> 'D'[\s\S]*?\) <> 7/
    );
    expect(STRICT_CODE).toContain('DO $require_stage_a_atomic_finishes_precertified$');
    expect(STRICT_CODE).toContain(
      'Stage-B requires the stopped-engine atomic finish precertification boundary first'
    );
    expect(STRICT_CODE).not.toContain('DO $certificate_atomic_stage_b_window$');
    expect(STRICT_CODE).not.toContain("'certificate_stage_b_backfill'");
    expect(STRICT_CODE).not.toContain('fn_tournament_finish_readiness');
    expect(STRICT_CODE).not.toMatch(/UPDATE public\.tournament_finish_receipts/);
    const zeroBoundaryStart = STRICT_CODE.indexOf(
      'DO $require_stage_a_atomic_finishes_precertified$'
    );
    const zeroBoundaryEnd = STRICT_CODE.indexOf(
      '$require_stage_a_atomic_finishes_precertified$;',
      zeroBoundaryStart
    );
    const zeroBoundary = STRICT_CODE.slice(zeroBoundaryStart, zeroBoundaryEnd);
    expect(zeroBoundary).toContain('IF EXISTS (');
    expect(zeroBoundary).not.toContain('LOOP');
  });

  it('certifies the finite Stage-A cohort before Stage B without inventing claims', () => {
    expect(PRECERT_CODE).toContain("SET LOCAL statement_timeout = '120s'");
    expect(PRECERT_CODE).toContain('DO $require_durable_maintenance_window$');
    expect(PRECERT_CODE).toContain('DO $require_stopped_engine_and_terminal_invariant$');
    expect(PRECERT_CODE).toContain('pg_try_advisory_xact_lock_shared(530090,1)');
    expect(PRECERT_CODE).toContain(
      'LOCK TABLE public.tournaments IN SHARE ROW EXCLUSIVE MODE NOWAIT'
    );
    for (const relation of [
      'tournament_finish_receipts',
      'tournament_players',
      'tournament_obligations',
      'tournament_payouts',
      'tournament_place_settlement_batches',
      'tournament_final_table_deal_batches',
      'tournament_satellite_settlement_batches',
      'tournament_escrow',
      'rake_records',
      'tournament_rake_settlements',
      'tournament_bounty_completion_receipts',
      'tournament_bounty_obligations',
      'tournament_bounty_awards',
      'tournament_bounty_award_recipients',
      'tournament_bounties',
      'tournament_satellite_entitlements',
      'chip_ledger',
    ]) {
      expect(PRECERT_CODE).toContain(`LOCK TABLE public.${relation}`);
    }
    expect(PRECERT_CODE).toContain('FROM public.tournament_finish_receipts f');
    expect(PRECERT_CODE).toContain('FOR UPDATE');
    expect(PRECERT_CODE).toContain('public.fn_tournament_finish_readiness(r.id,v_winner)');
    expect(PRECERT_CODE).toContain('AND certified_at IS NULL');
    expect(PRECERT_CODE).toContain('AND completed_at IS NULL');
    expect(PRECERT_CODE).toContain('AND evidence IS NULL');
    expect(PRECERT_CODE).not.toContain('INSERT INTO public.tournament_finish_receipts');
    expect(PRECERT_CODE).not.toContain('certificate_stage_b_backfill');
  });

  it('keeps the certificate RPC read-only and accepts only the durable domain receipt', () => {
    const certify = functionBody('fn_certify_tournament_finish');
    expect(certify).not.toContain('fn_tournament_payout_reconcile');
    expect(certify).not.toContain('fn_settle_tournament_obligation');
    expect(certify).not.toContain('fn_settle_tournament_places_atomic');
    expect(certify).not.toContain('fn_settle_final_table_deal_atomic');
    expect(certify).not.toContain('fn_settle_satellite_finish_atomic');
    expect(certify).not.toContain('UPDATE public.');
    expect(certify).toContain("v_t.status <> 'COMPLETED'");
    expect(certify).toContain("'domain_settlement_required'");
    expect(certify).toContain("'rows_updated',0,'already_completed',true");
  });

  it('certifies inside the status trigger with each domain RPC own old-state contract', () => {
    const guard = functionBody('fn_guard_tournament_completed_certificate');
    expect(guard).toContain("v_kind = 'final_table_deal'");
    expect(guard).toContain("OLD.status IS DISTINCT FROM 'COMPLETING'");
    expect(guard).toContain("current_setting('app.atomic_final_table_deal_batch', true)");
    expect(guard).toContain("'atomic_final_table_deal'");
    expect(guard).toContain('public.fn_tournament_finish_readiness(NEW.id,v_winner)');
    expect(guard).toContain('SET certified_at = COALESCE(certified_at,now())');
    expect(CODE).toContain('CREATE TRIGGER zzzzzz_tournaments_financial_certificate');
  });

  it('installs the hot-table trigger inside the one lock-bounded migration transaction', () => {
    const trigger = CODE.indexOf('DROP TRIGGER IF EXISTS tournaments_z_financial_certificate');
    const begin = CODE.indexOf('BEGIN;');
    const budget = CODE.indexOf("SET LOCAL lock_timeout = '250ms';", begin);
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(begin).toBeGreaterThan(-1);
    expect(budget).toBeGreaterThan(begin);
    expect(budget).toBeLessThan(trigger);
    expect(CODE).not.toContain('completion-state substitution is ambiguous');
  });

  it('all engine tails leave COMPLETED to the one stored-receipt authority', () => {
    expect(ELIMINATIONS).toContain('requestTournamentTerminalReceipt(');
    expect(ELIMINATIONS).toContain('processSatelliteAwards(tournament, winnerId)');
    expect(ELIMINATIONS).not.toContain('claimTournamentFinish(');
    expect(ELIMINATIONS).not.toContain('certifyTournamentFinish(');
    expect(ELIMINATIONS).not.toContain('settleTournamentPlacesAtomically(');
    expect(ELIMINATIONS).not.toContain('settleFinalTableDealAtomically(');
    expect(RECOVERY).not.toContain('certifyTournamentFinish(');
    expect(RECOVERY).toContain('requestTournamentTerminalReceipt(');
    expect(RECOVERY).toContain('requestSatelliteSettlementReceipt(');
    expect(`${ELIMINATIONS}\n${RECOVERY}`).not.toMatch(/\.update\(\{\s*status:\s*'COMPLETED'/);
  });

  it('recovery never recreates or drains child money beside the terminal receipt', () => {
    expect(RECOVERY).not.toContain('drainTournamentBountyObligations(');
    expect(RECOVERY).not.toContain("supabase.rpc('fn_sweep_pending_tournament_bounties'");
    expect(RECOVERY).not.toContain('fn_settle_tournament_obligation');
    expect(RECOVERY).not.toContain('fn_settle_satellite_finish_atomic');
    expect(RECOVERY).not.toContain('fn_settle_tournament_places_atomic');
    expect(RECOVERY.match(/requestSatelliteSettlementReceipt\(/g)).toHaveLength(1);
    expect(RECOVERY.match(/requestTournamentTerminalReceipt\(/g)).toHaveLength(1);
  });
});
