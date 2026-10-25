/**
 * A REBUY SEATED FROM ANOTHER TABLE IS MOVEMENT EVIDENCE (2026-10-24)
 *
 * 12135e5b "Union PKO Afternoon (PLO4)": Table 13 (3e3d1587) dealt nothing
 * from 19:53:39 UTC with 5 players seated while the event's other four tables
 * kept dealing, and an engine restart did not clear it. Every re-admission of
 * its park refused F06_MOVEMENT_WHOLE_ROSTER_REQUIRED. TylerRVA busted on
 * Table 16 and rebought; the purchase records its funding receipt before it
 * chooses a chair, so that receipt names Table 16, and the chair it chose on
 * Table 13 (taken while Table 13's last hand was dealt) is named only by the
 * purchase's own immutable result. f06_movement_prior admitted a rebuy only
 * when its receipt and its bust were on THIS table, so the event could never
 * finish. Owner rule: tournaments must always self-heal and finish.
 *
 * 20261024211825 adds the rebuy_proven predicate that
 * f06_movement_never_dealt_prior already used for exactly this purchase, plus
 * what a dealt table must also show. This law pins the conditions, that only
 * the one passage was added (removing it is the pre-image byte for byte), that
 * the migration replaces exactly the body production held, and that it writes
 * no row.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = '20261024211825_a_rebuy_seated_from_another_table_is_movement_evidence.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const ORIGIN = readFileSync(
  join(MIGRATIONS, '20261016183932_a_mid_hand_add_on_rebase_is_movement_evidence.sql'),
  'utf8'
);
const NEVER_DEALT = readFileSync(
  join(MIGRATIONS, '20261021172832_never_dealt_arrivals_keep_their_committed_move.sql'),
  'utf8'
);

const PRE_MD5 = 'd2ead73888242bf1d29bf7635bb0fa90';
const PRE_DEF_MD5 = 'cd75d4888abb11fbb33daba617e7d589';
const POST_MD5 = 'd21b415b4754a19147cce0160de59479';
const POST_DEF_MD5 = 'ddbca56b65a99f017fb86e791b2fb971';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, tag: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(');
  expect(start, 'the file defines f06_movement_prior').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const close = sql.indexOf(tag, open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const NEW_BODY = body(SQL, '$cross_table_rebuy_prior$');
const OLD_BODY = body(ORIGIN, '$mid_hand_addon_prior$');

/** The one passage the post-image check removes, read from the file. */
function passage(): string {
  const check = SQL.slice(SQL.indexOf('DO $cross_table_rebuy_postimage$'));
  const quoted = [...check.matchAll(/\$r\$([\s\S]*?)\$r\$/g)].map((m) => m[1]);
  expect(quoted.length).toBe(1);
  return quoted[0];
}
const PASSAGE = passage();

describe('a rebuy seated from another table is movement evidence', () => {
  it('replaces exactly the body production held and states the one it installs', () => {
    expect(md5(OLD_BODY)).toBe(PRE_MD5);
    expect(md5(NEW_BODY)).toBe(POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${PRE_DEF_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${POST_DEF_MD5}'`);
    expect(SQL).toContain(
      `-- @live-proof: (SELECT md5(prosrc)='${POST_MD5}' AND md5(pg_get_functiondef(oid))='${POST_DEF_MD5}'`
    );
  });

  it('adds one passage and nothing else: removing it is the pre-image byte for byte', () => {
    expect(NEW_BODY.split(PASSAGE).length).toBe(2);
    expect(md5(NEW_BODY.replace(PASSAGE, ''))).toBe(PRE_MD5);
    expect(SQL).toContain(`IF md5(replace(body, $r$${PASSAGE}$r$, '')) <> '${PRE_MD5}' THEN`);
  });

  it('sits in the no-move-receipt branch, after the same-table rebuy rule and before the entry rule', () => {
    const at = NEW_BODY.indexOf(PASSAGE);
    const sameTable = NEW_BODY.indexOf(' rf:=NULL; bust:=NULL;');
    const entryRule = NEW_BODY.indexOf(
      " WHERE f.tournament_id=p_tournament AND f.user_id=seat.user_id AND f.operation IN ('entry','reentry')"
    );
    expect(sameTable).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(sameTable);
    expect(entryRule).toBeGreaterThan(at);
    expect(PASSAGE.trimEnd().endsWith(' CONTINUE;\n END IF;')).toBe(true);
  });

  it('admits the chair only by the purchase that seated it, exactly as the never-dealt proof does', () => {
    for (const condition of [
      // the latest funding receipt is the paid rebuy or re-entry
      "IF fund.id IS NOT NULL AND fund.operation IN ('rebuy','reentry') AND registration.id IS NOT NULL AND EXISTS(",
      "WHERE pr.key_domain='tournament_chip_purchase' AND pr.idempotency_key=fund.purchase_key",
      // the purchase's own result names exactly this chair, seat and stack
      "AND pr.response->>'table_id'=p_table::text AND pr.response->>'seat_id'=seat.id::text",
      "AND (pr.response->>'seat_number')::integer=seat.seat_number AND (pr.response->>'stack')::numeric=seat.stack",
      "AND (pr.response->>'new_stack')::numeric=seat.stack AND (pr.response->>'chips_added')::numeric=seat.stack",
      "AND pr.response->>'candidate_state'='rebought'",
      // the knockout candidate rebought from 0, in a sealed hand on any table of this event
      "AND c.tournament_id=p_tournament AND c.eliminated_user_id=seat.user_id AND c.state='rebought'",
      'AND c.stack_after=0 AND c.resolved_at IS NOT NULL',
      'AND c.resolved_at>=fund.observed_at AND seat.joined_at>=c.resolved_at AND seat.joined_at<o.created_at',
      "AND bc.post_commit_completed_at IS NOT NULL AND bc.post_commit_result->'ok'='true'::jsonb",
      "AND bc.stack_result->'conservation_checked'='true'::jsonb",
      // the registration plays on exactly this chair with exactly these chips
      "AND registration.status='playing' AND registration.eliminated_at IS NULL",
      'AND (registration.table_id,registration.seat_number) IS NOT DISTINCT FROM (seat.table_id,seat.seat_number)',
      'AND registration.chips::numeric=seat.stack',
      "COALESCE(NULLIF((fund.tournament_snapshot->>'rebuy_chips')::numeric,0),(fund.tournament_snapshot->>'starting_chips')::numeric)=seat.stack",
      // paid: chip ledger and wallet debit, or diamond custody
      "AND ((fund.asset='chips' AND to_jsonb(l)=fund.ledger_snapshot AND l.status='posted' AND l.category=fund.operation",
      "OR (fund.asset='diamonds' AND EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger d",
      // nothing changed since
      'AND NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts later',
      'AND NOT EXISTS(SELECT 1 FROM public.ca_seat_stack_exits ex WHERE ex.table_id=p_table AND ex.user_id=seat.user_id AND ex.occurred_at>=pr.claimed_at)',
      // what a DEALT table must also show
      'AND NOT EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts mv WHERE mv.tournament_id=p_tournament AND mv.user_id=seat.user_id AND mv.moved_at>=c.resolved_at)',
      'AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits hc WHERE hc.table_id=p_table AND hc.committed_at>=seat.joined_at',
      // recorded as an entry, so the purchase, seat, registration and roster checks still apply
      "'seat_id',seat.id,'seat_number',seat.seat_number,'joined_at',seat.joined_at,'atomic_purchase',fund.purchase_key)));",
    ])
      expect(PASSAGE, condition).toContain(condition);
    // The never-dealt proof is the source of this rule.
    for (const shared of [
      "AND pr.response->>'atomic_tournament_chip_purchase'='v1'".replace('pr.', 'p.'),
      "AND m.request=jsonb_build_object('user_id',seat.user_id,'custody_id',d.custody_id,'amount',fund.amount,'action','tournament_add')",
    ])
      expect(NEVER_DEALT).toContain(shared);
  });

  it('never borrows a plpgsql variable name for a query alias', () => {
    // f06_movement_prior declares a, x and p; an alias of the same name is an
    // ambiguous reference the moment the passage runs.
    expect(PASSAGE).not.toMatch(/\bJOIN public\.\w+ (a|x|p) ON\b/);
    expect(PASSAGE).not.toMatch(/\bFROM public\.\w+ (a|x|p)\b/);
    expect(PASSAGE).not.toMatch(/jsonb_array_elements\([^)]*\) (a|x|p)\b/);
  });

  it('is one transaction that writes no row, keeps the ACL, and is the newest definition', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(SQL).toContain("p.proacl::text = '{postgres=X/postgres}'");
    expect(SQL).not.toMatch(/^GRANT /m);
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(
      /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(public|smarter_private)\.)/i
    );
    expect(code).not.toMatch(/cron\./i);
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) =>
        readFileSync(join(MIGRATIONS, f), 'utf8').includes(
          'FUNCTION smarter_private.f06_movement_prior('
        )
      );
    expect(later).toEqual([]);
  });
});
