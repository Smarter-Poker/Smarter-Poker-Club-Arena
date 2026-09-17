// Authored for protected execution. UNRUN: source-only assignment0110.
import { expect, test } from 'vitest';
import { decodeMTTDetachedSnapshot, MTT_DETACHED_SCHEMA, MTT_DETACHED_LIMITS } from './MTTDetachedSnapshot.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const reader = { admission_id: id(1), tournament_id: id(2), table_id: id(3), lifecycle: '1',
    lease_generation: id(4), custody_id: id(5), admission_revision: '1' };
  const admission = { admission_id: id(1), tournament_id: id(2), table_id: id(3), lifecycle: '1',
    origin_generation: id(4), original_custody_id: id(5), protocol_epoch: '1',
    enrollment_token: 'a'.repeat(64), revision: '1', state: 'ACTIVE',
    predecessor_admission_id: null as string | null, retirement_break_id: null as string | null,
    retirement_custody_id: null as string | null, retirement_operation_revision: null as string | null,
    terminal_receipt: null as string | null };
  const intent = { ...reader, permit_id: id(6), hand_number: '1000001',
    origin_generation: id(4), original_custody_id: id(5), state: 'TERMINAL',
    terminal_permit_id: id(6) as string | null, canonical_terminal_verified: true };
  const permit = { permit_id: id(6), tournament_id: id(2), table_id: id(3), lifecycle: '1',
    hand_number: '1000001', custody_id: id(5), generation: id(4), state: 'accepted', evidence_id: id(7) as string | null };
  return { schema: MTT_DETACHED_SCHEMA, read_status: 'returned',
    provenance: { database_identity: 'fixture-only', snapshot_text: '100:104:101', operation_receipt: 'fixture-receipt' },
    current_reader: reader,
    dependencies: [{ table_id: id(3), tournament_id: id(2), current_admission_id: id(1),
      lineage: [admission], frontier: [{ intent: intent as typeof intent | null, permit: permit as typeof permit | null }],
      unresolved_intents: [] as typeof intent[], reserved_permits: [] as typeof permit[],
      orphan_rows: [] as { relation: string; raw_row_json: string }[],
      supporting_rows: [] as { relation: string; raw_row_json: string }[],
      pending_associations: { accepted_roles: null },
      coverage: { lineage: 'reported_complete', frontier: 'reported_complete', unresolved: 'reported_complete', orphans: 'reported_complete' },
    }],
  };
}
const decode = (value: unknown) => decodeMTTDetachedSnapshot(JSON.stringify(value));
const codes = (result: ReturnType<typeof decode>) => result.issues.map(issue => issue.code);

test('complete structural observation is detached, immutable and never authoritative', () => {
  const f = fixture(); const raw = JSON.stringify(f); const result = decodeMTTDetachedSnapshot(raw);
  expect(result.status).toBe('unresolved');
  expect(codes(result)).toEqual(['read_seam_roles_receipts_continuity_coverage_and_consumer_authority_unqualified']);
  expect(result.canonicalAuthority).toBe('unqualified'); expect(result.rawEnvelope).toBe(raw);
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.evidence)).toBe(true);
  expect(result).not.toHaveProperty('rosterVersion'); expect(result).not.toHaveProperty('assertCurrent');
  f.current_reader.lifecycle = '2'; expect(JSON.stringify(result.evidence)).toContain('"lifecycle":"1"');
});

test.each(['9007199254740992', '999999', '01', '1e6', '1.0', '-1'])('rejects invalid hand text %s without Number rounding', hand => {
  const f = fixture(); f.dependencies[0].frontier[0].intent!.hand_number = hand;
  expect(codes(decode(f))).toContain('exact_positive_integer_text');
});

test('maximum hand and full int64 lifecycle remain exact text', () => {
  const f = fixture(); const t = f.dependencies[0];
  f.current_reader.lifecycle = t.lineage[0].lifecycle = t.frontier[0].intent!.lifecycle = t.frontier[0].permit!.lifecycle = '9223372036854775807';
  t.frontier[0].intent!.hand_number = t.frontier[0].permit!.hand_number = '9007199254740991';
  expect(codes(decode(f))).not.toContain('exact_positive_integer_text');
});

test('rejects numeric JSON tokens and duplicate escaped keys before JSON.parse can lose evidence', () => {
  for (const raw of ['{"x":9007199254740993}', '{"x":"a","\\u0078":"b"}']) {
    const r = decodeMTTDetachedSnapshot(raw); expect(r.status).toBe('malformed'); expect(r.rawEnvelope).toBe(raw);
  }
});

test.each(['{', '[] garbage', '{"x":true,}', '[null,]', '{"x":"\\q"}'])('malformed JSON returns refusal: %s', raw => {
  expect(decodeMTTDetachedSnapshot(raw).status).toBe('malformed');
});

test('preserves original aliases and rejects cross-identity evidence', () => {
  const f = fixture(); f.dependencies[0].frontier[0].intent!.origin_generation = id(99);
  f.dependencies[0].frontier[0].permit!.custody_id = id(98);
  const r = decode(f); expect(codes(r)).toContain('identity_mismatch');
  expect(r.rawEnvelope).toContain(id(99)); expect(r.rawEnvelope).toContain(id(98));
});

test('unknown states survive in full evidence as unsupported', () => {
  const f = fixture(); f.dependencies[0].frontier[0].intent!.state = 'NEW_UNKNOWN_STATE';
  const r = decode(f); expect(r.status).toBe('unsupported'); expect(JSON.stringify(r.evidence)).toContain('NEW_UNKNOWN_STATE');
});

test('accepted and reserved permit populations cannot share acceptance semantics', () => {
  const f = fixture(); f.dependencies[0].frontier[0].permit!.state = 'reserved';
  expect(codes(decode(f))).toContain('permit_evidence_disposition');
  expect(codes(decode(f))).toContain('intent_permit_state');
});

test('older unresolved and orphan reserved evidence cannot disappear behind the accepted frontier', () => {
  const f = fixture(); const t = f.dependencies[0];
  t.unresolved_intents.push({ ...t.frontier[0].intent!, permit_id: id(20), hand_number: '1000000',
    state: 'INTENT', terminal_permit_id: null, canonical_terminal_verified: false, admission_id: id(90) });
  t.reserved_permits.push({ ...t.frontier[0].permit!, permit_id: id(21), hand_number: '1000000', state: 'reserved', evidence_id: null });
  const r = decode(f); expect(codes(r)).toContain('intent_outside_lineage');
  expect(codes(r)).toContain('all_table_unresolved_evidence'); expect(r.rawEnvelope).toContain(id(21));
});

test('broken nullable frontier join and legacy accepted orphan are retained', () => {
  const f = fixture(); f.dependencies[0].frontier[0].intent = null;
  f.dependencies[0].orphan_rows.push({ relation: 'public.hand_atomic_commits', raw_row_json: '{"legacy_missing_request":true}' });
  const r = decode(f); expect(codes(r)).toContain('orphan_frontier');
  expect(codes(r)).toContain('orphan_or_legacy_evidence'); expect(JSON.stringify(r.evidence)).toContain('legacy_missing_request');
});

test('raw numeric and microsecond timestamp receipt text is preserved without parsing or acceptance', () => {
  const f = fixture(); const raw = '{"amount":9007199254740993.000001,"at":"2026-09-15T01:02:03.123456+00:00"}';
  f.dependencies[0].supporting_rows.push({ relation: 'public.settlement_idempotency_keys', raw_row_json: raw });
  const r = decode(f); expect(JSON.stringify(r.evidence)).toContain(JSON.stringify(raw).slice(1, -1));
  expect(r.status).toBe('unresolved'); expect(r.canonicalAuthority).toBe('unqualified');
});

test('unknown raw relation is retained, not ignored', () => {
  const f = fixture(); f.dependencies[0].supporting_rows.push({ relation: 'new.unknown', raw_row_json: '{"x":1}' });
  const r = decode(f); expect(codes(r)).toContain('unknown_relation_retained'); expect(r.rawEnvelope).toContain('new.unknown');
});

test('lineage gaps, cycles, reused-table identity and epoch inversions refuse', () => {
  const f = fixture(); const t = f.dependencies[0];
  t.lineage[0].predecessor_admission_id = id(1);
  t.lineage.push({ ...t.lineage[0], table_id: id(99) });
  const r = decode(f);
  for (const code of ['duplicate_or_cycle', 'identity_mismatch', 'nondecreasing_epoch', 'lineage_root_missing']) expect(codes(r)).toContain(code);
});

test('out-of-order and duplicate frontier cannot choose an older anchor', () => {
  const f = fixture(); f.dependencies[0].frontier.push(f.dependencies[0].frontier[0]);
  const r = decode(f); expect(codes(r)).toContain('duplicate_frontier_identity'); expect(codes(r)).toContain('frontier_order');
});

test.each(['lineage', 'frontier', 'unresolved', 'orphans'] as const)('export %s overflow refuses even an empty row page', key => {
  const f = fixture(); f.dependencies[0].coverage[key] = 'overflow';
  expect(decode(f).status).toBe('overflow');
});

test('row cap retains sentinel and all original bytes, without accepting a truncated scan', () => {
  const f = fixture(); const t = f.dependencies[0];
  t.frontier = Array.from({ length: MTT_DETACHED_LIMITS.rows + 1 }, () => t.frontier[0]);
  const r = decode(f); expect(r.status).toBe('overflow');
  expect(r.rawEnvelope).toBe(JSON.stringify(f)); expect(JSON.stringify(r.evidence)).toBe(JSON.stringify(f));
});

test('byte and depth overflow do not parse or return a shortened valid envelope', () => {
  const raw = ' '.repeat(MTT_DETACHED_LIMITS.bytes + 1);
  expect(decodeMTTDetachedSnapshot(raw)).toMatchObject({ status: 'overflow', rawEnvelope: raw, evidence: null });
  expect(decodeMTTDetachedSnapshot('['.repeat(30) + 'null' + ']'.repeat(30)).status).toBe('overflow');
  expect(decodeMTTDetachedSnapshot('"' + '€'.repeat(100000) + '"').status).toBe('overflow');
});

test('missing anti-join coverage and counterfactual table mismatch stay unresolved', () => {
  const f = fixture(); f.dependencies[0].coverage.orphans = 'unknown';
  f.dependencies.push({ ...f.dependencies[0], table_id: id(80), tournament_id: id(81) });
  const r = decode(f); expect(codes(r)).toContain('incomplete_coverage'); expect(codes(r)).toContain('identity_mismatch');
});

test('timeout is retained and does not assert remote cancellation', () => {
  const f = fixture(); f.read_status = 'timeout';
  expect(codes(decode(f))).toContain('read_not_completed_cancellation_unknown');
});

test('malformed nested object instead of state or integer cannot invoke coercion', () => {
  const f = fixture(); const raw = JSON.stringify(f).replace('"protocol_epoch":"1"', '"protocol_epoch":{}').replace('"state":"accepted"', '"state":{}');
  expect(() => decodeMTTDetachedSnapshot(raw)).not.toThrow(); expect(decodeMTTDetachedSnapshot(raw).status).toBe('malformed');
});

// Source-review finding0110; these regression controls are authored, not executed.
test.each(['frontier', 'unresolved_intents'] as const)('ACTIVE revision mismatch is diagnosed in %s', population => {
  const f = fixture(); const t = f.dependencies[0];
  if (population === 'unresolved_intents') {
    t.unresolved_intents.push({ ...t.frontier[0].intent!, state: 'INTENT',
      terminal_permit_id: null, canonical_terminal_verified: false });
    t.frontier = [];
  }
  const path = population === 'frontier'
    ? '$.dependencies[0].frontier[0].intent.admission_revision'
    : '$.dependencies[0].unresolved_intents[0].admission_revision';
  const baseline = decode(f);
  expect(baseline.issues.some(issue => issue.path === path)).toBe(false);
  const intent = population === 'frontier' ? t.frontier[0].intent! : t.unresolved_intents[0];
  intent.admission_revision = '2';
  const changed = decode(f);
  expect(changed.issues).toContainEqual({ kind: 'unresolved', path, code: 'identity_mismatch' });
  expect(changed.rawEnvelope).toBe(JSON.stringify(f));
  expect(changed.canonicalAuthority).toBe('unqualified');
  intent.admission_revision = '1';
  expect(decode(f).issues).toEqual(baseline.issues);
});

test('terminal predecessor retains allocation revision despite later retirement increments', () => {
  const f = fixture(); const t = f.dependencies[0];
  const predecessor = { ...t.lineage[0], admission_id: id(30), state: 'TERMINAL', revision: '3',
    retirement_break_id: id(31), retirement_custody_id: id(32), retirement_operation_revision: '1',
    terminal_receipt: '{"retained_original_receipt":"unqualified"}' };
  t.lineage[0].protocol_epoch = '2';
  t.lineage[0].predecessor_admission_id = predecessor.admission_id;
  t.lineage.push(predecessor);
  t.frontier[0].intent!.admission_id = predecessor.admission_id;
  t.frontier[0].intent!.admission_revision = '1';
  const result = decode(f);
  expect(result.issues).toEqual([{ kind: 'unresolved', path: '$',
    code: 'read_seam_roles_receipts_continuity_coverage_and_consumer_authority_unqualified' }]);
  expect(result.canonicalAuthority).toBe('unqualified');
  expect(result.rawEnvelope).toBe(JSON.stringify(f));
});
