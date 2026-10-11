/**
 * ===========================================================================
 *  LAW - A UNION SEND IS SUPPRESSED ONLY AS A RETRY TO THE SAME MEMBER
 * ===========================================================================
 *
 * Cashier launch audit C6-02, 2026-10-09. fn_union_send_to_member_zd3core
 * answers success with duplicate_suppressed when "an identical union send"
 * was recorded in the last 20 seconds. Its query matched the union, the
 * amount and the actor only, so a send of the same amount to a DIFFERENT
 * member, or of the other kind, inside 20 seconds was answered success while
 * nothing moved. Migration 20261010004314 matches the kind's own union-side
 * row AND the recipient-side ledger leg that send journalled in the same
 * transaction. Qualified by scripts/ci/test-union-send-db-postgres.py on
 * production's live body and wrapper.
 *
 * Registry: docs/laws.d/a-union-send-is-suppressed-only-as-a-retry.md
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';

const FILE = '20261010004314_a_union_send_is_suppressed_only_as_a_retry_to_the_same_membe.sql';
const DEFINES = /create\s+or\s+replace\s+function\s+public\.fn_union_send_to_member_zd3core\s*\(/i;
const squash = (s: string): string => s.replace(/\s+/g, ' ');

const NEWEST = migrationNames()
  .filter((n) => DEFINES.test(migrationText(n)))
  .at(-1)!;
const TEXT = migrationText(NEWEST);
const START = TEXT.search(DEFINES);
const BODY = squash(TEXT.slice(START, TEXT.indexOf('$function$;', START)));
const SUPPRESSION = BODY.slice(
  BODY.indexOf("if p_kind in ('chips','promo') and exists ("),
  BODY.indexOf("'duplicate_suppressed', true")
);

describe('a union send is suppressed only as a retry to the same member', () => {
  it('is defined last by the migration that fixed it, or by one that keeps the fix', () => {
    expect(NEWEST >= FILE).toBe(true);
    expect(SUPPRESSION.length).toBeGreaterThan(0);
  });

  it('still matches the union, the amount, the actor and the 20 second window', () => {
    expect(SUPPRESSION).toContain('where t.union_id = p_union_id');
    expect(SUPPRESSION).toContain('and t.amount = p_amount');
    expect(SUPPRESSION).toContain('and t.created_by is not distinct from v_actor');
    expect(SUPPRESSION).toContain("and t.created_at > now() - interval '20 seconds'");
  });

  it('matches the kind', () => {
    expect(SUPPRESSION).toContain(
      "and t.tx_type = case when p_kind = 'promo' then 'promo_member_send' else 'member_send' end"
    );
  });

  it('matches the recipient, through the ledger leg the same send journalled', () => {
    expect(SUPPRESSION).toContain(
      'select 1 from chip_ledger l where l.to_entity_id = p_target_user_id and l.created_at = t.created_at'
    );
    expect(SUPPRESSION).toContain(
      "and l.from_type = 'union_wallet' and l.from_entity_id = p_union_id"
    );
    expect(SUPPRESSION).toContain(
      "and l.category = case when p_kind = 'promo' then 'promo_send' else 'union_send' end and l.amount = p_amount"
    );
  });
});
