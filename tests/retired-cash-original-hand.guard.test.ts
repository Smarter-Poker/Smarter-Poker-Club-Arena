import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(__dirname, '..');
const sql = readFileSync(
  resolve(
    root,
    'supabase/migrations/20261006184554_a_retired_cash_hand_keeps_its_original_custody.sql'
  ),
  'utf8'
);
const native = readFileSync(
  resolve(root, 'scripts/qualification/retired-cash-original-hand/anonymous-shapes.sql'),
  'utf8'
);
const refusal = readFileSync(
  resolve(root, 'scripts/qualification/retired-cash-original-hand/atomic-refusal.sql'),
  'utf8'
);
describe('retired cash retains original custody inside the original financial owner', () => {
  it('bounds installation and pins the serial tournament predecessor', () => {
    expect(sql).toContain("SET LOCAL lock_timeout='2s'");
    expect(sql).toContain("SET LOCAL statement_timeout='15s'");
    expect(sql).toContain('0f9432bbd2ac735c53731e6eec75449e');
  });
  it('never restores without original funding, immutable inventory and no native return', () => {
    for (const witness of [
      'cash_hand_participant_manifests',
      'funding_provenance_complete',
      'cash_participant_funding_receipts',
      'cash_seat_move_receipts',
      'union_pnl_inventory_events',
      'patterned_identity_retirements',
      'seat_cashout_receipts',
      'table_cashout_history',
      'wallet_credit_idempotency',
      'ca_mint_ledger',
      "w.type='credit'",
      'l.table_id=c.table_id',
    ])
      expect(sql).toContain(witness);
    expect(sql.indexOf('RETIRED_CASH_IMMUTABLE_CUSTODY_OR_RETURN_CHANGED')).toBeLessThan(
      sql.indexOf('result:=public.fn_ca_restore_erased_seat_credit')
    );
  });
  it('requires coherent current restitution and native same-transaction handoff custody', () => {
    for (const invariant of [
      "l.from_type='issuance_reserve'",
      "l.to_type='player_wallet'",
      'l.chip_ledger_id=ledger',
      "result->>'restored' IS DISTINCT FROM 'true'",
      'r.transaction_id=txid_current()',
      'd.transaction_id=txid_current()',
      'd.request_hash=r.request_hash',
      "r.state='held'",
    ])
      expect(sql).toContain(invariant);
    expect(sql).not.toMatch(/UPDATE\s+public\.club_members\s+SET\s+chip_balance/i);
  });
  it('refuses partial financial and postcommit completion atomically', () => {
    expect(sql).toContain('(retirement_restored OR retired_cash_restored)');
    for (const refusal of [
      'RETIRED_CASH_ORIGINAL_POSTCOMMIT_NOT_COMPLETED',
      'RETIRED_CASH_ORIGINAL_POSTCOMMIT_REFUSED',
      'RETIRED_CASH_ORIGINAL_CUSTODY_NOT_CONSUMED',
    ])
      expect(sql).toContain(refusal);
    expect(sql).toContain("USING ERRCODE='P0404'");
    expect(sql).toContain('accepted_time_bank IS DISTINCT FROM c.original_time_bank');
  });
  it('pins actual eight native function postimages and immutable private authority', () => {
    expect(sql.match(/^-- @live-proof: \(SELECT md5\(pg_get_functiondef/gm)).toHaveLength(8);
    expect(sql).toContain('81fb89ad4db51ca9eb68754ebb8f384f');
    expect(sql).toContain('count(*)=4 AND sum(jsonb_array_length');
    expect(sql).toContain(
      "has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')"
    );
    expect(sql).toContain('pg_get_triggerdef(oid) IN(');
    expect(sql.indexOf('DO $postimage$')).toBeLessThan(sql.lastIndexOf('COMMIT;'));
  });
  it('retains anonymous four-shape native wallet/fee/replay and whole foreign-row assertions', () => {
    for (const index of [1, 2, 3, 4])
      expect(native).toContain(`anonymous_shape(${index});ROLLBACK;`);
    for (const witness of [
      'foreign_before IS DISTINCT FROM foreign_after',
      'currency_after-currency_before<>base-fee-bbj',
      'ANONYMOUS_FUNDING_WALLET_FAILED',
      'ANONYMOUS_REPLAY_CHANGED',
      "stack_result->>'conservation_checked'='true'",
      'p_case=4 THEN 2 ELSE 1',
      'p_case=4 THEN 9 ELSE 6',
    ])
      expect(native).toContain(witness);
    expect(native).not.toContain('16cd2682-cca3-4ea4-a8d9-04931a5153ba');
  });
  it('retains actual two-custody financial and postcommit rollback regressions', () => {
    expect(refusal.match(/PERFORM cash_retirement_native\.anonymous_shape\(4\)/g)).toHaveLength(2);
    for (const witness of [
      'TWO_CUSTODY_FINANCIAL_REFUSAL_ROLLBACK_PASS',
      'TWO_CUSTODY_POSTCOMMIT_REFUSAL_ROLLBACK_PASS',
      'hand_submission_handoffs',
      'hand_atomic_commits',
      'ca_mint_ledger',
      'retired_cash_hand_custody',
    ])
      expect(refusal).toContain(witness);
  });
});

it('enforces actual private custody regressions in the maintained accounting workflow', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const runner = readFileSync(resolve(root, 'scripts/ci/test-retired-cash-custody.py'), 'utf8');
  const probe = readFileSync(
    resolve(root, 'scripts/ci/probes/retired-cash-custody-native.sql'),
    'utf8'
  );
  expect(workflow).toContain(
    'python3 scripts/ci/test-retired-cash-custody.py --pg-bin /usr/lib/postgresql/17/bin'
  );
  expect(runner).toContain(
    "header=s[:s.index('INSERT INTO smarter_private.retired_cash_hand_qualification')]"
  );
  expect(runner).toContain('e.close()');
  expect(probe).toContain('RETIRED_CASH_CUSTODY_NATIVE_PASS');
  expect(probe).toContain('RETIRED_CASH_CUSTODY_TRANSITION_REFUSED');
  expect(probe).toContain('rollback leaked custody');
});
