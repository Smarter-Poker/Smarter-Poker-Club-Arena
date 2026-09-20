/**
 * STATS PAGE PROGRAMME, PHASE 3: LIVE FROM ANY TAB, DAYS IN THE PLAYER'S
 * ZONE, EV COVERAGE WATCHED (2026-09-04).
 *
 * Three findings drove this phase, all measured against production:
 *
 *   1. The page's "live from any tab" was DEAD. Another migration that
 *      morning (20260904101140_unpublish_the_index_nobody_subscribes_to)
 *      took ca_hand_player_idx out of the realtime publication - right about
 *      the cost (4.5M change records a day, the slot 136 MB behind), wrong
 *      that nobody subscribed: this page did. The subscription could never
 *      fire again. Replaced by ca_player_stats_pulse (157 ms), polled by the
 *      open page while visible.
 *   2. Day buckets were cut in UTC. A Chicago player's evening session was
 *      split across two bars, and the 'YYYY-MM-DD' labels were then parsed
 *      as UTC midnight by the browser, which labelled Sep 3 as Sep 2.
 *   3. All-in equity coverage was not watched. The first cut of the measure
 *      read 98.46% (715 pre-river all-in showdowns, 11 without equity); ten
 *      of the eleven were side pots that kept betting after a short stack's
 *      shove, which is not a runout and owes no equity. Counted against the
 *      action log the owed set is 715 and the gap is ONE hand: 99.86%, and
 *      the programme's 99% bar can stand.
 *
 * These pins read source, not the database; the production probes are
 * recorded in docs/changelog/2026-09-04-stats-phase-3-live-and-exact.md.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const MIG = read(
  'supabase/migrations/20260904222705_stats_phase_3_pulse_timezone_and_ev_coverage.sql'
);
const MIG2 = read(
  'supabase/migrations/20260904224726_stats_phase_3_ev_coverage_counts_runouts_only.sql'
);
const PAGE = read('src/pages/PlayerStatsPage.tsx');
const HOOK = read('src/hooks/useStatsPulse.ts');
const LOCAL_TIME = read('src/lib/localTime.ts');
const MONITOR = read('server/src/observability/StatsHealthMonitor.ts');
const RULES = read('infra/monitoring/engine-freeze-rules.yml');

const fn = (name: string, args: string): string => {
  const heads = [
    `CREATE OR REPLACE FUNCTION public.${name}(${args}`,
    `CREATE FUNCTION public.${name}(${args}`,
  ];
  const i = Math.max(...heads.map((h) => MIG.indexOf(h)));
  expect(i, `${name}(${args} is defined in the migration`).toBeGreaterThan(-1);
  const rest = MIG.slice(i);
  return rest.slice(0, rest.indexOf('$function$;'));
};

describe('phase 3 migration: the pulse', () => {
  it('is one transaction', () => {
    expect(MIG.trim().startsWith('BEGIN;') || /\nBEGIN;\n/.test(MIG)).toBe(true);
    expect(MIG.trim().endsWith('COMMIT;')).toBe(true);
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('is owner-asserted, two index probes, and covers tournament rows the hand index never could', () => {
    const p = fn('ca_player_stats_pulse', 'p_user uuid');
    expect(p).toMatch(/PERFORM public\.ca_assert_self\(p_user\);/);
    expect(p).toMatch(
      /SELECT max\(created_at\) INTO v_newest_hand\s+FROM public\.ca_hand_player_idx WHERE user_id = p_user;/
    );
    expect(p).toMatch(/FROM public\.tournament_players WHERE user_id = p_user;/);
    for (const col of ['status', 'position', 'prize', 'bounty_winnings', 'eliminated_at']) {
      expect(p, `fingerprint carries ${col}`).toContain(`coalesce(${col}`);
    }
    expect(p).toMatch(
      /'pulse', coalesce\(v_newest_hand::text, ''\) \|\| '#' \|\| coalesce\(v_tourn, ''\)/
    );
    expect(p).toMatch(/\bSTABLE\b/);
  });

  it('is reachable by a signed-in player and nobody anonymous', () => {
    expect(MIG).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_player_stats_pulse\(uuid\) FROM PUBLIC, anon;/
    );
    expect(MIG).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_player_stats_pulse\(uuid\) TO authenticated, service_role;/
    );
  });
});

describe("phase 3 migration: days in the player's zone", () => {
  it('drops the two-argument signatures so PostgREST cannot pick the wrong overload', () => {
    expect(MIG).toMatch(
      /DROP FUNCTION IF EXISTS public\.ca_player_stats_overview_v2\(uuid, integer\);/
    );
    expect(MIG).toMatch(/DROP FUNCTION IF EXISTS public\.ca_player_stats_full\(uuid, integer\);/);
  });

  it('takes p_tz with a UTC default, validates it, and buckets by it', () => {
    const full = fn(
      'ca_player_stats_full',
      "p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'"
    );
    expect(full).toMatch(/PERFORM now\(\) AT TIME ZONE p_tz;\s+v_tz := p_tz;/);
    expect(full).toMatch(/EXCEPTION WHEN OTHERS THEN\s+v_tz := 'UTC';/);
    expect(full).toMatch(
      /SELECT date\(created_at AT TIME ZONE v_tz\) AS d, count\(\*\)::int AS hands/
    );
    expect(full).toMatch(/'window_tz', v_tz,/);
    // The rolling window itself stays in absolute time: only the day labels move.
    expect(full).not.toMatch(/v_from\s*:=.*AT TIME ZONE/);
  });

  it('the browser door passes the zone through and reports the one it used', () => {
    const v2 = fn(
      'ca_player_stats_overview_v2',
      "p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'"
    );
    expect(v2).toMatch(/PERFORM public\.ca_assert_self\(p_user\);/);
    expect(v2).toMatch(/v_result := public\.ca_player_stats_full\(p_user, v_days, p_tz\);/);
    expect(v2).toMatch(/'range_tz', coalesce\(v_result ->> 'window_tz', 'UTC'\),/);
    expect(MIG).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_player_stats_overview_v2\(uuid, integer, text\) TO authenticated, service_role;/
    );
    expect(MIG).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_player_stats_full\(uuid, integer, text\) FROM PUBLIC, anon, authenticated;/
    );
  });

  it('pins the session rule: a new cash session after a 45-minute gap, profit as the sum of its hands', () => {
    const full = fn(
      'ca_player_stats_full',
      "p_user uuid, p_days integer DEFAULT NULL::integer, p_tz text DEFAULT 'UTC'"
    );
    expect(full).toMatch(/lag\(created_at\) OVER \(ORDER BY created_at\) > interval '45 minutes'/);
    expect(MIG).toMatch(/a new session starts after a 45-minute gap/);
  });
});

describe('phase 3 migration: EV coverage', () => {
  it('adds the two audit columns and measures pre-river all-in showdowns without equity', () => {
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS allin_showdown_7d integer NOT NULL DEFAULT 0,/);
    expect(MIG).toMatch(
      /ADD COLUMN IF NOT EXISTS allin_showdown_without_equity_7d integer NOT NULL DEFAULT 0;/
    );
    const audit = fn('ca_stats_witness_audit', '');
    expect(audit).toMatch(/count\(\*\) FILTER \(WHERE all_in_equity IS NULL\)::int/);
    expect(audit).toMatch(
      /WHERE was_all_in = true\s+AND went_to_showdown\s+AND coalesce\(all_in_street, ''\) <> 'river'\s+AND played_at >= now\(\) - interval '7 days';/
    );
  });

  it('the refinement counts RUNOUTS only: no check, bet or raise after the last all-in', () => {
    /**
     * The first cut counted a short stack's shove into a side pot that kept
     * betting as a gap. The engine prices equity only when no further betting
     * is possible (HandController.advanceStage parks the hand when fewer than
     * two players can still act), which is the rule every tracker applies;
     * those seats owe nothing. Ten of the first cut's eleven "gaps" were this.
     */
    expect(MIG2.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG2.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG2).toMatch(/CREATE OR REPLACE FUNCTION public\.ca_stats_witness_audit\(/);
    expect(MIG2).toMatch(
      /bool_or\(a\.act->>'action' IN \('check', 'bet', 'raise'\) AND a\.ord > la\.last_allin\)/
    );
    expect(MIG2).toMatch(/WHERE b\.act->>'action' IN \('all_in', 'allin'\)/);
    // A hand the pruner already took is unknown: neither owed nor missing.
    expect(MIG2).toMatch(/OR NOT coalesce\(h\.betting_continued, true\)\)::int,/);
    expect(MIG2).toMatch(
      /AND NOT coalesce\(h\.betting_continued, true\)\)::int\s+INTO v_allin_sd, v_allin_sd_no_eq/
    );
    // Same signature, same grants: the engine's read does not change.
    expect(MIG2).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_stats_witness_audit\(integer, integer\) TO service_role;/
    );
    expect(MIG2).not.toMatch(/ADD COLUMN/);
  });

  it('publishes it on ca_stats_health as evCoverage7d with a ratio', () => {
    const health = fn('ca_stats_health', ')');
    expect(health).toMatch(
      /'evCoverage7d', \(SELECT jsonb_build_object\(\s+'allInShowdowns', allin_showdown_7d,\s+'withoutEquity', allin_showdown_without_equity_7d,\s+'ratio', CASE WHEN allin_showdown_7d > 0/
    );
  });
});

describe('phase 3 page: live from any tab, by asking', () => {
  it('polls the pulse only as the owner and feeds the shared debouncer', () => {
    expect(PAGE).toMatch(
      /useStatsPulse\(\{\s+userId: targetUserId,\s+enabled: Boolean\(targetUserId && isOwnProfile\),\s+onChange: scheduleRefresh,\s+\}\);/
    );
    expect(PAGE).not.toMatch(/postgres_changes/);
    expect(PAGE).not.toMatch(/stats-live-/);
    expect(PAGE).not.toMatch(/useVisibilityRefresh/);
    // The same-tab bus events land in the same window.
    expect(PAGE).toMatch(
      /REFRESH_EVENTS\.map\(\(e\) => masterBus\.subscribe\(e as never, scheduleRefresh\)\)/
    );
  });

  it('the hook polls while visible, baselines the first sample, and owns the tab return', () => {
    expect(HOOK).toMatch(/export const STATS_PULSE_INTERVAL_MS = 8_000;/);
    expect(HOOK).toMatch(/export const STATS_PULSE_STALE_AFTER_MS = 30_000;/);
    /* The call gained `...statsScopeArgs(CHIP_STATS)` on 2026-09-20: the pulse
       is a change detector over the same facts table its page reads, so it
       carries the same asset scope. What this pins is unchanged - the hook
       asks for the pulse, by user. */
    expect(HOOK).toMatch(
      /supabase\.rpc\(\s*'ca_player_stats_pulse',[\s\S]*?p_user: userId,?\s*\}\)/
    );
    expect(HOOK).toContain('statsScopeArgs(CHIP_STATS)');
    expect(HOOK).toMatch(/document\.visibilityState !== 'visible'\) return;/);
    expect(HOOK).toMatch(/if \(last === null\) \{\s+last = pulse;/);
    expect(HOOK).toMatch(
      /if \(away >= staleAfterMs\) \{\s+\/\/[^\n]*\n\s+last = null;\s+onChangeRef\.current\(\);/
    );
    expect(HOOK).toMatch(/reportError\(err, 'useStatsPulse\.rpc_ca_player_stats_pulse'\)/);
    expect(HOOK).not.toMatch(/toast/i);
  });
});

describe("phase 3 page: the player's zone, end to end", () => {
  it('sends p_tz on both overview calls', () => {
    const calls = PAGE.match(/\.rpc\('ca_player_stats_overview_v2', \{[\s\S]*?\}\)/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatch(/p_tz: resolvedTimeZone\(\)/);
  });

  it('reads the daily labels as local days, never as UTC midnight', () => {
    expect(PAGE).toMatch(/localDateFromYmd\(d\.date\)\.toLocaleDateString/);
    expect(PAGE).not.toMatch(/new Date\(d\.date\)/);
    expect(LOCAL_TIME).toMatch(/Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
    expect(LOCAL_TIME).toMatch(
      /return new Date\(Number\(m\[1\]\), Number\(m\[2\]\) - 1, Number\(m\[3\]\)\);/
    );
  });
});

describe('phase 3 engine: EV coverage watched', () => {
  it("parses evCoverage7d, emits the gauges, and raises below the programme's 99% on 50+ runouts", () => {
    expect(MONITOR).toMatch(/const ev = obj\(r\.evCoverage7d\);/);
    expect(MONITOR).toContain("'poker_stats_ev_coverage_7d'");
    expect(MONITOR).toContain("'poker_stats_allin_showdowns_7d'");
    expect(MONITOR).toMatch(/export const STATS_EV_COVERAGE_ALERT = 'ClubArenaStatsEvCoverage';/);
    expect(MONITOR).toMatch(/export const STATS_EV_COVERAGE_MIN_RATIO = 0\.99;/);
    expect(MONITOR).toMatch(/export const STATS_EV_COVERAGE_MIN_SAMPLE = 50;/);
    expect(MONITOR).toMatch(
      /allInShowdowns >= STATS_EV_COVERAGE_MIN_SAMPLE && ratio < STATS_EV_COVERAGE_MIN_RATIO/
    );
  });

  it('has a Prometheus rule with the same bar and the same sample floor', () => {
    const i = RULES.indexOf('- alert: StatsAllInEquityCoverageLow');
    expect(i).toBeGreaterThan(RULES.indexOf('- name: stats-pipeline'));
    const rule = RULES.slice(i, RULES.indexOf('- alert: StatsHealthReadStale'));
    expect(rule).toMatch(/poker_stats_ev_coverage_7d < 0\.99/);
    expect(rule).toMatch(/and poker_stats_allin_showdowns_7d >= 50/);
    expect(rule).toMatch(/component: club-arena-stats/);
  });
});

describe('phase 3 schema manifest fragment', () => {
  it('declares the pulse and the two audit columns', () => {
    const p = join(ROOT, 'scripts', 'ci', 'schema-manifest.d', 'stats-phase-3.json');
    expect(existsSync(p)).toBe(true);
    const frag = JSON.parse(readFileSync(p, 'utf8')) as {
      functions: string[];
      columns: Record<string, string[]>;
    };
    expect(frag.functions).toContain('ca_player_stats_pulse');
    expect(frag.columns.ca_stats_witness_audit_log).toEqual([
      'allin_showdown_7d',
      'allin_showdown_without_equity_7d',
    ]);
  });
});
