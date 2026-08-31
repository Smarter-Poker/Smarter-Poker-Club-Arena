/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN INVOICE BILLS WHAT WAS BORROWED (2026-08-31, phase 1 of 7)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * fn_generate_all_credit_invoices computed an agent's debt as
 *
 *     credit_limit - agent_wallet_balance
 *
 * which is the UNUSED portion of the credit line. The less an agent had
 * borrowed, the larger their bill. Measured on production before the fix:
 *
 *     invoices raised .................. 224
 *     chips billed ..................... 18,047,771
 *     agents.credit_used, whole estate . 0.00
 *     overdue .......................... 184, oldest 2026-07-21
 *     payments ever made ............... 0
 *
 * One agent with a 500,000 line who had never borrowed a chip carried twelve
 * invoices of 500,000. Nobody paid, which is the only reason no money moved:
 * fn_pay_credit_invoice_from_wallet deducts real chips.
 *
 * The second half, found while fixing the first: fn_apply_credit_payment marked
 * the invoice paid and never touched agents.credit_used, so an agent could have
 * paid in full and still owed every chip.
 *
 * Verified against production inside a transaction that was rolled back:
 *   no debt        -> "this agent has drawn no credit, so there is nothing to invoice"
 *   500 drawn      -> billed exactly 500
 *   pay 200        -> applied 200, credit_used 500.00 -> 300.00
 *   overpay 1000   -> clamped to the 300 remaining, credit_used -> 0.00
 *   pay a void one -> "that invoice was voided and is not payable"
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIGRATION = 'supabase/migrations/20260901000001_an_invoice_bills_what_was_borrowed.sql';
const SQL = read(MIGRATION);
const CREDIT_SERVICE = read('src/services/CreditService.ts');

/** A "must not appear" pin has to look at code, not at the comment explaining the bug. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(--|\/\/|\*)/.test(line))
    .join('\n');

const CODE = codeOnly(SQL);

describe('the batch bills the debt, not the headroom', () => {
  it('reads credit_used', () => {
    expect(CODE).toMatch(/COALESCE\(credit_used, 0\) > 0/);
    expect(CODE).toMatch(/v_debt := COALESCE\(v_agent\.credit_used, 0\)/);
  });

  it('never subtracts the wallet balance from the limit again', () => {
    // The exact shape of the bug: credit_limit minus agent_wallet_balance.
    expect(CODE).not.toMatch(/credit_limit[^)\n]*\)?\s*-\s*COALESCE\(\s*agent_wallet_balance/);
    expect(CODE).not.toMatch(/credit_limit\s*-\s*agent_wallet_balance/);
  });
});

describe('the single entry point cannot be talked into over-billing', () => {
  it('refuses a debt larger than the credit actually drawn', () => {
    expect(CODE).toMatch(/an invoice cannot exceed the credit actually drawn/);
    expect(CODE).toMatch(/p_debt_owed > v_used/);
  });

  it('refuses to invoice a prepaid agent at all', () => {
    expect(CODE).toMatch(/a prepaid agent borrows nothing and cannot be invoiced/);
  });

  it('reads the debt from the agents row rather than trusting the caller', () => {
    expect(CODE).toMatch(
      /SELECT COALESCE\(credit_used, 0\)[\s\S]{0,160}FROM public\.agents WHERE id = p_agent_id/
    );
  });
});

describe('paying an invoice pays down the debt', () => {
  it('decrements agents.credit_used in the same transaction', () => {
    expect(CODE).toMatch(
      /UPDATE public\.agents[\s\S]{0,220}credit_used = GREATEST\(COALESCE\(credit_used, 0\) - v_applied, 0\)/
    );
  });

  it('never banks more than is owed', () => {
    expect(CODE).toMatch(
      /v_applied := LEAST\(p_amount, GREATEST\(v_inv\.debt_owed - v_inv\.amount_paid, 0\)\)/
    );
  });

  it('records the amount actually applied, not the amount offered', () => {
    expect(CODE).toMatch(/VALUES \(p_invoice_id, v_applied, p_method\)/);
  });
});

describe('a void invoice is not a bill', () => {
  it('exists as a status', () => {
    expect(CODE).toMatch(/'pending','partial','paid','overdue','disputed','void'/);
  });

  it('says why it was voided', () => {
    expect(CODE).toMatch(/void_reason text/);
  });

  it('refuses payment, and before the wallet is touched', () => {
    // The guard must sit above atomic_deduct_wallet_and_log, not below it: a
    // wallet debited and rolled back is a ledger entry nobody asked for.
    const walletFn = CODE.slice(CODE.indexOf('fn_pay_credit_invoice_from_wallet'));
    const voidGuard = walletFn.indexOf("v_status = 'void'");
    const deduct = walletFn.indexOf('atomic_deduct_wallet_and_log');
    expect(voidGuard).toBeGreaterThan(-1);
    expect(deduct).toBeGreaterThan(-1);
    expect(voidGuard).toBeLessThan(deduct);
  });

  it('voids only invoices nobody ever paid against', () => {
    expect(CODE).toMatch(/COALESCE\(ci\.amount_paid, 0\) = 0/);
  });
});

describe('the migration proves itself', () => {
  it('refuses to commit if a live invoice still over-bills', () => {
    expect(CODE).toMatch(/live invoice\(s\) still bill more than the agent has drawn/);
  });

  it('refuses to commit if the payment path cannot reach the debt', () => {
    expect(CODE).toMatch(/still does not pay down agents\.credit_used/);
  });
});

describe('the client still calls the same three RPCs', () => {
  it('generate, pay-from-wallet and apply are all still wired', () => {
    expect(CREDIT_SERVICE).toMatch(/rpc\('fn_generate_credit_invoice'/);
    expect(CREDIT_SERVICE).toMatch(/rpc\('fn_pay_credit_invoice_from_wallet'/);
    expect(CREDIT_SERVICE).toMatch(/rpc\('fn_apply_credit_payment'/);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * THE CLIENT HALF, found in the completion sweep AFTER the migration shipped.
 *
 * A new status in the database is a new state in every screen that reads it,
 * and four places did not know the word. The last of them would have suspended
 * people.
 * ───────────────────────────────────────────────────────────────────────────
 */
const INVOICES_PANEL = read('src/components/agent/AgentInvoicesPanel.tsx');

describe('the client knows what a void invoice is', () => {
  it('the status union can express it', () => {
    expect(CREDIT_SERVICE).toMatch(
      /InvoiceStatus =\s*'pending' \| 'partial' \| 'paid' \| 'overdue' \| 'disputed' \| 'void'/
    );
  });

  it('there is ONE definition of which statuses still owe money', () => {
    expect(CREDIT_SERVICE).toMatch(/export const OWED_INVOICE_STATUSES/);
    expect(INVOICES_PANEL).toMatch(/OWED_INVOICE_STATUSES/);
    // and the panel imports it rather than keeping a second copy
    expect(INVOICES_PANEL).toMatch(/import \{[\s\S]{0,120}OWED_INVOICE_STATUSES/);
  });

  it('a cancelled invoice cannot trap a settled agent in suspension either', () => {
    // reinstateAgent carried the identical filter. Suspending on a void invoice
    // is bad; refusing to lift it on the same void invoice is worse, because
    // there is nothing the agent can do about it.
    expect(codeOnly(CREDIT_SERVICE)).toMatch(
      /const hasOverdue = invoices\.some\(\s*\(i\) => OWED_INVOICE_STATUSES\.has\(i\.status\)/
    );
  });

  it('a cancelled invoice cannot get an agent suspended', () => {
    // checkSuspension asked `status !== 'paid'`, which counts a void invoice as
    // debt. FinancialCronService reads that answer and calls suspendAgent, so
    // 224 cancelled bills would have suspended every credit agent on the estate.
    expect(codeOnly(CREDIT_SERVICE)).not.toMatch(/i\.status !== 'paid' && new Date\(i\.dueDate\)/);
    expect(CREDIT_SERVICE).toMatch(
      /OWED_INVOICE_STATUSES\.has\(i\.status\) && new Date\(i\.dueDate\) < new Date\(\)/
    );
  });

  it('zero remaining means zero, not "fall back to the whole debt"', () => {
    // `inv.amount_remaining || inv.debt_owed` is falsy-coalescing: 0 became the
    // full original debt, so a settled or voided invoice reported its whole
    // balance as still due and drew a Pay Now button on it.
    expect(codeOnly(CREDIT_SERVICE)).not.toMatch(/amount_remaining \|\| inv\.debt_owed/);
    expect(CREDIT_SERVICE).toMatch(/amountRemaining: inv\.amount_remaining \?\? inv\.debt_owed/);
  });

  it('the pay button asks the status, not only the number', () => {
    expect(INVOICES_PANEL).toMatch(
      /const canPay = OWED_INVOICE_STATUSES\.has\(inv\.status\) && inv\.amountRemaining > 0/
    );
  });

  it('a void invoice has its own colour rather than the unknown-state fallback', () => {
    expect(INVOICES_PANEL).toMatch(/void: '#718096'/);
  });
});
