/**
 * LAW: AN ADMIN SCREEN NEVER DELETES A LEDGER ROW TO MEAN "PAID".
 *
 * 2026-09-08. `AdminDashboardPage`'s settlements tab offered "Mark Paid" per
 * commission and "Mark All As Paid" for the whole period. Both DELETED rows
 * from `agent_commissions` - the commission ledger itself.
 *
 * Three faults, worst last:
 *
 *  1. IT NEVER RAN. RLS on agent_commissions grants writes to `service_role`
 *     alone; `authenticated` holds read policies and nothing else. A browser
 *     DELETE matched zero rows, PostgREST returned no error, and the operator
 *     was told it worked. `n_tup_del` on that table is 1, ever - and pay_all
 *     was aimed at every commission row in the club for the period.
 *  2. DELETING A LEDGER ROW IS NOT A PAYMENT. It destroys the record of what
 *     was owed rather than recording that it was settled. Since phase 8 the
 *     append-only guard refuses the DELETE outright.
 *  3. AN ADMIN DOES NOT PAY AN AGENT'S COMMISSION AT ALL. The platform's path
 *     is fn_agent_claim_commission, which deliberately takes no p_user_id -
 *     "a parameter naming somebody else would make this a way to move another
 *     person's earnings, and Dan's rule is that agents handle their own
 *     payouts."
 *
 * Every pin below is one of those. A control that reports success without
 * doing anything is worse than no control, because it stops anybody looking.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'src', 'pages', 'AdminDashboardPage.tsx'), 'utf8');
// Comments describe the bug that was removed; they must not satisfy or defeat
// a pin about the code.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the settlements tab does not write to the commission ledger', () => {
  it('never deletes from agent_commissions', () => {
    expect(CODE).not.toMatch(/from\('agent_commissions'\)[\s\S]{0,200}\.delete\(\)/);
  });

  it('has no pay or pay_all action left to call', () => {
    expect(CODE).not.toMatch(/actionName === 'pay'/);
    expect(CODE).not.toMatch(/actionName === 'pay_all'/);
    expect(CODE).not.toMatch(/doAction\('pay'/);
    expect(CODE).not.toMatch(/doAction\('pay_all'/);
  });

  it('offers no button claiming to mark a commission paid', () => {
    expect(CODE).not.toMatch(/Mark Paid/);
    expect(CODE).not.toMatch(/Mark All As Paid/);
  });

  it('writes nothing at all to agent_commissions from the browser', () => {
    // Read-only: RLS would refuse anything else, silently.
    const calls = [...CODE.matchAll(/from\('agent_commissions'\)([\s\S]{0,160})/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, tail] of calls) {
      expect(tail).toMatch(/\.select\(/);
      expect(tail).not.toMatch(/\.(delete|update|insert|upsert)\(/);
    }
  });
});

describe('it tells the truth about what is owed instead', () => {
  it('reads settled_at, the column the claim actually stamps', () => {
    expect(CODE).toMatch(/settled_at/);
  });

  it('shows a status rather than an action', () => {
    expect(CODE).toMatch(/Awaiting Claim/);
    expect(CODE).toMatch(/Claimed/);
  });

  it('surfaces the club bank, which is the real blocker on a claim', () => {
    // fn_agent_claim_commission refuses when chip_treasury < amount owed, and
    // funding the bank is the one part of this an operator controls.
    expect(CODE).toMatch(/chip_treasury/);
    expect(CODE).toMatch(/Fund The Bank/);
  });

  it('counts only unclaimed rows toward what the bank must cover', () => {
    expect(CODE).toMatch(/filter\(\(c\) => !c\.settled_at\)/);
  });

  it('never reports a balance it could not read as zero', () => {
    /* A discarded error would make bankBalance 0 and put "the club bank
       cannot cover what agents are owed" on the screen because we could not
       ask. That is the same false alarm the fee reconciler raised 23 times on
       2026-09-08, and the ratchet in discardedErrorReadRatchet.test.ts caught
       this very line. Unknown must render as unknown. */
    expect(CODE).toMatch(/error: bankErr/);
    expect(CODE).toMatch(/bankErr \|\| clubRow == null \? null :/);
    expect(CODE).toMatch(/Could Not Be Read/);
  });
});
