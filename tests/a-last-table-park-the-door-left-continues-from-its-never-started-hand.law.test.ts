/**
 * A LAST-TABLE PARK THE DOOR LEFT CONTINUES FROM ITS NEVER-STARTED HAND (2026-09-27)
 *
 * The abandoned-generation door (20260927145416) closes a dead generation's
 * never-started hand and leaves that generation's own pre-manifest park for
 * the successor. On an event's last open table (41eb379e, a Spin) the park
 * cannot begin, and the no-start continuation required the ORIGIN's custody
 * and the origin's own cancellation as the never-started witness. It now also
 * accepts the successor that holds the custody with the door's receipt as the
 * witness, and nothing else.
 *
 * Run in a local PostgreSQL 17 on rows exported from production for 41eb379e:
 * the old body refuses F06_CONTINUATION_EXACT_PREMANIFEST_PARK, the new body
 * continues and withdraws the park, and a replay returns the stored receipt.
 *
 * THE HOLDER RULE (2026-09-27 21:40 UTC). The first body required the caller
 * to BE the generation named in the park's custody. In production that
 * generation (3871b71a) died too: engine e6b9dc5d adopted 41eb379e as
 * f798e8e0 and the park still names 3871b71a, so the first body refused the
 * very event it was written for (proved locally on the production shape).
 * The caller is instead the event's live lease holder (f06_prefix fences
 * every other generation), never the origin the door closed, and no other
 * generation may hold a lease. The origin as caller, a foreign lease and a
 * chip moved between chairs all still refuse.
 *
 * docs/changelog/2026-09-27-a-last-table-park-the-door-left-continues.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260927163617_a_last_table_park_the_door_left_continues_from_its_never_sta.sql'
  ),
  'utf8'
);
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const start = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_f06_continue_no_start_last_table(');
const open = SQL.indexOf('$function$', start) + '$function$'.length;
const BODY = SQL.slice(open, SQL.indexOf('$function$', open));

describe('a last-table park the door left continues from its never-started hand', () => {
  it('installs exactly the reviewed body over the production pre-image', () => {
    expect(start).toBeGreaterThan(0);
    expect(md5(BODY)).toBe('7bcd80fcbbd3ac6cb1f47da7a9dc1d34');
    expect(SQL).toContain("md5(p.prosrc) = '88273d46745a000fc1b7b006427b8d89'");
    expect(SQL).toContain("<> '79b411db1991b00e04e6cfce647843a0'");
  });

  it('admits only the live lease holder for a park the door left, with the door receipt as witness', () => {
    expect(BODY).toContain('AND NOT (p_lease_generation IS DISTINCT FROM o.origin_generation');
    expect(BODY).toContain('AND l.lease_generation IS DISTINCT FROM p_lease_generation)');
    expect(BODY).not.toContain('o.custody_generation = p_lease_generation');
    // The live lease is proved before any of this is read.
    expect(BODY.indexOf('PERFORM smarter_private.f06_prefix(')).toBeGreaterThan(0);
    expect(BODY.indexOf('PERFORM smarter_private.f06_prefix(')).toBeLessThan(
      BODY.indexOf('A PARK THE ABANDONED-GENERATION DOOR LEFT')
    );
    expect(BODY).toContain("g.expected->'foreign_parks_left' ? o.break_id::text");
    expect(BODY).toContain("WHERE ns#>>'{permit,permit_id}'=h.permit_id::text");
    expect(BODY).toContain('OR NOT (h.evidence_id IS NOT DISTINCT FROM o.custody_id');
    expect(BODY).toContain("RAISE EXCEPTION 'F06_CONTINUATION_EXACT_PREMANIFEST_PARK'");
    expect(BODY).toContain("RAISE EXCEPTION 'F06_CONTINUATION_POSITIVE_ORIGINAL_REQUIRED'");
    expect(BODY).toContain("RAISE EXCEPTION 'F06_CONTINUATION_LAST_TABLE_REQUIRED'");
  });

  it('moves no money and keeps the continuation service_role only', () => {
    expect(BODY).toContain("'credit',0");
    expect(BODY).not.toMatch(/INSERT INTO public\.(chip_ledger|wallet_transactions)\b/);
    expect(BODY).not.toMatch(/UPDATE public\.(table_seats|tournament_players)\b/);
    expect(SQL).toContain("p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
  });
});
