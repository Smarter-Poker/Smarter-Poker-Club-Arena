import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(__dirname, '../fixtures/sep8-spin-custody/qualify-current-case-reader.py'),
  'utf8'
);
const setup = source.match(/ {4}setup = """([\s\S]*?)"""/)?.[1];
const event = '199a71a9-f364-4e90-a3ba-3cdcfb7755bc';

describe('Spin Current Reader Unrelated Planner Population', () => {
  it('selects one stable non-null source outside both actual history reader branches', () => {
    expect(setup).toBeDefined();
    const selection = setup!.match(/WITH source AS \(([\s\S]*?)\),\nrows AS/)?.[1];
    expect(selection).toContain('h.tournament_id IS NOT NULL');
    expect(selection).toContain(`h.tournament_id<>'${event}'`);
    expect(selection).toContain(
      `NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id=h.table_id AND t.tournament_id='${event}')`
    );
    expect(selection).toContain('ORDER BY h.id LIMIT 1');
  });

  it('checks the actual inserted identities, count and disjointness before commit and planner analysis', () => {
    const reset = setup!.indexOf('SET LOCAL session_replication_role=origin;');
    const commit = setup!.indexOf('COMMIT;');
    const checks = setup!.slice(reset, commit);
    expect(checks.match(/SELECT sep8_spin_fixture.assert\(/g)).toHaveLength(4);
    expect(checks).toContain('(SELECT count(*) FROM sep8_spin_fixture.reader_population)=30000');
    expect(checks).toContain('reader_population p JOIN public.hand_history h ON h.id=p.id');
    expect(checks).toContain('h.tournament_id IS NULL');
    expect(checks).toContain('JOIN sep8_spin_fixture.cases c ON c.tournament_id=t.tournament_id');
    expect(checks).toContain('WHERE t.id=h.table_id');
    expect(checks).toContain('))=30000');
    expect(commit).toBeLessThan(setup!.indexOf('ANALYZE public.hand_history;'));
    // Keep the demonstrated old failure and real successor planner oracle.
    expect(source).toContain('if scoped(old_plan):');
    expect(source).toContain('if not scoped(new_plan):');
    expect(source).not.toContain('enable_seqscan');
  });

  it('uses real disjoint closed-cash parents and preserves all five documents while populated', () => {
    expect(setup).toContain(
      'INSERT INTO public.tables(__reader_insertable_columns__) SELECT __reader_insertable_columns__ FROM rows RETURNING id'
    );
    expect(setup).toContain('generate_series(1,64)');
    expect(setup).toContain(
      "'club_id',null,'union_id',null,'created_by',null,'cluster_id',null,'tournament_id',null"
    );
    expect(setup).toContain("'status','closed','lifecycle','closed','current_players',0");
    expect(setup).toContain("'table_id',b.ids[1+((n-1)%64)],'tournament_id',null");
    expect(source).toContain(
      'Planner population changed an original five-case document while active'
    );
    expect(source).toContain(
      'DELETE FROM public.tables t USING sep8_spin_fixture.reader_background_tables b WHERE t.id=b.id'
    );
    expect(source).toContain('DROP TABLE sep8_spin_fixture.reader_background_tables');
  });

  it('independently distinguishes unrelated rows from direct, target-table and null-source controls', () => {
    // Predicate model only, not PostgreSQL or planner qualification.
    const targetTables = new Set(['target-table']);
    const eligible = (tournament: string | null, table: string | null) =>
      tournament !== null && tournament !== event && !targetTables.has(table ?? '');
    expect(eligible('other-event', 'other-table')).toBe(true);
    expect(eligible('other-event', null)).toBe(true);
    expect(eligible(event, 'other-table')).toBe(false);
    expect(eligible('other-event', 'target-table')).toBe(false);
    expect(eligible(null, 'other-table')).toBe(false);
    expect(eligible(null, 'target-table')).toBe(false);
  });
});
