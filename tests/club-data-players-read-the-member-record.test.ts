/**
 * Club Data's player list reads hands, cash net and fees from the same sources
 * as the Member record (2026-10-19). It had read union-wide hands and rake, and
 * wallet-day cash net, so a member's list row disagreed with their record.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261019145606_club_data_players_read_the_member_record.sql'
  ),
  'utf8'
);
const NEW = [...SQL.matchAll(/\$new\$([\s\S]*?)\$new\$/g)].map((m) => m[1]);
const OLD = [...SQL.matchAll(/\$old\$([\s\S]*?)\$old\$/g)].map((m) => m[1]);

describe('club data players read the member record', () => {
  it('patches the three player readers from their measured live preimages, in one transaction', () => {
    for (const [signature, preimage] of [
      [
        'public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)',
        'c396ea690b937169ed836aeb7d1a0fb4',
      ],
      [
        'public.ca_club_player_breakdown(uuid,date,date,integer)',
        '7e66658450c17664dee186bb65e543f3',
      ],
      [
        'public.ca_club_player_export_start(uuid,date,date,text,uuid)',
        '9a2aeafafc9fd9a527ff2800b5e5d394',
      ],
    ]) {
      expect(SQL).toContain(`pg_get_functiondef('${signature}'::regprocedure) INTO original`);
      expect(SQL).toContain(`md5(original)<>'${preimage}'`);
    }
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout='2s';");
    expect(SQL.match(/^-- @live-proof:/gm)).toHaveLength(2);
  });

  it('reads hands, cash net and fees as the Member record does', () => {
    const readers = NEW.filter((n) => n.includes('record AS MATERIALIZED'));
    expect(readers).toHaveLength(3);
    for (const n of readers) {
      expect(n).toContain('FROM public.member_record_daily_facts f');
      expect(n).toContain(
        "f.accounting_cutoff IS NOT DISTINCT FROM public.fn_ca_launch_accounting_cutoff('club',p_club_id)"
      );
      expect(n).toContain('SUM(f.net) FILTER (WHERE NOT f.is_mtt) cash_net');
      expect(n).toContain('FROM public.ca_club_member_fee_totals(p_club_id,v_start,v_end) t');
      expect(n).not.toContain('union_rake_paid_daily_user');
      expect(n).not.toContain('club_rake_daily_user');
      expect(n).not.toContain('club_member_daily_stats');
      // Tournament money was already equal on both sides and stays where it was.
      expect(n).toContain('SUM(d.tournament_net) tournament_net');
    }
  });

  it('replaces only the reading CTEs, ending before the unchanged merged set', () => {
    // Each source appears twice in its exactly-once count, then in its replace.
    const readers = OLD.filter((o) => o.includes('wallet_pnl AS ('));
    expect(readers).toHaveLength(9);
    for (const o of readers) {
      expect(o.startsWith('  ), wallet_pnl AS (')).toBe(true);
      expect(o).toContain('union_rake_paid_daily_user');
      expect(o).not.toContain('merged AS MATERIALIZED');
    }
  });

  it('reports fees as complete through the end of the range, since they are now live', () => {
    expect(OLD).toContain("'rake_complete_through',LEAST(v_end,v_today-1),");
    expect(NEW).toContain("'rake_complete_through',v_end,");
  });
});
