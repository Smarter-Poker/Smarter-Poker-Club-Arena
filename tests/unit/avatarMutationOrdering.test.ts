import { beforeEach, describe, expect, it, vi } from 'vitest';

const profileRows: Record<string, unknown>[] = [];
const profileWrites: Array<Promise<{ error: unknown }>> = [];

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          update: (row: Record<string, unknown>) => ({
            eq: () => {
              profileRows.push(row);
              return profileWrites.shift() ?? Promise.resolve({ error: null });
            },
          }),
        };
      }
      return {
        upsert: () => Promise.resolve({ error: null }),
      };
    },
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: vi.fn(),
  reportWarning: vi.fn(),
}));

import { avatarService } from '../../src/services/AvatarService';

beforeEach(() => {
  profileRows.length = 0;
  profileWrites.length = 0;
  (avatarService as any)._avatarWriteTails.clear();
});

describe('avatar mutation ordering', () => {
  it('persists the current Hub WebP catalog path as retina table art', async () => {
    await expect(avatarService.setUserAvatar('user-1', '/avatars/free/shark.webp')).resolves.toBe(
      true
    );

    expect(profileRows).toEqual([{ arena_avatar_url: '/avatars/table/free_shark@2x.webp' }]);
  });

  it('persists rapid avatar choices in tap order', async () => {
    let resolveFirst: ((value: { error: null }) => void) | undefined;
    profileWrites.push(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
      Promise.resolve({ error: null })
    );

    const first = avatarService.setUserAvatar('user-1', '/avatars/table/first.webp');
    const second = avatarService.setUserAvatar('user-1', '/avatars/table/second.webp');
    await Promise.resolve();

    expect(profileRows).toEqual([{ arena_avatar_url: '/avatars/table/first.webp' }]);
    resolveFirst?.({ error: null });
    await Promise.all([first, second]);

    expect(profileRows).toEqual([
      { arena_avatar_url: '/avatars/table/first.webp' },
      { arena_avatar_url: '/avatars/table/second.webp' },
    ]);
  });
});
