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
 * The admin tab now shows only canonical club weekly summaries. Preserve the
 * no-browser-payer law without requiring this club surface to read or expose
 * individual commission claims. A summary is neither a claim button nor a
 * balance inferred from the currently visible rows.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceMethod } from './helpers/sourceWindow';

const SRC = readFileSync(join(__dirname, '..', 'src', 'pages', 'AdminDashboardPage.tsx'), 'utf8');
// Comments describe the bug that was removed; they must not satisfy or defeat
// a pin about the code.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const TAB = sliceMethod(CODE, 'function SettlementsTab(');
const SUMMARY = readFileSync(
  join(__dirname, '..', 'src/components/accounting/ClubWeeklyAccountingSummary.tsx'),
  'utf8'
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const READER = readFileSync(
  join(__dirname, '..', 'src/services/ClubWeeklyAccountingReader.ts'),
  'utf8'
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('the settlements tab does not write to the commission ledger', () => {
  /* THE LEDGER IS REACHED BY THREE NAMES (2026-09-08, phase 7). The table
     itself, and the two views over it - v_agent_commissions (which resolves
     settled_at across both payers) and agent_commissions_unsettled (still
     owed). Round 2 stopped stamping settled_at on 20260908025653, so this
     screen reads the view; a law that only knew the table's name would have
     gone vacuously green the moment it did. */
  it('never deletes from the commission ledger', () => {
    expect(CODE).not.toMatch(
      /from\('(?:v_)?agent_commissions(?:_unsettled)?'\)[\s\S]{0,200}\.delete\(\)/
    );
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

  it('uses the real weekly summary without reading individual commissions or dispatching a payer', () => {
    expect(TAB).toMatch(/<ClubWeeklyAccountingSummary\s+clubId=\{clubId\}\s*\/>/);
    expect(CODE).toMatch(
      /activeTab\s*===\s*'settlements'\s*&&\s*<SettlementsTab\s+clubId=\{clubId\}/
    );
    for (const source of [CODE, SUMMARY, READER]) {
      expect(source).not.toMatch(/from\('(?:v_)?agent_commissions(?:_unsettled)?'\)/);
    }
    for (const source of [TAB, SUMMARY, READER]) {
      expect(source).not.toMatch(/\.(delete|update|insert|upsert|rpc)\s*\(/);
    }
  });
});

describe('it shows verified club weekly records rather than individual claims', () => {
  it('queries only canonical summaries for the selected club and verifies their returned scope', () => {
    expect(READER).toMatch(/CLUB_WEEKLY_INVOICE_TYPE\s*=\s*'club_weekly_accounting'/);
    expect(READER).toMatch(
      /\.from\('settlement_invoices'\)\s*\.select\(COLUMNS\)\s*\.eq\('club_id',\s*clubId\)\s*\.eq\('invoice_type',\s*CLUB_WEEKLY_INVOICE_TYPE\)/
    );
    expect(READER).toMatch(/value\.club_id\s*!==\s*clubId/);
    expect(READER).toMatch(/value\.invoice_type\s*!==\s*CLUB_WEEKLY_INVOICE_TYPE/);
    expect(READER).toMatch(/value\.summary_club_id\s*!==\s*clubId/);
    expect(READER).toMatch(/value\.summary_period_id\s*!==\s*value\.period_id/);
  });

  it('labels received, paid and retained summary amounts without exposing claim actions', () => {
    expect(SUMMARY).toMatch(/<th>Rake Received<\/th>/);
    expect(SUMMARY).toMatch(/<th>Rakeback Paid<\/th>/);
    expect(SUMMARY).toMatch(/<th>Rake Retained<\/th>/);
    expect(SUMMARY).toMatch(/formatWeeklyChips\(row\.rakeFunding\)/);
    expect(SUMMARY).toMatch(/formatWeeklyChips\(row\.paidByClub\)/);
    expect(SUMMARY).toMatch(/formatWeeklyChips\(row\.retainedByClub\)/);
    expect(`${TAB}\n${SUMMARY}`).not.toMatch(
      /Awaiting Claim|Mark Paid|Mark All As Paid|Fund The Bank/
    );
  });

  it('bounds the visible issued records without presenting them as a current bank balance', () => {
    expect(READER).toMatch(/CLUB_WEEKLY_STATEMENT_LIMIT\s*=\s*50/);
    expect(SUMMARY).toMatch(
      /readClubWeeklyStatements\(\{\s*clubId,\s*userId:\s*user\.id,\s*limit:\s*CLUB_WEEKLY_STATEMENT_LIMIT,\s*isCurrent:\s*current,?\s*\}\)/
    );
    expect(SUMMARY).toContain(
      'Latest Up To {CLUB_WEEKLY_STATEMENT_LIMIT} Issued Weekly Summaries.'
    );
    expect(`${TAB}\n${SUMMARY}`).not.toMatch(/chip_treasury|bankBalance|\.reduce\(/);
  });

  it('uses exact verified weekly funding, paid and retained amounts instead of summing claims', () => {
    expect(READER).toContain('gross_amount::text,deductions::text,net_amount::text');
    expect(READER).toMatch(/funding\s*=\s*cents\(value\.gross_amount\)/);
    expect(READER).toMatch(/paid\s*=\s*cents\(value\.deductions\)/);
    expect(READER).toMatch(/retained\s*=\s*cents\(value\.net_amount,\s*true\)/);
    expect(READER).toMatch(/funding\s*-\s*paid\s*!==\s*retained/);
    expect(READER).toMatch(/funding\s*!==\s*cents\(value\.total_rake_funding\)/);
    expect(READER).toMatch(/paid\s*!==\s*cents\(value\.total_paid_by_club\)/);
    expect(READER).toMatch(/retained\s*!==\s*cents\(value\.retained_by_club,\s*true\)/);
  });

  it('keeps unavailable reads distinct from an empty club history and fences stale responses', () => {
    expect(READER).toMatch(
      /if\s*\(error\)\s*throw new Error\('Weekly Statements Are Unavailable'\)/
    );
    expect(SUMMARY).toMatch(
      /const current\s*=\s*\(\)\s*=>\s*scope\(\)\s*&&\s*sequence\.current\s*===\s*read/
    );
    expect(SUMMARY).toMatch(
      /if\s*\(current\(\)\)\s*setObservation\(\{\s*scope,\s*read,\s*phase:\s*'unavailable',\s*rows:\s*\[\]\s*\}\)/
    );
    expect(SUMMARY).toMatch(
      /unavailable\s*&&\s*\(?\s*<p\s+role="alert">\s*Weekly Summaries Are Unavailable/
    );
    expect(SUMMARY).toMatch(/!loading\s*&&\s*!unavailable\s*&&\s*current\?\.phase\s*===\s*'ready'/);
    expect(SUMMARY).toContain('No Issued Weekly Summaries Were Found For This Club.');
  });
});
