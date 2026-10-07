import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildCompleteRankingCandidate,
  rankingPredecessor,
} from './leaderboard-complete-ranking-candidate.mjs';
const source = readFileSync(rankingPredecessor, 'utf8');
test('only club ranking changes with exact legacy suffix and prospective canonical branch', () => {
  const sql = buildCompleteRankingCandidate(source);
  assert.equal(sql.match(/CREATE OR REPLACE FUNCTION/g).length, 1);
  assert.doesNotMatch(sql, /CREATE.*fn_global_leaderboard|is_horse|GRANT EXECUTE|REVOKE/);
  const start = source.indexOf('CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_by_dates(');
  const end = source.indexOf('\n$function$;', start) + '\n$function$;'.length;
  const legacy = source.slice(start, end).split('BEGIN\n')[1];
  assert.ok(sql.includes(legacy));
  assert.match(sql, /v_end <= v_today/);
  assert.match(sql, /LIMIT p_limit OFFSET GREATEST\(COALESCE\(p_offset,0\),0\)/);
  assert.match(sql, /ORDER BY s.score DESC NULLS LAST,s.user_id/);
  assert.match(sql, /v_min_hands integer := 20/);
});
test('prior complete absence remains unknown, invalid evidence is not silently accepted', () => {
  const sql = buildCompleteRankingCandidate(source);
  assert.match(sql, /SQLERRM='LEADERBOARD_CAPTURE_UNAVAILABLE'.*ELSE RAISE/);
  assert.match(sql, /v_previous IS NULL OR old.score IS NULL THEN NULL/);
  assert.match(sql, /authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE/);
  assert.match(sql, /Disposable bootstrap socket required/);
  assert.throws(() => buildCompleteRankingCandidate(source + '\n'));
});
