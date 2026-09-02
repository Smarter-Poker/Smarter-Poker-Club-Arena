import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), emit: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));

import { clubMessageManagementService } from '../../src/services/ClubMessageManagementService';

describe('ClubMessageManagementService version authority', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.emit.mockReset();
  });

  it('requires revision-bearing identity and announcement snapshots', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        identity: { tagline: 'Sharks', lobby_message: 'Welcome', description: 'Play fair.' },
        identity_revision: 6,
        announcements: [
          {
            id: 'a-1',
            title: 'Tonight',
            content: 'Main event at eight.',
            is_pinned: true,
            is_active: true,
            created_at: '2026-09-01T10:00:00Z',
            updated_at: '2026-09-01T11:00:00Z',
            revision: 3,
          },
        ],
      },
      error: null,
    });

    await expect(clubMessageManagementService.get('club-1')).resolves.toEqual({
      identity: { tagline: 'Sharks', lobbyMessage: 'Welcome', description: 'Play fair.' },
      identityRevision: 6,
      announcements: [
        expect.objectContaining({ id: 'a-1', revision: 3, updatedAt: '2026-09-01T11:00:00Z' }),
      ],
    });
  });

  it('rejects a snapshot without concurrency evidence', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, identity: {}, announcements: [] },
      error: null,
    });

    await expect(clubMessageManagementService.get('club-1')).rejects.toMatchObject({
      reason: 'invalid_payload',
    });
  });

  it('saves identity with compare-and-swap and adopts the returned normalization', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        revision: 10,
        identity: { tagline: 'Night Owls', lobby_message: 'Doors Open', description: 'Welcome.' },
      },
      error: null,
    });

    await expect(
      clubMessageManagementService.saveIdentity(
        'club-1',
        { tagline: ' Night Owls ', lobbyMessage: 'Doors Open', description: 'Welcome.' },
        9
      )
    ).resolves.toEqual({
      identity: { tagline: 'Night Owls', lobbyMessage: 'Doors Open', description: 'Welcome.' },
      revision: 10,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      'fn_save_club_identity_messages_versioned',
      expect.objectContaining({ p_expected_revision: 9 })
    );
    expect(mocks.emit).toHaveBeenCalledWith('CLUB_UPDATED', { clubId: 'club-1' });
  });

  it('keeps a stale announcement mutation rejected and emits no false realtime success', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, reason: 'version_conflict', current_revision: 5 },
      error: null,
    });

    await expect(
      clubMessageManagementService.manageAnnouncement(
        'club-1',
        'set_active',
        { id: 'a-1', isActive: false },
        4
      )
    ).rejects.toMatchObject({ reason: 'version_conflict', currentRevision: 5 });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('uses revision zero only for a new announcement', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, id: 'a-new', revision: 1 },
      error: null,
    });

    await expect(
      clubMessageManagementService.manageAnnouncement(
        'club-1',
        'save',
        { title: 'New', content: 'Message' },
        0
      )
    ).resolves.toEqual({ id: 'a-new', revision: 1 });
    expect(mocks.rpc).toHaveBeenCalledWith(
      'fn_manage_club_announcement_versioned',
      expect.objectContaining({ p_expected_revision: 0, p_announcement_id: null })
    );
  });
});
