/**
 * WEEKLY COMMISSION LANDS IN AGENT WALLETS; THE OWNER'S SHARE STAYS IN THE
 * CLUB BANK (Dan, 2026-10-22, binding).
 *
 * 1. Agent commission always goes to agents.agent_wallet_balance, never to
 *    club_members.chip_balance.
 * 2. Players with no agent belong to the club owner.
 * 3. The owner never receives commission into a personal wallet: the owner's
 *    tier is not moved out of clubs.chip_treasury.
 * 4. Rakeback owed to owner/no-agent players is paid from clubs.chip_treasury.
 * 5. A real agent's rakeback and pass-down commission come out of its agent
 *    wallet (agents are prepaid).
 *
 * The money proof is the native PostgreSQL 17 regression
 * scripts/ci/test-commission-agent-wallet-postgres.py, run in the accounting
 * CI shard against the exact live preimages. This law keeps the migration and
 * that regression from drifting apart.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261022164439_weekly_commission_lands_in_agent_wallets_and_the_owner_share.sql',
  'utf8'
);
const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start).toBeGreaterThan(0);
  return sql.slice(start, sql.indexOf('$function$;', start));
};
const r2 = body('public.fn_settle_accounting_commission_stage');
const r2v3 = body('public.fn_settle_accounting_commission_stage_v3');
const r3 = body('public.fn_settle_accounting_rakeback_stage');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const shard = readFileSync('scripts/dev/test-agent-accounting-statements.sh', 'utf8');

describe('weekly commission lands in agent wallets and the owner share stays in the club bank', () => {
  it('is one transaction pinned to its preimages with a live proof', () => {
    expect(sql).toMatch(/^-- @live-proof: /);
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('commission_agent_wallet_preimage_changed');
    expect(sql).toContain('commission_agent_wallet_postimage_changed');
  });

  for (const [label, stage] of [
    ['main', r2],
    ['v3', r2v3],
  ] as const) {
    it(`round 2 (${label}) credits agent wallets and never a player wallet`, () => {
      expect(stage).toContain(
        'UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+v_edge.amount'
      );
      expect(stage).not.toMatch(/UPDATE public\.club_members SET chip_balance/);
      expect(stage).toContain("'agent_wallet',v_edge.payee_user");
      expect(stage).not.toContain("'player_wallet',v_edge.payee_user");
    });

    it(`round 2 (${label}) keeps the owner's own tier in the club bank`, () => {
      expect(stage).toContain(
        'INSERT INTO pg_temp._routed_owner_nodes SELECT n.club_id,n.user_id,n.own_amount FROM pg_temp._routed_nodes n JOIN public.clubs c ON c.id=n.club_id AND c.owner_id=n.user_id;'
      );
      expect(stage).toContain('direct_total+owner_retained<>own_total');
      expect(stage).toContain("'owner_retained_in_club_bank',owner_retained");
    });
  }

  it('round 3 pays owner and no-agent shares from the club bank and agent shares from agent wallets', () => {
    expect(r3).toContain(
      "CASE WHEN fp.payer_kind='club' OR fp.payer_user IS NULL OR fp.payer_user=owner_club.owner_id THEN 'club_treasury' ELSE 'agent_wallet' END"
    );
    expect(r3).toContain(
      'UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-amount'
    );
    expect(r3).not.toMatch(/UPDATE public\.club_members SET chip_balance=chip_balance-amount/);
    expect(r3).toContain('routed_rakeback_final_agent_wallet_incorrect');
  });

  it('is qualified natively in the accounting shard', () => {
    expect(ci).toContain('run: bash scripts/dev/test-agent-accounting-statements.sh');
    expect(shard).toContain('scripts/ci/test-commission-agent-wallet-postgres.py');
  });
});
