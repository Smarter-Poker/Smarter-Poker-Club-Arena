import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(__dirname, '..');
const sql = readFileSync(
  resolve(
    root,
    'supabase/migrations/20261007002407_completed_retired_cash_hands_retain_their_original_base_cust.sql'
  ),
  'utf8'
);
const expected = JSON.parse(sql.match(/\$cases\$([\s\S]*?)\$cases\$::jsonb/)![1]);
const positive = readFileSync(
  resolve(root, 'scripts/qualification/completed-retired-cash-bases/anonymous-positive.sql'),
  'utf8'
);
const boundaries = readFileSync(
  resolve(root, 'scripts/qualification/completed-retired-cash-bases/anonymous-boundaries.sql'),
  'utf8'
);
const canonicalBody = sql.match(/DO \$restitution\$([\s\S]*?)END \$restitution\$;/)![1];
describe('completed retired hands return only the original proven base', () => {
  it('qualifies exactly23 original occupancies with completed positive negative and zero deltas', () => {
    expect(expected).toHaveLength(23);
    expect(new Set(expected.map((x: any) => x.occupancy)).size).toBe(23);
    expect(expected.reduce((n: number, x: any) => n + Number(x.base), 0)).toBeCloseTo(9404.73, 2);
    let zero = 0;
    for (const x of expected) {
      expect(Number(x.stack.stack_before)).toBe(Number(x.base));
      expect(x.inventory_before.occupancy_id).toBe(x.occupancy);
      expect(x.stack.user_id).toBe(x.user);
      expect(x.manifest_participant.funding_lineage.issues).toEqual([]);
      expect(x.hashes.request_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(x.hashes.stack_md5).toMatch(/^[0-9a-f]{32}$/);
      const delta = x.stack.stack - x.stack.stack_before;
      if (delta === 0) {
        zero++;
        expect(x.departed).toBeNull();
        expect(x.key).toBeNull();
        expect(x.ledger).toBeNull();
      } else {
        expect(x.departed).toHaveLength(1);
        expect(x.departed[0].delta).toBe(delta);
        expect(x.key.amount).toBe(delta);
        expect(x.ledger).toHaveLength(1);
        expect(x.ledger[0].amount).toBe(Math.abs(delta));
      }
    }
    expect(zero).toBe(5);
    expect(expected.filter((x: any) => x.retained_seat)).toHaveLength(3);
    expect(expected.filter((x: any) => !x.manifest_complete)).toHaveLength(2);
  });
  it('keeps all immutable and no-return admission before native current issuance', () => {
    const credit = sql.indexOf('result:=public.fn_ca_restore_erased_seat_credit');
    for (const token of [
      'src.request_hash IS DISTINCT FROM',
      'post_commit_completed_at IS NULL',
      'stack_md5',
      'post_md5',
      'payload_hash',
      'inventory.before_row @> (item->',
      'retained_seat',
      'funding_lineage,issues',
      'funding.source_ledger_id',
      'funding.wallet_transaction_id',
      'cash_seat_move_receipts',
      'seat_cashout_receipts',
      'table_cashout_history',
      'ZERO_DELTA_CHANGED',
      'BASE_ALREADY_RETURNED_OR_KEY_COLLISION',
    ]) {
      expect(sql.indexOf(token)).toBeGreaterThan(0);
      expect(sql.indexOf(token)).toBeLessThan(credit);
    }
    for (const pin of [
      '6307d1d0ae4f208de54dd5a0e13985d5',
      '2e60c4b66468b51061018a9058e9a395',
      'e1b0b9702e75378ecac634c3a879502e',
      'cbab2d426b0ec091b5b09f3e76eec640',
    ])
      expect(sql).toContain(pin);
    expect(sql).toContain("l.from_type='issuance_reserve'");
    expect(sql).toContain("l.action='mint'");
    expect(sql).toContain('FOREIGN_OR_RETAINED_CHAIR_CHANGED');
    expect(sql).not.toMatch(
      /UPDATE public\.|DELETE FROM|fn_ca_commit_hand_settlement\(|fn_ca_resume_hand_submission\(/
    );
    expect(sql).toContain("SET LOCAL lock_timeout='2s'");
    expect(sql).toContain("SET LOCAL statement_timeout='15s'");
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
  it('binds the actual anonymous native proof to the complete production financial body', () => {
    const anonymousBody = canonicalBody
      .replace(
        /expected jsonb := \$cases\$[\s\S]*?\$cases\$::jsonb;/,
        'expected jsonb := (SELECT payload FROM anonymous_completed_expected);'
      )
      .replaceAll('<>23', '<>4')
      .replaceAll('<>9404.73', '<>575');
    expect(positive).toContain(anonymousBody);
    expect(boundaries).toContain(anonymousBody);
    for (const token of [
      'NATIVE_FOUR_BASE_PARTIAL_FAULT_ROLLBACK_PASS',
      'NATIVE_INDIVIDUAL_ISSUANCE_575_AND_REPLAY_AND_THREE_CLOSED_SEAT_INGRESS_PASS',
      'CASHOUT_STALE_OCCUPANCY',
      'no_active_seat',
      'REPLAY_CHANGED_STATE',
      'CLOSED_ORIGINAL_REFUND_CHANGED_STATE',
    ])
      expect(boundaries).toContain(token);
    expect(positive.trimEnd().endsWith('ROLLBACK;')).toBe(true);
    expect(boundaries.trimEnd().endsWith('ROLLBACK;')).toBe(true);
  });
});
