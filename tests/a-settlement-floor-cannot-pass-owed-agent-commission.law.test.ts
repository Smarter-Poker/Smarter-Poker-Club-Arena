/**
 * A SETTLEMENT FLOOR CANNOT PASS OWED AGENT COMMISSION (2026-10-03)
 *
 * 1,162,765.28 of recorded agent commission (weeks 2026-04-27 .. 2026-09-14,
 * 239 club/agent pairs, 236 of them horses) sat below the union and club
 * settlement floors with no path that could ever pay it: the weekly close
 * never reaches below its floor, the agent claim is retired, and the floor
 * moves recorded only the skipped RAKEBACK as owed. 20261003092151 paid it
 * once; 20261003092217 makes the move that stranded it refuse.
 *
 * Pinned here: the guard is on both floor tables and refuses rather than
 * warns; the one-off pays horses exactly like the human (no horse filter,
 * CLAUDE.md 10.5); it pays the recorded rows from the club bank with a leg,
 * a wallet credit and a receipt each, and settles by period instead of
 * stamping millions of rows.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const sqlOnly = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

const GUARD = read(
  'supabase/migrations/20261003092217_a_settlement_floor_cannot_pass_owed_agent_commission.sql'
);
const PAY = read(
  'supabase/migrations/20261003092151_the_overdue_agent_commission_is_paid_from_the_club_bank.sql'
);
const ROLLUP = read(
  'supabase/migrations/20261003092205_the_paid_overdue_commission_leaves_the_unsettled_rollup.sql'
);

describe('a settlement floor cannot pass owed agent commission', () => {
  it('guards both floor tables on insert and on a move of the floor', () => {
    for (const table of ['union_settlement_floor', 'club_settlement_floor']) {
      expect(GUARD).toMatch(
        new RegExp(
          `CREATE TRIGGER a_floor_cannot_pass_owed_agent_commission\\s+BEFORE INSERT OR UPDATE OF earliest_period_start ON public\\.${table}`
        )
      );
    }
  });

  it('refuses, reading only the weeks the move skips, by the same coverage test the rollup uses', () => {
    const body = sqlOnly(GUARD);
    expect(body).toMatch(/RAISE EXCEPTION 'settlement_floor_would_strand_agent_commission'/);
    expect(body).toMatch(/x\.period_end > v_from AND x\.period_start < v_to/);
    expect(body).toMatch(/a\.created_at >= v_cursor AND a\.created_at < v_to/);
    expect(body).toMatch(/FROM public\.agent_commission_settlements x/);
    expect(body).not.toMatch(/RAISE WARNING/);
  });
});

describe('the overdue agent commission is paid once, to every agent alike', () => {
  const body = sqlOnly(PAY);

  it('never filters horses out of the payment', () => {
    expect(body).not.toMatch(/is_?horse/i);
  });

  it('pays each pair from the club bank with a journal leg, a wallet credit and a receipt', () => {
    expect(body).toMatch(
      /'club_treasury', r\.payer_club, 'player_wallet', r\.user_id, r\.amount, 'commission'/
    );
    expect(body).toMatch(/INSERT INTO public\.wallet_transactions/);
    expect(body).toMatch(/settlement_invoices i WHERE i\.source_ledger_id = v_lid/);
  });

  it('funds the bank through a sanctioned door, never from nowhere', () => {
    expect(body).toMatch(/public\.fn_ca_fund_club\(c_dss/);
    expect(body).toMatch(/'union_wallet', c_union, 'club_treasury', r\.payer_club/);
    expect(body).not.toMatch(/settlement_suspense'\s*,/);
  });

  it('settles by period and refuses a replay', () => {
    expect(body).toMatch(/INSERT INTO public\.agent_commission_settlements/);
    expect(body).not.toMatch(/SET settled_at/);
    expect(body).toMatch(/already ran; never replay/);
  });

  it('brings the rollup down by exactly what was settled, in the live writers lock order', () => {
    const r = sqlOnly(ROLLUP);
    expect(r).toMatch(/pg_advisory_xact_lock\(hashtextextended\('agent-commission:'/);
    expect(r).toMatch(/owed = r\.owed - d\.amount/);
  });
});
