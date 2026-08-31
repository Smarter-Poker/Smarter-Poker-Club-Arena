import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read('supabase/migrations/20260831150100_club_creation_atomic_workflow.sql');
const service = read('src/services/ClubsService.ts');
const modal = read('src/components/modals/CreateClubModal.tsx');
const imageUtility = read('src/utils/clubLogoImage.ts');

describe('Phase 2 atomic club creation', () => {
  it('commits the club, owner membership, and idempotency record in one RPC', () => {
    expect(migration).toContain('fn_create_club_atomic');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toMatch(/INSERT INTO public\.clubs[\s\S]*INSERT INTO public\.club_members/);
    expect(migration).toContain('club_creation_requests');
    expect(migration).toContain('PRIMARY KEY (user_id, request_id)');
  });

  it('keeps authority and limits at the server boundary', () => {
    expect(migration).toContain('v_uid uuid := auth.uid()');
    expect(migration).toContain("status IN ('active', 'approved')");
    expect(migration).toContain('v_memberships >= 4');
    expect(migration).toContain('fn_club_name_available');
    expect(migration).toContain('TO authenticated');
  });

  it('uses the atomic RPC and cleans the pre-transaction logo on failure', () => {
    expect(service).toContain("supabase.rpc('fn_create_club_atomic'");
    expect(service).toContain('p_request_id: requestId');
    expect(service).toContain('clubData.request_id || crypto.randomUUID()');
    expect(service).toContain('upsert: true');
    expect(service).toContain('definitiveRejection');
    expect(service).toContain('OrphanLogoCleanup');
    expect(service).not.toMatch(/\.from\('clubs'\)\s*\.insert/);
  });
});

describe('Phase 2 create experience', () => {
  it('restores drafts and checks allowance plus exact name availability', () => {
    expect(modal).toContain('CREATE_DRAFT_KEY');
    expect(modal).toContain('creationRequestIdRef');
    expect(modal).toContain('request_id: creationRequestIdRef.current');
    expect(modal).toContain('Draft restored');
    expect(modal).toContain('ClubsService.checkNameAvailability');
    expect(modal).toContain('ClubsService.getCreationEligibility');
  });

  it('exposes launch settings and a reviewable description', () => {
    expect(modal).toContain('Launch Settings');
    expect(modal).toContain('Discoverable in Club Arena');
    expect(modal).toContain('Review join requests');
    expect(modal).toContain('new-club-description');
  });

  it('decodes and normalizes logos before upload', () => {
    expect(imageUtility).toContain('createImageBitmap(file)');
    expect(imageUtility).toContain("'image/webp'");
    expect(imageUtility).toContain('MAX_OUTPUT_BYTES');
    expect(modal).toContain('optimizeClubLogo(file)');
    expect(modal).toContain('image/png,image/jpeg,image/webp');
  });
});
