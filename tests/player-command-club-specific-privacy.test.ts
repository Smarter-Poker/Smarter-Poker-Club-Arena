import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260901090000_club_card_human_realtime_stats.sql'),
  'utf8'
);

describe('Player Command club-specific privacy', () => {
  it('requires same-club staff or recursive downline access for sensitive data', () => {
    expect(sql).toContain('actor.club_id = p_club_id');
    expect(sql).toContain("actor.role IN ('super_agent','agent','sub_agent')");
    expect(sql).toContain("RETURN 'identity'");
  });

  it('uses club-attributed facts instead of lifetime fee totals', () => {
    expect(sql).toContain('FROM public.ca_hand_facts r');
    expect(sql).toContain('r.club_id = p_club_id');
    expect(sql).toContain('Player Command still exposes an unscoped financial source');
  });

  it('scopes member and agent wallets to the current club', () => {
    expect(sql).toContain("v_def := replace(v_def, '= ANY(v_scope)', '= p_club_id')");
    expect(sql).toContain('ct.club_id = p_club_id');
  });
});
