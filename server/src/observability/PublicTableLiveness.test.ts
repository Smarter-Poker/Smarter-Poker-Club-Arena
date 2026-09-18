import { describe, expect, it } from 'vitest';
import {
  parsePublicTableLivenessQuery as parse,
  selectPublicTableLiveness as select,
  MAX_PUBLIC_LIVENESS_TABLES,
  type PublicTableLiveness,
} from './PublicTableLiveness.js';

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const club = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherClub = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const table = (n: number, overrides: Partial<PublicTableLiveness> = {}) => ({
  tableId: id(n),
  gameFormat: 'mtt' as const,
  clubId: club,
  seated: 6,
  dealable: 6,
  handCount: n,
  msSinceProgress: 100,
  loopPhase: 'dealing+100ms',
  paused: false,
  running: true,
  privateLease: 'must-not-leave-process',
  hiddenCards: ['As', 'Ad'],
  ...overrides,
});

describe('explicit public table progress scope', () => {
  it('leaves ordinary/cache-busted health probes unexpanded', () => {
    expect(parse(new URLSearchParams())).toEqual({ ok: true });
    expect(parse(new URLSearchParams('cb=123'))).toEqual({ ok: true });
  });
  it('normalizes and deduplicates an explicit bounded table list', () => {
    expect(
      parse(
        new URLSearchParams({ liveness_table_ids: [id(1).toUpperCase(), id(1), id(2)].join(',') })
      )
    ).toEqual({ ok: true, query: { kind: 'tables', tableIds: [id(1), id(2)] } });
  });
  it.each(['mtt', 'spin', 'sng'])('requires exact %s and explicit club scope', (format) => {
    expect(
      parse(
        new URLSearchParams({ liveness_format: format, liveness_club_ids: `${club},${otherClub}` })
      )
    ).toEqual({
      ok: true,
      query: { kind: 'tournament', gameFormat: format, clubIds: [club, otherClub] },
    });
  });
  it.each([
    'liveness_table_ids=',
    'liveness_table_ids=not-a-table',
    'liveness_format=mtt',
    `liveness_club_ids=${club}`,
    `liveness_format=cash&liveness_club_ids=${club}`,
    `liveness_format=unknown&liveness_club_ids=${club}`,
    'liveness_all=true',
    `liveness_table_ids=${id(1)}&liveness_table_ids=${id(2)}`,
    `liveness_table_ids=${id(1)}&liveness_format=mtt&liveness_club_ids=${club}`,
    `liveness_format=mtt&liveness_club_ids=${club},${otherClub},${id(1)}`,
    `liveness_table_ids=${Array.from({ length: 33 }, (_, n) => id(n)).join(',')}`,
  ])('rejects incomplete, mixed, duplicate or oversized scope: %s', (query) => {
    expect(parse(new URLSearchParams(query))).toEqual({ ok: false });
  });
  it('returns only requested identities and copies the allowlisted progress facts', () => {
    const rows = [table(1), table(2), table(3)];
    const selected = select(rows, { kind: 'tables', tableIds: [id(3), id(1), id(99)] });
    expect(selected.map((r) => r.tableId)).toEqual([id(3), id(1)]);
    expect(selected[0]).toEqual({
      tableId: id(3),
      gameFormat: 'mtt',
      clubId: club,
      seated: 6,
      dealable: 6,
      handCount: 3,
      msSinceProgress: 100,
      loopPhase: 'dealing+100ms',
      paused: false,
      running: true,
    });
    expect(JSON.stringify(selected)).not.toMatch(/privateLease|hiddenCards|As|Ad/);
    rows[2].handCount = 999;
    expect(selected[0].handCount).toBe(3);
  });
  it('never widens a missing tournament scope to other clubs or formats', () => {
    const rows = [
      table(1),
      table(2, { gameFormat: 'spin' }),
      table(3, { clubId: otherClub }),
      table(4, { clubId: null }),
    ];
    expect(
      select(rows, { kind: 'tournament', gameFormat: 'mtt', clubIds: [club] }).map((r) => r.tableId)
    ).toEqual([id(1)]);
    expect(select(rows, { kind: 'tournament', gameFormat: 'sng', clubIds: [club] })).toEqual([]);
  });
  it('bounds a 2,000-table source while preserving stalled/paused facts honestly', () => {
    const rows = Array.from({ length: 2000 }, (_, i) =>
      table(i, { paused: true, msSinceProgress: 150000, loopPhase: 'x'.repeat(2000) })
    );
    const selected = select(rows, { kind: 'tournament', gameFormat: 'mtt', clubIds: [club] });
    expect(selected).toHaveLength(MAX_PUBLIC_LIVENESS_TABLES);
    expect(selected.every((r) => r.paused && r.msSinceProgress === 150000)).toBe(true);
    expect(selected.every((r) => r.loopPhase.length === 160)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(16000);
    expect(select(rows, { kind: 'tables', tableIds: rows.map((r) => r.tableId) })).toHaveLength(32);
  });

  it('carries whether the engine ever started, which no other field can say', () => {
    /**
     * A table whose engine was registered and never started reports
     * `dealable: 0` - it never loaded a seat - and `paused: false`, because no
     * authority ever held it. Every stall filter needs `dealable >= 2`, so
     * without this field the payload describes such a table in terms that
     * cannot distinguish it from a quiet, healthy, empty one.
     *
     * Measured 2026-09-18: 9 of 10 sampled dark tables the engine still held
     * were exactly this, aged 1.4 to 5.9 hours.
     */
    const dark = table(1, {
      running: false,
      dealable: 0,
      seated: 0,
      paused: false,
      loopPhase: 'not_started+21357s',
    });
    const healthyEmpty = table(2, { dealable: 0, seated: 0 });
    const [a, b] = select([dark, healthyEmpty], {
      kind: 'tables',
      tableIds: [id(1), id(2)],
    });
    expect(a.running, 'a never-started engine must not read as running').toBe(false);
    expect(b.running).toBe(true);
    // The two are otherwise indistinguishable in this payload, which is the
    // whole reason the field exists.
    expect(a.dealable).toBe(b.dealable);
    expect(a.paused).toBe(b.paused);
  });
});
