import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  changed: vi.fn(),
  setUserAvatar: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/services/SoundService', () => ({
  haptic: { light: vi.fn(), medium: vi.fn() },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
}));
vi.mock('../../src/services/AvatarService', () => ({
  avatarService: {
    getAvatarLibraryResult: vi.fn().mockResolvedValue({
      avatars: [
        {
          id: 'free-people-001',
          name: 'Club Captain',
          imageUrl: 'https://example.test/captain.png',
          thumbUrl: 'https://example.test/captain-thumb.png',
          category: 'free',
        },
        {
          id: 'free-animal-001',
          name: 'Card Shark',
          imageUrl: 'https://example.test/shark.png',
          thumbUrl: 'https://example.test/shark-thumb.png',
          category: 'free',
        },
      ],
      presetsFailed: false,
      customFailed: false,
    }),
    getCosmeticCatalog: vi.fn().mockResolvedValue({ cosmetics: [], ok: true }),
    getCosmetics: vi.fn().mockResolvedValue({ frame: null, aura: null, ok: true }),
    setUserAvatar: mocks.setUserAvatar,
    setCosmetics: vi.fn().mockResolvedValue({ ok: true }),
    openAvatarSelector: vi.fn(),
  },
}));

import { AvatarGallery } from '../../src/components/customization/AvatarGallery';

function renderGallery() {
  return render(
    <AvatarGallery
      isOpen
      onClose={mocks.close}
      userId="user-1"
      currentAvatarUrl="https://example.test/current.png"
      onAvatarChanged={mocks.changed}
    />
  );
}

describe('Avatar Gallery mobile interaction contract', () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.changed.mockReset();
    mocks.setUserAvatar.mockReset();
    mocks.setUserAvatar.mockResolvedValue(true);
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    document.body.style.overflow = '';
  });

  it('uses a trapped modal, semantic tabs, search, and semantic avatar buttons', async () => {
    renderGallery();
    expect(screen.getByRole('dialog', { name: 'Avatar Gallery' })).toBeVisible();
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('tab', { name: /Presets/ })).toHaveAttribute('aria-selected', 'true');

    const captain = await screen.findByRole('button', { name: 'Club Captain' });
    expect(captain).toHaveAttribute('aria-pressed', 'false');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Avatars' }), {
      target: { value: 'shark' },
    });
    expect(screen.queryByRole('button', { name: 'Club Captain' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Card Shark' })).toBeVisible();
  });

  it('applies a tapped avatar immediately and keeps Done honest', async () => {
    renderGallery();
    fireEvent.click(await screen.findByRole('button', { name: 'Club Captain' }));

    await waitFor(() =>
      expect(mocks.setUserAvatar).toHaveBeenCalledWith('user-1', 'https://example.test/captain.png')
    );
    expect(mocks.changed).toHaveBeenCalledWith('https://example.test/captain.png');
    expect(await screen.findByRole('button', { name: 'Done · Avatar Applied' })).toBeEnabled();
  });

  it('supports arrow-key tab movement and Escape restores modal control', async () => {
    renderGallery();
    await screen.findByRole('button', { name: 'Club Captain' });
    const presets = screen.getByRole('tab', { name: /Presets/ });
    presets.focus();
    fireEvent.keyDown(presets, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /VIP/ })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
