import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (p: string) => readFileSync(p, 'utf8');
const migration = read(
  'supabase/migrations/20261026150531_the_mint_watch_recognizes_its_completed_issuance_receipt_and.sql'
);
describe('completed mint receipts and explicit investigation', () => {
  it('preserves the limits and binds the actual completed Mint receipt', () => {
    for (const pin of [
      "c.fn_name = 'fn_ca_mint'",
      'c.finalized_at IS NOT NULL',
      'c.result @> jsonb_build_object(',
      "'ledger_id', l.id",
      "'amount', l.amount",
      "'target_id', m.holder_id",
      "l.idempotency_key = 'mint:' || m.op_id",
      'm.balance_after = m.balance_before + m.amount',
      'IF v_ops > 3 THEN',
      'IF v_mint > 250000 THEN',
      "ELSE 'union_bank' END",
    ])
      expect(migration).toContain(pin);
  });
  it('stamps only linked explicit actions and preserves terminal investigations', () => {
    expect(migration).toContain('WHERE e.id = d.inbox_event_id');
    expect(migration).toContain(
      "d.original_notification->'data'->>'incident_id' = p_incident_id::text"
    );
    expect(migration).toContain("WHEN e.investigation_status = 'new'");
    expect(migration).toContain("THEN 'investigating' ELSE e.investigation_status END");
    expect(migration).not.toMatch(/cron\.(schedule|alter_job)/);
  });
  it('runs real PostgreSQL regression on relevant shared inputs', () => {
    const workflow = read('.github/workflows/informational-alert-state.yml');
    expect(workflow).toContain('supabase/migrations/**');
    expect(workflow).toContain('run: python3 scripts/ci/test-alert-ledger-roots.py');
    expect(read('scripts/ci/test-alert-ledger-roots.py')).toContain('preimage reproduced');
  });
});
