/**
 * A union member club's open-period leaderboard ranks its own players on the
 * play the union's shared tables recorded for them (2026-10-17). Shark Club's
 * Today / This Week / This Month boards were empty because cash hands accrue
 * on the union root's player_stats rows; All Time, standalone clubs and the
 * union root keep the previous query, and no prize basis is touched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const NAME = '20261017025229_a_union_club_leaderboard_ranks_its_own_players.sql';
const SQL = readFileSync(resolve(process.cwd(), 'supabase/migrations', NAME), 'utf8');
const fragment = (tag: string) =>
  SQL.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`))?.[1] ?? '';

describe('a union club leaderboard ranks its own players', () => {
  it('patches only fn_club_leaderboard_period_v2 from its measured live preimage', () => {
    expect(SQL).toContain(
      "'public.fn_club_leaderboard_period_v2(uuid,text,text,integer,integer)'::regprocedure"
    );
    expect(SQL).toContain('e3f493cf57895d1ad32932497ea00b45');
    expect(SQL).toContain('9c7467edd1c92389dc846a396492cafb');
    expect(SQL.match(/^-- @live-proof:/gm)).toHaveLength(1);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    // The Diamond board law reads the latest full chip-board definition from
    // the corpus; this substitution must never be mistaken for one.
    expect(SQL).not.toContain('CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_period_v2(');
  });

  it('attributes players the way the Players page does, over the union physical scope', () => {
    const n2 = fragment('n2');
    expect(n2).toContain('SELECT DISTINCT ON(cm.user_id) cm.user_id,cm.club_id');
    expect(n2).toContain('ORDER BY cm.user_id,cm.joined_at ASC NULLS LAST,cm.club_id) a');
    expect(n2).toContain('WHERE a.club_id=p_club_id');
    expect(n2).toContain(
      'SELECT v_union AS club_id WHERE v_union IS NOT NULL AND NOT v_is_all_time'
    );
    expect(n2).toContain(
      'WHERE v_union IS NOT NULL AND NOT v_is_all_time AND uc.union_id = v_union'
    );
    // Every scope club is measured against its own baseline and previous day.
    expect(n2).toContain('b.snapshot_date=sc.baseline');
    expect(n2).toContain('pe.snapshot_date=sc.prev_end');
  });

  it('leaves All Time, standalone clubs and the union root on the previous query', () => {
    expect(fragment('n3')).toContain('AND (v_union IS NULL OR v_is_all_time)');
    expect(fragment('o3')).toContain('WHERE ps.club_id = p_club_id');
  });

  it('touches no prize basis, payout or settlement reader', () => {
    expect(SQL).not.toMatch(
      /fn_club_leaderboard_by_dates'|fn_leaderboard_complete_round_basis'|fn_settle_due_leaderboards'/
    );
    expect(SQL).not.toMatch(/INSERT INTO|UPDATE public\.|DELETE FROM/);
    expect(SQL).toContain('IN v_def) = 0 THEN');
  });

  it('keeps the security contract and the deleted-account filter', () => {
    expect(SQL).toContain("v_owner IS DISTINCT FROM 'postgres'");
    expect(SQL).toContain('v_definer IS DISTINCT FROM true');
    expect(SQL).toContain(
      "'{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'"
    );
    expect(SQL).toContain("$d$dp.status = 'deleted'$d$");
  });
});
