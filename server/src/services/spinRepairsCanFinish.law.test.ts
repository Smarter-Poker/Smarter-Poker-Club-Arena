/**
 * A root settlement authority makes the old Spin repair payer unnecessary.
 * The engine must not call it. During the rolling stage-one deployment the
 * old RPCs remain available to the old engine, while the new engine uses the
 * combined authority. Repairs for unrelated rake attribution remain bounded.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceCall } from '../testHelpers/sourceWindow.js';

const gameServer = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');
const executableGameServer = gameServer
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const stageOne = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260908032728_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
  ),
  'utf8'
);
const callBlock = (rpc: string): string => {
  const named = gameServer.indexOf(`'${rpc}'`);
  expect(named, `${rpc} is called from GameServer`).toBeGreaterThan(-1);
  const opens = gameServer.slice(0, named).lastIndexOf('supabase.rpc(');
  expect(opens, `${rpc} is passed to supabase.rpc`).toBeGreaterThan(-1);
  return sliceCall(gameServer.slice(opens), 'supabase.rpc(');
};

describe('the Spin payout repair fleet has one stage-one replacement', () => {
  it('has no GameServer winner-backpay caller or timer', () => {
    expect(executableGameServer).not.toMatch(/fn_backpay_spin_unpaid_winners/);
    expect(executableGameServer).not.toMatch(/lastSpinBackpayAt/);
  });

  it('records the production cohort before either historical correction', () => {
    const marker = stageOne.indexOf('CREATE TABLE public.tournament_spin_settlement_cutover');
    const repair = stageOne.indexOf('DO $repair_781cc0ee$');

    expect(marker).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(marker);
    expect(stageOne).toContain('transaction_timestamp()');
    expect(stageOne).toContain('production_requires_receipt boolean GENERATED ALWAYS AS');
    expect(stageOne).toContain('781cc0ee-6a1d-4e31-acaf-4e737661bba1');
    expect(stageOne).toContain('6d688095-c3c5-4d40-a5a0-952934667732');
    expect(stageOne).toMatch(
      /REVOKE ALL ON public\.tournament_spin_settlement_cutover[\s\S]*?service_role;/
    );
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
    expect(stageOne).toContain('stage-2 migration owns every');
    expect(stageOne).not.toMatch(/DROP FUNCTION IF EXISTS public\.fn_spin_sweep_unbooked/);
    expect(stageOne).not.toMatch(/cron\.unschedule/);
  });

  it('preserves observability and the unfilled-game refund lifecycle in stage one', () => {
    expect(gameServer).toContain('this.spinMetrics.start()');
    expect(gameServer).toContain('...this.spinMetrics.toPrometheus()');
    expect(executableGameServer).toContain("supabase.rpc('fn_spin_expire_unfilled'");
    expect(stageOne).not.toMatch(/DROP FUNCTION IF EXISTS public\.fn_spin_expire_unfilled/);
    expect(stageOne).not.toMatch(/DROP FUNCTION IF EXISTS public\.fn_ca_spin_cancel_returns_draw/);
  });
});

describe('unrelated recurring rake repairs remain bounded', () => {
  it('every rake repair the loop drives carries a limit', () => {
    for (const rpc of [
      'fn_repair_tournament_rake_attribution',
      'fn_backpay_tournament_rake_attribution',
    ]) {
      expect(callBlock(rpc), `${rpc} passes a limit`).toMatch(/p_limit:\s*\d+/);
    }
  });

  it('the attribution back-pay remains wired and observable', () => {
    expect(gameServer).toContain('fn_backpay_tournament_rake_attribution');
    expect(gameServer).toContain('GameServer.rake_attribution_backpay_failed');
  });
});
