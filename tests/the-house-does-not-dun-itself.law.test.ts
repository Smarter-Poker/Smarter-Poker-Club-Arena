/**
 * THE HOUSE DOES NOT DUN ITSELF (2026-10-02, launch-gate sweep).
 *
 * Pinned on migration 20261002165500. Club JAQK, SHARK CLUB and Midway Union
 * share one owner, so their weekly square-ups are a debt the owner owes
 * himself: the union waives the four open ones with credit notes (no chip
 * moves, nothing is marked paid) and the stop-loss sweep restores both clubs.
 * The push-deliverability light reads the channel an incident recipient is
 * routed to: the Production Alerts inbox for a recipient whose incidents
 * fn_is_owner_operational_notification routes there, a push receipt for
 * everyone else.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, '../supabase/migrations/20261002165500_the_house_does_not_dun_itself.sql');
const sql = readFileSync(FILE, 'utf8');
const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('the house does not dun itself', () => {
  it('is one transaction with a preimage on the body it replaces', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/fn_ca_negative_balance_watch'::regproc\)\) INTO v_live;/);
    expect(sql).toMatch(/'b8756eefab9d7a751f202bcd5b66bc90'/);
    expect(sql).not.toMatch(/^\s*DROP\b/im);
  });

  it('waives only the four open house square-ups, after proving one owner on all three books', () => {
    expect(sql).toMatch(/count\(DISTINCT owner_id\)/);
    for (const [num, owed] of [
      ['MIDWAY-2026-000005', '33222.29'],
      ['MIDWAY-2026-000006', '11242.82'],
      ['MIDWAY-2026-000008', '42719.62'],
      ['MIDWAY-2026-000010', '35117.39'],
    ]) {
      expect(sql).toContain(`('${num}', `);
      expect(sql).toContain(owed);
    }
    expect(sql).toMatch(/public\.fn_union_issue_credit_note\(\s*r\.id, r\.remaining,/);
    expect(sql).toMatch(/'House settlement 2026-10-02: /);
    // a waiver, not a payment that never happened
    expect(sql).not.toMatch(/ca_union_set_statement_paid\(/);
    expect(sql).not.toMatch(/chip_ledger|chip_treasury\s*=/);
    expect(sql).toMatch(/waive: a house square-up still reads outstanding/);
  });

  it('the power light reads the inbox for a routed recipient and a push receipt for everyone else', () => {
    const f = body('fn_ca_negative_balance_watch');
    expect(f).toMatch(
      /fn_is_owner_operational_notification\(rec\.user_id, 'financial_incident', NULL, NULL\)/
    );
    expect(f).toMatch(/o\.source = 'owner-operational-notifications'/);
    expect(f).toMatch(/COALESCE\(s\.last_receipt_at, s\.created_at\) > now\(\) - interval '48 hours'/);
    expect(f).toMatch(/'push-deliverability:' \|\| to_char\(now\(\), 'YYYY-MM-DD'\)/);
    // the negative-balance siren itself is unchanged
    expect(f).toMatch(/'negative-balance:' \|\| r\.store \|\| ':' \|\| r\.who/);
  });
});
