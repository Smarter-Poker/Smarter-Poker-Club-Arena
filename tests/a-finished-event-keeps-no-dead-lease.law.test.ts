/**
 * A FINISHED EVENT KEEPS NO DEAD LEASE (2026-10-03).
 *
 * The 19:07 restart left lease rows on two COMPLETED events (aa27c94f,
 * e52435d6) that their dead holder never released, and nine such rows stood
 * more than 60 s stale after the 21:00 database restart. They were removed
 * only by the one-hour age cutoff, up to two hours later. These assertions
 * pin the narrow shape of the cure: reap_dead_engine_leases also takes a
 * COMPLETED/CANCELLED event's lease once it has missed twelve renewals,
 * deletes it only exactly as it was locked, keeps every F06 retention, and
 * leaves the 600 s floor, the table loop and every live event alone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const SLUG = 'a_finished_event_keeps_no_dead_lease';
const hit = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(`_${SLUG}.sql`));
const FIX = hit.length === 1 ? fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8') : '';
const EDITS = FIX.slice(
  FIX.indexOf('v_edits := jsonb_build_array('),
  FIX.indexOf('v_new := v_src;')
);
const withs = [...EDITS.matchAll(/'with', \$w\$([\s\S]*?)\$w\$/g)].map((m) => m[1]);
const anchors = [...EDITS.matchAll(/'anchor', \$a\$([\s\S]*?)\$a\$/g)].map((m) => m[1]);

describe('a finished event keeps no dead lease', () => {
  it('is one measured, idempotent edit of the reaper and nothing else', () => {
    expect(hit).toHaveLength(1);
    expect(FIX.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FIX.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FIX).toMatch(/^-- @live-proof: .+$/m);
    expect(FIX).toContain("SET LOCAL lock_timeout = '2s';");
    expect(FIX).toContain("'public.reap_dead_engine_leases(integer)'::regprocedure");
    expect(FIX).toContain("IF md5(v_src) <> '789c71d1e878e509cc1236627a749003' THEN");
    expect(FIX).toContain('IF position(v_marker in v_src) > 0 THEN');
    expect(FIX).toContain('IF v_n <> 1 THEN');
    expect(FIX).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    expect(anchors).toHaveLength(2);
    expect(withs).toHaveLength(2);
  });

  it('takes only a finished event whose lease missed twelve renewals, besides the age cutoff', () => {
    const loop = withs[0];
    expect(loop).toContain('WHERE l.heartbeat_at<cutoff');
    expect(loop).toContain("OR (l.heartbeat_at<now()-interval '60 seconds'");
    expect(loop).toContain("t.status IN ('COMPLETED','CANCELLED')");
    expect(loop).toContain('FOR UPDATE OF l SKIP LOCKED LOOP');
    expect(loop).not.toMatch(/RUNNING|REGISTERING/);
  });

  it('deletes only the row exactly as locked, and the custody retention is untouched', () => {
    expect(withs[1]).toContain(
      'WHERE tournament_id=candidate.tournament_id AND heartbeat_at=candidate.heartbeat_at;'
    );
    for (const anchor of anchors) {
      expect(anchor).not.toContain('f06_lease_has_pending_custody');
      expect(anchor).not.toContain('refuses a cutoff under 600s');
      expect(anchor).not.toContain('engine_table_leases');
    }
  });
});
