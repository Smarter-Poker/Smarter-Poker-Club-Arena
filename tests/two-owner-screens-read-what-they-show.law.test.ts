/**
 * ===========================================================================
 *  LAW - TWO OWNER SCREENS READ WHAT THEY SHOW
 * ===========================================================================
 *
 * Dan's 2026-09-30 list: the Cashier Statements totals and the Club Data game
 * list time out for the busiest club. Measured on production 2026-10-07 as the
 * clubs' owner, against the authenticated role's 8 s statement_timeout
 * (docs/changelog/2026-10-07-two-owner-screens-read-what-they-show.md):
 *
 *   Club Data game page   Shark Club, 158,820 games in 14 days: 1.6-2.8 s warm,
 *                         18.4 s once cold, 27 statement timeouts in a day. To
 *                         show 200 rows it read the whole 1.1 GB tournaments
 *                         heap, counted players for every tournament the club
 *                         ever had (the player key cannot be bounded by date),
 *                         and re-sorted 157,476 facts to join them to 200 rows.
 *   Cashier totals        Deep Stack Society, 311,089 entries in 7 days: cold
 *                         4.2-7.6 s, Shark Club 8.5 s once - two covering-index
 *                         ranges read one page at a time, because the mirrored
 *                         movement set was a materialized CTE in the same
 *                         statement and a CTE scan is parallel-restricted.
 *
 * Migration 20261007041535 rebuilds both bodies from production's live text by
 * counted substitutions, pinned by md5 before and after. This law pins the
 * shapes that make them cheap, because every one of them fails SILENTLY: the
 * answer stays right, the plan reverts, and the timeout comes back.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_two_owner_screens_read_what_they_show.sql'))
  .at(-1);
if (!NAME) throw new Error('the two-owner-screens migration is missing');
const MIG = migrationText(NAME);
const PREAMBLE = MIG.slice(0, MIG.search(/^BEGIN;$/m));
const CORE = sliceBetween(
  MIG,
  'CREATE OR REPLACE FUNCTION public.ca_club_game_page_core_20261006(',
  '$function$;'
);
const ROWS = sliceBetween(
  MIG,
  'CREATE OR REPLACE FUNCTION public.fn_cashier_statement_rows(',
  '$function$;'
);
const INDEX = 'idx_tournaments_game_page_keys';
const squash = (s: string): string => s.replace(/\s+/g, ' ');

describe('the Club Data game page reads what it shows', () => {
  it('ranks from a covering key index built CONCURRENTLY, alone, before the transaction', () => {
    // tournaments is written by the engine all day: a plain CREATE INDEX holds
    // SHARE for the whole build (CLAUDE.md section 2 rule 7).
    expect(squash(PREAMBLE)).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON public.tournaments (id) INCLUDE (tournament_type, start_time);`
    );
    const later = migrationNames().filter(
      (n) => n > NAME && new RegExp(`DROP INDEX[^;]*${INDEX}`).test(migrationText(n))
    );
    expect(
      later,
      `${later.join(', ')} drops ${INDEX}; the page reads the 1.1 GB heap again`
    ).toEqual([]);
  });

  it('reads a tournament name only when the owner searches by name', () => {
    // Any other reference to tr.name in the ranking set puts the heap back.
    const keys = sliceBetween(CORE, 'keys AS MATERIALIZED (', 'filtered AS MATERIALIZED (');
    expect(keys).toContain(
      "CASE WHEN $6 IS NULL THEN NULL::text ELSE COALESCE(tr.name,'Tournament') END"
    );
    expect(keys.match(/tr\.name/g)).toHaveLength(1);
    // The name the owner sees still comes from the same tournament row.
    expect(CORE).toContain(
      "CASE WHEN v.kind='CASH' THEN v.name ELSE COALESCE(tr.name,'Tournament') END name"
    );
  });

  it('reads fee, winnings and players by key for the visible rows only', () => {
    expect(CORE).not.toContain('tournament_players');
    const detail = sliceBetween(CORE, 'detail AS (', '    SELECT jsonb_build_object(');
    expect(detail).toMatch(/FROM visible v/);
    expect(squash(detail)).toContain(
      "FROM public.ca_club_tournament_daily d WHERE v.kind<>'CASH' AND d.club_id=$1 AND d.tournament_id=v.id::uuid AND d.stat_date BETWEEN $2 AND $3"
    );
    expect(squash(detail)).toContain(
      "FROM public.ca_club_tournament_player_daily p WHERE v.kind<>'CASH' AND p.club_id=$1 AND p.tournament_id=v.id::uuid AND p.stat_date BETWEEN $2 AND $3"
    );
    // The page never joins the whole-window fact set back to its 200 rows.
    expect(detail).not.toMatch(/JOIN tournament_facts/);
  });
});

describe('the cashier totals may run in parallel', () => {
  it('reads the mirrored movement set first, into an array the movement branch excludes', () => {
    expect(ROWS).not.toContain('WITH omitted_movements AS MATERIALIZED');
    expect(ROWS).toContain("v_omitted uuid[] := '{}'::uuid[];");
    expect(ROWS).toContain("'     AND cl.id <> ALL ($19)'");
    expect(squash(ROWS)).toContain(
      "EXECUTE $omissions$SELECT coalesce(array_agg(omitted.id), '{}'::uuid[]) FROM ("
    );
    expect(squash(ROWS)).toContain(
      ') omitted$omissions$ INTO v_omitted USING p_club_id, p_viewer, p_from, p_to;'
    );
    // ...and hands it to the one statement that reads it, as $19.
    expect(squash(ROWS)).toMatch(/p_filters ->> 'reference', -- \$18 v_omitted; -- \$19/);
  });

  it('keeps both mirrored-set arms bounded by club and by both ends of the range', () => {
    const arms = sliceBetween(ROWS, 'EXECUTE $omissions$SELECT coalesce(', ') omitted$omissions$');
    const [receipts, restores] = squash(arms).split(' UNION ');
    expect(receipts).toMatch(/represented\.metadata \? 'idempotency_key'/);
    expect(receipts).toMatch(/represented\.club_id=\$1/);
    expect(receipts).toMatch(/represented\.created_at >= \$3-interval '1 day'/);
    expect(receipts).toMatch(/represented\.created_at < \$4\+interval '1 day'/);
    expect(restores).toMatch(/restored\.club_id=\$1/);
    expect(restores).toMatch(/restored\.created_at >= \$3-interval '1 minute'/);
    expect(restores).toMatch(/restored\.created_at < \$4\+interval '1 minute'/);
  });
});

describe('both bodies are exactly the reviewed text', () => {
  it('pins each body by md5 before and after, and keeps both owner-only', () => {
    expect(MIG).toContain("IS DISTINCT FROM '8d5df5bbf4312da7424c0a215daf4390'");
    expect(MIG).toContain("IS DISTINCT FROM '49e310be00e91afc9a9b7582bb048184'");
    expect(MIG).toContain("'871a9d6e8fbef694ac635407ef52a553'");
    expect(MIG).toContain("'72d29ab402ff75ae3f240ce40a750437'");
    expect(MIG).toContain("p.proacl::text = '{postgres=X/postgres}'");
    expect(MIG).toMatch(
      /has_function_privilege\('authenticated', v\.sig::regprocedure, 'EXECUTE'\)/
    );
    expect(MIG).not.toMatch(/^\s*(GRANT|REVOKE)\b/im);
  });
});
