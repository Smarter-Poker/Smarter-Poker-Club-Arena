/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DASHBOARD COUNTS WHAT IS THERE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04, phase 4 of the club operations upgrade)
 *
 * Five readings on /clubs/:id/dashboard-full were arithmetic over the wrong
 * set, and every one was measured against Deep Stack Society before it was
 * fixed:
 *
 *   - the Tables tab listed the 50 NEWEST tables and computed "N Live, M
 *     Seated" over them; 319 tables were live and the tab showed 50;
 *   - "Seated Now" counted seat rows (479) and called them people (243);
 *   - the leaderboard re-sorted the 100 most PROFITABLE players by Hands, and
 *     zero of the ten it showed were in the club's true top ten by hands;
 *   - ca_club_tournaments' LIMIT sat after jsonb_agg, so a request for 25 rows
 *     returned 3,534 in 879,696 bytes;
 *   - ca_club_revenue admitted every member of the club to the club's rake.
 *
 * Each pin below fails if one of those comes back. The migration pins slice
 * by SQL structure (tests/helpers/sourceWindow), never by byte count.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceDollarQuoted, sliceMethod } from '../helpers/sourceWindow';
import { canViewClubFinance, TABLES_LIVE_CAP } from '../../src/pages/club/ClubDashboard';
import { chipsHeldByMembership } from '../../src/components/admin/ClubMemberManagement';

const MIGRATION = readFileSync(
  'supabase/migrations/20260904100000_the_dashboard_counts_what_is_there.sql',
  'utf8'
);
const PAGE = readFileSync('src/pages/club/ClubDashboard.tsx', 'utf8');
const CARDS = readFileSync('src/components/club/ClubStatsCards.tsx', 'utf8');
const PANEL = readFileSync('src/components/admin/ClubMemberManagement.tsx', 'utf8');

/**
 * From `anchor` to the parenthesis that closes the first one opened after it:
 * one CTE (`live AS (...)`), one jsonb key (`'seated_now', (...)`).
 */
const parenBlock = (src: string, anchor: string): string => {
  const start = src.indexOf(anchor);
  expect(start, `"${anchor}" is present`).toBeGreaterThan(-1);
  const cleaned = blankNonCode(src.slice(start));
  let depth = 0;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '(') depth++;
    else if (cleaned[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(start, start + i + 1);
    }
  }
  return src.slice(start);
};

const fn = (name: string) => {
  const start = MIGRATION.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined by the migration`).toBeGreaterThan(-1);
  return sliceDollarQuoted(MIGRATION.slice(start), '$function$');
};

describe('the migration is one transaction and every function is gated and granted', () => {
  it('opens with BEGIN and closes with COMMIT, once each', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it.each([
    'ca_club_tables',
    'ca_club_dashboard_stats',
    'ca_club_top_players',
    'ca_club_tournaments',
    'ca_club_revenue',
  ])('%s is SECURITY DEFINER with a pinned search_path', (name) => {
    const start = MIGRATION.indexOf(`FUNCTION public.${name}(`);
    const header = MIGRATION.slice(start, MIGRATION.indexOf('$function$', start));
    expect(header).toMatch(/SECURITY DEFINER/);
    expect(header).toMatch(/SET search_path TO 'public'/);
  });

  it.each(['ca_club_tables', 'ca_club_top_players', 'ca_club_tournaments'])(
    '%s is revoked from anon and granted to authenticated',
    (name) => {
      expect(MIGRATION).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon;`)
      );
      expect(MIGRATION).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO authenticated`)
      );
    }
  );

  it('asserts, inside the transaction, that neither re-signed function left an overload behind', () => {
    const block = sliceDollarQuoted(MIGRATION.slice(MIGRATION.lastIndexOf('DO $$')), '$$');
    expect(block).toContain("p.proname = 'ca_club_top_players'");
    expect(block).toContain("p.proname = 'ca_club_tournaments'");
    expect(block).toMatch(/IF n <> 1 THEN RAISE EXCEPTION/);
  });

  it('drops the old signatures before creating the new ones, so PostgREST sees one candidate', () => {
    expect(MIGRATION).toContain(
      'DROP FUNCTION IF EXISTS public.ca_club_top_players(uuid, timestamp with time zone, integer);'
    );
    expect(MIGRATION).toContain(
      'DROP FUNCTION IF EXISTS public.ca_club_tournaments(uuid, integer);'
    );
  });
});

describe('ca_club_tables: the tables tab reads the tables that are live', () => {
  const body = fn('ca_club_tables');

  it('is gated by the same membership check as the page', () => {
    expect(body).toContain('IF NOT ca_can_view_club(p_club_id) THEN');
    expect(body).toContain("ERRCODE = '42501'");
  });

  it('applies the union scope the raw select used to build in the browser', () => {
    expect(body).toMatch(
      /t\.club_id = p_club_id\s+OR \(v_union IS NOT NULL AND t\.union_id = v_union\)/
    );
  });

  it('selects live tables by status, fullest first, never by created_at alone', () => {
    const live = parenBlock(body, 'live AS (');
    expect(live).toContain('WHERE s.is_live');
    expect(live).toMatch(/ORDER BY coalesce\(se\.seated, 0\) DESC, s\.created_at DESC/);
  });

  it('counts seats from table_seats, not tables.current_players', () => {
    expect(body).toContain('coalesce(se.seated, 0)::integer AS current_players');
    expect(body).not.toMatch(/t\.current_players/);
  });

  it('reports the true live count and says when the list was capped', () => {
    expect(body).toContain("'live_count', (SELECT count(*) FROM scoped WHERE is_live)");
    expect(body).toContain("'live_truncated', (SELECT count(*) FROM scoped WHERE is_live) > v_cap");
  });

  it('counts people and seat rows separately, so neither is mistaken for the other', () => {
    expect(body).toMatch(/'seated_people', \(\s+SELECT count\(DISTINCT ts\.user_id\)/);
    expect(body).toMatch(/'seat_rows', \(\s+SELECT count\(\*\) FROM table_seats/);
  });

  it('never filters on whether a player is house-run', () => {
    expect(body).not.toMatch(/is_horse/);
  });
});

describe('ca_club_dashboard_stats: seated_now counts people and the window is read once', () => {
  const body = fn('ca_club_dashboard_stats');

  it('counts DISTINCT people for seated_now', () => {
    const seated = parenBlock(body, "'seated_now', (");
    expect(seated).toContain('count(DISTINCT ts.user_id)');
    expect(seated).toContain('ts.user_id IS NOT NULL');
  });

  it('reads the 14-day window from the per-hand rollup exactly once', () => {
    const code = body.replace(/--[^\n]*/g, '');
    expect(code.match(/club_hand_daily\b/g)).toHaveLength(1);
    expect(body).toMatch(/WITH days AS \(/);
  });

  it('no longer re-aggregates the rake ledger through club_daily_stats on every call', () => {
    // A view over 163,585 rake_records + a 1.37M-row seq scan, referenced five
    // times: 132,855 buffers and ~910 ms per dashboard load. The rollup it
    // fell back from has covered every day this function reads since
    // 2026-08-05.
    expect(body).not.toContain('club_daily_stats');
  });

  it('still returns every key the client reads', () => {
    for (const key of [
      'total_members',
      'online_now',
      'active_tables',
      'total_tables',
      'hands_today',
      'rake_today',
      'new_this_week',
      'hands_week',
      'rake_week',
      'seated_now',
      'daily_series',
    ]) {
      expect(body, key).toContain(`'${key}'`);
    }
  });
});

describe('ca_club_top_players: the server orders by the key the viewer chose', () => {
  const body = fn('ca_club_top_players');

  it('takes p_sort with a default, so the old three-argument call still resolves', () => {
    const start = MIGRATION.indexOf('CREATE FUNCTION public.ca_club_top_players(');
    const signature = MIGRATION.slice(start, MIGRATION.indexOf(')', start));
    expect(signature).toContain("p_sort text DEFAULT 'profit'");
  });

  it('orders by the chosen key BEFORE the limit', () => {
    const orderAt = body.indexOf('ORDER BY');
    const limitAt = body.indexOf('LIMIT least(');
    expect(orderAt).toBeGreaterThan(-1);
    expect(limitAt).toBeGreaterThan(orderAt);
    const order = body.slice(orderAt, limitAt);
    expect(order).toContain("CASE WHEN v_sort = 'hands'   THEN a.hands_played    END DESC");
    expect(order).toContain("CASE WHEN v_sort = 'winrate' THEN a.win_rate        END DESC");
    expect(order).toContain("CASE WHEN v_sort = 'biggest' THEN a.biggest_pot_won END DESC");
  });

  it('refuses an unknown sort key by falling back to profit rather than erroring', () => {
    expect(body).toContain("IF v_sort NOT IN ('profit', 'hands', 'winrate', 'biggest') THEN");
    expect(body).toContain("v_sort := 'profit';");
  });

  it('still masks the horse flag below owner / co_owner / admin, and never filters on it', () => {
    expect(body).toContain('(v_may_see AND coalesce(pr.is_horse, false)) AS is_horse');
    const where = body.slice(body.indexOf('WHERE s.club_id'), body.indexOf('GROUP BY'));
    expect(where).not.toContain('is_horse');
  });
});

describe('ca_club_tournaments: the limit limits and the window is the viewer’s', () => {
  const body = fn('ca_club_tournaments');

  it('applies LIMIT inside each subquery, before jsonb_agg', () => {
    const live = parenBlock(body, 'live AS (');
    const recent = parenBlock(body, 'recent AS (');
    expect(live).toContain('LIMIT v_cap');
    expect(recent).toContain('LIMIT v_cap');
    // No LIMIT may follow an aggregate: that was the original defect.
    const afterAgg = body.slice(body.indexOf('jsonb_agg'));
    expect(afterAgg).not.toMatch(/\)\s*LIMIT\s+least/);
  });

  it('takes p_days, caps it, and says which window the summary describes', () => {
    const start = MIGRATION.indexOf('CREATE FUNCTION public.ca_club_tournaments(');
    const signature = MIGRATION.slice(start, MIGRATION.indexOf(')', start));
    expect(signature).toContain('p_days integer DEFAULT 30');
    expect(body).toContain("'window_days', v_days");
    expect(body).toContain("'completed_in_window'");
    expect(body).toContain("'prize_pool_in_window'");
    // The old keys ride along for one release, exact for the caller that
    // still reads them (it never passes p_days, so its window is 30).
    expect(body).toContain("'completed_30d'");
    expect(body).toMatch(/LEGACY, one release/);
  });
});

describe('ca_club_revenue: a finance read is gated like the other finance reads', () => {
  const body = fn('ca_club_revenue');

  it('gates on ca_can_view_club_finances, not on membership', () => {
    expect(body).toContain('IF NOT ca_can_view_club_finances(p_club_id) THEN');
    expect(body).not.toContain('IF NOT ca_can_view_club(p_club_id)');
  });

  it('keeps the payload the client already reads', () => {
    for (const key of ['range_days', 'totals', 'insurance', 'daily', 'by_table']) {
      expect(body).toContain(`'${key}'`);
    }
  });
});

describe('the page reads the floor through ca_club_tables', () => {
  const load = sliceMethod(PAGE, 'const loadDashboardData = async');

  it('calls the function with the same cap the server enforces', () => {
    expect(load).toContain(
      "supabase.rpc('ca_club_tables', { p_club_id: uuid, p_limit: TABLES_LIVE_CAP })"
    );
    expect(TABLES_LIVE_CAP).toBe(500);
  });

  it('no longer selects the 50 newest tables from the browser', () => {
    expect(load).not.toContain(".from('tables')");
    expect(load).not.toContain('.limit(50)');
    expect(PAGE).not.toContain('clubGamesOrFilter');
  });

  it('paints the header from the floor-wide figures, never a count over the rows on screen', () => {
    expect(PAGE).toContain('const liveTableCount = tablesMeta?.liveCount ?? 0;');
    expect(PAGE).toContain('const seatedAcrossTables = tablesMeta?.seatedPeople ?? 0;');
    expect(PAGE).not.toMatch(/clubTables\.filter\(\(t\) => isLiveTableStatus/);
  });

  it('sends the chosen sort to the server and re-reads when it changes', () => {
    expect(load).toContain('p_sort: sortBy');
    expect(PAGE).toMatch(/\}, \[clubId, dateRange, sortBy\]\);/);
  });

  it('sends the time range to the tournaments read and reads the window back', () => {
    expect(PAGE).toContain('p_limit: 25, p_days: windowDays');
    expect(PAGE).toContain('tournaments.summary.window_days');
    expect(PAGE).not.toContain('completed_30d');
  });
});

describe('the horse toggle is a per-visit viewing filter that can only do what it says', () => {
  it('is never persisted, and the old key is tombstoned', () => {
    expect(PAGE).not.toContain("getLocalStorage('ca_dashboard_hide_horses'");
    expect(PAGE).not.toContain("setLocalStorage('ca_dashboard_hide_horses'");
    expect(PAGE).toContain("removeLocalStorage('ca_dashboard_hide_horses')");
    expect(PAGE).toContain('useState<boolean>(false)');
  });

  it('is offered only when the viewer can see the flag it filters on', () => {
    expect(PAGE).toContain('const horseFlagVisible = topPlayers.some((p) => p.isHorse);');
    expect(PAGE).toMatch(/\{horseFlagVisible && \(\s*<label/);
  });

  it('relabels every figure it scopes, so a filtered number can never be read as the club’s', () => {
    expect(PAGE).toContain("hideHorses ? 'leaderboard-people' : 'leaderboard'");
    expect(PAGE).toContain("hideHorses ? 'People (Horses Hidden)' : 'Players'");
    expect(PAGE).toContain("hideHorses ? 'Person-Hands (Horses Hidden)' : 'Player-Hands'");
  });
});

describe('the revenue tab is offered to the finance roles and refused to everyone else', () => {
  it('mirrors ca_can_view_club_finances exactly', () => {
    for (const role of ['owner', 'co_owner', 'admin', 'super_agent']) {
      expect(canViewClubFinance(role), role).toBe(true);
    }
    for (const role of ['agent', 'sub_agent', 'player', 'member', '', null, undefined]) {
      expect(canViewClubFinance(role), String(role)).toBe(false);
    }
  });

  it('keeps the tab off the strip for a non-finance role', () => {
    expect(PAGE).toMatch(
      /\.\.\.\(canSeeRevenue \? \(\[\{ id: 'revenue', label: 'Revenue' \}\] as const\) : \[\]\)/
    );
  });

  it('names the refusal instead of calling it "No Revenue Data Available"', () => {
    expect(PAGE).toContain('Revenue Is Restricted To Club Owners, Admins And Super Agents');
    expect(PAGE).not.toContain('>No Revenue Data Available<');
  });

  it('says "Last 90 Days" when the range is All, because that is what the server returns', () => {
    expect(PAGE).toContain("dateRange === 'all' ? 'Last 90 Days' : rangeLabel");
  });
});

describe('the insurance cards appear when a policy has been sold, not whenever an object exists', () => {
  it('gates on contracts > 0', () => {
    expect(PAGE).toContain(
      'const hasInsurance = !!revenue?.insurance && revenue.insurance.contracts > 0;'
    );
    expect(PAGE).not.toMatch(/\.\.\.\(revenue\.insurance\s*\?/);
    expect(PAGE).not.toMatch(/\{revenue\.insurance && \(/);
  });
});

describe('the metric cards fetch once', () => {
  it('self-load only when no parent owns the read', () => {
    expect(CARDS).toContain('const selfLoading = statsProp === undefined;');
    expect(CARDS).toContain('if (!selfLoading) return;');
    expect(CARDS).not.toContain('}, [clubId, !!statsProp]);');
  });
});

describe('the member panel cannot destroy a wallet by deleting its row', () => {
  it('adds up every chip column a membership row carries', () => {
    expect(
      chipsHeldByMembership({
        chip_balance: '10067.64',
        held_chips: 0,
        locked_chips: null,
        promo_balance: 2,
        credit_used: 0.5,
      })
    ).toBeCloseTo(10070.14, 2);
    expect(chipsHeldByMembership({})).toBe(0);
  });

  it('refuses a removal while anything is held, and confirms one that is safe', () => {
    const kick = sliceMethod(PANEL, 'const kickMember = async');
    expect(kick).toContain('if (member.chipsAtRisk > 0) {');
    expect(kick).toContain('await liveSeatTableIds(resolvedId, member.id)');
    expect(kick).toContain('window.confirm(');
    // The order matters: no confirm dialog is shown for a removal that will
    // be refused anyway.
    expect(kick.indexOf('chipsAtRisk > 0')).toBeLessThan(kick.indexOf('window.confirm('));
  });

  it('checks the row count on every write, so a 204 is not reported as success', () => {
    const kick = sliceMethod(PANEL, 'const kickMember = async');
    const ban = sliceMethod(PANEL, 'const toggleBan = async');
    for (const body of [kick, ban]) {
      expect(body).toContain(".select('user_id')");
      expect(body).toContain('if (!data || data.length === 0) {');
    }
  });

  it('surfaces a failed read instead of an empty roster', () => {
    expect(PANEL).toContain('const [loadError, setLoadError] = useState(false);');
    expect(PANEL).toContain('The Member List Could Not Be Loaded.');
    const load = sliceMethod(PANEL, 'const loadMembers = useCallback');
    expect(load).toContain('if (error) throw error;');
    expect(load).toContain('if (profilesError) throw profilesError;');
  });

  it('staggers rows by id, so a search cannot leave survivors at opacity 0', () => {
    expect(PANEL).toContain('visibleIds.has(member.id)');
    expect(PANEL).not.toMatch(/visibleItems\.has\(i\)/);
  });

  it('renders the avatar as a picture, not as the text of its URL', () => {
    expect(PANEL).toMatch(/<img src=\{member\.avatarUrl\} alt="" loading="lazy" \/>/);
    expect(PANEL).not.toContain('<span className="avatar">{member.avatarUrl}</span>');
  });
});
