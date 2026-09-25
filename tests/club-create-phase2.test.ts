import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { optimizeClubLogo } from '../src/utils/clubLogoImage';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read('supabase/migrations/20260831150100_club_creation_atomic_workflow.sql');
const auditMigration = read(
  'supabase/migrations/20260831140909_club_entry_four_phase_audit_fixes.sql'
);
/** The current authority for the cap: one number, one count, one lock. */
const capMigration = read(
  'supabase/migrations/20260922153234_one_club_membership_cap_one_count_one_lock.sql'
);
const service = read('src/services/ClubsService.ts');
const modal = read('src/components/modals/CreateClubModal.tsx');
const deadJoinRequestRepair = read(
  'supabase/migrations/20260831163500_remove_dead_club_join_requests_dependency.sql'
);

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
    expect(auditMigration).toContain("status IN ('active', 'approved')");
    expect(auditMigration).toContain('v_memberships >= 4');
    expect(auditMigration).not.toContain('is_horse');
  });

  it('the current create path counts and locks through the one cap authority', () => {
    // The two files above are history: they installed a literal 4, which
    // 20260908125235 raised to 10 in place. The create path now takes the
    // player lock, the count and the cap from the shared helpers.
    expect(capMigration).toContain('SELECT 10');
    expect(capMigration).toContain(
      '$create_count_new$  v_memberships := public.fn_club_membership_count(v_uid);\n  IF v_memberships >= public.fn_club_membership_cap() THEN'
    );
    expect(capMigration).toContain(
      '$create_lock_new$  PERFORM public.fn_club_membership_lock(v_uid);'
    );
    expect(capMigration).toContain(
      '$create_flag_new$  IF NOT public.fn_club_creation_open(v_uid) THEN'
    );
    expect(capMigration).toContain("USING ERRCODE = '23514'");
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

  it('does not let the retired join-request shadow table roll back club creation', () => {
    expect(deadJoinRequestRepair).toContain(
      'DROP TRIGGER IF EXISTS trg_sync_club_join_request ON public.club_members'
    );
    expect(deadJoinRequestRepair).toContain(
      'DROP FUNCTION IF EXISTS public.fn_sync_club_join_request()'
    );
    expect(deadJoinRequestRepair).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM) public\.club_join_requests/
    );
    expect(deadJoinRequestRepair).toContain("status = 'pending'");
  });
});

describe('Phase 2 create experience', () => {
  it('restores drafts and checks allowance plus exact name availability', () => {
    expect(modal).toContain('CREATE_DRAFT_KEY');
    expect(modal).toContain('creationRequestIdRef');
    expect(modal).toContain('request_id: creationRequestIdRef.current');
    expect(modal).toContain('Draft Restored');
    expect(modal).toContain('ClubsService.checkNameAvailability');
    expect(modal).toContain('ClubsService.getCreationEligibility');
    // The allowance line is the server's cap and reason, never a number here.
    expect(modal).toContain('allowance.maxClubs.toLocaleString()');
    expect(modal).toContain("allowance.reason === 'creation_unavailable'");
    expect(modal).not.toMatch(/four-club/i);
  });

  it('exposes launch settings and a reviewable description', () => {
    expect(modal).toContain('Launch Settings');
    expect(modal).toContain('Discoverable In Club Arena');
    expect(modal).toContain('Review Join Requests');
    expect(modal).toContain('new-club-description');
  });

  it('decodes, center-crops, and normalizes logos to a 512px WEBP', async () => {
    const close = vi.fn();
    const bitmap = { width: 1200, height: 800, close } as ImageBitmap;
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback, type?: string) => {
      callback(new Blob(['optimized-logo'], { type }));
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob,
    } as unknown as HTMLCanvasElement;
    const originalCreateElement = document.createElement.bind(document);

    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(document, 'createElement').mockImplementation((tagName, options) =>
      tagName === 'canvas' ? canvas : originalCreateElement(tagName, options)
    );

    const file = new File(['source-logo'], 'club.png', { type: 'image/png' });
    const result = await optimizeClubLogo(file);

    expect(createImageBitmap).toHaveBeenCalledWith(file);
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 200, 0, 800, 800, 0, 0, 512, 512);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.88);
    expect(close).toHaveBeenCalledOnce();
    expect(result).toMatch(/^data:image\/webp;base64,/);
    expect(modal).toContain('optimizeClubLogo(file)');
    expect(modal).toContain('image/png,image/jpeg,image/webp');

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects unsupported or oversized source images before decoding', async () => {
    await expect(
      optimizeClubLogo(new File(['vector'], 'club.svg', { type: 'image/svg+xml' }))
    ).rejects.toThrow('Choose a PNG, JPG, or WEBP image.');

    const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'club.png', {
      type: 'image/png',
    });
    await expect(optimizeClubLogo(oversized)).rejects.toThrow(
      'The source image must be 5MB or smaller.'
    );
  });
});
