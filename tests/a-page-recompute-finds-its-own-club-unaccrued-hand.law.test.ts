/**
 * A PAGE RECOMPUTE FINDS ITS OWN CLUB'S UNACCRUED HAND (2026-10-25,
 * migration 20261025032315).
 *
 * The rakeback settler's cursor stopped at 2026-10-24 17:21:38 and stayed
 * there from 23:21 UTC: every cycle re-ran the same page, and that page's
 * period recompute for Lightning Internal Pilot (e14bc9f7, week 2026-10-19)
 * ran into its 300 s statement_timeout, so the settler counted a failure and
 * held the cursor for every club. The pilot had stopped dealing at 23:23, so
 * its unaccrued hands fell out of the page door's window (the week's newest
 * 200 cash records of EVERY club, all Midway hands now) and the call went to
 * the full-week calculator, whose evidence checkpoint was stale.
 *
 * The migration edits the installed definition in place: when the shared
 * window finds nothing, the door also reads this club's newest 200
 * attributions in the week under the window's own predicate, and the witness
 * wait asks that question once before it sleeps. This law pins:
 *   1. the migration edits only from the exact installed pre-image, which is
 *      the body the repository last declares, and asserts the proved
 *      post-image;
 *   2. applying the migration's own edits to that body yields the proved
 *      post-image, on which the existing door law and witness-wait law still
 *      hold unchanged;
 *   3. the club door counts only positive evidence of the calculator's own
 *      refusal: an attribution of THIS club on a cash record of the week with
 *      a hand and no accrued batch, read after the club-week lock and only
 *      when the shared window found nothing; anything else still reaches the
 *      unchanged calculator.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring } from './helpers/migrations';
import { recomputeDoorViolations } from './a-page-cannot-certify-an-unfinished-week.law.test';
import { witnessWaitViolations } from './a-page-waits-for-its-witness-before-it-holds-anything.law.test';

const FN = 'fn_rakeback_recompute_periods';
const FILE = '20261025032315_a_page_recompute_finds_its_own_club_unaccrued_hand.sql';
const SQL = readFileSync(resolve(__dirname, '..', 'supabase/migrations', FILE), 'utf8');
const PRE_SRC_MD5 = '93ef60909e00b2645ae6d7ddc30031e6';
const POST_SRC_MD5 = '33d4eb0fe9e4944668e6899ab0da8c41';
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** Evaluate a SQL text expression of quoted literals joined by `|| chr(10) ||`. */
function sqlText(expr: string): string {
  let out = '';
  for (const m of expr.matchAll(/'((?:[^']|'')*)'|chr\(10\)/g))
    out += m[1] !== undefined ? m[1].replace(/''/g, "'") : '\n';
  return out;
}

/** The (find, replacement) pairs the migration applies, in order. */
function migrationEdits(sql: string): Array<[string, string]> {
  const finds = [...sql.matchAll(/v_find := ([\s\S]*?);\n {2}v_n :=/g)].map((m) => sqlText(m[1]));
  const repls = [...sql.matchAll(/v_src := replace\(v_src, v_find,\n([\s\S]*?)\);\n/g)].map((m) =>
    sqlText(m[1])
  );
  expect(finds.length).toBe(repls.length);
  return finds.map((f, i) => [f, repls[i]]);
}

/** The body as installed before this migration: the last declaration in the repository. */
const PRE_BODY = (() => {
  const body = functionBody(latestDeclaring(FN).sql, FN);
  // functionBody returns the opening dollar quote with the body; prosrc does not carry it.
  return body.replace(/^\$\w*\$/, '');
})();

function applyEdits(body: string): string {
  let out = body;
  for (const [find, repl] of migrationEdits(SQL)) {
    expect(out.split(find).length - 1, `anchor not unique: ${find.slice(0, 60)}`).toBe(1);
    out = out.replace(find, () => repl);
  }
  return out;
}

const POST_BODY = applyEdits(PRE_BODY);

/** Every way the club door can be wrong, as named findings. Empty means the law holds. */
export function clubDoorViolations(body: string): string[] {
  const out: string[] = [];
  const b = body.replace(/--[^\n]*/g, '');
  const lock = b.indexOf("pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'");
  const calc = b.indexOf('public.fn_calculate_cash_rakeback_periods(');
  const gate = b.search(/IF\s+unaccrued\s*=\s*0\s+THEN/);
  if (gate < 0) {
    out.push('there is no club door: a stopped club still pays the full-week calculator');
    return out;
  }
  // The door is the block from its gate to the first END IF after it: its
  // body is one statement, so that END IF closes it.
  const end = b.indexOf('END IF;', gate);
  const door = b.slice(gate, end >= 0 ? end : b.length);
  if (lock < 0 || gate < lock) out.push('the club door runs before the club-week lock is held');
  if (calc >= 0 && calc < gate) out.push('the calculator runs before the club door is decided');
  if (!/SELECT\s+count\(\*\)\s+INTO\s+unaccrued/.test(door))
    out.push('the club door does not feed the same refusal count');
  if (!/a\.club_id\s*=\s*p_club_id/.test(door))
    out.push('the club door does not require an attribution to THIS club');
  if (
    !/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.accounting_cash_accrual_batches\s+b\s+WHERE\s+b\.rake_record_id\s*=\s*r\.id\s+AND\s+b\.status\s*=\s*'accrued'\s*\)/.test(
      door
    )
  )
    out.push('the club door does not require a hand with no accrued batch');
  for (const [re, what] of [
    [/r\.created_at\s*>=\s*v_club_from\s+AND\s+r\.created_at\s*<\s*v_to/, 'inside the week'],
    [/r\.rake_amount\s*>\s*0/, 'with positive rake'],
    [/r\.is_tournament\s+IS\s+NOT\s+TRUE\s+AND\s+r\.tournament_id\s+IS\s+NULL/, 'of a cash hand'],
    [/r\.hand_id\s+IS\s+NOT\s+NULL/, 'with a hand'],
  ] as const)
    if (!re.test(door)) out.push(`the club door does not require a record ${what}`);
  if (!/LIMIT\s+200/.test(door)) out.push('the club door is not bounded');
  if (
    !/v_club_from\s*:=\s*public\.fn_ca_launch_accounting_start\('club',\s*p_club_id,\s*v_from\)/.test(
      door
    )
  )
    out.push("the club door does not start at the club's accounting start");
  if (/\b(INSERT|UPDATE|DELETE)\b/i.test(door)) out.push('the club door writes');
  return out;
}

describe("a page recompute finds its own club's unaccrued hand", () => {
  it('edits only the exact installed pre-image, which is the last declared body', () => {
    expect(md5(PRE_BODY), `${FN} as last declared`).toBe(PRE_SRC_MD5);
    expect(SQL).toContain("IF md5(v_src) <> '754c7b903771621ccc4d3e90b2dd8454' THEN");
    expect(SQL).toContain("IF md5(v_src) <> '34534e8ec5452e854db21fb4e7b4bc3a' THEN");
    expect(SQL).toContain(
      `(SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '${POST_SRC_MD5}'`
    );
    expect(SQL).toMatch(
      /^-- @live-proof: \(SELECT md5\(prosrc\)='33d4eb0fe9e4944668e6899ab0da8c41'/m
    );
  });

  it('its own edits produce the proved post-image', () => {
    expect(migrationEdits(SQL).length).toBe(4);
    expect(md5(POST_BODY)).toBe(POST_SRC_MD5);
  });

  it('is one short transaction that keeps owner, grants and settings', () => {
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(code.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(code).toMatch(/SET LOCAL lock_timeout = '2s';/);
    expect(code).toMatch(/proacl::text FROM pg_proc WHERE oid = v_fn\) IS DISTINCT FROM v_acl/);
    expect(code).toMatch(/proconfig FROM pg_proc WHERE oid = v_fn\) IS DISTINCT FROM v_config/);
    expect(code).not.toMatch(/\b(INSERT INTO|DELETE FROM|UPDATE public\.)/);
  });

  it('the door law and the witness-wait law still hold on the post-image', () => {
    expect(recomputeDoorViolations(POST_BODY)).toEqual([]);
    expect(witnessWaitViolations(POST_BODY)).toEqual([]);
  });

  it('the club door counts only positive evidence of the calculator refusal', () => {
    expect(clubDoorViolations(POST_BODY)).toEqual([]);
  });

  it('the witness wait asks the club-scoped question once, before the lock, writing nothing', () => {
    const b = POST_BODY.replace(/--[^\n]*/g, '');
    const lock = b.indexOf("pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'");
    const pre = b.slice(0, lock);
    expect(pre).toMatch(/INTO witnessed;\s+IF NOT witnessed THEN\s+LOOP/);
    expect(pre).toMatch(/a\.club_id\s*=\s*p_club_id\s+AND\s+a\.created_at\s*>=\s*v_club_from/);
    expect(pre).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('carries its production measurements and proof', () => {
    expect(SQL).toMatch(/2026-10-24 23:21:04/);
    expect(SQL).toMatch(/new 263 ms/);
    expect(SQL).toMatch(/old 49 ms \/ new 5 ms, identical receipt/);
    expect(SQL).toMatch(/748,833 batches, 927,997 cash records/);
  });

  // Planted regressions: each is a way the club door could be broken, and the
  // checker must name it. A law that cannot fail is not a law. Each replaces
  // the LAST occurrence, which is inside the club door.
  const plantLast = (from: string, to: string) => {
    const at = POST_BODY.lastIndexOf(from);
    expect(at, `plant anchor ${from}`).toBeGreaterThan(0);
    return clubDoorViolations(POST_BODY.slice(0, at) + to + POST_BODY.slice(at + from.length));
  };
  it('refuses a door that counts any club', () => {
    expect(plantLast('WHERE a.club_id=p_club_id AND', 'WHERE true AND')).toContain(
      'the club door does not require an attribution to THIS club'
    );
  });
  it('refuses a door that counts accrued hands', () => {
    expect(
      plantLast(
        "b.rake_record_id=r.id AND b.status='accrued'",
        "b.rake_record_id=r.id AND b.status='x'"
      )
    ).toContain('the club door does not require a hand with no accrued batch');
  });
  it('refuses a door that reaches outside the week', () => {
    expect(
      plantLast('r.created_at>=v_club_from AND r.created_at<v_to', 'r.created_at IS NOT NULL')
    ).toContain('the club door does not require a record inside the week');
  });
  it('refuses a door that reads tournament rake', () => {
    expect(plantLast('r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL', 'true')).toContain(
      'the club door does not require a record of a cash hand'
    );
  });
  const plant = (from: RegExp, to: string) => {
    const planted = POST_BODY.replace(from, to);
    expect(planted, 'the plant must change the body').not.toBe(POST_BODY);
    return clubDoorViolations(planted);
  };
  it('refuses a door that writes', () => {
    expect(
      plant(/IF unaccrued=0 THEN\n/, 'IF unaccrued=0 THEN\n DELETE FROM public.rakeback_periods;\n')
    ).toContain('the club door writes');
  });
  it('refuses a door decided before the lock', () => {
    const b = POST_BODY;
    const gate = b.indexOf('    IF unaccrued=0 THEN');
    const end = b.indexOf('    END IF;\n', gate) + '    END IF;\n'.length;
    const block = b.slice(gate, end);
    const moved = block + b.slice(0, gate) + b.slice(end);
    expect(clubDoorViolations(moved)).toContain(
      'the club door runs before the club-week lock is held'
    );
  });
});
