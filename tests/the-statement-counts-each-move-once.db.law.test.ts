/**
 * ===========================================================================
 *  LAW - THE STATEMENT COUNTS EACH MOVE ONCE AND NAMES ITS WALLET
 * ===========================================================================
 *
 * Cashier launch audit, 2026-10-09. Production's statement row query
 * (fn_cashier_statement_rows, md5 72d29ab4...) printed a move twice when its
 * door wrote a receipt and journalled the same move as a chip_ledger leg (2,054
 * BBJ promo sweeps in the last 14 days alone, add-on refunds, and every promo,
 * pot and reversal door the launch opens), counted a 30 cash out as out 60 for
 * the player, charged the operator for every Club Bank send, printed every
 * horse's treasury-funded seat as a kind no human row has, printed display
 * names before the arena name (display_name copied full_name on 264 of 1,308
 * profiles when tests/theArenaIsAlwaysTheAlias.law.test.ts measured it) and
 * printed storage paths as names.
 *
 * Migration 20261012030847 (first written as 20261009223439 over md5
 * 72d29ab4..., rebased onto #6615's body, md5 8a47b11b..., and again on
 * 2026-10-12 onto #6688's live body, md5 b1f42803...)
 * rebuilds the body from production's live text by counted substitutions,
 * pinned by md5 before and after, and
 * scripts/ci/test-cashier-statement-db-postgres.py qualifies it on PostgreSQL
 * 17 (tests/fixtures/cashier-statements/db-one-move-once.sql fails 21 of 31
 * on the live body and passes 31 after). #6615's default all-scope fast path,
 * read as #6688's concurrent slices, is kept; each slice counts only the
 * receipts the viewer is not a side of, the viewer's own receipts are added
 * once so a cash out or a pot is counted by its kind there too, and its
 * omitted set carries the mirrored legs. This law pins the shapes that fail silently:
 * the answer stays plausible, the double count or the leak comes back, and
 * nothing goes red.
 *
 * Registry: docs/laws.d/the-statement-counts-each-move-once.md
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const FILE = '20261012030847_the_statement_counts_each_move_once_and_names_its_wallet.sql';
/** #6688, the file that installed the live body this one replaces. */
const LIVE_SOURCE = '20261011225840_cashier_totals_read_the_range_as_concurrent_slices.sql';
const INDEX = 'idx_chip_ledger_statement_mirror_legs';
const PRE = 'b1f42803af9196e322159660ff6f9e57';
const SIG =
  'public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)';
const PAIRABLE =
  "'promo', 'promo_send', 'treasury_transfer', 'transfer', 'player_funding', 'reversal', 'refund', 'correction', 'adjustment'";
const squash = (s: string): string => s.replace(/\s+/g, ' ');

const MIG = migrationText(FILE);
const PREAMBLE = MIG.slice(0, MIG.search(/^BEGIN;$/m));
const ROWS = sliceBetween(
  MIG,
  'CREATE OR REPLACE FUNCTION public.fn_cashier_statement_rows(',
  '$function$;'
);
const POST =
  /-- @live-proof: \(SELECT md5\(pg_get_functiondef\('[^']+'::regprocedure\)\) = '([0-9a-f]{32})'\)/.exec(
    MIG
  )?.[1];

/** The newest migration that defines the row query is the one production runs. */
const NEWEST = migrationNames()
  .filter((n) =>
    migrationText(n).includes('CREATE OR REPLACE FUNCTION public.fn_cashier_statement_rows(')
  )
  .at(-1)!;
const NEWEST_ROWS = sliceBetween(
  migrationText(NEWEST),
  'CREATE OR REPLACE FUNCTION public.fn_cashier_statement_rows(',
  '$function$;'
);

describe('the statement counts each move once and names its wallet', () => {
  it('is the newest definition of the row query, and sorts after the body it replaces', () => {
    expect(NEWEST).toBe(FILE);
    expect(FILE > LIVE_SOURCE).toBe(true);
    for (const superseded of ['20261009223439', '20261011194856']) {
      expect(migrationNames()).not.toContain(
        `${superseded}_the_statement_counts_each_move_once_and_names_its_wallet.sql`
      );
    }
  });

  it("keeps #6688's sliced default fast path, with the viewer's receipts directed by their kind", () => {
    for (const body of [ROWS, NEWEST_ROWS]) {
      const fast = squash(
        sliceBetween(
          body,
          "IF v_totals_only AND p_scope='all' AND v_wallet IS NULL",
          'RETURN QUERY EXECUTE v_sql'
        )
      );
      // #6688's slices stay: both sources, slice by slice, with parallel workers.
      expect(fast.match(/'\$20\[' \|\| v_slice \|\| '\]'/g)).toHaveLength(2);
      expect(fast).toContain(
        "FROM ($narrow$ || array_to_string(v_ranged, ' UNION ALL ') || $narrow$) ranged GROUP BY direction"
      );
      expect(fast).toContain("PERFORM set_config('max_parallel_workers_per_gather', '6', true);");
      // Each slice counts only the receipts the viewer is not a side of.
      expect(fast).toContain(
        "$slice$SELECT 'managed'::text direction,amount FROM public.chip_transactions WHERE club_id=$1 AND created_at >= @LO@ AND created_at < @HI@ AND from_user_id IS DISTINCT FROM $2 AND to_user_id IS DISTINCT FROM $2$slice$"
      );
      // The viewer's own receipts are added once, directed by their kind.
      expect(fast.match(/\$own\$, '@DIRECTION@', v_receipt_direction\)/g)).toHaveLength(2);
      expect(fast).toContain(
        'SELECT @DIRECTION@ direction,ct.amount FROM public.chip_transactions ct WHERE ct.club_id=$1 AND ct.from_user_id=$2 AND ct.created_at >= $3 AND ct.created_at < $4'
      );
      expect(fast).toContain(
        'SELECT @DIRECTION@ direction,ct.amount FROM public.chip_transactions ct WHERE ct.club_id=$1 AND ct.to_user_id=$2 AND ct.from_user_id IS DISTINCT FROM $2 AND ct.created_at >= $3 AND ct.created_at < $4'
      );
      // The plain from/to rule would charge a cash out twice and the operator for a pot.
      expect(fast).not.toContain(
        "SELECT CASE WHEN to_user_id=$2 AND from_user_id IS DISTINCT FROM $2 THEN 'in'"
      );
      // The legs it subtracts are the omitted set, mirrored legs included.
      expect(fast).toContain('AND id=ANY($19)) removed GROUP BY direction)');
    }
  });

  it('runs its PostgreSQL 17 harness in CI, and an edit to the harness alone still runs it', () => {
    const ci = readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain(
      '      - name: The Cashier Statement counts each move once and names its wallet\n        if: matrix.shard == 2\n        env:\n          PG_BIN: /usr/lib/postgresql/17/bin\n        run: python3 scripts/ci/test-cashier-statement-db-postgres.py\n'
    );
    const classify = classifyChangedPaths(['scripts/ci/test-cashier-statement-db-postgres.py']);
    expect(classify.server).toBe(true);
    expect(classify.tests).toBe(true);
  });

  it("replaces production's live text only, and pins the installed text", () => {
    expect(MIG).toContain(`IS DISTINCT FROM '${PRE}' THEN`);
    expect(POST, 'the migration declares the installed md5 as a live proof').toMatch(
      /^[0-9a-f]{32}$/
    );
    expect(MIG).toContain(
      `IF md5(pg_get_functiondef('${SIG}'::regprocedure)) IS DISTINCT FROM '${POST}' THEN`
    );
    expect(MIG).toContain(
      `REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, authenticated, service_role;`
    );
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('builds the mirror-leg index CONCURRENTLY, alone, before the transaction, and never drops it', () => {
    expect(squash(PREAMBLE)).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON public.chip_ledger (club_id, created_at) INCLUDE (id, amount, from_entity_id, to_entity_id, correlation_id) WHERE status = 'posted' AND category = ANY (ARRAY[${PAIRABLE}]::text[]);`
    );
    const droppers = migrationNames().filter(
      (n) => n > FILE && new RegExp(`DROP INDEX[^;]*${INDEX}`).test(migrationText(n))
    );
    expect(
      droppers,
      `${droppers.join(', ')} drops ${INDEX}; the all-scope totals read the heap again`
    ).toEqual([]);
  });

  it('reads a leg against a receipt only for the categories a receipt writer journals', () => {
    for (const body of [ROWS, NEWEST_ROWS]) {
      const probe = sliceBetween(body, 'v_mirror_probe := $mirror$', '$mirror$;');
      expect(squash(probe)).toContain(`cl.category = ANY (ARRAY[${PAIRABLE}]::text[])`);
      expect(squash(probe)).toContain(
        'mirror.club_id = cl.club_id AND mirror.created_at = cl.created_at AND abs(mirror.amount) = abs(cl.amount)'
      );
      expect(squash(probe)).toContain("(mirror.metadata ->> 'op_id') = cl.correlation_id::text");
      // An operator who pressed the button for a pot is not a side of the move.
      expect(squash(probe)).toContain(
        "SELECT CASE WHEN mirror.transaction_type IN ('club_bank_send', 'horse_treasury_funding', 'club_promo_send', 'promo_disbursement', 'union_member_send', 'union_promo_send', 'union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn') THEN NULL ELSE mirror.from_user_id END AS f"
      );
      expect(squash(probe)).toContain(
        'AND (side.f IS NULL OR cl.from_entity_id IS NULL OR side.f = cl.from_entity_id) AND (side.t IS NULL OR cl.to_entity_id IS NULL OR side.t = cl.to_entity_id)'
      );
      // A prize, spin, buy-in or bounty leg is never read against a receipt.
      for (const category of [
        'tournament_prize',
        'spin_prize',
        'spin_entry',
        'buyin',
        'bounty',
        'addon',
        'rebuy',
      ]) {
        expect(probe).not.toContain(`'${category}'`);
      }
    }
  });

  it("keeps the all-scope totals index-only: mirrored legs in $19, receipts split by the viewer's side", () => {
    for (const body of [ROWS, NEWEST_ROWS]) {
      expect(squash(body)).toContain(
        "v_movement_base := replace(v_movement_base, '@MIRROR@', CASE WHEN v_totals_only AND p_scope = 'all' THEN '' ELSE v_mirror_probe END);"
      );
      const arms = sliceBetween(
        body,
        'EXECUTE $omissions$SELECT coalesce(',
        ') omitted$omissions$'
      );
      expect(squash(arms)).toContain(
        `SELECT l.id FROM public.chip_ledger l WHERE l.club_id=$1 AND l.created_at >= $3 AND l.created_at < $4 AND l.status='posted' AND l.category = ANY (ARRAY[${PAIRABLE}]::text[])`
      );
      expect(squash(body)).toContain("IF p_scope = 'all' AND v_totals_only THEN");
      expect(squash(body)).toContain(
        "'ct.from_user_id IS DISTINCT FROM $2 AND ct.to_user_id IS DISTINCT FROM $2', 'ct.from_user_id = $2', 'ct.to_user_id = $2 AND ct.from_user_id IS DISTINCT FROM $2']; v_receipt_directions := ARRAY['''managed''::text', NULL, NULL];"
      );
    }
  });

  it('counts a cash out where its chips move and never charges the operator for a pot', () => {
    for (const body of [ROWS, NEWEST_ROWS]) {
      const direction = squash(
        sliceBetween(body, 'v_receipt_direction := $direction$', '$direction$;')
      );
      expect(direction).toContain(
        "WHEN ct.transaction_type = 'cashout_request_escrow' THEN CASE WHEN ct.from_user_id = $2 THEN 'out' ELSE 'managed' END"
      );
      expect(direction).toContain(
        "WHEN ct.transaction_type IN ('cashout_approved', 'cashout_denied', 'cashout_cancelled', 'cashout_expired_refund') THEN CASE WHEN ct.to_user_id = $2 THEN 'in' ELSE 'managed' END"
      );
      expect(direction).toContain(
        "WHEN ct.transaction_type IN ('club_bank_send', 'horse_treasury_funding', 'club_promo_send', 'promo_disbursement', 'union_member_send', 'union_promo_send') THEN CASE WHEN ct.to_user_id = $2 THEN 'in' ELSE 'managed' END"
      );
      expect(direction).toContain(
        "WHEN ct.transaction_type IN ('club_bank_claim', 'admin_removal', 'club_bank_reversal') THEN CASE WHEN ct.from_user_id = $2 THEN 'out' ELSE 'managed' END"
      );
      expect(direction).toContain(
        "WHEN ct.transaction_type IN ('union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn') THEN 'managed'"
      );
    }
  });

  it('names no horse, no real name and no storage path', () => {
    for (const body of [ROWS, NEWEST_ROWS]) {
      expect(body).toContain(
        "SELECT CASE WHEN ct.transaction_type ~* 'horse' THEN 'club_bank_send' ELSE ct.transaction_type END AS kind"
      );
      expect(body).not.toMatch(/THEN 'treasury_funding' ELSE/);
      expect(body).not.toMatch(/coalesce\(p[ft]\.alias, p[ft]\.display_name/);
      expect(body).not.toMatch(/pf\.alias, pf\.display_name, pf\.username/);
      expect(
        body.match(
          /public\.fn_arena_name\(p[ft]\.alias, p[ft]\.username, p[ft]\.display_name, p[ft]\.first_name, p[ft]\.last_name, p[ft]\.full_name\)/g
        )?.length
      ).toBeGreaterThanOrEqual(6);
      expect(body).toContain("cl.from_label !~ '^[a-z0-9_]+([.+][a-z0-9_]+)*$'");
      expect(body).toContain("cl.to_label !~ '^[a-z0-9_]+([.+][a-z0-9_]+)*$'");
    }
  });
});
