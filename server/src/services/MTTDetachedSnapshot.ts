/** INERT proposed read envelope. No provider, RPC, currentness token or production caller. */
export const MTT_DETACHED_SCHEMA = 'mtt-detached-snapshot-proposal-1';
export const MTT_DETACHED_LIMITS = Object.freeze({
  bytes: 262144, depth: 24, tables: 16, lineage: 32, rows: 64,
});
type Json = null | boolean | string | readonly Json[] | { readonly [key: string]: Json };
type Row = { readonly [key: string]: Json };
export type SnapshotIssue = Readonly<{
  kind: 'malformed' | 'unsupported' | 'unresolved' | 'overflow';
  path: string;
  code: string;
}>;
export interface DetachedSnapshotResult {
  readonly status: 'malformed' | 'unsupported' | 'unresolved' | 'overflow';
  readonly canonicalAuthority: 'unqualified';
  /** Exact original transport text, including unknown/invalid/orphan material. Never a capability. */
  readonly rawEnvelope: string;
  /** Complete immutable parsed envelope when syntax/byte bounds permit; never a filtered subset. */
  readonly evidence: Json | null;
  readonly issues: readonly SnapshotIssue[];
}

class DecodeFault extends Error {
  constructor(readonly kind: SnapshotIssue['kind'], readonly code: string) { super(code); }
}
const fault = (code: string, kind: SnapshotIssue['kind'] = 'malformed'): never => {
  throw new DecodeFault(kind, code);
};

/** Proposed projection uses strings for ALL SQL numbers. Opaque row JSON stays verbatim text.
 * Reject duplicate keys (including escaped aliases), numeric tokens and excessive nesting BEFORE
 * JSON.parse can silently coalesce keys or round integers. No user objects/getters are accepted.
 */
function parseProjection(text: string): Json {
  let at = 0;
  const whitespace = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') { at++; continue; }
      if (char === '"') {
        try { return JSON.parse(text.slice(start, at)) as string; }
        catch { return fault('invalid_json_string'); }
      }
    }
    return fault('unterminated_string');
  };
  const value = (depth: number): Json => {
    if (depth > MTT_DETACHED_LIMITS.depth) return fault('depth_limit', 'overflow');
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === '{') {
      at++; whitespace();
      const result: Record<string, Json> = Object.create(null);
      if (text[at] === '}') { at++; return Object.freeze(result); }
      while (at < text.length) {
        whitespace();
        if (text[at] !== '"') return fault('object_key');
        const key = string();
        if (Object.prototype.hasOwnProperty.call(result, key)) return fault('duplicate_key');
        whitespace();
        if (text[at++] !== ':') return fault('missing_colon');
        result[key] = value(depth + 1); whitespace();
        const end = text[at++];
        if (end === '}') return Object.freeze(result);
        if (end !== ',') return fault('object_separator');
      }
      return fault('unterminated_object');
    }
    if (char === '[') {
      at++; whitespace();
      const result: Json[] = [];
      if (text[at] === ']') { at++; return Object.freeze(result); }
      while (at < text.length) {
        result.push(value(depth + 1)); whitespace();
        const end = text[at++];
        if (end === ']') return Object.freeze(result);
        if (end !== ',') return fault('array_separator');
      }
      return fault('unterminated_array');
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, at)) { at += token.length; return parsed; }
    }
    return fault(/[0-9-]/.test(char || 'x') ? 'numeric_token_requires_text' : 'invalid_json');
  };
  const result = value(0); whitespace();
  if (at !== text.length) return fault('trailing_json');
  return result;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxInt64 = 9223372036854775807n;
const identity = ['admission_id', 'tournament_id', 'table_id', 'lifecycle',
  'lease_generation', 'custody_id', 'admission_revision'] as const;
const admissionKeys = ['admission_id', 'table_id', 'tournament_id', 'lifecycle',
  'origin_generation', 'original_custody_id', 'protocol_epoch', 'enrollment_token',
  'revision', 'state', 'predecessor_admission_id', 'retirement_break_id',
  'retirement_custody_id', 'retirement_operation_revision', 'terminal_receipt'] as const;
const intentKeys = [...identity, 'permit_id', 'hand_number', 'origin_generation',
  'original_custody_id', 'state', 'terminal_permit_id', 'canonical_terminal_verified'] as const;
const permitKeys = ['permit_id', 'tournament_id', 'table_id', 'lifecycle', 'hand_number',
  'custody_id', 'generation', 'state', 'evidence_id'] as const;
const supportingRelations = [
  'smarter_private.f06_operations', 'public.tournament_table_origins',
  'public.tables', 'public.hand_atomic_commits', 'public.hand_history',
  'public.settlement_idempotency_keys',
  'public.tournament_launch_receipts', 'public.tournament_capacity_table_receipts',
  'smarter_private.mtt_original_entry_rosters',
] as const;
// Durable original-role storage has no accepted relation/export ABI in this source intake.
const pendingAssociations = ['accepted_roles'] as const;

/** This is a structural observation decoder only. Even a clean input remains unresolved. */
export function decodeMTTDetachedSnapshot(rawEnvelope: string): DetachedSnapshotResult {
  const issues: SnapshotIssue[] = [];
  let evidence: Json | null = null;
  const add = (kind: SnapshotIssue['kind'], path: string, code: string) => {
    issues.push(Object.freeze({ kind, path, code }));
  };
  const object = (input: Json | undefined, path: string): Row => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      add('malformed', path, 'object_required'); return Object.freeze({});
    }
    return input as Row;
  };
  const exact = (row: Row, keys: readonly string[], path: string) => {
    if (Object.keys(row).length !== keys.length || keys.some(key => !(key in row)))
      add('malformed', path, 'exact_projection_keys');
  };
  const uuid = (x: Json | undefined, path: string, nullable = false) => {
    if (!(nullable && x === null) && (typeof x !== 'string' || !uuidPattern.test(x)))
      add('malformed', path, 'canonical_uuid_text');
  };
  const integer = (x: Json | undefined, path: string, hand = false, nullable = false) => {
    if (nullable && x === null) return;
    if (typeof x !== 'string' || !/^[1-9][0-9]{0,18}$/.test(x) ||
        BigInt(x) > (hand ? 9007199254740991n : maxInt64) ||
        (hand && BigInt(x) < 1000000n)) add('malformed', path, 'exact_positive_integer_text');
  };
  const same = (a: Json | undefined, b: Json | undefined, path: string) => {
    if (a === undefined || b === undefined || a !== b) add('unresolved', path, 'identity_mismatch');
  };
  const rows = (x: Json | undefined, path: string, cap: number): readonly Json[] => {
    if (!Array.isArray(x)) { add('malformed', path, 'array_required'); return []; }
    if (x.length > cap) add('overflow', path, 'row_limit_or_sentinel');
    // Entire original array remains in evidence/rawEnvelope even when bounded inspection stops.
    return x.slice(0, cap);
  };
  const state = (x: Json | undefined, allowed: readonly string[], path: string) => {
    if (typeof x !== 'string' || !allowed.includes(x)) add('unsupported', path, 'unknown_state');
  };
  const rawRow = (x: Json | undefined, path: string) => {
    // Deliberately not JSON.parse: retain arbitrary SQL numeric and timestamp precision.
    // This text is NOT decoded/validated row authority or a verified accepted receipt.
    if (typeof x !== 'string' || x.length === 0) add('malformed', path, 'raw_row_text_required');
  };
  try {
    if (rawEnvelope.length > MTT_DETACHED_LIMITS.bytes ||
        new TextEncoder().encode(rawEnvelope).byteLength > MTT_DETACHED_LIMITS.bytes)
      fault('envelope_byte_limit', 'overflow');
    evidence = parseProjection(rawEnvelope);
    const root = object(evidence, '$');
    exact(root, ['schema', 'read_status', 'provenance', 'current_reader', 'dependencies'], '$');
    if (root.schema !== MTT_DETACHED_SCHEMA) add('unsupported', '$.schema', 'unknown_schema');
    state(root.read_status, ['returned', 'permission_denied', 'query_failed', 'timeout', 'sink_failed'], '$.read_status');
    if (root.read_status !== 'returned') add('unresolved', '$.read_status', 'read_not_completed_cancellation_unknown');
    const provenance = object(root.provenance, '$.provenance');
    exact(provenance, ['database_identity', 'snapshot_text', 'operation_receipt'], '$.provenance');
    for (const key of ['database_identity', 'snapshot_text', 'operation_receipt']) rawRow(provenance[key], '$.provenance.' + key);
    const reader = object(root.current_reader, '$.current_reader');
    exact(reader, identity, '$.current_reader');
    for (const key of identity) {
      if (key === 'lifecycle' || key === 'admission_revision') integer(reader[key], '$.current_reader.' + key);
      else uuid(reader[key], '$.current_reader.' + key);
    }
    const tables = rows(root.dependencies, '$.dependencies', MTT_DETACHED_LIMITS.tables);
    if (!tables.length) add('unresolved', '$.dependencies', 'missing_dependency_tables');
    const tableIds = new Set<Json>();
    let readerFound = false;
    for (const [index, tableValue] of tables.entries()) {
      const path = `$.dependencies[${index}]`;
      const table = object(tableValue, path);
      exact(table, ['table_id', 'tournament_id', 'current_admission_id', 'lineage', 'frontier',
        'unresolved_intents', 'reserved_permits', 'orphan_rows', 'supporting_rows',
        'pending_associations', 'coverage'], path);
      for (const key of ['table_id', 'tournament_id', 'current_admission_id']) uuid(table[key], path + '.' + key);
      same(table.tournament_id, reader.tournament_id, path + '.tournament_id');
      if (tableIds.has(table.table_id ?? null)) add('malformed', path, 'duplicate_dependency_table');
      tableIds.add(table.table_id ?? null);
      const isReader = table.table_id === reader.table_id;
      if (isReader) { readerFound = true; same(table.current_admission_id, reader.admission_id, path); }
      const lineage = rows(table.lineage, path + '.lineage', MTT_DETACHED_LIMITS.lineage);
      const admissions = new Map<Json, Row>();
      let previous: Row | undefined;
      for (const [n, value] of lineage.entries()) {
        const p = path + `.lineage[${n}]`;
        const row = object(value, p); exact(row, admissionKeys, p);
        for (const key of ['admission_id', 'table_id', 'tournament_id', 'origin_generation', 'original_custody_id']) uuid(row[key], p + '.' + key);
        for (const key of ['predecessor_admission_id', 'retirement_break_id', 'retirement_custody_id']) uuid(row[key], p + '.' + key, true);
        for (const key of ['lifecycle', 'protocol_epoch', 'revision']) integer(row[key], p + '.' + key);
        integer(row.retirement_operation_revision, p + '.retirement_operation_revision', false, true);
        if (typeof row.enrollment_token !== 'string' || !/^[0-9a-f]{64}$/.test(row.enrollment_token)) add('malformed', p, 'enrollment_token');
        state(row.state, ['ACTIVE', 'RETIRING', 'TERMINAL'], p + '.state');
        same(row.table_id, table.table_id, p); same(row.tournament_id, table.tournament_id, p);
        if (admissions.has(row.admission_id ?? null)) add('unresolved', p, 'duplicate_or_cycle');
        admissions.set(row.admission_id ?? null, row);
        if (previous) {
          same(previous.predecessor_admission_id, row.admission_id, p);
          if (row.state !== 'TERMINAL') add('unresolved', p, 'predecessor_not_terminal');
          // Only compare already canonical integer text, without a Number conversion.
          if (typeof row.protocol_epoch === 'string' && typeof previous.protocol_epoch === 'string' &&
              /^[1-9][0-9]{0,18}$/.test(row.protocol_epoch) &&
              /^[1-9][0-9]{0,18}$/.test(previous.protocol_epoch) &&
              BigInt(row.protocol_epoch) >= BigInt(previous.protocol_epoch)) add('unresolved', p, 'nondecreasing_epoch');
        } else {
          same(row.admission_id, table.current_admission_id, p);
          if (row.state !== 'ACTIVE') add('unresolved', p, 'current_not_active');
          if (isReader) for (const [a, b] of [['lifecycle', 'lifecycle'], ['origin_generation', 'lease_generation'],
            ['original_custody_id', 'custody_id'], ['revision', 'admission_revision']]) same(row[a], reader[b], p + '.' + a);
        }
        if (row.state === 'ACTIVE') {
          for (const key of ['retirement_break_id', 'retirement_custody_id', 'retirement_operation_revision', 'terminal_receipt'])
            if (row[key] !== null) add('unresolved', p + '.' + key, 'active_retirement_fields');
        } else if (row.state === 'RETIRING' || row.state === 'TERMINAL') {
          for (const key of ['retirement_break_id', 'retirement_custody_id', 'retirement_operation_revision'])
            if (row[key] == null) add('unresolved', p + '.' + key, 'missing_retirement_identity');
          if (row.state === 'TERMINAL') rawRow(row.terminal_receipt, p + '.terminal_receipt');
          else if (row.terminal_receipt !== null) add('unresolved', p, 'premature_terminal_receipt');
        }
        previous = row;
      }
      if (!previous || previous.predecessor_admission_id !== null) add('unresolved', path, 'lineage_root_missing');
      const decodeIntent = (value: Json | undefined, p: string): Row => {
        const row = object(value, p); exact(row, intentKeys, p);
        for (const key of [...identity, 'permit_id']) {
          if (key === 'lifecycle' || key === 'admission_revision') integer(row[key], p + '.' + key);
          else uuid(row[key], p + '.' + key);
        }
        integer(row.hand_number, p + '.hand_number', true);
        uuid(row.terminal_permit_id, p + '.terminal_permit_id', true);
        same(row.lease_generation, row.origin_generation, p + '.origin_generation');
        same(row.custody_id, row.original_custody_id, p + '.original_custody_id');
        same(row.table_id, table.table_id, p); same(row.tournament_id, table.tournament_id, p);
        state(row.state, ['INTENT', 'BOUND', 'TERMINAL'], p + '.state');
        if (typeof row.canonical_terminal_verified !== 'boolean') add('malformed', p, 'terminal_verifier_boolean');
        if (row.state === 'TERMINAL') {
          same(row.terminal_permit_id, row.permit_id, p);
          if (row.canonical_terminal_verified !== true) add('unresolved', p, 'terminal_unverified');
        } else if (row.terminal_permit_id !== null || row.canonical_terminal_verified !== false) add('unresolved', p, 'nonterminal_terminal_fields');
        const admission = admissions.get(row.admission_id ?? null);
        if (!admission) add('unresolved', p, 'intent_outside_lineage');
        else {
          for (const key of ['table_id', 'tournament_id', 'lifecycle', 'origin_generation', 'original_custody_id']) same(row[key], admission[key], p + '.' + key);
          // Allocation binds the ACTIVE revision; retirement later increments the admission
          // revision without changing the retained original intent revision.
          if (admission.state === 'ACTIVE') same(row.admission_revision, admission.revision, p + '.admission_revision');
        }
        return row;
      };
      const decodePermit = (value: Json | undefined, p: string): Row => {
        const row = object(value, p); exact(row, permitKeys, p);
        for (const key of ['permit_id', 'tournament_id', 'table_id', 'custody_id', 'generation']) uuid(row[key], p + '.' + key);
        uuid(row.evidence_id, p + '.evidence_id', true);
        integer(row.lifecycle, p + '.lifecycle'); integer(row.hand_number, p + '.hand_number', true);
        same(row.table_id, table.table_id, p); same(row.tournament_id, table.tournament_id, p);
        state(row.state, ['reserved', 'accepted', 'never_started'], p + '.state');
        if ((row.state === 'reserved') !== (row.evidence_id === null)) add('unresolved', p, 'permit_evidence_disposition');
        return row;
      };
      const seenHands = new Set<Json>(); const seenPermits = new Set<Json>();
      let priorHand: bigint | undefined;
      for (const [n, value] of rows(table.frontier, path + '.frontier', MTT_DETACHED_LIMITS.rows).entries()) {
        const p = path + `.frontier[${n}]`; const joined = object(value, p);
        exact(joined, ['intent', 'permit'], p);
        // Nullable sides preserve a broken join; they are never silently inner-joined away.
        if (joined.intent === null || joined.permit === null) add('unresolved', p, 'orphan_frontier');
        const intent = joined.intent === null ? null : decodeIntent(joined.intent, p + '.intent');
        const permit = joined.permit === null ? null : decodePermit(joined.permit, p + '.permit');
        const row = intent ?? permit;
        if (!row) continue;
        for (const [key, set] of [['hand_number', seenHands], ['permit_id', seenPermits]] as const) {
          if (set.has(row[key] ?? null)) add('unresolved', p, 'duplicate_frontier_identity');
          set.add(row[key] ?? null);
        }
        if (typeof row.hand_number === 'string' && /^[1-9][0-9]{0,18}$/.test(row.hand_number)) {
          const hand = BigInt(row.hand_number);
          if (priorHand !== undefined && hand >= priorHand) add('unresolved', p, 'frontier_order');
          priorHand = hand;
        }
        if (intent && permit) {
          for (const key of ['permit_id', 'tournament_id', 'table_id', 'lifecycle', 'hand_number', 'custody_id']) same(intent[key], permit[key], p + '.' + key);
          same(intent.lease_generation, permit.generation, p + '.generation');
          if ((permit.state === 'reserved' && intent.state !== 'BOUND') ||
              ((permit.state === 'accepted' || permit.state === 'never_started') && intent.state !== 'TERMINAL')) add('unresolved', p, 'intent_permit_state');
        }
        if (intent?.state !== 'TERMINAL' || permit?.state === 'reserved') add('unresolved', p, 'unresolved_frontier');
      }
      const unresolved = rows(table.unresolved_intents, path + '.unresolved_intents', MTT_DETACHED_LIMITS.rows);
      const reserved = rows(table.reserved_permits, path + '.reserved_permits', MTT_DETACHED_LIMITS.rows);
      unresolved.forEach((value, n) => {
        const p = path + `.unresolved_intents[${n}]`;
        const row = decodeIntent(value, p);
        if (row.state !== 'INTENT' && row.state !== 'BOUND') add('unresolved', p, 'unresolved_population_state');
      });
      reserved.forEach((value, n) => {
        const p = path + `.reserved_permits[${n}]`;
        const row = decodePermit(value, p);
        if (row.state !== 'reserved') add('unresolved', p, 'reserved_population_state');
      });
      if (unresolved.length || reserved.length) add('unresolved', path, 'all_table_unresolved_evidence');
      const decodeRawRows = (value: Json | undefined, p: string) => {
        const list = rows(value, p, MTT_DETACHED_LIMITS.rows);
        list.forEach((item, n) => {
          const r = object(item, p + `[${n}]`); exact(r, ['relation', 'raw_row_json'], p + `[${n}]`);
          if (!supportingRelations.includes(r.relation as typeof supportingRelations[number])) add('unsupported', p + `[${n}]`, 'unknown_relation_retained');
          rawRow(r.raw_row_json, p + `[${n}].raw_row_json`);
        });
        return list;
      };
      if (decodeRawRows(table.orphan_rows, path + '.orphan_rows').length) add('unresolved', path, 'orphan_or_legacy_evidence');
      decodeRawRows(table.supporting_rows, path + '.supporting_rows');
      const pending = object(table.pending_associations, path + '.pending_associations');
      exact(pending, pendingAssociations, path + '.pending_associations');
      for (const name of pendingAssociations) {
        // No speculative role ABI. Null means unavailable; text is retained unqualified.
        if (pending[name] !== null) rawRow(pending[name], path + '.pending_associations.' + name);
      }
      const coverage = object(table.coverage, path + '.coverage');
      exact(coverage, ['lineage', 'frontier', 'unresolved', 'orphans'], path + '.coverage');
      for (const name of ['lineage', 'frontier', 'unresolved', 'orphans']) {
        state(coverage[name], ['reported_complete', 'incomplete', 'overflow', 'unknown'], path + '.coverage.' + name);
        if (coverage[name] === 'overflow') add('overflow', path + '.coverage.' + name, 'export_sentinel');
        else if (coverage[name] !== 'reported_complete') add('unresolved', path + '.coverage.' + name, 'incomplete_coverage');
      }
    }
    if (!readerFound) add('unresolved', '$.dependencies', 'current_reader_dependency_missing');
    add('unresolved', '$', 'read_seam_roles_receipts_continuity_coverage_and_consumer_authority_unqualified');
  } catch (error) {
    if (!(error instanceof DecodeFault)) throw error;
    add(error.kind, '$', error.code);
  }
  const status = (['overflow', 'malformed', 'unsupported', 'unresolved'] as const)
    .find(kind => issues.some(issue => issue.kind === kind)) ?? 'unresolved';
  return Object.freeze({ status, canonicalAuthority: 'unqualified', rawEnvelope, evidence,
    issues: Object.freeze(issues) });
}
