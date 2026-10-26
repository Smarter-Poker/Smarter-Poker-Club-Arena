import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createRiverAcceptedWindowReader } from './riverAcceptedWindow.js';
const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  calls: [] as { sql: string; values?: unknown[] }[],
  index: true,
  fence: true,
  visibility: true,
  error: false,
  fenceAt: '2026-10-25T20:00:00.000000Z',
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      async connect() {}
      async end() {}
      async query(sql: string, values?: unknown[]) {
        db.calls.push({ sql, values });
        if (db.error) throw Error('private driver configuration');
        if (sql.includes('AS visibility'))
          return {
            rows: [
              {
                visibility: db.visibility,
                clear: db.fence,
                fence_at: db.fenceAt,
              },
            ],
          };
        if (sql.includes('AS ready')) return { rows: [{ ready: db.index }] };
        if (sql.includes('AS read_at'))
          return { rows: [{ read_at: '2026-10-25T20:00:00.000000Z', snapshot_id: '20:30:22,24' }] };
        return { rows: sql.startsWith('SELECT c.') ? db.rows : [] };
      }
    },
  },
}));
const env = {
  DATABASE_URL: 'postgresql://offline:private@synthetic.local/postgres?sslmode=require',
};
const request = {
  startsAt: '2026-10-25T18:00:00.000Z',
  endsAt: '2026-10-25T19:00:00.000Z',
  after: null,
};
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n = 1) => ({
  hand_id: id(n),
  table_id: id(900),
  hand_number: String(n),
  committed_at: '2026-10-25T18:30:00.123456Z',
  core_digest: 'a'.repeat(64),
  payload_digest: 'b'.repeat(64),
  roster_status: 'captured',
  roster_payload_digest: 'b'.repeat(64),
  roster_digest: 'c'.repeat(64),
});
beforeEach(() => {
  db.rows = [row()];
  db.calls = [];
  db.index = true;
  db.fence = true;
  db.visibility = true;
  db.error = false;
  db.fenceAt = '2026-10-25T20:00:00.000000Z';
});
describe('finite indexed accepted window keys', () => {
  it('refuses a finality fence even one microsecond before the exclusive end', async () => {
    const result = await createRiverAcceptedWindowReader(env)({
      ...request,
      endsAt: '2026-10-25T20:00:00.000001Z',
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'window_finality_unavailable' });
    expect(db.calls.some((c) => c.sql.startsWith('BEGIN'))).toBe(false);
  });
  it('preserves a positive sub-millisecond interval and its exact resume cursor', async () => {
    const r = await createRiverAcceptedWindowReader(env)({
      startsAt: '2026-10-25T18:30:00.123100Z',
      endsAt: '2026-10-25T18:30:00.123900Z',
      after: { committedAt: '2026-10-25T18:30:00.123200Z', handId: id(1) },
    });
    expect(r).toMatchObject({
      status: 'accepted_window_page',
      keys: [{ committedAt: '2026-10-25T18:30:00.123456Z' }],
    });
  });
  it('reads all accepted coordinates without pot/card/variant filtering and pins roster payload', async () => {
    const result = await createRiverAcceptedWindowReader(env)(request);
    expect(result).toMatchObject({
      status: 'accepted_window_page',
      hasMore: false,
      next: null,
      completePopulation: false,
      keys: [{ handId: id(1), committedAt: '2026-10-25T18:30:00.123456Z', gaps: [] }],
    });
    const query = db.calls.find((c) => c.sql.startsWith('SELECT c.'))!;
    expect(query.values).toEqual([request.startsAt, request.endsAt, null, null]);
    expect(query.sql).toContain('c.committed_at < $2');
    expect(query.sql).toContain('ORDER BY c.committed_at,c.hand_id LIMIT 129');
    expect(query.sql).not.toMatch(/hole_cards|post_commit_payload::|10\s*\*|hand_history/);
    expect(db.calls.at(-1)?.sql).toBe('COMMIT');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('returns an exact microsecond resume cursor and explicit overflow', async () => {
    db.rows = Array.from({ length: 129 }, (_, i) => row(i + 1));
    const result = await createRiverAcceptedWindowReader(env)(request);
    expect(result).toMatchObject({
      status: 'accepted_window_page',
      hasMore: true,
      next: { committedAt: '2026-10-25T18:30:00.123456Z', handId: id(128) },
      completePopulation: false,
    });
    if (result.status === 'accepted_window_page') expect(result.keys).toHaveLength(128);
  });
  it('retains missing and mismatched source rows as explicit gaps', async () => {
    db.rows = [
      {
        ...row(),
        payload_digest: null,
        roster_status: null,
        roster_digest: null,
        roster_payload_digest: null,
      },
      { ...row(2), roster_payload_digest: 'd'.repeat(64) },
    ];
    const r = await createRiverAcceptedWindowReader(env)(request);
    expect(r).toMatchObject({
      status: 'accepted_window_page',
      keys: [
        { gaps: ['accepted_payload_missing', 'accepted_roster_missing'] },
        { gaps: ['accepted_roster_payload_mismatch'] },
      ],
    });
  });
  it.each([
    'duplicate',
    'order',
    'out-of-window',
    'extra-card',
    'bad-digest',
    'over-budget',
  ] as const)('refuses %s rather than partial success', async (fault) => {
    if (fault === 'duplicate') db.rows.push(row());
    if (fault === 'order') db.rows = [row(2), row(1)];
    if (fault === 'out-of-window') db.rows[0].committed_at = request.endsAt;
    if (fault === 'extra-card') db.rows[0].hole_cards = [];
    if (fault === 'bad-digest') db.rows[0].payload_digest = 'untrusted';
    if (fault === 'over-budget') db.rows = Array.from({ length: 130 }, (_, i) => row(i + 1));
    expect(await createRiverAcceptedWindowReader(env)(request)).toMatchObject({
      status: 'unavailable',
      reason: 'window_reply_refused',
    });
    expect(db.calls.at(-1)?.sql).toBe('ROLLBACK');
  });
  it('refuses missing index before scanning and does not expose query errors', async () => {
    db.index = false;
    expect(await createRiverAcceptedWindowReader(env)(request)).toMatchObject({
      status: 'unavailable',
      reason: 'window_index_unavailable',
    });
    expect(db.calls.some((c) => c.sql.startsWith('SELECT c.'))).toBe(false);
    db.error = true;
    expect(JSON.stringify(await createRiverAcceptedWindowReader(env)(request))).not.toContain(
      'private'
    );
  });
  it('requires full visibility and a clear pre-snapshot late-transaction fence', async () => {
    db.fence = false;
    expect(await createRiverAcceptedWindowReader(env)(request)).toMatchObject({
      status: 'unavailable',
      reason: 'window_finality_unavailable',
    });
    expect(db.calls.some((c) => c.sql.startsWith('BEGIN'))).toBe(false);
    db.fence = true;
    db.visibility = false;
    expect(await createRiverAcceptedWindowReader(env)(request)).toMatchObject({
      status: 'unavailable',
      reason: 'window_finality_unavailable',
    });
    db.visibility = true;
    db.calls = [];
    expect(await createRiverAcceptedWindowReader(env)(request)).toMatchObject({
      status: 'accepted_window_page',
      finalityFenceAt: '2026-10-25T20:00:00.000000Z',
    });
    expect(db.calls[0].sql).toContain('pg_stat_activity');
    expect(db.calls[0].sql).toContain('pg_prepared_xacts');
    expect(db.calls[1].sql).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  });
  it('rejects invalid invocations and absent configuration before connecting', async () => {
    expect(
      await createRiverAcceptedWindowReader(env)({ ...request, endsAt: request.startsAt })
    ).toMatchObject({ status: 'unavailable', reason: 'window_request_refused' });
    expect(await createRiverAcceptedWindowReader({})(request)).toMatchObject({
      status: 'unavailable',
      reason: 'window_configuration_unavailable',
    });
    expect(db.calls).toEqual([]);
  });
});
