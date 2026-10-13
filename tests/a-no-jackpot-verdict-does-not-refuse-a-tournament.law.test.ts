import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const prior = read(
  'supabase/migrations/20261012191143_diamond_cash_jackpots_settle_with_the_accepted_hand.sql'
);
const corrected = read(
  'supabase/migrations/20261013021756_a_diamond_no_jackpot_verdict_preserves_tournament_hand_settl.sql'
);
const body = (text: string) => {
  const start = text.indexOf('FUNCTION public.fn_poker_diamond_jackpot_accept_hand()');
  const end = text.indexOf('END $fn$;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
};
describe('a validated no-jackpot verdict preserves tournament settlement', () => {
  it('validates the verdict then returns none before the positive cash-only scope', () => {
    const next = body(corrected);
    expect(next.indexOf('diamond_jackpot_invalid_accepted_verdict')).toBeLessThan(
      next.indexOf("IF v_kind='none'")
    );
    expect(next.indexOf("IF v_kind='none'")).toBeLessThan(
      next.indexOf('WHERE t.id=NEW.table_id AND t.tournament_id IS NULL')
    );
    expect(next).toContain('diamond_jackpot_wrong_hand_scope');
  });
  it('preserves every positive-hit calculation and payment line verbatim', () => {
    const tail = (text: string) =>
      body(text).slice(body(text).indexOf("SELECT request->'rake_facts'"));
    expect(tail(corrected)).toBe(tail(prior));
    expect(corrected).toContain('9bf2c572669648dc445ac0cb281eac33');
    expect(corrected).toContain('0db3d6146f5e1118c570ded9bfb5261f');
    expect(corrected).toContain("'{postgres=X/postgres}'");
    expect(corrected).not.toMatch(
      /UPDATE public\.(?:ca_arena_settings|ca_diamond_economics|hand_atomic_commits)/
    );
  });
  it('enforces the actual old-trigger counterexample and repaired trigger in existing SQL CI', () => {
    const runner = read('tests/sql/run-diamond-jackpot-integration.py');
    expect(runner).toContain("load((SQL / 'diamond-none-tournament-before.sql').read_text()");
    expect(runner).toContain('load(scope_fix.read_text()');
    expect(runner).toContain("load((SQL / 'diamond-none-tournament-after.sql').read_text()");
    expect(read('scripts/ci/run-diamond-sql-acceptance.py')).toContain(
      'run-diamond-jackpot-integration.py'
    );
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 scripts/ci/run-diamond-sql-acceptance.py'
    );
    expect(read('tests/sql/diamond-none-tournament-before.sql')).toContain(
      'diamond_jackpot_wrong_hand_scope'
    );
    expect(read('tests/sql/diamond-none-tournament-after.sql')).toContain(
      "ARRAY['main','mini','invalid']"
    );
  });
});
