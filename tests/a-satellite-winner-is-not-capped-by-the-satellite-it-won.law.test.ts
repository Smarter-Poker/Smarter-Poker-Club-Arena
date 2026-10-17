/**
 * A SATELLITE WINNER IS NOT CAPPED BY THE SATELLITE IT WON (2026-10-17)
 *
 * Satellite a4445447 could not finish for over an hour: both settlement
 * authorities counted the winner's own final-table seat, still live while the
 * satellite is RUNNING, as one of its four games. The seat is released by
 * the same settlement. Each authority now passes it as p_exclude_table_id;
 * the four-game cap itself is unchanged.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017025359_a_satellite_winner_is_not_capped_by_the_satellite_it_won.sql',
  'utf8'
);
const between = (open: string, close: string) =>
  sql.slice(sql.indexOf(open) + open.length, sql.indexOf(close, sql.indexOf(open) + open.length));
const oldPassage = between('c_old constant text := $old$', '$old$;');
const newPassage = between('c_new constant text := $new$', '$new$;');

describe('a satellite winner is not capped by the satellite it won', () => {
  it('replaces the call that counted every live seat, including this satellite', () => {
    expect(oldPassage).toContain(
      'fn_concurrent_game_load(\n          v_finisher.user_id,NULL,NULL,v_target_id);'
    );
  });

  it('excludes exactly the winner live seat at this satellite and nothing else', () => {
    expect(newPassage).toContain('v_finisher.user_id,NULL,\n          (SELECT ts.table_id');
    expect(newPassage).toContain('WHERE tb.tournament_id = p_tournament_id');
    expect(newPassage).toContain('AND ts.user_id = v_finisher.user_id');
    expect(newPassage).toContain('AND ts.left_at IS NULL');
    expect(newPassage).toContain('LIMIT 1),\n          v_target_id);');
  });

  it('leaves the cap itself absolute in both authorities', () => {
    expect(newPassage).not.toMatch(/>=\s*4|v_cap_load\s*>=/);
    expect(sql).toContain("'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'");
    expect(sql).toContain("'public.fn_ca_settle_satellite_cohort(uuid,uuid[])'");
  });

  it('installs only over the exact preimages and reads back the exact postimages', () => {
    for (const md5 of [
      '384887d62082eec9a0d61a9d49d955a2',
      'd98767846aeab9497aaeae71a082d972',
      'e8986b5b177c88acbde1ac80fe7e029f',
      '0883aa98fdf1e688cc26c4792685a9dd',
    ]) {
      expect(sql).toContain(`'${md5}'`);
    }
    expect(sql).toContain('pg_get_functiondef(v_oid) IS DISTINCT FROM v_new');
  });
});
