/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PRIZE AUDIT READS THE LEDGER, AND THE ENGINE ACTUALLY CALLS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-30 "Sunday $200 Deep Stack" paid 62,841.60 against a 44,640
 * prize pool. A recovery payout paid places 1-9 on the pre-reset 20,880 pool;
 * the outage reset then re-opened the event, it was replayed, and the
 * reconciler paid the NEW places 1-9 in full. 18,201.60 chips came from
 * nowhere.
 *
 * EVERY EXISTING CHECK STAYED GREEN. TournamentSentinel compares
 * SUM(tournament_players.prize) against prize_pool, and the reset had
 * overwritten tournament_players — so that sum read 44,640, exactly the pool.
 * The evidence survived only in wallet_transactions, which a reset cannot
 * rewrite.
 *
 * These pins are the two ways that fix can silently rot:
 *   1. the auditor stops existing, or stops being wired into the reconciler
 *      tick — a watchdog nobody calls is not a watchdog;
 *   2. someone "simplifies" it into a writer, so a watchdog starts moving
 *      money instead of reporting on it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('prize disbursement audit', () => {
  it('exists in FeeReconciler and asks the SQL auditor, not a snapshot column', () => {
    const src = read('./FeeReconciler.ts');
    expect(src).toContain('export async function auditPrizeDisbursement');

    const body = sliceMethod(src, 'export async function auditPrizeDisbursement');
    // It must call the ledger-reading RPC.
    expect(body).toContain('fn_tournament_prize_disbursement_audit');
    // It must raise a durable alert, not only a console line.
    expect(body).toContain('raiseFinancialAlert');
    // It must never repair: no writes from a watchdog.
    expect(body).not.toMatch(/\.rpc\(\s*['"]fn_credit_and_log/);
    expect(body).not.toMatch(/\.from\(['"]wallet_transactions['"]\)\s*\.\s*(insert|update|upsert)/);
  });

  it('is wired into the engine fee-reconciler cycle', () => {
    const gs = read('../GameServer.ts');
    // Imported AND called — an import alone would type-check and do nothing.
    expect(gs).toContain('auditPrizeDisbursement,');
    expect(gs).toMatch(/await auditPrizeDisbursement\(\s*\d+\s*\)/);
  });

  it('keeps the satellite auditor beside it in the same cycle', () => {
    const gs = read('../GameServer.ts');
    expect(gs).toMatch(/await auditSatelliteConservation\(\s*\d+\s*\)/);
  });
  it('the restart-orphaned fee sweep exists, files claims only, and runs each cycle', () => {
    const src = read('./FeeReconciler.ts');
    expect(src).toContain('export async function requeueUnbankedCashRake');

    const body = sliceMethod(src, 'export async function requeueUnbankedCashRake');
    // It asks the SQL sweep, which inserts into the durable queue.
    expect(body).toContain('fn_requeue_unbanked_cash_rake');
    // It must never bank directly: banking stays on the hand-gated,
    // idempotent atomic_distribute_rake path the reconciler already drives.
    expect(body).not.toContain('atomic_distribute_rake');
    expect(body).not.toMatch(/\.from\(['"]rake_records['"]\)\s*\.\s*(insert|upsert)/);

    const gs = read('../GameServer.ts');
    expect(gs).toContain('requeueUnbankedCashRake,');
    expect(gs).toMatch(/await requeueUnbankedCashRake\(/);
  });
});
