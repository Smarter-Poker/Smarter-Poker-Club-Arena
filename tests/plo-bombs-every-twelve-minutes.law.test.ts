import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bombCadenceLabel, type CashBombTrigger } from '../src/config/cashGames';

const sql = readFileSync(
  'supabase/migrations/20261028202604_plo_bomb_pots_every_twelve_minutes.sql',
  'utf8'
);
const patches = JSON.parse(sql.split('$patches$')[1]) as Array<{
  fn: string;
  md5: string;
  edits: Array<[string, string]>;
}>;

describe('PLO bomb pots use twelve minutes (owner 2026-10-28)', () => {
  it('prints the same promise from the stored token', () => {
    const cadence: CashBombTrigger = 'timed_12m';
    expect(bombCadenceLabel(cadence)).toBe('Every 12 Minutes');
    expect(bombCadenceLabel(cadence, true)).toBe('Every 12 Min');
    expect(bombCadenceLabel('timed_10m')).toBe('Every 10 Minutes');
  });

  it('changes the template, creator validation, current-table and new-table owners together', () => {
    expect(patches.map((p) => p.fn)).toEqual(
      expect.arrayContaining([
        'public.fn_cash_template_defaults(text,text)',
        'public.fn_cash_apply_ruleset(uuid)',
        'public.fn_cash_cluster_open_table(uuid,text,integer,text,uuid)',
        'public.fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)',
      ])
    );
    for (const patch of patches) {
      expect(patch.md5).toMatch(/^[a-f0-9]{32}$/);
      expect(patch.edits.some(([, next]) => next.includes('timed_12m'))).toBe(true);
      if (/apply_ruleset|open_table/.test(patch.fn)) {
        expect(
          patch.edits.some(([, next]) =>
            next.includes("WHEN v_bomb_trigger = 'timed_12m' THEN 720")
          )
        ).toBe(true);
      }
    }
    expect(patches[0].edits[0][1]).toContain("WHEN t='classic' THEN NULL");
    expect(patches[0].edits[0][1]).toContain("WHEN v IN ('plo4','plo5','plo6','plo8')");
    expect(patches[0].edits[0][1]).toContain("ELSE 'timed_10m'");
  });

  it('updates open PLO configuration without resetting an owed bomb or changing money', () => {
    expect(sql).toContain('g.closed_at IS NULL');
    expect(sql).toContain("coalesce(c.lifecycle_status,'')<>'retired'");
    expect(sql).toContain("t.lifecycle<>'closed'");
    expect(sql).toContain('bomb_pot_interval_seconds=720');
    expect(sql).toContain('PLO_CADENCE_SOURCE_CHANGED');
    expect(sql).toContain('PLO_CADENCE_PROJECTION_FAILED');
    expect(sql).not.toMatch(
      /SET\s+(?:bomb_pot_sched_state|bomb_pot_next_due_at|stack|chip_balance)/i
    );
  });
});
