/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN AGENT CAN FINALLY BE PAID (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 6 of 7. Phases 4 and 5 each wrote the same sentence into a comment and
 * moved on: "there is no payout path to send them to yet (phase 6 builds one)".
 *
 * MEASURED ON PRODUCTION BEFORE THIS CHANGE:
 *   958,627 unsettled agent_commissions rows, 394,904.61 chips, 96 agents,
 *   accruing since 2026-04-28 and still accruing.
 *
 * THREE BROKEN THINGS STOOD WHERE THE PAYOUT PATH SHOULD HAVE BEEN:
 *   fn_pay_commission_atomic   a stub returning {'error': 'not_implemented'}
 *   execute_commission_payout  credited a wallet, debited NOTHING, and never
 *                              set settled_at - so one row could pay forever
 *   sum_agent_commissions      read commission_history, a table with 0 rows
 *
 * And the agent dashboard told people "Commissions are paid out automatically
 * at the weekly settlement", which no function, cron or settlement job did.
 *
 * The pins below are about the properties that make a money path safe. Each one
 * corresponds to something that was actually wrong.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const MIGRATION = read('supabase/migrations/20260902000001_an_agent_can_finally_be_paid.sql');
const SQL = codeOnly(MIGRATION);
/** Comments explain what was removed and name it; only code counts here. */
const jsCodeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
const SERVICE_SRC = read('src/services/CommissionService.ts');
const SERVICE = jsCodeOnly(SERVICE_SRC);
const DASHBOARD = read('src/components/agent/AgentCommissionDashboard.tsx');

/**
 * The claim's own body. Bounded by the REVOKE that follows it - a line of CODE,
 * so it survives comment stripping. The section headers in the migration are
 * comments, and slicing to one of those returned -1 and a nonsense window.
 */
const claimFunctionSource = () => {
  const start = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_agent_claim_commission');
  const end = SQL.indexOf('REVOKE ALL ON FUNCTION public.fn_agent_claim_commission', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SQL.slice(start, end);
};

describe('the three dead ends are gone', () => {
  it.each(['fn_pay_commission_atomic', 'execute_commission_payout', 'sum_agent_commissions'])(
    'drops %s',
    (fn) => {
      expect(SQL).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${fn}\\(`));
    }
  );

  it('takes the dropped function off the wallet guard allow-list', () => {
    // Bounded at the function's own terminator. Slicing to end-of-file swept in
    // the assertion block below, which names the dropped function on purpose.
    const guardStart = SQL.indexOf('CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write');
    const guard = SQL.slice(guardStart, SQL.indexOf('$function$;', guardStart));
    expect(guard).not.toMatch(/'execute_commission_payout'/);
    // and leaves the rest of the list intact
    expect(guard).toMatch(/'fn_club_bank_send'/);
    expect(guard).toMatch(/'mint_club_chips'/);
  });

  it('refuses to commit if any of them survived', () => {
    expect(SQL).toMatch(/a dead commission function survived this migration/);
  });
});

describe('the claim cannot create chips, and cannot pay twice', () => {
  it('debits the club bank by exactly what it credits', () => {
    expect(SQL).toMatch(/SET chip_treasury = COALESCE\(chip_treasury, 0\) - v_amount/);
    expect(SQL).toMatch(/SET chip_balance = COALESCE\(chip_balance, 0\) \+ v_amount/);
  });

  it('refuses when the club bank is short, naming both figures', () => {
    expect(SQL).toMatch(/IF v_bank_before < v_amount THEN/);
    expect(SQL).toMatch(/'bank_short', true/);
    expect(SQL).toMatch(/The Club Bank Holds /);
    expect(SQL).toMatch(/Ask An Owner To Fund The Bank, Then Claim Again\./);
  });

  it('marks the rows settled - the line the old function never had', () => {
    expect(SQL).toMatch(/UPDATE agent_commissions\s+SET settled_at = now\(\)/);
  });

  it('settles LAST, after both sides of the money have moved', () => {
    // A refusal returns JSON, and a plain RETURN commits rather than rolls
    // back. So if the settle ever rises above the debit, a short bank marks
    // rows paid without paying them. An earlier draft of this migration did
    // exactly that, and this pin is the reason it did not ship.
    const settleAt = SQL.indexOf('SET settled_at = now()');
    const debitAt = SQL.indexOf('SET chip_treasury = COALESCE(chip_treasury, 0) - v_amount');
    const creditAt = SQL.indexOf('SET chip_balance = COALESCE(chip_balance, 0) + v_amount');
    expect(debitAt).toBeGreaterThan(-1);
    expect(settleAt).toBeGreaterThan(debitAt);
    expect(settleAt).toBeGreaterThan(creditAt);
    expect(SQL).toMatch(/the claim marks commission settled before it debits the bank/);
  });

  it('replays a repeated op_id instead of paying again', () => {
    expect(SQL).toMatch(/metadata ->> 'op_id' = v_op_id::text/);
    expect(SQL).toMatch(/'replayed', true/);
  });

  it('writes one ledger row naming both sides', () => {
    expect(SQL).toMatch(/INSERT INTO chip_transactions/);
    expect(SQL).toMatch(/'commission_claim'/);
    expect(SQL).toMatch(/'bank_before', v_bank_before/);
    expect(SQL).toMatch(/'bank_after', v_bank_after/);
  });
});

describe('the claim finishes inside the statement timeout', () => {
  it('settles a bounded batch, not everything owed', () => {
    // The largest agent has 192,135 unsettled rows. Settling them in one
    // statement measured 64.6s against an 8s timeout, and would hold the club
    // row locked for that minute.
    expect(SQL).toMatch(/LIMIT v_batch/);
    expect(SQL).toMatch(/v_batch := LEAST\(GREATEST\(COALESCE\(p_max_rows, 1000\), 1\), 5000\);/);
    expect(SQL).toMatch(/the claim settles an unbounded number of rows/);
  });

  it('does not sort the batch, and does not count what is left', () => {
    // ORDER BY created_at cost 1,194ms; the exact remaining sum cost 1,474ms.
    const fn = claimFunctionSource();
    expect(fn).not.toMatch(/ORDER BY created_at/);
    expect(fn).toMatch(/SELECT EXISTS \(/);
    expect(fn).toMatch(/'more', v_more/);
  });
});

describe('it pays the caller, and only the caller', () => {
  it('takes no payee parameter', () => {
    const signature = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_agent_claim_commission'),
      SQL.indexOf(') RETURNS jsonb')
    );
    expect(signature).not.toMatch(/user_id/);
    expect(SQL).toMatch(/v_actor := auth\.uid\(\);/);
  });

  it('pays a demoted agent too - membership, not role', () => {
    // Phase 4 let a demotion through because "the agents row survives with the
    // figure intact". Requiring an agent role here would have turned that
    // deferral into a confiscation.
    expect(SQL).toMatch(/IN \('active', 'approved'\)/);
    expect(SQL).toMatch(/You Are Not An Active Member Of This Club/);
  });

  it('is not reachable without a session', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_agent_claim_commission\(uuid, uuid, integer\) FROM PUBLIC, anon;/
    );
    expect(SQL).toMatch(/RAISE EXCEPTION 'anon can claim commission'/);
  });
});

describe('commission does not pay the debt down', () => {
  it('never touches credit_used', () => {
    // Dan, 2026-08-31: "THEY PAY THE BALANCE OFF WEEKLY, AND ANY RAKE BACK GOES
    // ON TOP." An agent carrying a debt still squares the invoice in full.
    const fn = claimFunctionSource();
    expect(fn).not.toMatch(/credit_used/);
    expect(SQL).toMatch(/commission must not net against debt/);
  });
});

// September 14, 2026: the user's single automatic Monday process supersedes
// the August 31 manual claim UI. The historical SQL conservation pins above
// remain relevant until the database owner retires that legacy RPC.
describe('the client uses the single automatic weekly settlement path', () => {
  it('contains no manual payout writer', () => {
    expect(SERVICE).not.toMatch(
      /execute_commission_payout|fn_agent_claim_commission|async claimCommission/
    );
    expect(jsCodeOnly(DASHBOARD)).not.toMatch(/claimPayout|claimCommission|Claim Commission/);
  });

  it('retains the authoritative unpaid balance reader', () => {
    expect(SERVICE).toMatch(/fn_agent_unsettled_commission/);
    expect(DASHBOARD).toMatch(/CommissionService\.unsettledCommission/);
    expect(DASHBOARD).toMatch(/Unpaid Commission/);
    expect(DASHBOARD).toMatch(/'Unavailable'/);
  });

  it('shows the schedule without asserting that an unpaid transfer succeeded', () => {
    expect(DASHBOARD).toMatch(/Automatic Weekly Settlement/);
    expect(DASHBOARD).toMatch(/Every Monday At 4:00 AM Central Time/);
    expect(DASHBOARD).toMatch(/Until A Verified Transfer Is Recorded/);
  });

  it('opens the selected club invoice tab through the existing platform bridge', () => {
    expect(DASHBOARD).toMatch(/leaveForHub/);
    expect(DASHBOARD).toMatch(/encodeURIComponent\(resolvedClubId\)/);
    expect(DASHBOARD).toMatch(/&folder=invoices/);
    expect(DASHBOARD).toMatch(/View Invoices/);
  });
});
