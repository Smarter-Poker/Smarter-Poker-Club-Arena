import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');
const indexMigration = read(
  'supabase/migrations/20260906144259_phase_4_game_management_health_scope_index.sql'
);
const recertification = read(
  'supabase/migrations/20260906144315_phase_4_realtime_access_and_health_recertified.sql'
);
const unionTrigger = read(
  'supabase/migrations/20260906144333_phase_4_union_membership_reassignments_invalidate.sql'
);
const ownerTrigger = read(
  'supabase/migrations/20260906144804_phase_4_club_ownership_invalidates_access.sql'
);

describe('Table Management Phase 4 recertification', () => {
  it('keeps the health window on a scope-and-time covering index', () => {
    expect(indexMigration).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(indexMigration).toContain('idx_game_management_events_scope_created_cover');
    expect(indexMigration).toContain('(scope_kind, scope_id, created_at DESC)');
    expect(indexMigration).toContain('INCLUDE (sequence, event_type)');
    expect(indexMigration).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/);

    expect(recertification).toContain("e.created_at>=now()-interval '24 hours'");
    expect(recertification).toContain('ORDER BY e.sequence DESC');
    expect(recertification).not.toContain('INTO v_result FROM public.game_management_events e');
  });

  it('invalidates both sides of reassigned access rows', () => {
    expect(recertification).toContain(
      "jsonb_build_object('operation', v_operation, 'side', 'before')"
    );
    expect(recertification).toContain(
      "jsonb_build_object('operation', v_operation, 'side', 'after')"
    );
    expect(unionTrigger).toContain('AFTER UPDATE OF union_id, club_id ON public.union_clubs');
    expect(recertification).toContain('OLD.user_id');
    expect(recertification).toContain('NEW.user_id');
  });

  it('treats club ownership as management authority and filters non-operators', () => {
    expect(ownerTrigger).toContain('AFTER UPDATE OF owner_id ON public.clubs');
    expect(recertification).toContain("m.role IN ('owner','co_owner','admin')");
    expect(recertification).toContain("m.status IN ('active','approved')");
    expect(recertification).toContain('COALESCE(m.is_active, true)');
    expect(recertification).not.toContain("m.role IN ('owner','co_owner','admin','host')");
  });

  it('does not turn metadata-only writes into content changes or audit noise', () => {
    expect(recertification).toContain("to_jsonb(NEW) - ARRAY['updated_at','revision']");
    expect(recertification).toContain("to_jsonb(NEW) - ARRAY['updated_at','management_revision']");
    expect(recertification).toContain('NEW.tagline IS NOT DISTINCT FROM OLD.tagline');
  });

  it('preserves function privilege boundaries and transaction atomicity', () => {
    expect(recertification).toMatch(/BEGIN;[\s\S]*COMMIT;/);
    expect(recertification).toContain(
      'REVOKE ALL ON FUNCTION public.fn_emit_management_access_event() FROM PUBLIC,anon,authenticated'
    );
    expect(recertification).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_get_game_management_health(text,uuid) TO authenticated,service_role'
    );
  });
});
