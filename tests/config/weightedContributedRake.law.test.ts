/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WEIGHTED CONTRIBUTED RAKE LAW (Dan 2026-08-29, BINDING)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "A player's credited rake is proportional to the player's actual eligible
 * contribution to the rakeable pot. Being dealt into a hand does not by itself
 * generate rake credit."
 *
 * This RETIRES equal-dealt attribution (FIX 144 / DECISION D-001) for new cash
 * hands. These pins keep the retired methodology from creeping back into the
 * production write path, the way `no-auto-table-switch.law.test.ts` guards its
 * own deletion. They are source pins (the services construct Supabase clients
 * and timers at module load, so importing them in vitest is not an option).
 *
 * If a pin here goes red, you are re-shipping equal-dealt rake attribution.
 * Fix your change — do not weaken the pin.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const settler = stripComments(read('server/src/services/RakebackSettlerService.ts'));
const allocation = read('server/src/services/rakeAllocation.ts');
const allocationCode = stripComments(allocation);
const settlement = stripComments(read('server/src/engine/ServerTableEngineSettlement.ts'));
const reconciler = stripComments(read('server/src/services/FeeReconciler.ts'));
const handEvents = stripComments(read('server/src/engine/ServerTableEngineHandEvents.ts'));

describe('the canonical allocator exists and is the single JS source of shares', () => {
  it('rakeAllocation.ts declares the weighted allocator and the method-aware entry point', () => {
    expect(allocationCode).toMatch(/export function allocateWeightedShareCents/);
    expect(allocationCode).toMatch(/export function sharesForRakeRecord/);
    expect(allocationCode).toMatch(/WEIGHTED_CONTRIBUTED/);
  });

  it('the settler consumes sharesForRakeRecord and no longer owns a private equal split', () => {
    expect(settler).toMatch(/import \{ sharesForRakeRecord \} from '\.\/rakeAllocation\.js'/);
    expect(settler).not.toMatch(/function equalShareCents/);
    // The retired formula shape must not reappear in any form:
    expect(settler).not.toMatch(/rake_amount\s*\/\s*dealt/i);
    expect(settler).not.toMatch(/totalRake\s*\/\s*(playerCount|dealtPlayerCount|n\b)/);
  });

  it('the settler selects rake_method so every row is processed under its own methodology', () => {
    expect(settler).toMatch(/rake_method/);
  });
});

describe('the engine stamps new cash hands WEIGHTED_CONTRIBUTED', () => {
  it('settlement passes the methodology and the returned-uncalled audit map to atomic_distribute_rake', () => {
    expect(settlement).toMatch(/p_rake_method:\s*'WEIGHTED_CONTRIBUTED'/);
    expect(settlement).toMatch(/p_returned_uncalled:\s*returnedObj/);
  });

  it('the unbanked-fee queue carries the methodology so a re-driven hand keeps it', () => {
    expect(settlement).toMatch(/rakeMethod:\s*'WEIGHTED_CONTRIBUTED'/);
    expect(reconciler).toMatch(/p_rake_method:\s*row\.rake_method\s*\?\?\s*'DEALT_EQUAL'/);
  });

  it('eligible contribution and returned-uncalled are captured as separate first-class state', () => {
    expect(handEvents).toMatch(/currentHandReturnedUncalled/);
  });
});

describe('the migration is present and self-testing', () => {
  const migrations = readdirSync(resolve(__dirname, '../../supabase/migrations'));
  const file = migrations.find((f) => f.includes('weighted_contributed_rake'));

  it('20260829_weighted_contributed_rake.sql exists', () => {
    expect(file).toBeTruthy();
  });

  it('declares the canonical SQL allocator, the method stamp and the per-player ledger', () => {
    const sql = read(`supabase/migrations/${file}`);
    expect(sql).toMatch(/fn_allocate_rake_credits/);
    expect(sql).toMatch(/rake_method/);
    expect(sql).toMatch(/rake_attributions/);
    expect(sql).toMatch(/WEIGHTED_CONTRIBUTED/);
    // The spec's reference hands are asserted at apply time:
    expect(sql).toMatch(/self-test §35/);
    expect(sql).toMatch(/self-test §38/);
  });
});

describe('reconciliation watchdog is wired', () => {
  it('FeeReconciler exposes the attribution drift audit and GameServer runs it', () => {
    expect(reconciler).toMatch(/export async function auditRakeAttributionDrift/);
    const gameServer = stripComments(read('server/src/GameServer.ts'));
    expect(gameServer).toMatch(/auditRakeAttributionDrift\(/);
  });
});
