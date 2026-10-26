/**
 * ENTRY CLOSE TAKES THE TOURNAMENT LANE BEFORE ITS ROW.
 *
 * Measured 2026-10-22 to 2026-10-24: fourteen
 * tournament.real_time_payout_refused alerts, every one 40P01, every one
 * raised by the transaction that closed the event's entry. Both entry-close
 * doors locked the tournaments row first and took no lane; the pool they
 * finalize fires the deferred payer, which asks for T(id) exclusive at
 * COMMIT, while a rebuy, add-on or hand already held T(id) and waited for
 * that row (postgres log 2026-10-24 22:31:42 UTC). The lane's one order is
 * G, then T(id), then rows, and every other writer of the event keeps it.
 *
 * This pins, against the migration and the exact production fixtures:
 *   - both doors take fn_ca_lock_settlement_lane_for_tournament(id) as their
 *     first statement, before the row, only for a non-NULL id;
 *   - the edit is one anchored replace of production's pre-image, and
 *     applying it to the fixtures gives the pinned post-image md5 that the
 *     migration asserts and its @live-proof lines read;
 *   - no later migration redefines either door with the row before the lane;
 *   - the fix is not a retry, sweep or cron, and its native proof is wired.
 *
 * Registry: docs/laws.d/entry-close-takes-the-tournament-lane-before-its-row.md
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const NAME = '20261025030526_entry_close_takes_the_tournament_lane_before_its_row.sql';
const MIGRATION = readFileSync(join(MIGRATIONS, NAME), 'utf8');
const FIX = join(ROOT, 'scripts', 'ci', 'fixtures', 'entry-close-lane');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

const LANE_CALL = 'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);';

// The lane block exactly as the migration builds it with chr(10).
const LANE_BLOCK = [
  '  /* THE LANE BEFORE THE ROW (2026-10-25). G shared, then T(id) exclusive,',
  '     then the tournaments row: the order of every other writer of this',
  '     event. Finalizing the pool here fires the deferred payer, which asks',
  '     for T(id) exclusive at COMMIT; holding the row without the lane made',
  '     that a deadlock with any rebuy, add-on or hand that holds T(id) and',
  "     waits for the row. Taken first, the payer's request is re-entrant. */",
  '  IF p_tournament_id IS NOT NULL THEN',
  `    ${LANE_CALL}`,
  '  END IF;',
  '',
].join('\n');

const DOORS = [
  {
    name: 'fn_close_tournament_entry_window',
    sig: 'fn_close_tournament_entry_window(uuid,text)',
    pre: '45df22d088d6e1e82c7783ae32415112',
    post: '8cb316d211658925f175131f07a5202a',
    postSrc: '508e59bc8d5be4439aac1e3054e7fe98',
    anchor:
      'BEGIN\n  SELECT * INTO v_t\n    FROM public.tournaments t\n   WHERE t.id=p_tournament_id\n   FOR UPDATE;\n',
  },
  {
    name: 'fn_close_tournament_addon_period',
    sig: 'fn_close_tournament_addon_period(uuid,text)',
    pre: '385d1b85fd08702be6c9bd046c2a7e76',
    post: 'd5e0ba63cb0540f4fbfa5b84563b7ca4',
    postSrc: 'c570c866b2c9446eed97916edda488a4',
    anchor:
      'BEGIN\n  SELECT * INTO v_t\n    FROM public.tournaments\n   WHERE id=p_tournament_id\n   FOR UPDATE;\n',
  },
];

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe('entry close takes the tournament lane before its row', () => {
  it('is one short transaction that edits only the two doors', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIGRATION).toMatch(/^SET LOCAL lock_timeout = '2s';$/m);
    const body = MIGRATION.replace(/^\s*--.*$/gm, '');
    expect(body).not.toMatch(
      /cron\.schedule|pg_sleep|fn_[a-z_]*(repair|backpay|redrive|sweep|catchup|heal)/i
    );
    expect(body).not.toMatch(/'40P01'/);
    expect(body).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.(fn_ca_pay_tournament_finishers_now|trg_ca_pay_tournament_finishers_at_commit|fn_finalize_tournament_entry_pool_locked|fn_apply_prize_guarantee|fn_ca_lock_settlement_lane)/
    );
    expect(body).not.toMatch(/@install-window/);
  });

  for (const door of DOORS) {
    describe(door.name, () => {
      const fixture = readFileSync(join(FIX, `${door.name}.sql`), 'utf8');

      it('the fixture is the production pre-image the migration guards', () => {
        expect(md5(fixture)).toBe(door.pre);
        expect(MIGRATION).toContain(`'${door.pre}'`);
        expect(count(fixture, door.anchor)).toBe(1);
      });

      it('takes the lane first, then the row, and the result is the pinned post-image', () => {
        const post = fixture.replace(
          door.anchor,
          `BEGIN\n${LANE_BLOCK}${door.anchor.slice('BEGIN\n'.length)}`
        );
        expect(md5(post)).toBe(door.post);
        const begin = post.indexOf('\nBEGIN\n');
        const lane = post.indexOf(LANE_CALL);
        const row = post.indexOf('FROM public.tournaments');
        expect(begin).toBeGreaterThan(0);
        expect(lane).toBeGreaterThan(begin);
        expect(lane).toBeLessThan(row);
        // Nothing else is locked or read between BEGIN and the lane.
        expect(post.slice(begin, lane)).not.toMatch(/SELECT|FOR UPDATE|FOR SHARE|PERFORM\s+1/);
        expect(post).toMatch(
          /IF p_tournament_id IS NOT NULL THEN\n {4}PERFORM public\.fn_ca_lock_settlement_lane_for_tournament/
        );
      });

      it('the migration asserts and live-proves that post-image', () => {
        expect(MIGRATION).toContain(`'${door.post}'`);
        expect(MIGRATION).toContain(`'${door.postSrc}'`);
        const proof = MIGRATION.split('\n').find(
          (line) => line.startsWith('-- @live-proof: ') && line.includes(`public.${door.sig}`)
        );
        expect(proof).toBeDefined();
        expect(proof).toContain(`md5(pg_get_functiondef(oid))='${door.post}'`);
        expect(proof).toContain(`md5(prosrc)='${door.postSrc}'`);
        expect(proof).toContain("proacl::text='{postgres=X/postgres,service_role=X/postgres}'");
      });

      it('no later migration puts the row back in front of the lane', () => {
        const head = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${door.name}\\s*\\(`);
        const later = readdirSync(MIGRATIONS)
          .filter((f) => f.endsWith('.sql') && f > NAME)
          .sort();
        for (const file of later) {
          const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
          const at = sql.search(head);
          if (at < 0) continue;
          const def = sql.slice(at, sql.indexOf('$function$;', at));
          const lane = def.indexOf('fn_ca_lock_settlement_lane_for_tournament(');
          const row = def.indexOf('public.tournaments');
          const rowLock = def.search(/FROM public\.tournaments[\s\S]*?FOR UPDATE/);
          expect(lane, `${file} redefines ${door.name} without the lane`).toBeGreaterThan(0);
          expect(lane, `${file} locks the row before the lane`).toBeLessThan(
            rowLock >= 0 ? rowLock : row
          );
        }
      });
    });
  }

  it('the native PostgreSQL proof is wired to the paths it proves', () => {
    const script = join(ROOT, 'scripts', 'ci', 'test-entry-close-takes-the-lane-before-its-row.py');
    const workflow = join(
      ROOT,
      '.github',
      'workflows',
      'entry-close-takes-the-lane-before-its-row.yml'
    );
    expect(existsSync(script)).toBe(true);
    expect(existsSync(workflow)).toBe(true);
    const py = readFileSync(script, 'utf8');
    expect(py).toContain(NAME);
    for (const door of DOORS) expect(py).toContain(door.post);
    expect(py).toMatch(/40P01/);
    const yml = readFileSync(workflow, 'utf8');
    expect(yml).toContain(`supabase/migrations/${NAME}`);
    expect(yml).toContain('scripts/ci/fixtures/entry-close-lane/**');
    expect(yml).not.toMatch(/^\s*schedule:/m);
  });
});
