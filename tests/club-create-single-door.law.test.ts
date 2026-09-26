import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260926165000_club_creation_has_one_atomic_door.sql'),
  'utf8'
);

describe('club creation has one atomic door', () => {
  it('removes browser table insertion without removing the authenticated RPC', () => {
    expect(sql).toContain('REVOKE INSERT ON TABLE public.clubs FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('DROP POLICY IF EXISTS "Authenticated users can create clubs"');
    expect(sql).toContain("has_table_privilege('authenticated', 'public.clubs', 'INSERT')");
    expect(sql).toContain('public.fn_create_club_atomic(uuid,text,text,text,boolean,boolean,text)');
    expect(sql).toContain('REVOKE UPDATE ON TABLE public.clubs FROM PUBLIC, anon, authenticated;');
    expect(sql).toMatch(
      /GRANT UPDATE \([\s\S]*name,[\s\S]*logo_url,[\s\S]*settings,[\s\S]*\) ON TABLE public\.clubs TO authenticated;/
    );
    for (const protectedColumn of [
      'chip_treasury',
      'chip_pool',
      'promo_balance',
      'insurance_balance',
      'is_union',
      'union_id',
      'opening_checklist_started_at',
    ]) {
      expect(sql).toContain(`'${protectedColumn}', 'UPDATE'`);
    }
  });

  it('is bounded DDL and moves no club or chip data', () => {
    expect(sql).toContain("SET LOCAL lock_timeout = '15s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s';");
    expect(sql).not.toMatch(/^\s*(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/im);
  });
});
