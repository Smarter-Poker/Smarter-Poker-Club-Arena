/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE LAST WRONG-ACCOUNT MONEY PATH IS GONE (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Completing phase 3 of 7. Dan: "FIX THIS, REMOVE IT IF ITS AN UNUSED LEGACY."
 *
 * After ChipTransferModal was rewired, four wrong-account paths were still in
 * the tree. Each is pinned below by what replaced it:
 *
 *   1. AgentService.transferToPlayer - LIVE, from SuperAgentDashboard, and
 *      broken twice over. It called ChipFlowService.transfer (a peer-to-peer
 *      move between two users' PLAYER wallets, not the agent wallet), and the
 *      dashboard passed `agent.id` - the agents-table ROW id - into a parameter
 *      read as a USER id, so no wallet ever matched and the one live caller
 *      could not have moved a chip.
 *   2. AgentService.distributeFromTreasury - the only client of the World Hub
 *      route POST /api/club-arena/distribute-chips, and NOTHING called it.
 *   3. AgentService.distributeChips - only caller was ChipDistributionPanel,
 *      which is rendered nowhere.
 *   4. AgentService.transferToAgent - zero callers.
 *
 * And underneath them, transfer_chips_agent_to_player, which debits
 * club_members.chip_balance. It had never moved a chip: zero
 * 'agent_to_player_transfer' rows in chip_transactions, and zero
 * chip_distribution audit rows from the route above it.
 *
 * These are source pins. What they defend is a property of the whole tree -
 * "there is one money path" - which no single render test can state.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(process.cwd(), p));

/** Strips comments, so a "must not appear" pin cannot match its own explanation. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const AGENT_SERVICE = codeOnly(read('src/services/AgentService.ts'));
const SUPER_AGENT = codeOnly(read('src/pages/SuperAgentDashboard.tsx'));
const MIGRATION = read(
  'supabase/migrations/20260901000004_the_last_wrong_account_money_path_is_gone.sql'
);
const MIGRATION_CODE = codeOnly(MIGRATION);

describe('the one live path now spends the agent wallet', () => {
  it('transferToPlayer calls fn_agent_wallet_send', () => {
    expect(AGENT_SERVICE).toMatch(/supabase\.rpc\('fn_agent_wallet_send'/);
  });

  /**
   * The sender used to be an argument, which is exactly how a row id got passed
   * where a user id belonged. auth.uid() is the only identity a browser can
   * establish, and the RPC derives the sender from it.
   */
  it('takes no sender parameter at all', () => {
    expect(AGENT_SERVICE).toMatch(
      /async transferToPlayer\(playerId: string, clubId: string, amount: number\)/
    );
    expect(AGENT_SERVICE).not.toMatch(/async transferToPlayer\(\s*\n?\s*agentId: string/);
  });

  it('the dashboard no longer passes the agents-table row id', () => {
    expect(SUPER_AGENT).not.toMatch(/transferToPlayer\(agent\.id/);
    expect(SUPER_AGENT).toMatch(/transferToPlayer\(transferPlayerId, clubId!, amount\)/);
  });

  it('reuses a durable retry identity and requires a confirmed receipt', () => {
    const transfer = AGENT_SERVICE.slice(
      AGENT_SERVICE.indexOf('async transferToPlayer('),
      AGENT_SERVICE.indexOf('async getAgentHierarchy(')
    );
    expect(transfer).toMatch(/runAgentWalletOperation\(/);
    expect(transfer).toMatch(/p_op_id: operation.operationId/);
    expect(transfer).toMatch(/confirmedAgentWalletReceipt\(/);
    expect(transfer).not.toMatch(/p_op_id:\s*uuid\(/);
  });
});

describe('the dead paths are gone, not merely unused', () => {
  it('AgentService no longer exposes the three removed methods', () => {
    expect(AGENT_SERVICE).not.toMatch(/async distributeFromTreasury\(/);
    expect(AGENT_SERVICE).not.toMatch(/async distributeChips\(/);
    expect(AGENT_SERVICE).not.toMatch(/async transferToAgent\(/);
  });

  it('and no longer reaches ChipFlowService or the ops API at all', () => {
    expect(AGENT_SERVICE).not.toMatch(/ChipFlowService/);
    expect(AGENT_SERVICE).not.toMatch(/callClubArenaApi/);
  });

  it('the unrendered ChipDistributionPanel is deleted, barrel included', () => {
    expect(exists('src/components/agent/ChipDistributionPanel.tsx')).toBe(false);
    expect(exists('src/components/agent/ChipDistributionPanel.css')).toBe(false);
    expect(codeOnly(read('src/components/agent/index.ts'))).not.toMatch(/ChipDistributionPanel/);
  });
});

describe('the function underneath is dropped, and the guards agree', () => {
  it('drops transfer_chips_agent_to_player', () => {
    expect(MIGRATION_CODE).toMatch(
      /DROP FUNCTION IF EXISTS public\.transfer_chips_agent_to_player\(uuid, uuid, uuid, numeric\)/
    );
  });

  /**
   * fn_union_money_path_check treats a listed function that has been "deleted
   * outright" as a breach, in its own words. Dropping the function without
   * updating it would have traded one red guard for another - so both happen in
   * the same transaction.
   */
  it('removes it from all three integrity checks in the same transaction', () => {
    // Only the guard bodies: the verify block legitimately names the function
    // when it asserts that the drop actually happened.
    const guards = MIGRATION_CODE.slice(
      MIGRATION_CODE.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_money_path_check'),
      MIGRATION_CODE.indexOf('DROP FUNCTION IF EXISTS')
    );
    expect(guards.length).toBeGreaterThan(500);
    expect(guards).not.toMatch(/transfer_chips_agent_to_player/);
    for (const fn of [
      'fn_union_money_path_check',
      'fn_club_arena_global_wallet_check',
      'fn_union_overload_check',
    ]) {
      expect(MIGRATION_CODE).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(\\)`));
    }
    const begin = MIGRATION_CODE.indexOf('BEGIN;');
    const commit = MIGRATION_CODE.indexOf('COMMIT;');
    const drop = MIGRATION_CODE.indexOf('DROP FUNCTION IF EXISTS public.transfer_chips');
    expect(begin).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(drop);
  });

  /**
   * A migration whose subject is a removal must not quietly widen an estate
   * guard to cover the replacement. That is a separate decision with its own
   * blast radius.
   */
  it('adds no new name to any guard while it is there', () => {
    expect(MIGRATION_CODE).not.toMatch(/'fn_agent_wallet_send[^']*'/);
    expect(MIGRATION_CODE).not.toMatch(/'fn_club_bank_send'/);
  });

  it('asserts the guards are quiet afterwards, so a bad apply aborts itself', () => {
    expect(MIGRATION).toMatch(/fn_union_money_path_check reports % breach/);
    expect(MIGRATION).toMatch(/is still present/);
  });

  it('touches no table', () => {
    expect(MIGRATION_CODE).not.toMatch(/ALTER TABLE/i);
    expect(MIGRATION_CODE).not.toMatch(/\bUPDATE\s+public\./i);
  });

  it('carries the rollback the DROP obliges', () => {
    expect(MIGRATION).toMatch(/^-- ROLLBACK$/m);
  });
});
