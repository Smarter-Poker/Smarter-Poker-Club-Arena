/**
 * LAW: CLUB DATA COUNTS WHAT THE CLUB PLAYED, AND SHOWS IT TO THE RIGHT PEOPLE
 * ===========================================================================
 * Dan 2026-10-17, on Club JAQK: "THERE IS NO SHOT THIS IS CORRECT DATA FOR
 * THE ENTIRE CLUB WITH ONLY 5 GAMES ... CLUB OWNERS SEE EVERYTHING, AGENTS SEE
 * THERE GENERATED STATS + DOWNLINES, REGULAR PLAYER ACCOUNTS DONT SEE THE DATA
 * BUTTON OR PAGES. MAKE SURE THAT THIS IS ACCURATE REAL TIME DATA AT ALL TIMES.
 * AND THE CLUB NAME SHOULD BE AT THE TOP NEXT TO "CLUB DATA"."
 *
 * The cause (read from production): every union fact was filed under the
 * player's EARLIEST joined union club, a guess, instead of the club the money
 * moved through, which the platform records with the money every time
 * (chip_ledger.club_id, table_seats.club_id, tournament_players.club_id).
 * Migration 20261017160125 writes ca_club_data_fact from those records, in
 * the transaction that moves the money, one row per club, day, game and
 * player, and the screen reads it scoped by who is asking.
 *
 * Behaviour is qualified on real Postgres by
 * scripts/ci/test-club-data-fact-db-postgres.py; this file pins the source so
 * a later migration cannot quietly put the guess back first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { functionBody, latestDeclaring } from './helpers/migrations';

function latest(fnName: string): string {
  return functionBody(latestDeclaring(fnName).sql, fnName)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}
const squash = (s: string) => s.replace(/\s+/g, ' ');
const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('the club is read from the money, the guess is only a last resort', () => {
  it('a cash wallet row takes the club of its own ledger leg, then its seat', () => {
    const b = squash(latest('trg_ca_club_data_fact_wallet'));
    const first = b.indexOf(
      'public.fn_ca_ledger_leg_club(NEW.user_id, NEW.amount, NEW.type, NEW.created_at, NEW.table_id)'
    );
    const seat = b.indexOf('public.fn_ca_cash_seat_club(NEW.table_id, NEW.user_id)');
    const guess = b.indexOf('public.fn_ca_cash_reporting_club(v_union, v_owner_club, NEW.user_id)');
    expect(first).toBeGreaterThan(-1);
    expect(seat).toBeGreaterThan(first);
    expect(guess).toBeGreaterThan(seat);
  });

  it('a tournament row takes the club of the entry', () => {
    const b = squash(latest('trg_ca_club_data_fact_wallet'));
    expect(b).toContain('SELECT tp.club_id INTO v_club FROM public.tournament_players tp');
    const r = squash(latest('trg_ca_club_data_fact_rake'));
    expect(r).toContain('SELECT tp.club_id INTO v_club FROM public.tournament_players tp');
  });

  it('a cash hand credits each contributor to the club their seat was bought in through', () => {
    const r = squash(latest('trg_ca_club_data_fact_rake'));
    expect(r).toMatch(
      /COALESCE\(public\.fn_ca_cash_seat_club\(NEW\.table_id, s\.uid\), public\.fn_ca_cash_reporting_club\(/
    );
  });

  it('the ledger leg is the one written beside the wallet row', () => {
    const b = squash(latest('fn_ca_ledger_leg_club'));
    expect(b).toContain('cl.created_at = p_at');
    expect(b).toContain("cl.from_type = 'player_wallet'");
    expect(b).toContain("cl.to_type = 'player_wallet'");
  });

  it('the live writers are their own triggers, and a failure never touches the money', () => {
    const sql = read(
      'supabase/migrations/20261017160125_club_data_counts_what_the_club_played.sql'
    );
    expect(sql).toContain(
      'CREATE OR REPLACE TRIGGER ca_club_data_fact_rake AFTER INSERT ON public.rake_records'
    );
    expect(sql).toContain(
      'CREATE OR REPLACE TRIGGER ca_club_data_fact_wallet AFTER INSERT ON public.wallet_transactions'
    );
    // Dropping a trigger takes ACCESS EXCLUSIVE on a money table even when there
    // is nothing to drop; it deadlocked the first install (2026-10-17 18:07 UTC).
    expect(sql).not.toMatch(/DROP TRIGGER/i);
    for (const fn of ['trg_ca_club_data_fact_rake', 'trg_ca_club_data_fact_wallet']) {
      expect(latest(fn)).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/);
    }
  });
});

describe('a hand belongs to the club of the seat AT THAT TABLE', () => {
  // 20261017105645 used the player's most recent seat at ANY table, with the
  // union not consulted: 150 multi-tabling players, 63 across clubs.
  it('the three-argument last resort never leaves its union and reads no seat', () => {
    const b = squash(latest('fn_ca_cash_reporting_club'));
    expect(b).toContain(
      'JOIN public.union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union'
    );
    expect(b).not.toContain('table_seats');
  });

  it('the table-aware form reads the seat at that table first', () => {
    expect(squash(latest('fn_ca_cash_table_reporting_club'))).toContain(
      'CASE WHEN p_table IS NOT NULL AND p_user IS NOT NULL THEN public.fn_ca_cash_seat_club(p_table, p_user) END, public.fn_ca_cash_reporting_club(p_union, p_table_club, p_user));'
    );
  });

  it('the advanced report and the felt pass the table or read the seat', () => {
    expect(squash(latest('fn_ca_club_table_daily_add_rake'))).toContain(
      'public.fn_ca_cash_table_reporting_club(v_union, v_table_club, rr.uid::uuid, p_table)'
    );
    expect(squash(latest('fn_ca_club_cash_felt'))).toContain(
      'COALESCE(s.club_id, public.fn_ca_cash_reporting_club(t.union_id, t.club_id, s.user_id)) = ANY (public.fn_ca_club_data_clubs(p_club_id))'
    );
  });
});

describe('who sees what', () => {
  it('the owner, co-owner and admins see the club; agents see their downline; nobody else', () => {
    const b = squash(latest('fn_ca_club_data_scope'));
    expect(b).toMatch(/cm\.role IN \('owner',\s*'co_owner',\s*'admin'\)/);
    expect(b).toMatch(/cm\.role IN \('super_agent',\s*'agent',\s*'sub_agent'\)/);
    expect(b).toContain("THEN 'downline'");
    expect(b).toContain('ELSE NULL END');
    expect(b).not.toContain("'player'");
    expect(b).toContain('public.ca_can_oversee_union(p_club_id)');
    expect(b.indexOf('public.ca_can_oversee_union(p_club_id)')).toBeLessThan(
      b.indexOf("cm.role IN ('owner'")
    );
  });

  it('the screen refuses anyone the scope does not name, and filters an agent to his downline', () => {
    const b = squash(latest('ca_club_data_screen'));
    expect(b).toContain('v_scope text := public.fn_ca_club_data_scope(p_club_id)');
    expect(b).toContain(
      "IF v_scope IS NULL THEN RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501'"
    );
    expect(b).toContain('v_users := public.fn_ca_club_data_downline(p_club_id, auth.uid())');
    expect(b).toContain('(v_users IS NULL OR d.user_id = ANY (v_users))');
    expect(b).toContain("'club_name', v_club_name");
  });
});

describe('the page and the footer say the same thing', () => {
  const page = read('src/pages/club/ClubDataSimplePage.tsx');
  const footer = read('src/components/club/ClubBottomNav.tsx');

  it('names the club in the header: "CLUB JAQK - CLUB DATA"', () => {
    expect(page).toContain("return name ? `${name.toUpperCase()} - CLUB DATA` : 'Club Data';");
    expect(page).toContain(
      '<span className={styles.titleClub}>{clubName.trim().toUpperCase()}</span>'
    );
  });

  it("an agent's page has no whole-club report door", () => {
    expect(page).toContain(
      'onAdvanced={isDownline ? undefined : () => navigate(`/clubs/${clubKey}/data/advanced`)}'
    );
  });

  it('a player gets the five-door footer, with no Data door, and it never flashes on', () => {
    // The server answers (fn_ca_club_data_scope); a client-side role guess
    // showed the door while roles were still loading.
    expect(footer).toContain(
      "const canSeeData = isDevFooter || dataScope === 'club' || dataScope === 'downline';"
    );
    expect(footer).not.toMatch(/!effectiveRole|isPlayer/);
    expect(footer).toContain(
      'const footerArt = canSeeData ? APPROVED_FOOTER_ART : APPROVED_PLAYER_FOOTER_ART;'
    );
    const art = statSync(
      resolve(__dirname, '../public/images/club-footer/club-arena-footer-player-v1.webp')
    );
    expect(art.size).toBeGreaterThan(10_000);
  });
});

/**
 * THE REPORT READS WHAT THE CLUB PLAYED (Dan 2026-10-17, "FINISH THESE UP NOW").
 * 20261017204111: the advanced Report's daily tables are written with the
 * club the money moved through and rebuilt from the Club Data facts; the
 * whole-club Report is the owner's, co-owner's and admins'; the fourteen-day
 * screen describes only the rows it shows.
 */
describe('the Report tables are written by the club the money moved through', () => {
  const report = read(
    'supabase/migrations/20261017204111_the_club_data_report_reads_what_the_club_played.sql'
  );

  it('a tournament row belongs to ONE club, never every club the player is in', () => {
    for (const fn of ['trg_ca_reporting_wallet_insert', 'trg_ca_reporting_rake_insert']) {
      const b = latest(fn);
      expect(b).not.toContain('ca_reporting_tournament_clubs_for_user');
      expect(b).toContain('fn_ca_tournament_reporting_club(');
    }
    const club = squash(latest('fn_ca_tournament_reporting_club'));
    const entry = club.indexOf('SELECT tp.club_id FROM public.tournament_players tp');
    const leg = club.indexOf('public.fn_ca_ledger_leg_club(');
    const guess = club.indexOf('public.fn_ca_cash_reporting_club(');
    expect(entry).toBeGreaterThan(-1);
    expect(leg).toBeGreaterThan(entry);
    expect(guess).toBeGreaterThan(leg);
  });

  it('a cash wallet row takes its own ledger leg, then the seat at that table', () => {
    const b = squash(latest('trg_ca_reporting_wallet_insert'));
    expect(b).toContain(
      'v_club:=COALESCE( public.fn_ca_ledger_leg_club(NEW.user_id,NEW.amount,NEW.type,NEW.created_at,NEW.table_id), public.fn_ca_cash_table_reporting_club(v_union,v_table_club,NEW.user_id,NEW.table_id));'
    );
    expect(b).not.toMatch(/joined_at ASC/);
  });

  it('the club rake totals read the after-the-hand witness before any guess', () => {
    const b = squash(latest('fn_ca_club_rake_daily_compute'));
    const ra = b.indexOf('SELECT ra.club_id FROM rake_attributions ra');
    const receipt = b.indexOf(
      'SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x'
    );
    const seat = b.indexOf('SELECT ts.club_id FROM public.table_seats ts');
    const guess = b.indexOf('ORDER BY cm.joined_at ASC');
    expect(ra).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(ra);
    expect(seat).toBeGreaterThan(receipt);
    expect(guess).toBeGreaterThan(seat);
    expect(b).toContain('x.seat_joined_at <= b.created_at');
    expect(b).toContain('ts.joined_at <= b.created_at');
    expect(b).not.toContain('fn_ca_cash_seat_club(');
  });

  it('every rebuild of a covered day is a rebuild from the facts', () => {
    expect(latest('fn_club_table_daily_refresh_day')).toContain(
      'fn_ca_reporting_rollups_from_facts(p_day)'
    );
    for (const fn of ['ca_refresh_reporting_rollups_base', 'ca_refresh_reporting_cash_rollup']) {
      const b = latest(fn);
      expect(b).toContain('PERFORM public.fn_ca_reporting_rollups_from_facts(v_d);');
      expect(b.indexOf('fn_ca_reporting_rollups_from_facts')).toBeLessThan(
        b.indexOf('pg_advisory_xact_lock(918273645)')
      );
    }
    const f = latest('fn_ca_reporting_rollups_from_facts');
    for (const t of [
      'club_table_daily',
      'ca_club_table_player_daily',
      'ca_club_player_daily',
      'ca_club_tournament_daily',
      'ca_club_tournament_player_daily',
    ]) {
      expect(f).toContain(`DELETE FROM public.${t} WHERE stat_date = p_day`);
    }
    expect(f).toContain('FROM public.ca_club_data_fact f');
  });

  it('the whole-club Report is the owner, co-owner and admins, never a super agent', () => {
    expect(squash(latest('ca_can_view_whole_club_report'))).toContain(
      "public.fn_ca_club_data_scope(p_club_id) = 'club'"
    );
    for (const fn of [
      'ca_club_data_snapshot',
      'ca_club_game_page_core_20261006',
      'ca_club_game_export_start',
      'ca_club_player_breakdown',
      'ca_club_player_page_core_20261006',
      'ca_club_player_export_start',
      'ca_club_union_invoices',
      'ca_club_data_export_page',
      'ca_rake_snapshot',
    ]) {
      expect(report).toContain(`'public.${fn}(`);
    }
    expect(report).toContain(
      "SELECT pg_temp.ca_rewrite(f::regprocedure, 'ca_can_view_club_finances\\(', 'ca_can_view_whole_club_report(', 1)"
    );
    expect(report).toContain(
      "SELECT pg_temp.ca_rewrite(f::regprocedure, 'ca_can_read_club_production\\(', 'ca_can_read_whole_club_production(', 1)"
    );
  });

  it("the Report's player lists are the club's members", () => {
    expect(report).toContain(
      "'SELECT DISTINCT cm.user_id FROM public.club_members cm WHERE cm.club_id=p_club_id', 1)"
    );
  });

  it('the fourteen-day screen describes only the rows it shows', () => {
    const b = squash(latest('ca_club_data_screen'));
    // 20261017221938: the plain screen takes its totals in one aggregate,
    // chooses its rows newest day first, and counts players only for them.
    expect(b).toContain("IF v_game = 'ALL' AND v_stakes = 'ALL' AND v_q IS NULL THEN");
    expect(b).toContain('FOR v_day IN SELECT u.d FROM unnest(v_days) u(d) ORDER BY u.d DESC LOOP');
    expect(b).toContain('AND f.game_id = ANY (v_cands)');
    // the filtered form counts players for the page's rows by exact day lookups
    expect(b).toContain('AND f.game_id IN (SELECT tp.game_id FROM top tp)');
    expect(b).toContain(
      // 20261022200354 / 20261022165130: the same days, probed as a range.
      'WHERE f.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND f.stat_date BETWEEN v_start AND v_end AND f.user_id <>'
    );
    // tournaments are described for every game only when a filter reads them
    expect(b).toContain("v_attrs := v_game IN ('MTT', 'SNG') OR v_q IS NOT NULL;");
    expect(b).toMatch(
      /FROM tour tu JOIN public\.tournaments tr ON tr\.id = tu\.game_id WHERE v_attrs/
    );
  });
});
