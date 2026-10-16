import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (p: string) => readFileSync(p, 'utf8');
const pins = JSON.parse(read('scripts/ci/fixtures/weekly-club-event-witness/replacement.json'));
const before = read('scripts/ci/fixtures/weekly-club-event-witness/before.sql');
const migration = read(
  'supabase/migrations/20261016173058_weekly_club_discovery_uses_indexed_event_witnesses.sql'
);
describe('indexed original event witnesses preserve every weekly cohort rule', () => {
  it('installs only the two qualified query substitutions under exact source and authority guards', () => {
    for (const key of ['old1', 'new1', 'old2', 'new2'])
      expect(migration).toContain(`$${key}$${pins[key]}$${key}$`);
    expect(before.split(pins.old1)).toHaveLength(2);
    expect(before.split(pins.old2)).toHaveLength(2);
    expect(migration).toContain(pins.before);
    expect(migration).toContain(pins.after);
    expect(migration).toContain('club_witness_preimage_authority_refused');
    expect(migration).toContain('club_witness_scheduler_owned');
    expect(migration).toContain('club_witness_history_replay');
    expect(migration).not.toMatch(
      /UPDATE\s+(?:public\.)?(?:chip_ledger|club_members|ca_settlements)/i
    );
    expect(migration).not.toContain('CREATE INDEX');
  });
  it('retains half-open times, finite cutoffs and original source receipt equalities', () => {
    for (const predicate of [
      'rs.recognized_at>=p_from AND rs.recognized_at<p_to',
      "rs.disposition='earned'",
      "r.status='recognized'",
      'rs.rake_credit=s.rake_credit',
      'rs.recognized_at=r.recognized_at',
      'NOT s.union_id IS DISTINCT FROM r.union_id',
      'isfinite(s.charged_at)',
      'isfinite(rs.recognized_at)',
    ])
      expect(pins.new2).toContain(predicate);
    expect(pins.new2).toContain('s.club_id=t.club_id AND s.tournament_id=r.tournament_id OFFSET 0');
    expect(pins.new1).toContain('s.club_id>w.club_id ORDER BY s.club_id LIMIT 1');
    const after = before.replace(pins.old1, pins.new1).replace(pins.old2, pins.new2);
    expect(after.replace(pins.new1, pins.old1).replace(pins.new2, pins.old2)).toBe(before);
  });
  it('executes real PostgreSQL coverage in the existing required accounting step', () => {
    const parent = read('scripts/ci/test_launch_reset_floor.py');
    expect(parent).toContain("'test-weekly-club-event-witness-postgres.py'");
    const native = read('scripts/ci/test-weekly-club-event-witness-postgres.py');
    expect(native).toContain('boundary_parity_failed');
    expect(native).toContain('whole_rollback_and_replay_refusal');
    expect(native).toContain('old_distinct_blocks');
  });
});
