import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string): string => resolve(__dirname, '..', path);
const migrationsDirectory = root('supabase/migrations');
const contractionFiles = readdirSync(migrationsDirectory).filter(
  (file) =>
    file.endsWith('_stage_b_current_postimage_contraction.sql') ||
    file.endsWith('_stage_b_current_postimage_contraction.sql.pending')
);
if (contractionFiles.length !== 1) {
  throw new Error(
    `expected exactly one staged-or-promoted Stage-B contraction; found ${contractionFiles.length}`
  );
}
const contraction = readFileSync(resolve(migrationsDirectory, contractionFiles[0]), 'utf8');
const cashRunner = readFileSync(root('scripts/ci/rehearse-stage-b-cash-payers.py'), 'utf8');
const cancellationSource = readFileSync(
  root('supabase/migrations/20260909014444_tournament_cancellation_commits_one_stored_receipt.sql'),
  'utf8'
);
const cashPayerProbe = readFileSync(
  root('scripts/ci/probes/stage-b-cash-payers-native.sql'),
  'utf8'
);
const satelliteTicketProbe = readFileSync(
  root('scripts/ci/probes/atomic-satellite-ticket-return.sql'),
  'utf8'
);
const unregisterProbe = readFileSync(
  root('scripts/ci/probes/tournament-unregistration-cross-club.sql'),
  'utf8'
);
const actualStartProbe = readFileSync(
  root('scripts/ci/probes/seat-first-unregistration-actual-start.sql'),
  'utf8'
);

function functionBody(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`CREATE(?: OR REPLACE)? FUNCTION public\\.${escapedName}\\(`, 'g');
  let start = -1;
  for (const match of source.matchAll(pattern)) {
    start = match.index;
  }
  expect(start, `${name} definition`).toBeGreaterThanOrEqual(0);

  const tail = source.slice(start);
  const delimiter = /\bAS\s+(\$[a-zA-Z0-9_]*\$)/.exec(tail)?.[1];
  expect(delimiter, `${name} delimiter`).toBeTruthy();
  const bodyStart = tail.indexOf(delimiter!) + delimiter!.length;
  const bodyEnd = tail.indexOf(delimiter!, bodyStart);
  expect(bodyEnd, `${name} closing delimiter`).toBeGreaterThan(bodyStart);
  return tail.slice(bodyStart, bodyEnd);
}

describe('Stage-B keeps refunds behind their recorded-funding authorities', () => {
  it('refuses a valid refund before the generic pre-atomic payer in executable M5', () => {
    const body = functionBody(contraction, 'fn_settle_tournament_obligation');
    const refundGuard = body.indexOf("IF v_kind = 'refund' THEN");
    const genericPayer = body.indexOf(
      'RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate('
    );

    expect(refundGuard).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("'exact_refund_authority_required'", refundGuard)).toBeGreaterThan(
      refundGuard
    );
    expect(refundGuard).toBeLessThan(genericPayer);
    expect(contraction).toContain(
      "position('exact_refund_authority_required'\n                 IN v_single_obligation_source) = 0"
    );
  });

  it('makes the focused cash runner resolve executable M5 instead of the deploy mirror', () => {
    expect(cashRunner).toContain(
      'STAGE_B_MIGRATION_NAME = "stage_b_current_postimage_contraction"'
    );
    expect(cashRunner).toContain('stage_b_path = exact_migration(root, STAGE_B_MIGRATION_NAME)');
    expect(cashRunner).not.toContain('scripts/deploy/phase-three-strict-tournament-cutover.sql');
  });

  it('executes the valid-refund refusal in the native Stage-B cash-payer probe', () => {
    expect(cashPayerProbe).toMatch(
      /fn_settle_tournament_obligation\([\s\S]*?'refund',NULL[\s\S]*?'exact_refund_authority_required'/
    );
    expect(cashPayerProbe).toContain(
      'strict public payer keeps every refund behind exact entitlement authority'
    );
  });

  it('preserves exact wallet refunds and exact ticket returns in cancel and unregister', () => {
    const cancellation = functionBody(cancellationSource, 'atomic_cancel_tournament');
    const unregister = functionBody(
      contraction,
      'fn_ca_unregister_tournament_player_exact_seat_exit_core_v2'
    );

    expect(cancellation).toMatch(
      /entitlement_kind='wallet_charge'[\s\S]*?fn_settle_tournament_refund_exact\([\s\S]*?v_entitlement\.refund_wallet_club_id[\s\S]*?v_entitlement\.refund_prize[\s\S]*?v_entitlement\.refund_bounty[\s\S]*?v_entitlement\.refund_fee/
    );
    expect(cancellation).toMatch(
      /entitlement_kind IN \([\s\S]*?'satellite_seat','tournament_ticket'[\s\S]*?fn_ca_return_satellite_entitlement_as_ticket\(/
    );
    expect(cancellation).not.toContain('fn_settle_tournament_obligation(');

    const walletRefund = unregister.indexOf('fn_settle_tournament_refund_exact(');
    const ticketReturn = unregister.indexOf('fn_ca_return_satellite_entitlement_as_ticket(');
    expect(walletRefund).toBeGreaterThanOrEqual(0);
    expect(ticketReturn).toBeGreaterThan(walletRefund);
    expect(unregister).toContain("WHERE e.entitlement_kind='wallet_charge'");
    expect(unregister).toContain("e.entitlement_kind IN ('satellite_seat','tournament_ticket')");
    expect(unregister).toMatch(
      /fn_settle_tournament_refund_exact\([\s\S]*?v_ent\.refund_wallet_club_id[\s\S]*?v_ent\.refund_prize[\s\S]*?v_ent\.refund_bounty[\s\S]*?v_ent\.refund_fee/
    );
    expect(contraction).toContain("md5(p.prosrc)='16ea7acbbf76613a0a1193dff18f1330'");
  });

  it('keeps unregistration pre-start-only and rechecks actual start before commit', () => {
    const unregister = functionBody(
      contraction,
      'fn_ca_unregister_tournament_player_exact_seat_exit_core_v2'
    );
    const preWriteStartedAt = unregister.indexOf(
      'IF v_t.started_at IS NOT NULL OR v_launch_completed_at IS NOT NULL THEN'
    );
    const scheduledClock = unregister.indexOf("IF v_start_authority='scheduled_clock' THEN");
    const deleteRoster = unregister.indexOf('DELETE FROM public.tournament_players');
    const postWriteReread = unregister.indexOf(
      'SELECT t.status::text,t.started_at,launch.completed_at',
      deleteRoster
    );
    const receiptWrite = unregister.indexOf(
      'INSERT INTO public.tournament_unregistration_receipts(',
      deleteRoster
    );

    expect(unregister).toContain("'reason','tournament_started'");
    expect(unregister).toContain('clock_timestamp()>=v_t.start_time');
    expect(unregister).toContain('v_t.started_at IS NOT NULL');
    expect(unregister).toContain('v_launch_completed_at IS NOT NULL');
    expect(unregister).toContain('tournament started before unregistration could commit');
    expect(preWriteStartedAt).toBeGreaterThanOrEqual(0);
    expect(preWriteStartedAt).toBeLessThan(scheduledClock);
    expect(postWriteReread).toBeGreaterThan(deleteRoster);
    expect(postWriteReread).toBeLessThan(receiptWrite);
    expect(unregister.slice(postWriteReread, receiptWrite)).toMatch(
      /v_actual_started_at IS NOT NULL[\s\S]*?v_launch_completed_at IS NOT NULL[\s\S]*?v_start_authority='scheduled_clock'/
    );
    expect(actualStartProbe).toContain('spin_after_launch_refusal');
    expect(actualStartProbe).toContain('heads_up_after_launch_refusal');
    expect(actualStartProbe).toContain('spin_after_hand_refusal');
    expect(actualStartProbe).toContain('heads_up_after_hand_refusal');
    expect(actualStartProbe).toContain('scheduled_after_started_at_refusal');
    expect(actualStartProbe).toContain('scheduled_after_launch_refusal');
    expect(actualStartProbe).toContain("'Scheduled MTT Started At Refusal'");
    expect(actualStartProbe).toContain("'Scheduled MTT Completed Launch Refusal'");
  });

  it('probes exact source-wallet journals and idempotent tournament-ticket replay', () => {
    expect(unregisterProbe).toContain(
      "(v_result->>'returned_ticket_value')::numeric IS DISTINCT FROM 0"
    );
    expect(unregisterProbe).toContain('cardinality(v_receipt.credit_ledger_ids)<>2');
    expect(unregisterProbe).toContain('cardinality(v_receipt.wallet_transaction_ids)<>2');
    expect(unregisterProbe).toContain(
      "(v_replay-'replayed') IS DISTINCT FROM (v_first-'replayed')"
    );
    expect(unregisterProbe).toContain(
      'unregistration returned each charge to its own funding club'
    );

    expect(satelliteTicketProbe).toContain("(v_first->>'returned_ticket_value')::numeric<>200");
    expect(satelliteTicketProbe).toContain(
      "(v_first->>'wallet_chips_from_satellite_entitlements')::numeric<>0"
    );
    expect(satelliteTicketProbe).toContain(
      "(v_first_replay-'replayed') IS DISTINCT FROM (v_first-'replayed')"
    );
    expect(satelliteTicketProbe).toContain('public.fn_unregister_from_tournament(');
    expect(satelliteTicketProbe).toContain(
      "e.entitlement_kind IN ('satellite_seat','tournament_ticket')"
    );
  });
});
