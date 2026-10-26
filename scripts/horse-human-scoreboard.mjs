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
    const canonical = new Date(value).toISOString();
    if (canonical.slice(0, 19) !== value.slice(0, 19)) throw Error('Invalid calendar instant');
    return canonical;
  };
  if (
    userId !== undefined &&
    (typeof userId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))
  )
    throw Error('Invalid player identifier');
  userId = userId?.toLowerCase();
  const start = instant(since),
    end = instant(through);
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0 || duration > 14 * 86400000)
    throw Error('Window must be positive and at most fourteen days');
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout = '5000ms';
-- Ordering an over-limit sample is unnecessary: it never emits scores.
-- Let LIMIT stop the existing per-player index scans as soon as the cap is known.
WITH selected AS MATERIALIZED (
 SELECT f.hand_id, f.user_id, f.game_variant, f.big_blind, f.tournament_id,
        f.net, f.opponent_ids, f.players_dealt, p.is_horse
 FROM public.profiles p CROSS JOIN LATERAL (
   SELECT f.hand_id, f.user_id, f.game_variant, f.big_blind, f.tournament_id,
          f.net, f.opponent_ids, f.players_dealt, f.played_at
   FROM public.ca_hand_facts f
   WHERE f.user_id = p.id AND f.played_at >= '${start}'::timestamptz
     AND f.played_at < '${end}'::timestamptz
   LIMIT 50001
 ) f WHERE p.is_horse = false ${userId === undefined ? '' : `AND p.id = '${userId}'`}
 LIMIT 50001
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
 FROM selected f WHERE (SELECT count(*) FROM selected) <= 50000
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
 'roster_digest', (SELECT md5(string_agg(id::text || ':' || COALESCE(is_horse::text, 'unknown'), ',' ORDER BY id)) FROM public.profiles),
 'candidate_facts', (SELECT count(*) FROM selected),
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

/** A finite original report, never a retry or background repair. */
export function scoreboardWindows(since, through, userId) {
  scoreboardSQL(since, through, userId); // same validation as each actual query
  const end = Date.parse(through),
    windows = [];
  for (let at = Date.parse(since); at < end; at += 21600000)
    windows.push({
      since: new Date(at).toISOString(),
      through: new Date(Math.min(at + 21600000, end)).toISOString(),
    });
  return windows;
}

export function mergeScoreboards(reports, since, through, userId) {
  const windows = scoreboardWindows(since, through, userId);
  userId = userId?.toLowerCase();
  if (!Array.isArray(reports) || reports.length === 0 || reports.length > 56)
    throw Error('Incomplete window receipts');
  let cursor = new Date(since).toISOString();
  const end = new Date(through).toISOString();
  const digest = reports[0]?.roster_digest;
  if (typeof digest !== 'string' || !/^[a-f0-9]{32}$/.test(digest))
    throw Error('Missing roster receipt');
  const coverage = new Map(),
    scores = new Map();
  let facts = 0;
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  for (let i = 0; i < reports.length; i++) {
    const r = reports[i],
      w = { since: cursor, through: r?.through };
    if (
      typeof w.through !== 'string' ||
      !Number.isFinite(Date.parse(w.through)) ||
      w.through !== new Date(w.through).toISOString() ||
      Date.parse(w.through) <= Date.parse(cursor) ||
      Date.parse(w.through) - Date.parse(cursor) > 86400000 ||
      Date.parse(w.through) > Date.parse(end)
    )
      throw Error('Invalid partition');
    if (
      !r ||
      r.version !== 1 ||
      r.status !== 'observed' ||
      r.since !== w.since ||
      r.through !== w.through ||
      r.player_id !== (userId ?? null) ||
      r.roster_digest !== digest ||
      r.classification_basis !== 'current_profiles_not_historical_identity' ||
      r.candidate_scope !== 'currently_classified_humans_only_unknown_actors_excluded' ||
      !count(r.candidate_facts) ||
      r.candidate_facts > 50000 ||
      !Array.isArray(r.coverage) ||
      !Array.isArray(r.scores)
    )
      throw Error('Unqualified window receipt');
    const cohorts = new Set();
    let covered = 0,
      scored = 0;
    for (const c of r.coverage) {
      if (!c || typeof c.cohort !== 'string' || !count(c.facts) || cohorts.has(c.cohort))
        throw Error('Invalid coverage');
      cohorts.add(c.cohort);
      covered += c.facts;
      coverage.set(c.cohort, (coverage.get(c.cohort) ?? 0) + c.facts);
    }
    if (covered !== r.candidate_facts) throw Error('Incomplete coverage');
    const groups = new Set();
    for (const row of r.scores) {
      if (
        !row ||
        typeof row.user_id !== 'string' ||
        (userId !== undefined && row.user_id !== userId) ||
        typeof row.game_variant !== 'string' ||
        !row.game_variant ||
        typeof row.tournament !== 'boolean' ||
        !finite(row.big_blind) ||
        row.big_blind <= 0 ||
        !count(row.hands) ||
        row.hands === 0 ||
        row.distinct_hands !== row.hands ||
        !finite(row.human_net_chips_after_rake) ||
        !finite(row.human_net_bb_after_rake) ||
        !finite(row.human_bb_per_100) ||
        Math.abs(row.human_bb_per_100 - (100 * row.human_net_bb_after_rake) / row.hands) > 1e-7
      )
        throw Error('Invalid score');
      const key = JSON.stringify([row.game_variant, row.big_blind, row.tournament, row.user_id]);
      if (groups.has(key)) throw Error('Duplicate score group');
      groups.add(key);
      scored += row.hands;
      const total = scores.get(key) ?? {
        ...row,
        hands: 0,
        distinct_hands: 0,
        human_net_chips_after_rake: 0,
        human_net_bb_after_rake: 0,
      };
      total.hands += row.hands;
      total.distinct_hands += row.distinct_hands;
      total.human_net_chips_after_rake =
        Math.round((total.human_net_chips_after_rake + row.human_net_chips_after_rake) * 100) / 100;
      total.human_net_bb_after_rake += row.human_net_bb_after_rake;
      total.human_bb_per_100 = (100 * total.human_net_bb_after_rake) / total.hands;
      scores.set(key, total);
    }
    if (scored !== (r.coverage.find((c) => c.cohort === 'sole_human_against_horses')?.facts ?? 0))
      throw Error('Incomplete scores');
    facts += r.candidate_facts;
    cursor = r.through;
  }
  if (cursor !== end) throw Error('Incomplete window receipts');
  return {
    ...reports[0],
    since: windows[0].since,
    through: end,
    candidate_facts: facts,
    windows: reports.length,
    coverage: [...coverage]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cohort, facts]) => ({ cohort, facts })),
    scores: [...scores.values()].sort(
      (a, b) =>
        a.game_variant.localeCompare(b.game_variant) ||
        a.big_blind - b.big_blind ||
        Number(a.tournament) - Number(b.tournament) ||
        a.user_id.localeCompare(b.user_id)
    ),
  };
}

export function runScoreboard(args) {
  if (![3, 4].includes(args.length) || !['--sql', '--sql-windows', '--run'].includes(args[0]))
    return {
      code: 64,
      output:
        'Usage: node scripts/horse-human-scoreboard.mjs --sql|--sql-windows|--run <since-UTC> <through-UTC> [player-UUID]\n',
    };
  try {
    const windows = scoreboardWindows(args[1], args[2], args[3]);
    if (args[0] === '--sql') return { code: 0, output: scoreboardSQL(args[1], args[2], args[3]) };
    if (args[0] === '--sql-windows')
      return {
        code: 0,
        output:
          JSON.stringify(
            windows.map((w) => ({ ...w, sql: scoreboardSQL(w.since, w.through, args[3]) }))
          ) + '\n',
      };
    const reports = [],
      deadline = Date.now() + 90000;
    for (const w of windows) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('Report deadline exceeded');
      const result = spawnSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
        input: scoreboardSQL(w.since, w.through, args[3]),
        encoding: 'utf8',
        timeout: Math.min(10000, remaining),
        maxBuffer: 8 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw Error('Query failed');
      const report = JSON.parse(result.stdout.trim());
      if (report.status === 'incomplete_row_limit')
        return {
          code: 2,
          output:
            JSON.stringify({
              status: 'incomplete_row_limit',
              since: args[1],
              through: args[2],
              failedWindow: w,
              scores: [],
            }) + '\n',
        };
      reports.push(report);
    }
    const report = mergeScoreboards(reports, args[1], args[2], args[3]);
    return { code: 0, output: JSON.stringify(report) + '\n' };
  } catch {
    return {
      code: 3,
      output: 'Scoreboard unavailable; invalid window, failed query or incomplete receipts.\n',
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runScoreboard(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
