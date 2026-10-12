import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  changed: vi.fn(),
  setUserAvatar: vi.fn(),
  setCosmetics: vi.fn(),
  getCosmeticCatalog: vi.fn(),
  getCosmetics: vi.fn(),
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
        {
          id: 'vip-animal-001',
          name: 'Wolf Enforcer',
          imageUrl: 'https://example.test/wolf.png',
          thumbUrl: 'https://example.test/wolf-thumb.png',
          category: 'vip',
          isOwned: false,
        },
      ],
      presetsFailed: false,
      customFailed: false,
    }),
    getCosmeticCatalog: mocks.getCosmeticCatalog,
    getCosmetics: mocks.getCosmetics,
    setUserAvatar: mocks.setUserAvatar,
    setCosmetics: mocks.setCosmetics,
    openAvatarSelector: vi.fn(),
  },
}));

import { AvatarGallery } from '../../src/components/customization/AvatarGallery';
import { ALL_COSMETICS } from '../../src/cosmetics/avatarCosmetics';

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
    mocks.setCosmetics.mockReset();
    mocks.setCosmetics.mockResolvedValue({ ok: true });
    mocks.getCosmeticCatalog.mockReset();
    mocks.getCosmeticCatalog.mockResolvedValue({
      cosmetics: ALL_COSMETICS.map((cosmetic) => ({ ...cosmetic, isOwned: true })),
      ok: true,
    });
    mocks.getCosmetics.mockReset();
    mocks.getCosmetics.mockResolvedValue({ frame: null, aura: null, ok: true });
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

  it('describes a locked premium avatar through every real entitlement path', async () => {
    renderGallery();
    fireEvent.click(await screen.findByRole('tab', { name: /VIP/ }));

    const lockedWolf = screen.getByRole('button', {
      name: 'Wolf Enforcer, Premium; Active VIP, Club-Shop, Or Reward Unlock Required',
    });
    expect(lockedWolf).toHaveAttribute(
      'title',
      'Wolf Enforcer (Active VIP, Club-Shop, Or Reward Unlock Required)'
    );
    expect(screen.getByText('Premium')).toBeVisible();

    fireEvent.click(lockedWolf);
    expect(
      screen.getByText(
        'This Premium Avatar Requires Active VIP, A Club-Shop Purchase, Or A Reward Unlock.'
      )
    ).toBeVisible();
    expect(mocks.setUserAvatar).not.toHaveBeenCalled();
  });

  it('offers ten frame designs, ten aura designs, and a None tile for each', async () => {
    renderGallery();
    const styleTab = await screen.findByRole('tab', { name: 'Style (20)' });
    fireEvent.click(styleTab);

    expect(screen.getByRole('heading', { name: 'Frames 10 Designs + None' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Auras 10 Designs + None' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'None' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /(?:Frame|Aura), Owned$/ })).toHaveLength(20);

    fireEvent.click(screen.getByRole('button', { name: 'Obsidian Frame, Owned' }));
    await waitFor(() =>
      expect(mocks.setCosmetics).toHaveBeenCalledWith('user-1', 'frame-obsidian', null)
    );
  });

  it('describes locked premium styles through VIP, shop, or reward ownership', async () => {
    mocks.getCosmeticCatalog.mockResolvedValue({
      cosmetics: ALL_COSMETICS.map((cosmetic) => ({
        ...cosmetic,
        isOwned: cosmetic.tier === 'free',
      })),
      ok: true,
    });

    renderGallery();
    fireEvent.click(await screen.findByRole('tab', { name: 'Style (20)' }));

    const lockedGold = screen.getByRole('button', {
      name: 'Gold Frame, Premium; Active VIP, Club-Shop, Or Reward Unlock Required',
    });
    expect(lockedGold).toHaveAttribute(
      'title',
      'Gold (Active VIP, Club-Shop, Or Reward Unlock Required)'
    );
    expect(screen.getAllByText('Premium')).toHaveLength(14);

    fireEvent.click(lockedGold);
    expect(
      screen.getByText(
        'Premium Frames And Auras Require Active VIP, A Club-Shop Purchase, Or A Separate Reward Unlock.'
      )
    ).toBeVisible();
    expect(mocks.setCosmetics).not.toHaveBeenCalled();
  });
});
