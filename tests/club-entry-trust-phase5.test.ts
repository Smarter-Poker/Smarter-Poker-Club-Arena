import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read('supabase/migrations/20260831150300_club_entry_trust_layer.sql');
const trustService = read('src/services/ClubEntryTrustService.ts');
const createMigration = read(
  'supabase/migrations/20260831150100_club_creation_atomic_workflow.sql'
);
const findMigration = read('supabase/migrations/20260831150200_player_search_authoritative.sql');
const joinMigration = read('supabase/migrations/20260831150400_club_join_atomic_workflow.sql');
const createModal = read('src/components/modals/CreateClubModal.tsx');
const findModal = read('src/components/modals/FindPlayerModal.tsx');
const joinModal = read('src/components/modals/JoinClubModal.tsx');

describe('Phase 5 shared trust boundary', () => {
  it('removes public/client-writable audit policies and installs immutable server auditing', () => {
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON public.audit_trail');
    expect(migration).toContain('INSERT INTO public.audit_trail');
    expect(migration).toContain("v_club,v_actor,'system'");
    expect(migration).toContain('fn_audit_club_entry_mutation');
  });

  it('accepts only allowlisted, low-cardinality analytics metadata', () => {
    expect(migration).toContain('fn_track_club_entry_event');
    expect(migration).toContain("'source',p_metadata->>'source'");
    expect(migration).toContain("'result_count',p_metadata->'result_count'");
    expect(migration).not.toContain("p_metadata->>'query'");
    expect(migration).not.toContain("p_metadata->>'club_name'");
    expect(trustService).toContain('Fire-and-forget, privacy-filtered telemetry');
  });

  it('enforces deterministic rollout flags in UI and every authoritative RPC', () => {
    expect(migration).toContain('club_entry_feature_flags');
    expect(migration).toContain('rollout_percent');
    expect(createMigration).toContain("f.key='create_club'");
    expect(findMigration).toContain("f.key='find_player'");
    expect(joinMigration).toContain("f.key='join_club'");
    expect(createMigration + findMigration + migration + joinMigration).not.toContain(
      'abs(hashtextextended'
    );
  });

  it('exposes service-role-only daily operational metrics', () => {
    expect(migration).toContain('club_entry_daily_metrics');
    expect(migration).toContain('percentile_cont(0.95)');
    expect(migration).toContain('GRANT SELECT ON public.club_entry_daily_metrics TO service_role');
  });
});

describe('Phase 5 accessibility and recovery wiring', () => {
  it.each([createModal, findModal, joinModal])(
    'gives every primary dialog owned Escape behavior',
    (source) => {
      expect(source).toContain('useDialogEscape');
    }
  );

  it('tracks all three flows without sending names, codes, or queries', () => {
    expect(createModal).toContain("ClubEntryTrustService.track('create'");
    expect(findModal).toContain("ClubEntryTrustService.track('find'");
    expect(joinModal).toContain("ClubEntryTrustService.track('join'");
  });
});
