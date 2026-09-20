/**
 * THE STATS PAGE'S MONEY IS EXACT AND ITS NUMBERS ARE LIVE (2026-09-03).
 *
 * Found by a live E2E of /hub/club-arena/stats against production: the
 * headline cash result was wrong by 16x (reconstructed -21,891 vs exact
 * -1,329 on the same 484 hands), nothing on the page updated until a
 * 15-minute cron ran, "Hands Played" was 17 hours stale and falling further
 * behind for ever, and "Worst Losses" was ranking tournament chips.
 *
 * These assert on the migration and component text because CI has no
 * database. They cannot prove the SQL is right - the rolled-back production
 * probe in docs/changelog/2026-09-03-stats-page-money-is-exact-and-live.md
 * did that - but they can stop the load-bearing parts being quietly removed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const MIG = readFileSync(
  resolve(ROOT, 'supabase/migrations/20260903190000_stats_page_money_is_exact_and_live.sql'),
  'utf8'
);
const PAGE = readFileSync(resolve(ROOT, 'src/pages/PlayerStatsPage.tsx'), 'utf8');
// Phase 2 (2026-09-04) moved each tab's markup into its own lazy chunk.
const TROPHIES_TAB = readFileSync(resolve(ROOT, 'src/pages/stats/TrophiesTab.tsx'), 'utf8');
const OVERVIEW_TAB = readFileSync(resolve(ROOT, 'src/pages/stats/OverviewTab.tsx'), 'utf8');
const FACTS = readFileSync(resolve(ROOT, 'src/services/StatsFactsService.ts'), 'utf8');

const fn = (name: string): string => {
  const i = MIG.indexOf(`FUNCTION public.${name}(`);
  expect(i, `${name} is defined in the migration`).toBeGreaterThan(-1);
  const rest = MIG.slice(i);
  const end = rest.indexOf('$function$;');
  return rest.slice(0, end);
};

describe('the reconstruction uses the engine amount semantics', () => {
  it('treats bet / raise / all_in as raise-TO levels, not increments', () => {
    const f = fn('ca_hand_player_facts');
    expect(f).toMatch(/WHEN a\.action IN \('bet','raise','all_in','allin'\) THEN 'to'/);
    expect(f).toMatch(/ELSE t\.amount \+ \(w\.inc_cum - t\.inc_cum\) END AS committed/);
  });

  it('subtracts the recorded uncalled-bet return, and infers it on logs that predate it', () => {
    const f = fn('ca_hand_player_facts');
    expect(f).toMatch(/WHEN a\.action = 'return' THEN 'ret'/);
    expect(f).toMatch(/- coalesce\(mx\.returned, 0\)/);
    expect(f).toMatch(/inferred_ret AS \(/);
    expect(f).toMatch(/WHERE r\.rn = 1 AND NOT hs\.has_returns/);
    // The stored pot arbitrates the inference, same rule as handReplay.ts.
    expect(f).toMatch(/inference_ok AS \(/);
  });

  it('keeps dead money (antes) out of the live bet level', () => {
    const f = fn('ca_hand_player_facts');
    expect(f).toMatch(/\(a\.dead_flag OR a\.action = 'ante'\) AS dead/);
    expect(f).toMatch(/FILTER \(WHERE kind = 'inc' AND NOT dead\)/);
  });

  it('does not restate the naive sum anywhere in the migration', () => {
    // The exact line that produced the 16x error.
    expect(MIG).not.toMatch(
      /sum\(a\.amount\) FILTER \(WHERE a\.action IN \('bet','call','raise','all_in'\)\)/
    );
    expect(MIG).not.toMatch(/AND act->>'action' IN \('bet','call','raise','all_in'\)/);
  });
});

describe('the page is live', () => {
  it('writes the idx and stat rows from an AFTER INSERT trigger on hand_history', () => {
    expect(MIG).toMatch(
      /CREATE TRIGGER trg_ca_stats_live_from_hand\s+AFTER INSERT ON public\.hand_history/
    );
    const t = fn('trg_ca_stats_live_from_hand');
    expect(t).toMatch(/INSERT INTO public\.ca_hand_player_idx/);
    expect(t).toMatch(/INSERT INTO public\.ca_hand_player_stat/);
    expect(t).toMatch(/ca_hand_player_facts\(NULL, NULL, NULL, NEW\.id\)/);
  });

  it('never lets a stats failure fail the hand write', () => {
    const t = fn('trg_ca_stats_live_from_hand');
    expect(t).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(t).toMatch(/RAISE WARNING/);
    expect(t).not.toMatch(/RAISE EXCEPTION/);
  });

  it('reads every stat row the player has, with no rollup ceiling', () => {
    const f = fn('ca_player_stats_full');
    expect(f).toMatch(/FROM ca_hand_player_stat s\b/);
    expect(f).not.toMatch(/s\.created_at\s*<\s*v_ceil/);
    expect(f).not.toMatch(/\bFROM\s+hand_history\b/);
  });

  it('says so in the contract, as a measurement not a constant', () => {
    const v2 = fn('ca_player_stats_overview_v2');
    expect(v2).toMatch(/'live_tail_included', true/);
    expect(v2).toMatch(/'cash_money_source', v_source/);
    expect(v2).toMatch(/'cash_money_exact', \(v_source = 'exact_settlement'\)/);
    expect(v2).not.toMatch(/'cash_money_source', 'reconstructed_actions'/);
  });

  it('keeps the page live from any tab: the pulse poll replaced the dead realtime channel', () => {
    /**
     * This used to pin a postgres_changes subscription on ca_hand_player_idx.
     * On 2026-09-04 that table left the realtime publication (4.5M inserts a
     * day decoded out of WAL for one page; the slot was 136 MB behind), which
     * was the right call and also meant the subscription could never fire
     * again. Phase 3 replaced it with ca_player_stats_pulse, polled by the
     * open page while visible; the intent of this pin is unchanged.
     */
    expect(PAGE).toMatch(/useStatsPulse\(\{/);
    expect(PAGE).toMatch(/enabled: Boolean\(targetUserId && isOwnProfile\)/);
    expect(PAGE).toMatch(/onChange: scheduleRefresh/);
    expect(PAGE).not.toMatch(/postgres_changes/);
    expect(PAGE).not.toMatch(/table: 'ca_hand_player_idx'/);
    expect(MIG).toMatch(/FOR SELECT TO authenticated USING \(user_id = auth\.uid\(\)\)/);
  });
});

describe('the money is exact where the engine recorded it', () => {
  it('overlays ca_hand_facts on the reconstruction, per hand', () => {
    const f = fn('ca_player_stats_full');
    expect(f).toMatch(
      /LEFT JOIN ca_hand_facts x ON x\.hand_id = s\.hand_id AND x\.user_id = s\.user_id/
    );
    expect(f).toMatch(/coalesce\(x\.net, s\.profit\) AS profit/);
    expect(f).toMatch(/coalesce\(x\.invested, s\.invested_actions \+ s\.my_blind\) AS invested/);
    expect(f).toMatch(/count\(\*\) FILTER \(WHERE is_cash AND exact\)::int AS exact_cash_hands/);
  });

  it('ranks notable hands by the same money, cash only for the biggest modes', () => {
    const h = fn('ca_player_hands');
    expect(h).toMatch(/coalesce\(x\.net, s\.profit\) AS profit/);
    expect(h).toMatch(/AND \(v_mode = 'recent' OR s\.is_cash\)/);
    expect(h).not.toMatch(/act->>'action' IN/);
  });

  it('windows the tournament block on the same range as everything else', () => {
    const f = fn('ca_player_stats_full');
    expect(f).toMatch(/coalesce\(t\.start_time, tp\.registered_at, now\(\)\) >= v_since/);
  });
});

describe('the backlog is repaired and the index keeps up', () => {
  it('repairs existing rows in bounded, self-unscheduling batches', () => {
    const r = fn('ca_repair_hand_player_stat_money');
    expect(r).toMatch(/pg_try_advisory_xact_lock/);
    expect(r).toMatch(/clock_timestamp\(\) < v_deadline/);
    expect(r).toMatch(/PERFORM cron\.unschedule\('ca-stats-money-repair'\)/);
    expect(MIG).toMatch(/cron\.schedule\('ca-stats-money-repair'/);
  });

  it('loops the index refresh under a time budget instead of stopping at 3,000', () => {
    const i = fn('ca_refresh_hand_player_index');
    expect(i).toMatch(/LOOP\s+EXIT WHEN n_hands >= v_budget OR clock_timestamp\(\) >= v_deadline;/);
    expect(i).not.toMatch(/least\(greatest\(coalesce\(p_max_hands, 3000\), 1\), 3000\)/);
  });

  it('prunes by who has rows in the window, since the trigger now writes first', () => {
    const roll = fn('ca_roll_hand_stats_forward');
    expect(roll).toMatch(/WHERE created_at >= v_start AND created_at < v_ceil\)/);
    expect(roll).toMatch(/HAVING count\(\*\) > 1000/);
    expect(roll).not.toMatch(/RETURNING user_id/);
  });
});

describe('a failed read is not an empty history', () => {
  it('marks every facts payload that failed', () => {
    expect(FACTS).toMatch(/export type WithReadStatus<T> = T & \{ error\?: string \}/);
    /* `scope` joined the payload on 2026-09-20 so a figure cannot be printed
       under the wrong asset heading (src/services/statsScope.ts). What this
       pins is unchanged: a failed read is MARKED, never returned as an
       innocent empty payload. */
    expect(FACTS).toMatch(
      /return \{ \.\.\.fallback, scope, error: error\.message \|\| error\.code \|\| 'read_failed' \}/
    );
  });

  for (const file of [
    'src/components/stats/EVLuckChart.tsx',
    'src/components/stats/NemesisPanel.tsx',
    'src/components/stats/HoleCardHeatmap.tsx',
    'src/components/stats/BenchmarkPanel.tsx',
  ]) {
    it(`${file} renders a retryable error state`, () => {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      expect(src).toMatch(/readError/);
      expect(src).toMatch(/Try Again/);
    });
  }
});

describe('one range, the page range', () => {
  for (const file of [
    'src/components/stats/SessionHistory.tsx',
    'src/components/stats/BankrollTracker.tsx',
    'src/components/stats/PositionWinRates.tsx',
    'src/components/stats/AdvancedStatsSummary.tsx',
  ]) {
    it(`${file} carries no fetch and no range selector of its own`, () => {
      // Strip comments: the docblocks record what was removed, by name.
      const src = readFileSync(resolve(ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src).not.toMatch(/supabase\s*\.\s*(from|rpc)\(/);
      expect(src).not.toMatch(/masterBus/);
      expect(src).not.toMatch(/localStorage/);
      expect(src).not.toMatch(/from '\.\.\/\.\.\/lib\/supabase'/);
    });
  }

  it('feeds the Trophy Room the all-time payload, never the windowed one', () => {
    expect(TROPHIES_TAB).toMatch(/overall=\{allTimeStats\.overall\}/);
    expect(TROPHIES_TAB).toMatch(/lifetimeHands=\{allTimeStats\.lifetime\.hands\}/);
    expect(TROPHIES_TAB).not.toMatch(/<TrophyRoom overall=\{full\?\.overall\}/);
    // The page hands the tab the all-time payload, not the windowed one.
    expect(PAGE).toMatch(/allTimeStats=\{allTimeStats\}/);
    expect(PAGE).toMatch(
      /const allTimeStats: FullStats \| null = rangeKey === 'all' \? full : allTimeFetched/
    );
  });

  it('captions the share card with the window it covers', () => {
    expect(OVERVIEW_TAB).toMatch(
      /rangeLabel=\{rangeLabel === 'All' \? 'All Time' : `Last \$\{rangeLabel\}`\}/
    );
  });
});
