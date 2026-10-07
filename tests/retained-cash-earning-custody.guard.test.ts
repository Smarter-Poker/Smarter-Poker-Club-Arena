import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const sql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261007020733_a_retained_cash_hand_keeps_its_earning_club_while_closing.sql'
  ),
  'utf8'
);
const positive = readFileSync(
  resolve(
    __dirname,
    '../scripts/qualification/retired-cash-original-hand/anonymous-shared-union-closing.sql'
  ),
  'utf8'
);
const boundaries = readFileSync(
  resolve(
    __dirname,
    '../scripts/qualification/retired-cash-original-hand/anonymous-shared-union-boundaries.sql'
  ),
  'utf8'
);
describe('retained cash earning stays with proven original custody', () => {
  it('requires the same accepted transaction and exact immutable original participant before using its funding club', () => {
    for (const token of [
      "r.state='consumed'",
      'r.transaction_id=txid_current()',
      'h.transaction_id=r.transaction_id',
      'h.request_hash=r.request_hash',
      's.request_hash=r.request_hash',
      'q.request_hash=r.request_hash',
      'r.accepted_time_bank=r.original_time_bank',
      'r.settlement_id IS NOT NULL',
      'a.hand_id=r.submission_id',
      "e#>>'{stack,occupancy_id}'",
      "e#>>'{stack,seat_joined_at}'",
      "e->>'funding_club_id'",
    ])
      expect(sql).toContain(token);
    expect(sql).toContain("AND t.lifecycle IN('live','breaking')");
    expect(sql).not.toMatch(
      /UPDATE public\.(?:table_seats|club_members)|INSERT INTO public\.(?:chip_ledger|ca_mint_ledger)/
    );
  });
  it('pins exact native preimages and restricted postimages in the maintained installer envelope', () => {
    for (const pin of [
      '81fb89ad4db51ca9eb68754ebb8f384f',
      'efb0c06347c4a12f91ec796558f8660d',
      'cb60a3624bb45d03dbd77c4d8cdc3305',
      '0327409fe4751720376893776b124c60',
    ])
      expect(sql).toContain(pin);
    expect(sql).toContain("SET LOCAL lock_timeout='2s'");
    expect(sql).toContain("SET LOCAL statement_timeout='15s'");
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/-- @live-proof:/g)).toHaveLength(2);
    expect(sql).toContain("NOT has_function_privilege('authenticated',oid,'EXECUTE')");
    expect(sql).toContain("provolatile='s'");
  });
  it('retains real shared-union fees, closing, replacement refusal, replay and full financial rollback fixtures', () => {
    for (const token of [
      'INSERT INTO public.unions',
      'is_private=false',
      "lifecycle='breaking'",
      'currency_after-currency_before<>base-fee-bbj',
      'ANONYMOUS_FOREIGN_CHAIR_CHANGED',
      'ANONYMOUS_REPLAY_CHANGED',
    ])
      expect(positive).toContain(token);
    for (const token of [
      'cash_earning_seat_provenance_missing_or_ambiguous',
      'ANONYMOUS_POSTCOMMIT_FAULT',
      'ANONYMOUS_POSTCOMMIT_FAULT_DID_NOT_ROLL_BACK_ALL',
    ])
      expect(boundaries).toContain(token);
  });
});
