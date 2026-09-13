import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadSchemaManifest } from '../scripts/ci/schema-manifest.mjs';
import { runtimeFilesMatching } from './helpers/runtimeSourceSearch';

const root = resolve(__dirname, '..');
const migrationsDirectory = resolve(root, 'supabase/migrations');
const contractionFiles = readdirSync(migrationsDirectory).filter(
  (file) =>
    file.endsWith('_stage_b_current_postimage_contraction.sql') ||
    file.endsWith('_stage_b_current_postimage_contraction.sql.pending')
);
if (contractionFiles.length !== 1) throw new Error('Stage-B contraction migration is ambiguous');
const migration = readFileSync(resolve(migrationsDirectory, contractionFiles[0]), 'utf8');
const terminalBoundaryStart = migration.indexOf(
  '-- FORWARD-COMPOSED BOUNDARY: DB-FIRST TERMINAL ROOTS'
);
const terminalBoundaryEnd = migration.indexOf(
  '-- FORWARD-COMPOSED BOUNDARY: COMMITTED MOVE RESPONSE RECOVERY',
  terminalBoundaryStart
);
expect(terminalBoundaryStart, 'DB-first terminal boundary').toBeGreaterThan(-1);
expect(terminalBoundaryEnd, 'committed-move boundary').toBeGreaterThan(terminalBoundaryStart);
const terminalBoundary = migration.slice(terminalBoundaryStart, terminalBoundaryEnd);

const rollingServiceRoots = [
  'fn_apply_prize_guarantee(uuid,text)',
  'fn_collect_bounty(uuid,uuid,uuid,jsonb)',
  'fn_complete_tournament_terminal(uuid,uuid,text)',
  'fn_final_table_deal(uuid)',
  'fn_finalize_bounty_pool(uuid,uuid)',
  'fn_mystery_bounty_pay(uuid)',
  'fn_mystery_bounty_reserve(\n  uuid,uuid,jsonb,uuid,text,uuid,integer)',
  'fn_mystery_bounty_settle(uuid,uuid)',
  'fn_prepare_tournament_place_obligations(uuid,text)',
  'fn_resolve_satellite_settlement_outcome(uuid,uuid)',
  'fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
  'fn_settle_final_table_deal_atomic(uuid)',
  'fn_settle_satellite_finish_atomic(uuid,text)',
  'fn_settle_satellite_tournament(uuid,uuid)',
  'fn_settle_tournament_obligation(\n  uuid,text,integer,uuid,numeric,text,text,uuid)',
  'fn_settle_tournament_places_atomic(uuid,text)',
  'fn_settle_tournament_rake(uuid,text)',
  'fn_ca_epoch3_preflight()',
  'fn_ca_execute_epoch3_reset(text,boolean)',
] as const;

const ownerOnlyLeaves = [
  'fn_apply_prize_guarantee_before_atomic_proof(uuid,text)',
  'fn_award_satellite_seat(uuid,uuid,uuid,text,integer)',
  'fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)',
  'fn_collect_bounty_unguarded_20260907(uuid,uuid,uuid,jsonb)',
  'fn_deliver_satellite_ticket_exact(\n  uuid,uuid,uuid,text,integer,numeric)',
  'fn_final_table_deal_unguarded_20260907(uuid)',
  'fn_finalize_bounty_pool_unguarded_20260907(uuid,uuid)',
  'fn_mystery_bounty_pay_unguarded_20260907(uuid)',
  'fn_mystery_bounty_reserve_unguarded_20260907(\n  uuid,uuid,jsonb,uuid,text,uuid,integer)',
  'fn_mystery_bounty_settle_unguarded_20260907(uuid,uuid)',
  'fn_register_for_tournament_with_ticket_before_terminal_gate(uuid,uuid)',
  'fn_settle_satellite_cash_entitlement_exact(\n  uuid,text,integer,uuid,numeric,text)',
  'fn_settle_satellite_finish_atomic_before_maintenance_gate(uuid,text)',
  'fn_settle_tournament_bubble_protection(uuid,uuid)',
  'fn_settle_tournament_final_table_deal(uuid)',
  'fn_settle_tournament_obligation_before_atomic_batch_gate(\n  uuid,text,integer,uuid,numeric,text,text,uuid)',
  'fn_settle_tournament_places(uuid,uuid)',
] as const;

describe('terminal settlement DB-first hardening', () => {
  it('keeps every deployed-engine root present and exact service-only', () => {
    expect(terminalBoundary).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    for (const signature of rollingServiceRoots) {
      expect(terminalBoundary).toContain(
        `REVOKE ALL ON FUNCTION public.${signature}\n  FROM PUBLIC,anon,authenticated,service_role`
      );
      expect(terminalBoundary).toContain(
        `GRANT EXECUTE ON FUNCTION public.${signature}\n  TO service_role`
      );
    }
    expect(terminalBoundary).toContain('v_service_only text[] := ARRAY[');
    expect(terminalBoundary).toContain('aclexplode(');
    expect(terminalBoundary).toContain(
      "a.grantee<>ALL(ARRAY[v_owner,'service_role'::regrole::oid])"
    );
  });

  it('makes every wrapper-only terminal implementation owner-only', () => {
    for (const signature of ownerOnlyLeaves) {
      expect(terminalBoundary).toContain(
        `REVOKE ALL ON FUNCTION public.${signature}\n  FROM PUBLIC,anon,authenticated,service_role`
      );
    }
    expect(terminalBoundary).toContain('v_owner_only text[] := ARRAY[');
    expect(terminalBoundary).toContain('AND a.grantee<>v_owner');
  });

  it('refuses a revoked ticket session before any acquisition lock or ticket mutation', () => {
    const bodyStart = terminalBoundary.indexOf('$ticket_registration_terminal_gate$');
    const bodyEnd = terminalBoundary.indexOf('$ticket_registration_terminal_gate$', bodyStart + 1);
    const body = terminalBoundary.slice(bodyStart, bodyEnd);
    const sessionGate = body.indexOf('public.fn_caller_session_is_live() IS DISTINCT FROM TRUE');
    const acquisitionLock = body.indexOf('public.fn_ca_lock_tournament_seat_acquisition(');
    const ticketCore = body.indexOf(
      'public.fn_register_for_tournament_with_ticket_before_terminal_gate('
    );

    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    expect(sessionGate).toBeGreaterThan(-1);
    expect(acquisitionLock).toBeGreaterThan(sessionGate);
    expect(ticketCore).toBeGreaterThan(acquisitionLock);
    expect(body).toContain("USING ERRCODE = '28000'");
  });

  it('removes dead client wrappers without removing their still-live DB rollout roots', () => {
    for (const file of [
      'server/src/tournament/atomicPlaceSettlement.ts',
      'server/src/tournament/atomicPlaceSettlement.test.ts',
      'server/src/tournament/atomicFinalTableDeal.ts',
      'server/src/tournament/atomicFinalTableDeal.test.ts',
    ]) {
      expect(existsSync(resolve(root, file)), file).toBe(false);
    }

    const forbiddenQuotedRpc = `["']fn_(?:prepare_tournament_place_obligations|settle_tournament_places_atomic|settle_final_table_deal_atomic|settle_satellite_finish_atomic)["']`;
    const matches = runtimeFilesMatching(
      ['server/src', 'src', 'supabase/functions'].map((directory) => resolve(root, directory)),
      new RegExp(forbiddenQuotedRpc)
    );
    expect(matches).toEqual([]);
  });

  it('declares every branch object and tombstones only functions already removed', () => {
    const manifest = loadSchemaManifest(root);
    for (const table of [
      'tournament_paid_candidate_cutover_receipts',
      'tournament_positive_orphan_cutover_receipts',
    ]) {
      expect(manifest.tables, table).toContain(table);
    }
    for (const fn of [
      'fn_ca_tournament_rebuy_window',
      'fn_claim_bounty_legacy_candidate_20260907',
      'fn_tournament_seat_exit_cutover_receipts_append_only',
    ]) {
      expect(manifest.functions, fn).toContain(fn);
    }
    for (const removed of [
      'fn_ca_spin_cancel_returns_draw',
      'fn_clear_seats_on_game_end',
      'fn_reconcile_tournament_denormals',
      'fn_release_seats_on_tournament_finish',
      'fn_spin_reap_stale_boards',
      'fn_sync_tournament_chips',
      'process_tournament_rebuy_before_one_minute_addon',
    ]) {
      expect(manifest.functions, removed).not.toContain(removed);
    }
    // Post-engine retirement is intentionally a separate release.
    expect(manifest.functions).toContain('fn_settle_satellite_finish_atomic');
    expect(manifest.functions).toContain('fn_settle_final_table_deal_atomic');
    expect(manifest.functions).toContain('fn_settle_tournament_places_atomic');
  });
});
