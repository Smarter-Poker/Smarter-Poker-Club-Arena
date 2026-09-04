/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE MONEY IS READ FROM THE LEDGER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04, phase 6 of the club operations upgrade)
 *
 * Every defect below was measured on Deep Stack Society (2a1132b9) against
 * production before it was changed. The club is four days old and dealt
 * 216,140 hands on 2026-09-03, which makes it the hardest case on the
 * platform today.
 *
 *   - The Financials page summed the OLDEST 5,000 rake_records rows in the
 *     browser: `.order('created_at', {ascending:true}).limit(5000)` against
 *     124,549 cash rake rows in three days. Rake Collected read 4.6% of the
 *     truth, Hands Played a flat 5,000, and Net Revenue inherited all of it.
 *   - Its rakeback line read chip_transactions directly, whose RLS returns
 *     `from_user_id = auth.uid() OR to_user_id = auth.uid()` - the caller's
 *     own rows. An owner saw the rakeback paid to themselves.
 *   - Its union-fee line read invoice_type 'union_to_club'; the weekly
 *     square-up writes 'union_weekly_squareup'. A silent zero in Net Revenue.
 *   - "Club Chip Audit Trail" read chip_ledger, whose RLS is also the
 *     caller's own rows, and showed a club owner their personal movements.
 *   - Four numbers were called "hands" and two "rake". rake_records is the
 *     money ledger (the row is written in the transaction that credits the
 *     club); 176 of its rows on 2026-09-03 have no hand_history row at all.
 *   - club_hand_daily.pot_total adds tournament chips to cash pots:
 *     118,254,757 against 5,239,484 of cash. The dashboard's "Average Pot"
 *     read it and was wrong by twenty times.
 *   - club_table_daily dropped every raked hand whose player_contributions
 *     were never recorded (109 rows, 173.38 chips), so it disagreed with the
 *     ledger by exactly those rows.
 *   - Per-player rake was 0.00 for every club not in a union: the rake CTE
 *     joined union_rake_paid_daily_user on a NULL union.
 *   - Per-player CASH results were never written for a club outside a union
 *     either: all three writers of ca_club_player_daily.cash_net joined
 *     `tables.union_id IS NOT NULL`. 415 players, not one non-zero cash row.
 *   - Table add-ons (713,968.61 chips in seven days), rebuys and refunds were
 *     not counted as table money by any of those writers.
 *   - The insurance report's take rate divided event counts by event counts
 *     (an offer accepted then cashed out counted twice) and its funnel and
 *     money used different windows, so the day rows could never sum to the
 *     headline.
 *   - Both report pages passed the route SLUG into a uuid argument.
 *   - RakeReports pulled every rake_records row in the window into the
 *     browser with no limit at all.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceDollarQuoted, sliceMethod } from '../helpers/sourceWindow';

const MIGRATION = readFileSync(
  'supabase/migrations/20260904220000_the_money_is_read_from_the_ledger.sql',
  'utf8'
);
const FINANCIALS = readFileSync('src/pages/ClubFinancialsPage.tsx', 'utf8');
/**
 * The page's own header explains the defects by name ("Hands Played a flat
 * 5,000", ".limit(5000)"), which is history worth keeping and is not a read.
 * The absence pins below are made against the CODE.
 */
const FINANCIALS_CODE = blankNonCode(FINANCIALS);
const LEDGER = readFileSync('src/components/common/TransactionLedgerView.tsx', 'utf8');
const RAKE_REPORTS = readFileSync('src/components/admin/RakeReports.tsx', 'utf8');
const CLUB_DASH = readFileSync('src/components/dashboard/ClubFinancialDashboard.tsx', 'utf8');
const DASHBOARD = readFileSync('src/pages/club/ClubDashboard.tsx', 'utf8');
const STATS_CARDS = readFileSync('src/components/club/ClubStatsCards.tsx', 'utf8');
const CLUB_DATA = readFileSync('src/pages/club/ClubDataPage.tsx', 'utf8');
const INSURANCE = readFileSync('src/pages/club/ClubInsuranceReportPage.tsx', 'utf8');
const BOMB_POT = readFileSync('src/pages/club/ClubBombPotReportPage.tsx', 'utf8');
const MANIFEST = readFileSync('scripts/ci/schema-manifest.d/cowork-ops-upgrade.json', 'utf8');
/**
 * The three corrections shipped the same day, each written because the live
 * measurement said the previous one was wrong. See their headers.
 */
const CORRECTION_1 = readFileSync(
  'supabase/migrations/20260904234500_a_rebuild_that_races_the_ledger_checks_itself.sql',
  'utf8'
);
const CORRECTION_2 = readFileSync(
  'supabase/migrations/20260904235500_a_live_day_is_the_triggers_to_keep.sql',
  'utf8'
);
const CORRECTION_3 = readFileSync(
  'supabase/migrations/20260904235900_one_rebuild_signature_and_a_correction_still_lands.sql',
  'utf8'
);
/** Found by the gate on this phase - see its header. */
const CORRECTION_4 = readFileSync(
  'supabase/migrations/20260905001500_the_busiest_tables_count_table_hands.sql',
  'utf8'
);
const ACTIVITY_CHART = readFileSync('src/components/club/ClubActivityChart.tsx', 'utf8');

const fn = (name: string) => {
  const start = MIGRATION.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sliceDollarQuoted(MIGRATION.slice(start), '$function$');
};

describe('the rake rollup is the ledger, kept per club per day', () => {
  it('is a table with a per-(club, day) key, readable only by the definer functions', () => {
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS public.ca_club_rake_daily');
    expect(MIGRATION).toContain('PRIMARY KEY (club_id, stat_date)');
    expect(MIGRATION).toContain('ALTER TABLE public.ca_club_rake_daily ENABLE ROW LEVEL SECURITY');
    expect(MIGRATION).toContain(
      'REVOKE ALL ON TABLE public.ca_club_rake_daily FROM PUBLIC, anon, authenticated;'
    );
  });

  it('reads rake_records and never hand_history', () => {
    const body = fn('fn_ca_club_rake_daily_compute');
    expect(body).toContain('FROM rake_records r');
    expect(body).not.toContain('hand_history');
    expect(body).toContain('NOT coalesce(r.is_tournament, false)');
  });

  it('keeps a raked hand whose contributions were never recorded', () => {
    // The whole rake stays with the table's club rather than vanishing.
    const body = fn('fn_ca_club_rake_daily_compute');
    expect(body).toContain('has_split');
    expect(body).toContain('CASE WHEN h.has_split THEN 0 ELSE h.rake END');
    const refresh = fn('fn_club_table_daily_refresh_day');
    expect(refresh).toContain('NULL::text, 1::numeric, 1::numeric');
  });

  it('attributes a union player to their home club and the drop to the table', () => {
    const body = fn('fn_ca_club_rake_daily_compute');
    expect(body).toContain('JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id');
    expect(body).toContain('ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id');
    expect(body).toContain('h.rake * s.contrib / st.tot');
  });

  it('is maintained by statement-level triggers that warn rather than refuse a ledger write', () => {
    expect(MIGRATION).toContain('CREATE TRIGGER trg_ca_club_rake_daily_ins');
    expect(MIGRATION).toContain('REFERENCING NEW TABLE AS new_rows');
    expect(MIGRATION).toContain('FOR EACH STATEMENT EXECUTE FUNCTION');
    const insert = fn('trg_ca_club_rake_daily_insert');
    expect(insert).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(insert).toContain('RAISE WARNING');
  });

  it('reconciles itself hourly against the ledger', () => {
    const catchup = fn('fn_club_table_daily_catchup');
    expect(catchup).toContain('fn_ca_club_rake_daily_rebuild_range(d, d)');
    expect(catchup).toContain('abs(v_ledger - v_rollup) > 0.005');
  });

  it('never filters on whether a player is house-run', () => {
    // is_horse survives in exactly the sanctioned place (CLAUDE.md 10.5): the
    // flag surfaced as DATA on a player row, behind fn_can_see_horse_flag.
    // Never in a WHERE, never negated, never a reason to leave a horse out.
    const uses = MIGRATION.match(/[^\n]*is_horse[^\n]*/g) || [];
    for (const line of uses) {
      if (line.trim().startsWith('--')) continue;
      // Either the masking itself, or a projection of the column it produced.
      const masked = line.includes('fn_can_see_horse_flag');
      const projection = /\bq\.is_horse\b/.test(line);
      expect(masked || projection, line).toBe(true);
    }
    expect(MIGRATION).not.toMatch(/NOT\s+COALESCE\(\s*\w+\.is_horse/i);
    expect(MIGRATION).not.toMatch(/is_horse\s*=\s*(false|true)/i);
    // The masking expression itself reads
    // `fn_can_see_horse_flag(...) AND COALESCE(pr.is_horse,false)`, so an
    // "AND near is_horse" pin would fire on the sanctioned use. What must
    // never appear is the EXCLUDING shape: a negation, or an equality used to
    // drop rows.
    expect(MIGRATION).not.toMatch(/NOT\s+\w*\.?is_horse/i);
    expect(MIGRATION).not.toMatch(/is_horse\s+IS\s+(NOT\s+)?(TRUE|FALSE)/i);
  });
});

describe('the finance reads say who may call them', () => {
  it.each([
    ['ca_club_financials(uuid, date, date)', 'ca_club_financials'],
    ['ca_club_chip_ledger(uuid, integer, timestamptz, boolean)', 'ca_club_chip_ledger'],
    ['ca_club_insurance_report(uuid, integer)', 'ca_club_insurance_report'],
    ['ca_club_revenue(uuid, integer)', 'ca_club_revenue'],
  ])('%s is gated and granted', (signature, name) => {
    expect(fn(name)).toContain('ca_can_view_club_finances');
    expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon;`);
    expect(MIGRATION).toContain(
      `GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated, service_role;`
    );
  });

  it('the rollup maintainers are service-role only', () => {
    for (const sig of [
      'fn_ca_club_rake_daily_compute(timestamptz, timestamptz, uuid[])',
      'fn_ca_club_rake_daily_apply(uuid[])',
      'fn_ca_club_rake_daily_rebuild_range(date, date)',
      'fn_ca_club_rake_daily_rebuild(date, date)',
      'fn_rebuild_ca_club_commission_daily()',
    ]) {
      expect(MIGRATION, sig).toContain(
        `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`
      );
      expect(MIGRATION, sig).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });

  it('the hand breakdown admits everyone who may read the club money', () => {
    const body = fn('fn_hand_rake_breakdown');
    expect(body).toContain('public.ca_can_view_club_finances(v_rr.club_id)');
    expect(body).toContain('fn_is_union_overseer');
  });
});

describe('the financials read', () => {
  const body = fn('ca_club_financials');

  it('names every line of net revenue and computes it from them', () => {
    expect(body).toContain("'net_revenue', round(t.gross_rake - t.bbj_drop + t.tournament_fees");
    expect(body).toContain('- t.rakeback_paid - t.agent_commissions - t.union_fee, 2)');
  });

  it('reads the union fee from the statement type the union actually writes', () => {
    expect(body).toContain("i.invoice_type = 'union_weekly_squareup'");
    expect(body).not.toContain("'union_to_club'");
    expect(body).toContain("i.breakdown->>'union_fee_kept'");
  });

  it('reads rakeback and commissions server-side, for every player', () => {
    expect(body).toContain("x.transaction_type = 'rakeback'");
    expect(body).toContain('FROM ca_club_commission_daily k');
  });

  it('clamps a window that starts before the club did', () => {
    expect(body).toContain('IF v_start < v_first THEN v_start := v_first; END IF;');
    expect(body).toContain("'first_day', v_first");
  });
});

describe('the chip ledger read is the club ledger', () => {
  const body = fn('ca_club_chip_ledger');

  it('is club-scoped, paged, and leaves the per-hand rows out by default', () => {
    expect(body).toContain('WHERE l.club_id = p_club_id');
    expect(body).toContain("l.category NOT IN ('rake', 'bbj_contribution')");
    expect(body).toContain("'has_more'");
    expect(body).toContain("'next_before'");
  });

  it('has an index to page it with', () => {
    expect(MIGRATION).toContain(
      'CREATE INDEX IF NOT EXISTS idx_chip_ledger_club_created_desc\n  ON public.chip_ledger (club_id, created_at DESC);'
    );
  });
});

describe('per-player money for a club that is not in a union', () => {
  it('rake comes from the club rollup when there is no union', () => {
    for (const name of ['ca_club_player_page', 'ca_club_player_breakdown']) {
      const body = fn(name);
      expect(body, name).toContain('FROM public.club_rake_daily_user c');
      expect(body, name).toContain('WHERE v_union IS NULL AND c.club_id=p_club_id');
      expect(body, name).toContain('WHERE v_union IS NOT NULL AND u.union_id=v_union');
    }
  });

  it('cash results are written for a standalone table by all three writers', () => {
    expect(fn('trg_ca_reporting_wallet_insert')).toContain('v_club:=v_table_club;');
    expect(fn('ca_refresh_reporting_cash_rollup')).toContain('tb.union_id IS NULL');
    expect(fn('ca_refresh_reporting_rollups_base')).toContain('tb.union_id IS NULL');
  });

  it('a top-up, a rebuy and a refund are table money', () => {
    for (const name of [
      'trg_ca_reporting_wallet_insert',
      'ca_refresh_reporting_cash_rollup',
      'ca_refresh_reporting_rollups_base',
      'fn_club_table_daily_refresh_day',
    ]) {
      expect(fn(name), name).toMatch(/'addon'/);
      expect(fn(name), name).toMatch(/'rebuy'/);
    }
  });

  it('the sign of a tournament row is the row type, not its name', () => {
    const trigger = fn('trg_ca_reporting_wallet_insert');
    expect(trigger).toContain("v_tournament:=CASE WHEN NEW.type='credit' THEN NEW.amount");
    expect(trigger).not.toContain("CASE WHEN NEW.category='tournament_buyin' THEN -NEW.amount");
  });
});

describe('the insurance report counts offers, over one window', () => {
  const body = fn('ca_club_insurance_report');

  it('groups the funnel per offer, with one outcome each', () => {
    expect(body).toContain(
      'GROUP BY e.table_id, coalesce(e.hand_number::text, e.id::text), e.player_id'
    );
    expect(body).toContain('count(*) FILTER (WHERE o.accepted AND NOT o.cashed_out)');
  });

  it('uses UTC days for the headline as well as the rows', () => {
    expect(body).toContain('v_from := v_today - (v_days - 1);');
    expect(body).not.toContain('now() - (v_days');
    expect(body).toContain("'window_start', v_from");
  });

  it('returns the take rate rather than leaving the browser to divide', () => {
    expect(body).toContain("'take_rate_pct'");
  });
});

describe('the dashboard revenue reads the same ledger', () => {
  const body = fn('ca_club_revenue');

  it('takes rake, drop and pots from the rake rollup, not the hand rollup', () => {
    expect(body).toContain('FROM ca_club_rake_daily d');
    expect(body).toContain("'rake_source', 'rake_records'");
    expect(body).not.toContain('sum(d.pot_total)');
  });

  it('separates raked hands from hands dealt', () => {
    expect(body).toContain("'hands_dealt', coalesce((SELECT sum(h.hands) FROM club_hand_daily h");
    expect(fn('ca_club_dashboard_stats')).toContain("'raked_hands_today'");
  });
});

describe('the migration refuses to commit the old shapes', () => {
  const block = sliceDollarQuoted(MIGRATION.slice(MIGRATION.lastIndexOf('DO $$')), '$$');

  it.each([
    'ca_club_player_page still reads per-player rake from the union rollup alone',
    'ca_club_insurance_report still mixes a rolling window with UTC day rows',
    'fn_club_table_daily_refresh_day still drops raked hands with no recorded contributions',
    'ca_club_revenue still reads pot volume from club_hand_daily',
    'trg_ca_reporting_wallet_insert still drops cash results at standalone tables',
    'the rake rollup trigger is not installed',
  ])('asserts: %s', (message) => {
    expect(block).toContain(message);
  });
});

describe('the client asks the server for the money', () => {
  it('the financials page makes one gated call and no table reads', () => {
    expect(FINANCIALS).toContain("supabase.rpc('ca_club_financials'");
    // The only tables this page still reads are the two that decide which
    // WALLET ROWS to draw for the viewer - never a money total.
    const tables = [...FINANCIALS.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual(['club_members', 'clubs']);
    expect(FINANCIALS_CODE).not.toMatch(/limit\(5000\)/);
    expect(FINANCIALS_CODE).not.toMatch(/\.order\(/);
  });

  it('resolves the club strictly and names a missing club', () => {
    const load = sliceMethod(FINANCIALS, 'const load = useCallback');
    expect(load).toContain('resolveClubUUIDStrict(clubId)');
    expect(load).toContain("'ClubNotFoundError'");
    expect(FINANCIALS).not.toMatch(/\bresolveClubUUID\(/);
  });

  it('shows the server refusal as a permission gate, not as zeros', () => {
    expect(FINANCIALS).toContain('isAuthzError(error)');
    expect(FINANCIALS).toContain('setDenied(true)');
    expect(FINANCIALS).toContain('<PermissionState');
  });

  it('labels raked hands, the drop and the union line honestly', () => {
    expect(FINANCIALS).toContain('Raked Hands');
    expect(FINANCIALS).toContain('To The Jackpot');
    expect(FINANCIALS).toContain("data?.union_id ? 'Union Fee' : 'Union Fee (No Union)'");
    expect(FINANCIALS_CODE).not.toContain('Hands Played');
  });

  it('the audit trail is club-scoped through the RPC', () => {
    expect(FINANCIALS).toContain('clubScoped');
    expect(LEDGER).toContain("supabase.rpc('ca_club_chip_ledger'");
    expect(LEDGER).toContain('clubScoped = false');
  });

  it('the ledger view stops reading a failed read as "no transactions"', () => {
    expect(LEDGER).toContain("reportError(readError, 'TransactionLedgerView.read')");
    expect(LEDGER).toContain("setError('The Ledger Could Not Be Loaded')");
  });

  it('rake reports asks the rollup instead of downloading the ledger', () => {
    expect(RAKE_REPORTS).toContain("supabase.rpc('ca_club_financials'");
    expect(RAKE_REPORTS).not.toMatch(
      /from\('rake_records'\)\s*\n\s*\.select\('rake_amount, created_at'\)/
    );
    expect(RAKE_REPORTS).toContain('Raked Hands');
    // Math.max of an empty list is -Infinity, and every bar height was NaN%.
    expect(RAKE_REPORTS).toContain('Math.max(0, ...data.dailyBreakdown.map');
  });

  it('the commission split comes from the one gated read', () => {
    expect(CLUB_DASH).toContain("supabase.rpc('ca_club_financials'");
    expect(CLUB_DASH).not.toMatch(/from\('rake_records'\)/);
    expect(CLUB_DASH).not.toMatch(/transaction_type', 'rakeback'/);
    expect(CLUB_DASH).toContain('isAuthzError(error)');
  });

  it('the dashboard separates raked hands from hands dealt', () => {
    expect(DASHBOARD).toContain("label: 'Raked Hands'");
    expect(DASHBOARD).toContain("label: 'Hands Dealt'");
    expect(DASHBOARD).toContain("label: 'Average Raked Pot'");
    expect(DASHBOARD).toContain("label: 'Tournament Fees'");
    expect(STATS_CARDS).toContain("label: 'Hands Dealt Today'");
    expect(STATS_CARDS).toContain("label: 'Cash Rake Today'");
  });

  it('club data names a sit-and-go and renders the statement standing', () => {
    expect(CLUB_DATA).toContain("{ id: 'SNG', label: 'Sit & Go' }");
    expect(CLUB_DATA).not.toContain("label: 'Heads Up'");
    expect(CLUB_DATA).toContain('latestInvoice.overdue');
    expect(CLUB_DATA).toContain('Outstanding');
    expect(CLUB_DATA).toContain('Paid</span>');
  });

  it('both report pages resolve the slug before calling a uuid RPC', () => {
    for (const [name, src] of [
      ['insurance', INSURANCE],
      ['bomb pot', BOMB_POT],
    ] as const) {
      expect(src, name).toContain('resolveClubUUIDStrict(clubId)');
      expect(src, name).toContain('p_club_id: resolved');
      expect(src, name).toContain('setNotFound(true)');
    }
  });

  it('the insurance page trusts the server take rate', () => {
    expect(INSURANCE).toContain('const acceptRate = t?.take_rate_pct ?? null;');
    expect(INSURANCE).not.toContain('(t.accepted + t.cashouts) / t.offers');
  });
});

describe('the new objects are declared to the schema gate', () => {
  const manifest = JSON.parse(MANIFEST) as { functions: string[]; tables: string[] };

  it.each([
    'ca_club_financials',
    'ca_club_chip_ledger',
    'fn_ca_club_rake_daily_compute',
    'fn_ca_club_rake_daily_apply',
    'fn_ca_club_rake_daily_rebuild_range',
    'fn_ca_club_rake_daily_rebuild',
    'trg_ca_club_rake_daily_insert',
    'trg_ca_club_rake_daily_change',
    'fn_rebuild_ca_club_commission_daily',
  ])('declares %s', (name) => {
    expect(manifest.functions).toContain(name);
  });

  it.each(['ca_club_rake_daily', 'ca_club_commission_daily'])('declares table %s', (name) => {
    expect(manifest.tables).toContain(name);
  });
});

describe('a live day belongs to the triggers, and a complete day to the recount', () => {
  /**
   * Measured on 2026-09-04, an hour after the phase shipped, on the club that
   * deals ~1,200 raked hands a minute:
   *
   *   20:40:45   ledger 194,648.19   rollup 194,627.07   diff 21.1200
   *   20:41:17   ledger 194,717.42   rollup 194,696.30   diff 21.1200
   *
   * The ledger moved by 69 chips in 32 seconds and the difference did not
   * move at all: the trigger tracked every one of them. (It is not perfect -
   * it catches its own errors and warns rather than refusing a rake write, so
   * a statement lost to a deadlock is lost from the rollup; measured residual
   * 0.016% on the live day, recounted exactly when the day closes.)
   * DELETE-then-recount cannot converge on a day that is still being written,
   * because whatever commits inside a pass had its trigger row deleted and is
   * not in that pass's snapshot. Retrying loses a fresh slice every time,
   * which the first correction assumed would close and it did not.
   */
  it('the rebuild takes complete days by default and today only when asked', () => {
    expect(CORRECTION_2).toContain('p_include_today boolean DEFAULT false');
    expect(CORRECTION_2).toContain(
      'v_last date := CASE WHEN coalesce(p_include_today, false) THEN v_today ELSE v_today - 1 END;'
    );
  });

  it('the reconcile reports what today is short by, and never rewrites it', () => {
    expect(CORRECTION_2).toContain('IF d < v_today THEN');
    expect(CORRECTION_2).toContain("'today_drift', v_today_drift");
  });

  it('a rake correction still reaches the rollup on the day it was made', () => {
    expect(CORRECTION_3).toContain('fn_ca_club_rake_daily_rebuild_range(v_lo, v_hi, true)');
  });

  it('there is exactly one rebuild signature, so a two-argument call is not ambiguous', () => {
    // The two-argument form kept "so nothing breaks" made every existing call
    // ambiguous, and the one caller was the trigger that repairs a corrected
    // rake row - which catches its own errors, so it would have failed quietly.
    expect(CORRECTION_3).toContain(
      'DROP FUNCTION IF EXISTS public.fn_ca_club_rake_daily_rebuild_range(date, date);'
    );
    expect(CORRECTION_3).toContain('the rebuild still has % signatures');
  });

  it('the reconcile and the rebuild share one definition of agreement', () => {
    expect(CORRECTION_1).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_ledger_total'
    );
    expect(CORRECTION_2).toContain('fn_ca_club_rake_daily_ledger_total(d)');
    expect(CORRECTION_1).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_ledger_total(date) FROM PUBLIC, anon, authenticated;'
    );
  });

  it('every correction asserts the shape it replaced is gone', () => {
    for (const [name, sql] of [
      ['1', CORRECTION_1],
      ['2', CORRECTION_2],
      ['3', CORRECTION_3],
    ] as const) {
      expect(sql, name).toMatch(/RAISE EXCEPTION/);
    }
  });
});

describe('the gate on phase 6: hands still meant two things in two places', () => {
  /**
   * Measured over seven days on Deep Stack Society while checking the phase:
   *
   *   Busiest Tables, as shipped   2,113,324  "Hands"
   *   hands actually dealt            596,730
   *   hands actually raked            181,766
   *
   * The list summed club_member_daily_stats.hands_played - one row per player
   * per hand - on the same page whose cards this phase had just relabelled so
   * raked hands and hands dealt could not be confused. It survived because I
   * changed the totals and never looked further down the page.
   */
  it("by_table counts the table's raked hands, not one per player sitting in it", () => {
    expect(CORRECTION_4).toContain('FROM club_table_daily c');
    expect(CORRECTION_4).toContain(
      'Busiest Tables still counts a hand once per player sitting in it'
    );
    expect(CORRECTION_4).toContain("'players', q.players");
  });

  it('the dashboard says which hands the list is counting', () => {
    expect(DASHBOARD).toContain('Raked Hands\n                        </span>');
  });

  it('the activity chart is told which hands it is drawing, by every caller', () => {
    // One component, two tabs, two different series: the Overview tab passes
    // hands DEALT and the Revenue tab passes RAKED hands (182,035 against
    // 596,817 for the same week), and both drew a legend that said "Hands".
    expect(ACTIVITY_CHART).toContain('handsLabel: string;');
    expect(ACTIVITY_CHART).toContain('name={handsLabel}');
    expect(ACTIVITY_CHART).not.toContain('name="Hands"');
    expect(DASHBOARD).toContain('handsLabel="Hands Dealt"');
    expect(DASHBOARD).toContain('handsLabel="Raked Hands"');
  });

  it('the financials chart says so when it plots a shorter window than the totals', () => {
    // ca_club_financials caps the daily series at 92 days; the totals are not
    // capped, so on a club with a longer history the picture and the cards
    // describe different windows.
    expect(FINANCIALS).toContain('data.range.series_from > data.range.start');
    expect(FINANCIALS).toContain('Last ${chartDays} Days Of This Window');
  });

  it('the club-scoped ledger refuses an unresolved club instead of sending a slug to a uuid', () => {
    expect(LEDGER).toContain('!isUUID(clubId)');
    expect(LEDGER).toContain('TransactionLedgerView.unresolved_club');
  });

  it('the ledger-total helper is declared to the schema gate', () => {
    const manifest = JSON.parse(MANIFEST) as { functions: string[] };
    expect(manifest.functions).toContain('fn_ca_club_rake_daily_ledger_total');
  });
});
