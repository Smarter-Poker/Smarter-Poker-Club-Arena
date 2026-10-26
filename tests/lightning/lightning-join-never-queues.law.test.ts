import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* Dan 2026-10-24: "REMOVE THE ABILITY TO EVEN JOIN A WAITING LIST IN A
   LIGHTNING GAME, PLAYER BUYS IN AND GETS DEALT INTO A NEW TABLE ASAP, NO
   WAITING". fn_cash_game_join fell through to cash_game_waitlist when every
   Lightning table was full, and nothing opens a table for a Lightning game
   (fn_cash_cluster_tick stands down for it), so the queue was permanent. */
const MIGRATION =
  'supabase/migrations/20261024073506_lightning_join_opens_a_table_instead_of_queueing.sql';
const sql = readFileSync(MIGRATION, 'utf8');
const branch = sql.slice(sql.indexOf('$branch$'), sql.lastIndexOf('$branch$'));

describe('a Lightning join never queues', () => {
  it('replaces the live join only when its source is the qualified one', () => {
    expect(sql).toMatch(/md5\(s\) <> '[0-9a-f]{32}'/);
    expect(sql).toContain("pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure)");
    expect(sql).toMatch(
      /IF n = s OR position\('LIGHTNING NEVER QUEUES' IN n\) = 0 THEN\s+RAISE EXCEPTION/
    );
    expect(sql).toMatch(/^-- @live-proof: .*LIGHTNING NEVER QUEUES/m);
  });

  it('opens a live table and holds a chair before the waitlist insert, for Lightning only', () => {
    expect(branch).toContain("IF g.cluster_mode = 'lightning' THEN");
    expect(branch).toContain(
      "public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'live', NULL)"
    );
    expect(branch).toContain(
      "pg_advisory_xact_lock(hashtextextended('table_seat:' || v_probe_table::text, 0))"
    );
    expect(branch).toMatch(
      /INSERT INTO public\.table_waitlist[\s\S]*'notified'[\s\S]*v_hold_until/
    );
    expect(branch).toContain("'action', 'seat'");
    expect(branch).not.toContain("'waitlisted'");
    expect(branch).not.toContain('INSERT INTO public.cash_game_waitlist');
    /* the branch sits immediately before the game waitlist fallthrough */
    expect(
      branch.trimEnd().endsWith('-- A LAPSED GAME OFFER IS NOT A PLACE IN LINE (2026-10-23).')
    ).toBe(true);
  });

  it('treats horses and humans the same', () => {
    expect(branch).not.toMatch(/is_horse/);
  });
});
