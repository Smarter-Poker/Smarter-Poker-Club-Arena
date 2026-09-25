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
const cashAccrual = read(
  'supabase/accounting/weekly-v3/components/20260914131539_cash_commissions_account_for_every_contributor_once.sql'
);
const cashSources = read(
  'supabase/accounting/weekly-v3/components/20260914144442_cash_accounting_refusals_are_durable_and_retryable.sql'
);
function sqlBody(sql: string, name: string): string {
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  const definitions = [
    ...code.matchAll(
      new RegExp(
        `^CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`,
        'gm'
      )
    ),
  ];
  expect(definitions, `one maintained definition of ${name}`).toHaveLength(1);
  return definitions[0][1];
}

describe('the canonical allocator exists and is the single JS source of shares', () => {
  it('rakeAllocation.ts declares the weighted allocator and the method-aware entry point', () => {
    expect(allocationCode).toMatch(/export function allocateWeightedShareCents/);
    expect(allocationCode).toMatch(/export function sharesForRakeRecord/);
    expect(allocationCode).toMatch(/WEIGHTED_CONTRIBUTED/);
  });

  it('the settler delegates source identities to the canonical stored-weighted authority, never a private equal split', () => {
    // The worker now submits source IDs, not JS-recomputed player credits.
    // Follow the maintained database call chain to the immutable allocations;
    // an arbitrary RPC name alone would not establish weighted provenance.
    expect(settler).toMatch(
      /supabase\.rpc\('fn_credit_agent_commissions_batch',\s*\{\s*p_items: ids\.map\(\(id\) => \(\{ source_type: 'cash_rake_record', source_id: id \}\)\)/
    );
    expect(settler).toMatch(/readCashSourceBatch\(data, ids\)/);
    expect(stripComments(read('server/src/services/cashSourceReceipts.ts'))).toContain(
      'r.receipt_version !== 3'
    );
    expect(settler).not.toContain('sharesForRakeRecord');
    expect(settler).not.toContain('fn_apply_rakeback_player_stats_batch');
    expect(sqlBody(cashSources, 'fn_credit_agent_commissions_batch')).toMatch(
      /public\.fn_process_cash_accounting_source\(record_id\)/
    );
    expect(sqlBody(cashSources, 'fn_process_cash_accounting_source')).toMatch(
      /public\.fn_accrue_cash_hand_commissions\(r\.hand_id\)/
    );
    expect(sqlBody(cashAccrual, 'fn_accrue_cash_hand_commissions')).toMatch(
      /public\.fn_accounting_cash_commission_plan\(source\.id\)/
    );
    const plan = sqlBody(cashAccrual, 'fn_accounting_cash_commission_plan');
    expect(plan).toMatch(
      /sum\(weighted_rake_credit\)[\s\S]*?FROM public\.rake_attributions WHERE rake_record_id=source\.id AND hand_id=source\.hand_id/
    );
    expect(plan).toMatch(/allocated IS DISTINCT FROM source\.rake_amount/);
    expect(plan).toMatch(/RAISE EXCEPTION 'cash_commission_attribution_incomplete'/);
    expect(plan).toMatch(
      /public\.fn_accounting_earning_contract\(a\.club_id,a\.player_id,a\.weighted_rake_credit,game_union,source\.created_at\)/
    );
    const attributionWriter = sqlBody(cashAccrual, 'atomic_distribute_rake');
    expect(attributionWriter).toMatch(
      /p_rake_method = 'WEIGHTED_CONTRIBUTED'\s+THEN 'WEIGHTED_CONTRIBUTED'/
    );
    expect(attributionWriter).toMatch(
      /INSERT INTO public\.rake_attributions[\s\S]*?FROM public\.fn_allocate_rake_credits\(p_rake, p_contributions, v_method\)/
    );
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

  it('the unbanked-fee queue carries the methodology it was settled under', () => {
    expect(settlement).toMatch(/rakeMethod:\s*'WEIGHTED_CONTRIBUTED'/);
  });

  /**
   * NOTHING RE-DRIVES A QUEUED RAKE, SO NOTHING CAN RE-DRIVE IT EQUAL-DEALT
   * (2026-09-22). This pin used to require the reconciler's re-drive to fall
   * back to `row.rake_method ?? 'DEALT_EQUAL'`. That fallback was the door this
   * law exists to keep shut: the hourly re-queue filed DEALT_EQUAL claims for
   * raked hands whose envelope was merely late, the re-drive banked them first,
   * and atomic_distribute_rake keeps the first write, so the hand's weighted
   * attribution was lost for good. The rake of an accepted hand is now banked
   * only by its own post-commit envelope, and the reconciler re-drives no rake
   * at all. Stronger than the old pin, not weaker: no methodology can re-enter
   * through a path that no longer exists.
   */
  it('the reconciler re-drives no rake, so equal-dealt cannot re-enter through it', () => {
    expect(reconciler).not.toMatch(/atomic_distribute_rake/);
    expect(reconciler).not.toMatch(/DEALT_EQUAL/);
    expect(reconciler).not.toMatch(/fn_requeue_unbanked_cash_rake/);
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

describe('BBJ collection law (Dan 2026-08-29) — collection is not payout', () => {
  const hc = stripComments(read('server/src/engine/HandController.ts'));
  const serverCfg = stripComments(read('server/src/config/RakeConfig.ts'));
  const clientCfg = stripComments(read('src/config/RakeConfig.ts'));

  it('the engine prices deductions in exactly one place', () => {
    expect(hc).toMatch(/public priceDeductions\(/);
    expect((hc.match(/bbjCfg\.feeBB/g) ?? []).length).toBe(1);
    expect((hc.match(/this\.priceDeductions\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('no fee path may gate on pot size — that is the PAYOUT rule', () => {
    expect(hc).not.toMatch(/minPotBB/);
    expect(hc).not.toMatch(/potInBB/);
  });

  it('both calculateBBJFee copies take flopSeen, never potSize', () => {
    for (const src of [serverCfg, clientCfg]) {
      const sig = src.match(/export function calculateBBJFee\(([\s\S]*?)\):/)?.[1] ?? '';
      expect(sig).toMatch(/flopSeen/);
      expect(sig).not.toMatch(/potSize/);
    }
  });

  it('the payout floor survives in detectBBJHit, untouched', () => {
    expect(serverCfg).toMatch(/potSize < bigBlind \* BBJ_RULES\.minPotBB/);
  });

  it('the CI gate that enforces all of this exists and is wired', () => {
    expect(() => read('scripts/ci/check-rake-bbj-collection-law.mjs')).not.toThrow();
    expect(read('.github/workflows/ci.yml')).toMatch(/check-rake-bbj-collection-law\.mjs/);
    expect(read('scripts/ci/all-gates.sh')).toMatch(/check-rake-bbj-collection-law/);
  });

  it('the player-facing copy states collection and payout separately', () => {
    const basic = read('src/components/bbj/BBJBasicPanel.tsx');
    expect(basic).toMatch(/Collected On Every Hand That Sees A Flop/i);
  });
});

describe('hardening sweep (2026-08-29) stays swept', () => {
  const migrations = readdirSync(resolve(__dirname, '../../supabase/migrations'));

  it('the hardening + retention and ledger-read migrations are recorded', () => {
    expect(migrations.some((f) => f.includes('rake_hardening_and_retention'))).toBe(true);
    expect(migrations.some((f) => f.includes('rake_consumers_read_the_ledger'))).toBe(true);
  });

  it('the dead client persistence layer stays dead', () => {
    // HandPersistenceService wrote to the retired hands/hand_players tables
    // (0 rows ever) and had zero callers. Deleted 2026-08-29.
    expect(() => read('src/services/HandPersistenceService.ts')).toThrow();
    const barrel = read('src/services/index.ts');
    expect(barrel).not.toMatch(/from '\.\/HandPersistenceService'/);
  });

  it('the browser no longer schedules weekly rakeback settlement', () => {
    const cron = stripComments(read('src/services/FinancialCronService.ts'));
    // The method may remain callable for an explicit admin action, but no
    // timer in a random player's tab may own a money schedule.
    expect(cron).not.toMatch(/setInterval\(\s*\(\)\s*=>\s*this\.settleAllClubRakebacks/);
  });

  it('the admin drill-down consumes the authorised breakdown RPC', () => {
    const reports = stripComments(read('src/components/admin/RakeReports.tsx'));
    expect(reports).toMatch(/fn_hand_rake_breakdown/);
  });
});
