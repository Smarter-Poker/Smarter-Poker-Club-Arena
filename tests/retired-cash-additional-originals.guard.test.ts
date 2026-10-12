import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(__dirname, '..');
const sql = readFileSync(
  resolve(
    root,
    'supabase/migrations/20261007000750_five_additional_retired_cash_originals_retain_their_custody.sql'
  ),
  'utf8'
);
const native = readFileSync(
  resolve(root, 'scripts/qualification/retired-cash-original-hand/additional-anonymous-shapes.sql'),
  'utf8'
);
const refusal = readFileSync(
  resolve(root, 'scripts/qualification/retired-cash-original-hand/additional-positive-refusal.sql'),
  'utf8'
);
const rows = Array.from(sql.matchAll(/\$qualified\$(.*?)\$qualified\$::jsonb/g), (m) =>
  JSON.parse(m[1])
);
describe('additional retired originals retain immutable native custody authority', () => {
  it('extends only five originals and seven occupancies through the exact predecessor', () => {
    expect(rows).toHaveLength(5);
    expect(rows.reduce((n, r) => n + r.participants.length, 0)).toBe(7);
    expect(new Set(rows.map((r) => r.submission_id)).size).toBe(5);
    expect(
      rows.reduce(
        (n, r) => n + r.participants.reduce((a: any, p: any) => a + p.stack.stack_before, 0),
        0
      )
    ).toBeCloseTo(1295.8, 2);
    expect(sql).toContain('992019226ea1c06a3514a9087ac70be5');
    expect(sql).toContain('81fb89ad4db51ca9eb68754ebb8f384f');
    expect(sql).toContain("version='20261006184554'");
    expect(sql).toContain(')<>4');
    expect(sql).toContain(')<>9');
  });
  it('preserves original hashes, funding manifests, force-exit witnesses and timebanks', () => {
    for (const r of rows) {
      expect(r.request_hash).toMatch(/^[0-9a-f]{64}$/);
      for (const p of r.participants) {
        expect(p.stack.user_id).toBe(p.manifest_participant.user_id);
        expect(p.stack.occupancy_id).toBe(p.manifest_participant.occupancy_id);
        expect(p.stack.stack_before).toBe(p.inventory_before.stack);
        expect(p.stack.seat_id).toBe(p.inventory_before.id);
        expect(p.time_bank.occupancy_id).toBe(p.stack.occupancy_id);
        expect(p.manifest_funding_complete).toBe(true);
        expect(p.manifest_participant.funding_lineage.issues).toEqual([]);
      }
    }
    for (const token of [
      's.request_hash IS DISTINCT FROM q.request_hash',
      'hand_atomic_commits',
      'hand_submission_handoffs',
      'hand_submission_disposals',
      'm.funding_provenance_complete',
      'e.before_row @> (item->',
    ])
      expect(sql).toContain(token);
  });
  it('performs no financial operation or source replacement', () => {
    expect(sql).not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION|UPDATE public\.|DELETE FROM|(?:SELECT|PERFORM) public\.fn_ca_resume_hand_submission|PERFORM.*restore/i
    );
    expect(
      sql.match(/INSERT INTO smarter_private.retired_cash_hand_qualification VALUES/g) || []
    ).toHaveLength(5);
    expect(sql).toContain("SET LOCAL lock_timeout='2s'");
    expect(sql).toContain("SET LOCAL statement_timeout='15s'");
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    const envelope = readFileSync(
      resolve(
        root,
        'scripts/qualification/retired-cash-original-hand/additional-authority-envelope.sql'
      ),
      'utf8'
    );
    expect(envelope).toContain(sql.match(/DO \$preimage\$[\s\S]*?END \$preimage\$;/)![0]);
    let authority = sql.match(/DO \$authority\$[\s\S]*?END \$authority\$;/)![0];
    const shapeByHand: Record<number, number> = {
      26113905: 5,
      26113946: 6,
      26114038: 7,
      26113937: 8,
      26113907: 9,
    };
    for (const r of rows)
      authority = authority.replaceAll(
        r.submission_id,
        '89400000-0000-0000-0000-' + String(shapeByHand[r.hand_number]).padStart(12, '0')
      );
    expect(envelope).toContain(authority);
    expect(envelope.trimEnd().endsWith('ROLLBACK;')).toBe(true);
  });
  it('retains anonymous four/five player and positive-delta actual owner shapes', () => {
    expect(native).toContain('WHEN 5 THEN 5 WHEN 6 THEN 5 WHEN 7 THEN 4 WHEN 8 THEN 9 ELSE 6');
    expect(native).toContain('WHEN 7 THEN -6');
    expect(native).toContain('ELSE -195');
    for (const x of [
      'currency_after-currency_before<>base-fee-bbj',
      'foreign_before IS DISTINCT FROM foreign_after',
      'ANONYMOUS_REPLAY_CHANGED',
      'ROLLBACK;',
    ])
      expect(native).toContain(x);
    expect(refusal).toContain('anonymous_shape(9)');
    expect(refusal).toContain('POSITIVE_TWO_CUSTODY_FINANCIAL_REFUSAL_ROLLBACK_PASS');
    expect(refusal).toContain('POSITIVE_TWO_CUSTODY_POSTCOMMIT_REFUSAL_ROLLBACK_PASS');
  });
});
