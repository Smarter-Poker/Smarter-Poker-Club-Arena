import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isLibraryAvatarUrl } from '../../src/services/AvatarService';

/**
 * Dan 2026-08-21: "they can now only use avatars."
 *
 * The reason this is a test and not just a code review note: removing the
 * Upload tab and the "Use Profile Photo" button is an affordance change, and
 * an affordance is not a rule. `setUserAvatar` used to accept ANY string, so a
 * cached bundle, the console, the Hub, or a future feature could still write a
 * photograph into profiles.avatar_url. The guard is the rule; these are the
 * cases it has to get right.
 */

const CA = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('library-only avatar guard', () => {
  it('accepts library art in every shape the Hub sends it', () => {
    expect(isLibraryAvatarUrl('/avatars/table/vip_alien@2x.webp')).toBe(true);
    expect(isLibraryAvatarUrl('/avatars/free/cowboy.png')).toBe(true);
    expect(isLibraryAvatarUrl('https://smarter.poker/avatars/table/free_chef.webp')).toBe(true);
  });

  it('accepts AI-generated custom art', () => {
    // Generated from a TEXT PROMPT. Not a photograph — and the photo-likeness
    // route that could have turned a selfie into one is deleted in the Hub.
    expect(
      isLibraryAvatarUrl(
        'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/custom-avatars/generated/u1/a.png'
      )
    ).toBe(true);
  });

  it('accepts the generated monogram fallback', () => {
    // Drawn locally from initials; contains no user image at all.
    expect(isLibraryAvatarUrl('data:image/svg+xml;utf8,<svg/>')).toBe(true);
  });

  it('REFUSES every shape a profile picture could arrive in', () => {
    // 1. Club Arena's old upload bucket.
    expect(
      isLibraryAvatarUrl(
        'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/avatars/u1/avatar-1.jpg'
      ),
      'Club Arena storage upload must be refused'
    ).toBe(false);

    // 2. The Hub's upload path.
    expect(
      isLibraryAvatarUrl(
        'https://kuklfnapbkmacvwxktbh.supabase.co/storage/v1/object/public/social-media/avatars/u1/p.jpg'
      ),
      'Hub storage upload must be refused'
    ).toBe(false);

    // 3. The OAuth provider photo — what "Use Profile Photo" wrote. Not an
    //    upload at all, which is exactly why removing the upload tab alone
    //    would not have closed this.
    expect(
      isLibraryAvatarUrl('https://lh3.googleusercontent.com/a/ACg8ocK=s96-c'),
      'Google OAuth photo must be refused'
    ).toBe(false);

    // 4. Anything else someone points at.
    expect(isLibraryAvatarUrl('https://example.com/me.jpg')).toBe(false);
    expect(isLibraryAvatarUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe(false);
    expect(isLibraryAvatarUrl('')).toBe(false);
  });

  it('does not mistake a bucket NAMED avatars for library art', () => {
    // The upload bucket is literally called `avatars`, so a naive
    // `url.includes('/avatars/')` would have let every upload straight through.
    // The guard anchors on the PATH ROOT, which is what makes these differ.
    expect(isLibraryAvatarUrl('/avatars/table/vip_x.webp')).toBe(true);
    expect(isLibraryAvatarUrl('https://host/storage/v1/object/public/avatars/u1/x.jpg')).toBe(
      false
    );
  });

  it('has no photo-upload affordance left in the client', () => {
    // Belt to the guard's braces: the UI must not offer something the service
    // will refuse, or players get a button that silently does nothing.
    const gallery = CA('src/components/customization/AvatarGallery.tsx');
    expect(gallery, 'file input still present').not.toMatch(/<input[^>]*type=["']file/);
    expect(gallery, 'upload tab still present').not.toMatch(/setActiveTab\(['"]upload['"]\)/);
    const service = CA('src/services/AvatarService.ts');
    expect(service, 'uploadAvatar still callable').not.toMatch(/async uploadAvatar\s*\(/);
    expect(service, 'getProfilePhotoUrl still callable').not.toMatch(
      /async getProfilePhotoUrl\s*\(/
    );
  });

  it('runs the guard AFTER normalisation, not before', () => {
    // Order matters and is easy to get backwards. `/avatars/vip/x.png` and
    // `social-media/avatars/vip_x.png` are both legitimate ways of naming
    // library art and both become `/avatars/table/...` in normalizeAvatarUrl.
    // Guarding first would reject the very paths the Hub sends.
    const service = CA('src/services/AvatarService.ts');
    const normalise = service.indexOf('avatarUrl = normalizeAvatarUrl(avatarUrl)');
    const guard = service.indexOf('if (!isLibraryAvatarUrl(avatarUrl))');
    expect(normalise).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard, 'guard must run after normalisation').toBeGreaterThan(normalise);
  });
});
