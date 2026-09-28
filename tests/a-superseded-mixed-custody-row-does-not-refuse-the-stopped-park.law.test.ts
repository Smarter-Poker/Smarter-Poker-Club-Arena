/**
 * A SUPERSEDED MIXED CUSTODY ROW DOES NOT REFUSE THE STOPPED PARK (2026-09-28)
 *
 * Tournament 4e2de62d ("Friday Fight Night Opener", 31 players): an F06 mixed
 * manager-custody transfer completed at 2026-09-28 00:56:59Z and wrote its four
 * engine_presence_parked rows as engine_instance 'f06_mixed_custody' at hands
 * 14775285, 14774766, 14772724 and 14775004. The event resumed at 13:47Z, dealt
 * to hands 16686550-16686591, and lost its lease at 13:49:49Z. At 13:50:02Z
 * every stopped-custody park was refused `mixed_custody_adopted` because the
 * park refused over ANY mixed row, whatever its hand number; the manager's stop
 * failed "retained time-bank custody" on all four tables and the event has not
 * dealt since. A mixed row is read only by loadTimeBanksFromPark, only at the
 * exact hand number an engine boots at; once a hand is dealt above it, no
 * engine can ever read it again.
 *
 * The law, pinned on the LATEST definition of the park in the tree:
 *   - a mixed row still refuses `mixed_custody_adopted` unless it is PROVED
 *     superseded: a readable non-negative integer hand number strictly below
 *     the custody, and a hand_history row on this table strictly above it and
 *     at or below the custody;
 *   - the open-transfer refusal still comes first, and every later refusal
 *     (newer_park, hand_after_custody, permits) still runs before the write;
 *   - that branch is the only change from the previous body;
 *   - the migration guards its pre-image and post-image by the bodies it
 *     replaces and installs, in one transaction.
 *
 * docs/changelog/2026-09-28-a-superseded-mixed-custody-row-does-not-refuse-the-stopped-park.md
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const OWN_FILE = '20260928154327_a_superseded_mixed_custody_row_does_not_refuse_the_stopped_p.sql';
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, fn: string): string {
  const start = sql.indexOf(`FUNCTION public.${fn}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const tag = sql.slice(sql.indexOf('AS $', start) + 3).match(/^\$[a-z_]*\$/)?.[0] ?? '$$';
  const open = sql.indexOf(tag, start) + tag.length;
  return sql.slice(open, sql.indexOf(tag, open));
}

function definitions(fn: string): { file: string; sql: string }[] {
  const re = new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`);
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(DIR, file), 'utf8') }))
    .filter(({ sql }) => re.test(sql));
}

const FN = 'fn_park_stopped_time_bank_custody';
const PARKS = definitions(FN);
const PARK = body(PARKS[PARKS.length - 1].sql, FN);
const OWN_AT = PARKS.findIndex((d) => d.file === OWN_FILE);

const OLD_BRANCH =
  "    IF v_existing.engine_instance = 'f06_mixed_custody' THEN\n" +
  "      RETURN jsonb_build_object('ok', false, 'refused', 'mixed_custody_adopted',\n" +
  "                                'table_id', p_table_id);\n" +
  '    END IF;\n';

/** The mixed branch of the latest park, from its test to its END IF. */
function mixedBranch(): string {
  const open = PARK.indexOf("    IF v_existing.engine_instance = 'f06_mixed_custody' THEN\n");
  expect(open).toBeGreaterThan(0);
  const close = PARK.indexOf('\n    END IF;\n', open);
  expect(close).toBeGreaterThan(open);
  return PARK.slice(open, close + '\n    END IF;\n'.length);
}

describe('a superseded mixed custody row does not refuse the stopped park', () => {
  it('still refuses a mixed row that is not proved superseded', () => {
    const branch = mixedBranch();
    expect(branch.match(/'refused', 'mixed_custody_adopted'/g)).toHaveLength(2);
    const first = branch.slice(0, branch.indexOf("'mixed_custody_adopted'"));
    for (const clause of [
      "v_hand := v_existing.time_bank_snapshot -> 'handNumber';",
      "IF jsonb_typeof(v_hand) IS DISTINCT FROM 'number'",
      'OR (v_hand::text)::numeric <> trunc((v_hand::text)::numeric)',
      'OR (v_hand::text)::numeric < 0',
      'OR (v_hand::text)::numeric >= p_hand_number THEN',
    ])
      expect(first, clause).toContain(clause);
    // The only thing that lets the park past a mixed row: a hand this table
    // dealt after it, no later than the custody being parked.
    const second = branch.slice(branch.indexOf("'mixed_custody_adopted'") + 1);
    expect(second).toContain(
      'IF NOT EXISTS (SELECT 1 FROM public.hand_history h\n' +
        '                      WHERE h.table_id = p_table_id\n' +
        '                        AND h.hand_number > (v_hand::text)::bigint\n' +
        '                        AND h.hand_number <= p_hand_number) THEN'
    );
    expect(branch).not.toMatch(/UPDATE|INSERT|DELETE/);
  });

  it('keeps the open-transfer refusal first and every later refusal before the write', () => {
    const transfer = PARK.indexOf("'refused', 'mixed_transfer_recorded'");
    const mixed = PARK.indexOf("IF v_existing.engine_instance = 'f06_mixed_custody' THEN");
    const write = PARK.indexOf('UPDATE public.engine_presence_parked');
    expect(transfer).toBeGreaterThan(0);
    expect(mixed).toBeGreaterThan(transfer);
    expect(write).toBeGreaterThan(mixed);
    for (const later of [
      "'existing_park_unreadable'",
      "'newer_park'",
      "'evidence', 'hand_history'",
      "'evidence', 'hand_atomic_commits'",
      "'evidence', 'hand_state_snapshots'",
      "'evidence', 'f06_hand_permits'",
    ]) {
      const at = PARK.indexOf(later, mixed);
      expect(at, later).toBeGreaterThan(mixed);
      expect(at, later).toBeLessThan(write);
    }
  });

  it('the mixed branch is the only change from the previous body', () => {
    expect(OWN_AT).toBeGreaterThan(0);
    const own = body(PARKS[OWN_AT].sql, FN);
    const prior = body(PARKS[OWN_AT - 1].sql, FN);
    expect(prior.split(OLD_BRANCH)).toHaveLength(2);
    const ownBranchOpen = own.indexOf('    /* A SUPERSEDED MIXED ROW IS NOT THE SUCCESSOR');
    const ownBranchClose =
      own.indexOf('\n    END IF;\n', own.indexOf("'f06_mixed_custody' THEN", ownBranchOpen)) +
      '\n    END IF;\n'.length;
    expect(ownBranchOpen).toBeGreaterThan(0);
    const restored =
      own.slice(0, ownBranchOpen) + OLD_BRANCH + own.slice(ownBranchClose);
    expect(restored).toBe(prior);
  });

  it('the migration guards its pre-image and post-image by the bodies it replaces and installs, in one transaction', () => {
    const file = PARKS[OWN_AT];
    const sql = file.sql;
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    const pre = sql.slice(sql.indexOf('DO $pre$'), sql.indexOf('$pre$;'));
    const post = sql.slice(sql.indexOf('DO $post$'), sql.indexOf('$post$;'));
    expect(pre).toContain(`'${md5(body(PARKS[OWN_AT - 1].sql, FN))}'`);
    expect(post).toContain(`'${md5(body(sql, FN))}'`);
    for (const g of [pre, post]) {
      expect(g).toContain("ARRAY['postgres=X/postgres', 'service_role=X/postgres']");
      expect(g).toContain("ARRAY['search_path=pg_catalog, pg_temp']");
      expect(g).toContain('p.prosecdef IS DISTINCT FROM true');
    }
    expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('TO service_role;');
    expect(sql).toMatch(/^-- @live-proof: /m);
  });
});
