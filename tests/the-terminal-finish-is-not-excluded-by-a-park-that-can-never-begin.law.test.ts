/**
 * THE TERMINAL FINISH IS NOT EXCLUDED BY A PARK THAT CAN NEVER BEGIN (2026-09-28)
 *
 * bfcfaf17 was decided on 2026-09-18 and its winner never paid: the event's own
 * terminal settlement was refused F06_SOURCE_EXCLUDED by a pre-manifest
 * park_requested operation on its last table (probed in production, rolled
 * back). Every live park_requested row has no manifest until it begins, so the
 * bare shape may be unbound only for the event's own terminal settlement, never
 * for ordinary writers (that window is what the guard protects).
 *
 * Behaviour: scripts/dev/probe-f06-terminal-finish-bare-park-pg16.sh (red on the
 * production pre-image, green under this event's terminal authority, refused
 * without it, for another event, for a move authority and for a park with a
 * member or a manifest). This law pins the reviewed source.
 *
 * docs/changelog/2026-09-28-the-terminal-finish-is-not-excluded-by-a-park-that-can-never-begin.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SQL = readFileSync(
  join(
    ROOT,
    'supabase',
    'migrations',
    '20260928044311_the_terminal_finish_is_not_excluded_by_a_park_that_can_never.sql'
  ),
  'utf8'
);
const PRE = readFileSync(
  join(ROOT, 'scripts', 'dev', 'fixtures', 'f06-terminal-finish-bare-park', 'preimage-2026-09-28.prosrc.txt'),
  'utf8'
);
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const start = SQL.indexOf('CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()');
const open = SQL.indexOf('$function$', start) + '$function$'.length;
const BODY = SQL.slice(open, SQL.indexOf('$function$', open));

describe('the terminal finish is not excluded by a park that can never begin', () => {
  it('replaces exactly the live pre-image and installs exactly the reviewed body', () => {
    expect(start).toBeGreaterThan(0);
    expect(md5(PRE)).toBe('be484837a5103b3c0ac78a1d6d5d0bf2');
    expect(md5(BODY)).toBe('6af3955d0fce49b522b4ba3707a60891');
    expect(SQL).toContain("md5(p.prosrc) = 'be484837a5103b3c0ac78a1d6d5d0bf2'");
    expect(SQL).toContain("md5(p.prosrc) = '6af3955d0fce49b522b4ba3707a60891'");
    expect(SQL.match(/p\.proacl::text = '\{postgres=X\/postgres\}'/g)?.length).toBe(2);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).not.toMatch(/\bGRANT\b/);
  });

  it('changes only the bound test, and only for this event\'s terminal settlement', () => {
    const at = BODY.indexOf(" -- THE EVENT'S OWN TERMINAL SETTLEMENT");
    const end = BODY.indexOf(' IF NOT bound THEN');
    expect(at).toBeGreaterThan(0);
    const oldBound =
      " bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state NOT IN ('acknowledged','withdrawn_before_manifest'));\n";
    expect(BODY.slice(0, at) + oldBound + BODY.slice(end)).toBe(PRE);
    const bound = BODY.slice(at, end);
    for (const clause of [
      "o.state='park_requested' AND o.tournament_id=t AND o.manifest IS NULL",
      'o.close_receipt IS NULL AND o.cleanup_kind IS NULL AND o.abort_receipt_id IS NULL',
      'NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)',
      'NOT EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)',
      'NOT EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id)',
      "current_setting('app.tournament_seat_exit_operation',true)='terminal_finish'",
      "x.tournament_id=t AND x.operation='terminal_finish'",
      "x.token::text=current_setting('app.tournament_seat_exit_token',true)",
    ])
      expect(bound).toContain(clause);
    // No general unbinding of the bare shape (the #5474 predicate).
    expect(bound).not.toMatch(/o\.state<>'park_requested' OR o\.manifest IS NOT NULL/);
  });
});
