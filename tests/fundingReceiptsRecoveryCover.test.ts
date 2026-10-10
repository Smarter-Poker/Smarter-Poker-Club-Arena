import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
const path = 'supabase/migrations/20261010030115_funding_receipts_recovery_covering_scan.sql';
const sql = readFileSync(path, 'utf8');
describe('the funding census cover uses the maintained concurrent installation route', () => {
 it('splits exactly one nonunique whole-relation covering index from its guarded transaction', () => {
  const parsed = splitConcurrentPreamble(sql);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.indexes).toHaveLength(1);
  expect(parsed.indexes[0]).toMatchObject({ name: 'idx_tournament_funding_recovery_cover', schema: 'public', table: 'tournament_participant_funding_receipts' });
  expect(parsed.indexes[0].statement).toContain('(ledger_id) INCLUDE(asset,amount,wallet_transaction_id)');
  expect(parsed.indexes[0].statement).not.toMatch(/\b(?:WHERE|UNIQUE)\b/i);
  expect(parsed.body).toContain('funding_recovery_cover_shape_changed');
  expect(parsed.body).toContain('NOT ix.indisvalid OR NOT ix.indisready OR NOT ix.indislive');
  expect(parsed.body).toContain('ix.indpred IS NOT NULL');
  expect(parsed.body).toContain('ix.indnkeyatts<>1 OR ix.indnatts<>4');
 });
 it('does not modify a financial row, authority, constraint, runtime or budget', () => {
  expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|ALTER|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|statement_timeout|VACUUM|ANALYZE)\b/i);
  expect(sql).not.toContain('is_horse');
 });
});
