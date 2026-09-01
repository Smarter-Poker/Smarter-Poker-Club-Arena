import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260901090000_club_card_human_realtime_stats.sql'),
  'utf8'
);
const orchestrator = readFileSync(
  resolve(__dirname, '../src/services/HorseOrchestrator.ts'),
  'utf8'
);

describe('Club membership provenance', () => {
  it('blocks every membership insert outside Join A Club or owner creation', () => {
    expect(sql).toContain('trg_club_members_require_explicit_join');
    expect(sql).toContain('MEMBERSHIP_REQUIRES_JOIN');
    expect(sql).toContain("v_source NOT IN ('join_club', 'club_owner_create')");
  });

  it('turns wallet assurance into an existence check rather than an insert', () => {
    const ensure = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ensure_club_wallet'),
      sql.indexOf('-- A seat may identify')
    );
    expect(ensure).toContain('SELECT EXISTS');
    expect(ensure).not.toContain('INSERT INTO');
  });

  it('does not batch-enroll the horse fleet as club members', () => {
    expect(orchestrator).not.toContain('ensureHorsesInBothClubs');
    expect(orchestrator).not.toMatch(/from\(['"]club_members['"]\)\s*\.(?:insert|upsert)/);
  });

  it('keeps live-seat cleanup out of the schema transaction', () => {
    expect(sql).not.toContain('DELETE FROM public.table_seats');
    expect(sql).not.toContain('DELETE FROM public.club_members');
    expect(sql).toContain('stored count/level %/% disagrees with real-time %/%');
  });
});
