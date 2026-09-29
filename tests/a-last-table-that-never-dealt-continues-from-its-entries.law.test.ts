/**
 * A LAST TABLE THAT NEVER DEALT CONTINUES FROM ITS ENTRIES (2026-09-26)
 *
 * e9c07fe8 (spin-v1) and 114c6069 (sng-v1) parked their only table before
 * its first hand. fn_f06_continue_no_start_last_table proved chairs only
 * against a last committed hand and refused
 * F06_CONTINUATION_PRIOR_COMMIT_REQUIRED for ever. 20260926132457 proves such
 * a table from its entries and leaves the prior-commit branch byte-identical.
 * The behaviour is qualified natively in the shared-hand lane
 * (first_hand_continuation_qualification.py); this law pins the text.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILE = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260926132457_a_last_table_that_never_dealt_continues_from_its_entries.sql'
  ),
  'utf8'
);
const PRE_MD5 = '974e426ede5bd86fa3410fc98f5461f9';
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(tag: string): string {
  const open = FILE.indexOf(`AS $${tag}$`);
  expect(open, tag).toBeGreaterThanOrEqual(0);
  const start = open + `AS $${tag}$`.length;
  return FILE.slice(start, FILE.indexOf(`$${tag}$;`, start));
}

/** Undo the edit: what is left must be the definition production held. */
function undo(after: string): string {
  const a = after.indexOf(' IF NOT FOUND THEN\n -- A last table that never committed a hand');
  const b = after.indexOf(' ELSE\n', a) + ' ELSE\n'.length;
  const c = after.indexOf(
    ' END IF;\n',
    after.indexOf('f06_no_start_prior_committed_stacks(h.permit_id,prior,roster);', b)
  );
  return (
    after.slice(0, a) +
    " IF NOT FOUND THEN RAISE EXCEPTION 'F06_CONTINUATION_PRIOR_COMMIT_REQUIRED' USING ERRCODE='55000'; END IF;\n" +
    after.slice(b, c) +
    after.slice(c + ' END IF;\n'.length)
  );
}

function violations(helper: string): string[] {
  const v: string[] = [];
  for (const [needle, what] of [
    ["h.state<>'never_started'", 'a permit that started is accepted'],
    [
      'EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id)',
      'a table with a commit is proven from entries',
    ],
    [
      'EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id)',
      'a table with a recorded hand is proven from entries',
    ],
    [
      'EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id)',
      'a table with a snapshot is proven from entries',
    ],
    ['AND permit_id<>h.permit_id', 'a table with another permit is proven from entries'],
    [
      "(r->>'stack')::numeric IS DISTINCT FROM t.starting_chips::numeric",
      'a chair off the entry is admitted',
    ],
    [
      'COALESCE(p.rebuys,0)=0 AND NOT COALESCE(p.add_on,false)',
      'a purchase is admitted as an entry',
    ],
    ["f.operation<>'entry'", 'a purchase receipt is admitted'],
    [
      '(SELECT count(*) FROM public.tournament_players WHERE tournament_id=h.tournament_id)<>n',
      'an unseated entrant is admitted',
    ],
  ] as const)
    if (!helper.includes(needle)) v.push(what);
  if (/UPDATE public\.|INSERT INTO |DELETE FROM /.test(helper)) v.push('the proof writes rows');
  return v;
}

describe('a last table that never dealt continues from its entries', () => {
  const door = body('continuation');
  const helper = body('first_hand');

  it('starts from the definition production holds and lands the one it asserts', () => {
    expect(md5(undo(door))).toBe(PRE_MD5);
    expect(FILE).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(FILE).toContain(`md5(p.prosrc) = '${md5(door)}'`);
    expect(FILE).toContain(`md5(p.prosrc) = '${md5(helper)}'`);
  });

  it('proves a never-dealt table only from its exact entries', () => {
    expect(door).toContain(
      'prior:=smarter_private.f06_no_start_first_hand_stacks(h.permit_id,roster);'
    );
    expect(door).not.toContain('F06_CONTINUATION_PRIOR_COMMIT_REQUIRED');
    expect(violations(helper)).toEqual([]);
  });

  it('goes red when any one witness is dropped (planted regressions)', () => {
    expect(
      violations(
        helper.replace(
          " OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=h.tournament_id AND f.operation<>'entry')",
          ''
        )
      )
    ).toContain('a purchase receipt is admitted');
    expect(
      violations(
        helper.replace("(r->>'stack')::numeric IS DISTINCT FROM t.starting_chips::numeric OR ", '')
      )
    ).toContain('a chair off the entry is admitted');
    expect(
      violations(
        helper.replace(
          ' OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id AND permit_id<>h.permit_id)',
          ''
        )
      )
    ).toContain('a table with another permit is proven from entries');
  });

  it('is private, one transaction, with a preimage and a postimage', () => {
    expect(FILE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FILE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FILE).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_no_start_first_hand_stacks(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;'
    );
    expect(FILE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint) TO service_role;'
    );
    expect(FILE).toContain('F06_FIRST_HAND_CONTINUATION_PREIMAGE_DRIFT');
  });
});
