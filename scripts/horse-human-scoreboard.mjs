/** Private, explicit read-only report. No scheduler, credentials or gameplay writes.
 * psql uses its configured authentication; this script never loads secret files.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function scoreboardSQL(since, through, userId) {
  const instant = (value) => {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      throw Error('Explicit UTC timestamps required');
    return new Date(value).toISOString();
  };
  if (
    userId !== undefined &&
    (typeof userId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))
  )
    throw Error('Invalid player identifier');
  const start = instant(since),
    end = instant(through);
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0 || duration > 14 * 86400000)
    throw Error('Window must be positive and at most fourteen days');
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout = '5000ms';
WITH selected AS MATERIALIZED (
 SELECT f.hand_id, f.user_id, f.game_variant, f.big_blind, f.tournament_id,
        f.net, f.opponent_ids, f.players_dealt, p.is_horse
 FROM public.profiles p CROSS JOIN LATERAL (
   SELECT f.hand_id, f.user_id, f.game_variant, f.big_blind, f.tournament_id,
          f.net, f.opponent_ids, f.players_dealt, f.played_at
   FROM public.ca_hand_facts f
   WHERE f.user_id = p.id AND f.played_at >= '${start}'::timestamptz
     AND f.played_at < '${end}'::timestamptz
   ORDER BY f.played_at, f.hand_id LIMIT 50001
 ) f WHERE p.is_horse = false ${userId === undefined ? '' : `AND p.id = '${userId}'`}
 ORDER BY f.played_at, f.hand_id, f.user_id LIMIT 50001
), classified AS MATERIALIZED (
 SELECT f.*, CASE
 WHEN f.is_horse IS NULL THEN 'unknown_actor'
 WHEN f.is_horse THEN 'horse_fact'
 WHEN f.big_blind IS NULL OR f.big_blind <= 0 OR f.net IS NULL
   OR f.big_blind::text IN ('NaN', 'Infinity', '-Infinity')
   OR f.net::text IN ('NaN', 'Infinity', '-Infinity') THEN 'invalid_result'
 WHEN f.game_variant IS NULL OR f.game_variant = '' THEN 'unknown_variant'
 WHEN f.players_dealt IS NULL OR f.players_dealt < 2
   OR f.opponent_ids IS NULL OR cardinality(f.opponent_ids) = 0
   OR cardinality(f.opponent_ids) <> f.players_dealt - 1
   OR (SELECT count(DISTINCT x) FROM unnest(f.opponent_ids) x) <> cardinality(f.opponent_ids)
   OR f.user_id = ANY(f.opponent_ids) THEN 'unknown_participants'
 WHEN EXISTS (SELECT 1 FROM unnest(f.opponent_ids) o(id)
   LEFT JOIN public.profiles p ON p.id = o.id WHERE p.is_horse IS NULL) THEN 'unknown_opponent'
 WHEN EXISTS (SELECT 1 FROM unnest(f.opponent_ids) o(id)
   JOIN public.profiles p ON p.id = o.id WHERE p.is_horse = false) THEN 'mixed_human'
 ELSE 'sole_human_against_horses' END AS cohort
 FROM selected f
), scores AS (
 SELECT game_variant, big_blind, tournament_id IS NOT NULL AS tournament,
        user_id, count(*) AS hands,
        sum(net) AS human_net_chips_after_rake,
        sum(net / big_blind) AS human_net_bb_after_rake,
        100 * sum(net / big_blind) / count(*) AS human_bb_per_100,
        count(DISTINCT hand_id) AS distinct_hands
 FROM classified WHERE cohort = 'sole_human_against_horses'
 GROUP BY game_variant, big_blind, tournament_id IS NOT NULL, user_id
), coverage AS (
 SELECT cohort, count(*) AS facts FROM classified GROUP BY cohort
)
SELECT jsonb_build_object(
 'version', 1, 'since', '${start}', 'through', '${end}',
 'status', CASE WHEN (SELECT count(*) FROM selected) > 50000 THEN 'incomplete_row_limit' ELSE 'observed' END,
 'classification_basis', 'current_profiles_not_historical_identity',
 'player_id', ${userId === undefined ? 'NULL' : `'${userId}'`},
 'candidate_scope', 'currently_classified_humans_only_unknown_actors_excluded',
 'meaning', 'Human net after rake in hands where every other dealt player is a horse. Tournament chips are not ROI. The negative of human net includes rake and is not horse profit.',
 'limits', 'No claim of sustainable win rate, causal strategy improvement, all-horse coverage, or exact individual horse transfers. Mixed-human hands excluded; no private cards read.',
 'coverage', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY cohort) FROM coverage c), '[]'::jsonb),
 'scores', CASE WHEN (SELECT count(*) FROM selected) > 50000 THEN '[]'::jsonb
   ELSE COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY game_variant, big_blind, tournament, user_id) FROM scores s), '[]'::jsonb) END
);
COMMIT;
`;
}

export function runScoreboard(args) {
  if (![3, 4].includes(args.length) || !['--sql', '--run'].includes(args[0]))
    return {
      code: 64,
      output:
        'Usage: node scripts/horse-human-scoreboard.mjs --sql|--run <since-UTC> <through-UTC> [player-UUID]\n',
    };
  try {
    const sql = scoreboardSQL(args[1], args[2], args[3]);
    if (args[0] === '--sql') return { code: 0, output: sql };
    const result = spawnSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
      input: sql,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      return { code: 3, output: 'Scoreboard unavailable; query failed or timed out.\n' };
    const report = JSON.parse(result.stdout.trim());
    if (!['observed', 'incomplete_row_limit'].includes(report.status)) throw Error();
    return { code: report.status === 'observed' ? 0 : 2, output: JSON.stringify(report) + '\n' };
  } catch {
    return { code: 3, output: 'Scoreboard unavailable; invalid window or unreadable result.\n' };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runScoreboard(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
