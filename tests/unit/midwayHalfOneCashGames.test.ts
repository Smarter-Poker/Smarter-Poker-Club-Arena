import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cashGameCategoryKey,
  MIDWAY_CASH_HOST_ID,
  stakesRungTaken,
  type CashTemplate,
} from '../../src/config/cashGames';

const variants = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'];
describe('Midway half/one addition', () => {
  it('the database index and trigger use the same narrowly scoped category', () => {
    const sql = readFileSync(
      'supabase/migrations/20261020204148_midway_half_one_cash_games.sql',
      'utf8'
    );
    expect(sql).toContain(MIDWAY_CASH_HOST_ID);
    expect(sql).toContain("p_variant IN ('nlh','plo4','plo5','plo6','plo8')");
    expect(sql).toContain("p_sb = 0.50 AND p_bb = 1.00 THEN 'half_one'");
    expect(sql).toContain('ELSE public.fn_cash_stake_band(p_bb) END');
    expect(sql).toContain('public.fn_cash_game_category_key(club_id, variant, sb, bb)');
    expect(sql).toContain('public.fn_cash_game_category_key(g.club_id,g.variant,g.sb,g.bb)');
    expect(sql).toContain(
      'public.fn_cash_game_category_key(NEW.club_id,NEW.variant,NEW.sb,NEW.bb)'
    );
    expect(sql.indexOf('CREATE UNIQUE INDEX')).toBeLessThan(sql.indexOf('DROP INDEX'));
    expect(sql).toContain('enabled,template_name,variant,sb,bb,club_id');
    expect(sql).not.toMatch(/UPDATE public\.(club_members|table_seats|cash_games)/);
  });
  it.each(variants)('%s can coexist with one/two in all styles', (variant) => {
    for (const template of ['classic', 'action', 'madness'] as CashTemplate[]) {
      const oneTwo = {
        name: 'Existing',
        template_name: template,
        variant,
        sb: 1,
        bb: 2,
        must_move: true,
      };
      expect(
        stakesRungTaken([oneTwo], template, variant, 0.5, 1, true, MIDWAY_CASH_HOST_ID)
      ).toBeNull();
      const halfOne = { ...oneTwo, sb: 0.5, bb: 1 };
      expect(
        stakesRungTaken([halfOne], template, variant, 0.5, 1, true, MIDWAY_CASH_HOST_ID)
      ).not.toBeNull();
      expect(
        stakesRungTaken([halfOne], template, variant, 1, 2, true, MIDWAY_CASH_HOST_ID)
      ).toBeNull();
    }
  });
  it('preserves all other categories and hosts', () => {
    expect(cashGameCategoryKey('other', 'nlh', 0.5, 1)).toBe('low');
    expect(cashGameCategoryKey(MIDWAY_CASH_HOST_ID, 'flh', 0.5, 1)).toBe('low');
    expect(cashGameCategoryKey(MIDWAY_CASH_HOST_ID, 'nlh', 1, 2)).toBe('low');
    expect(cashGameCategoryKey(MIDWAY_CASH_HOST_ID, 'nlh', 0.25, 0.5)).toBe('micro');
    const oneTwo = {
      name: 'Existing',
      template_name: 'action',
      variant: 'nlh',
      sb: 1,
      bb: 2,
      must_move: true,
    };
    expect(stakesRungTaken([oneTwo], 'action', 'nlh', 0.5, 1, true, 'other')).not.toBeNull();
  });
});
