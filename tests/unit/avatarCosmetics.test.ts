/**
 * Avatar cosmetics — catalog, resolution, ownership.
 *
 * Every case here corresponds to a way this feature could ship broken:
 *
 *   - a token in the database that this build does not know, rendering as a
 *     class name nothing defines (the `/avatars/default-player.png` shape of
 *     defect, one layer up);
 *   - the catalog drifting from the World Hub's class names, so a frame
 *     equipped on smarter.poker/hub/avatars is invisible on the felt;
 *   - the catalog drifting from the DATABASE guard's catalog, so the picker
 *     offers something the trigger then refuses;
 *   - a frame equipped into the aura column;
 *   - ownership failing OPEN and handing VIP art to everyone.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_COSMETICS,
  AVATAR_AURAS,
  AVATAR_FRAMES,
  cosmeticById,
  cosmeticClassName,
  isCosmeticOwned,
  normalizeCosmeticToken,
  resolveCosmetic,
} from '../../src/cosmetics/avatarCosmetics';
import { normalizeUnlockToken } from '../../src/services/AvatarService';

describe('avatar cosmetics catalog', () => {
  it('matches the World Hub class names exactly', () => {
    /* These six strings are the contract between two apps. The Hub writes them
       into equipped_frame / equipped_aura from AvatarContext.setAvatarCosmetics
       and renders them as `className={"cosmetic-frame " + frame}`. If this
       assertion is ever updated, AvatarGallery.jsx in Smarter-Poker-World-Hub
       has to change in the same breath or a player's frame vanishes when they
       walk between the two surfaces. */
    expect(AVATAR_FRAMES.map((f) => f.id)).toEqual([
      'frame-gold',
      'frame-diamond',
      'frame-cyber',
      'frame-hellfire',
    ]);
    expect(AVATAR_AURAS.map((a) => a.id)).toEqual(['aura-fire', 'aura-glitch']);
  });

  it('matches the database guard catalog exactly', () => {
    /* The other half of the same contract. `sp_cosmetic_is_owned` in
       20260825120000_avatar_cosmetics_ownership_guard.sql holds this list, and
       a cosmetic the picker offers but the trigger refuses is a purchase that
       fails at the last step with a Postgres error. */
    const guardCatalog = [
      'frame_gold',
      'frame_diamond',
      'frame_cyber',
      'frame_hellfire',
      'aura_fire',
      'aura_glitch',
    ];
    expect(ALL_COSMETICS.map((c) => c.unlockToken).sort()).toEqual([...guardCatalog].sort());
  });

  it('derives every unlock token from its id', () => {
    for (const cosmetic of ALL_COSMETICS) {
      expect(cosmetic.unlockToken).toBe(normalizeCosmeticToken(cosmetic.id));
    }
  });

  it('normalizes the same way AvatarService does', () => {
    /* Two normalizers, one ledger. avatar_unlocks is written by three producers
       that never agreed on a separator; if these two functions ever disagree, a
       granted cosmetic silently stops matching. */
    for (const raw of ['Frame-Gold', 'frame_gold', '  FRAME GOLD  ', 'aura--fire']) {
      expect(normalizeCosmeticToken(raw)).toBe(normalizeUnlockToken(raw));
    }
  });

  it('has no duplicate ids across kinds', () => {
    const ids = ALL_COSMETICS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('resolveCosmetic', () => {
  it('resolves every spelling of a known token', () => {
    for (const raw of ['frame-gold', 'frame_gold', 'FRAME-GOLD', ' Frame Gold ']) {
      expect(resolveCosmetic(raw, 'frame')?.id).toBe('frame-gold');
    }
  });

  it('returns null for a token this build does not know', () => {
    // A retired cosmetic, a Hub-only experiment, or something typed into the
    // SQL editor. It must draw nothing, not `class="... frame-unicorn"`.
    expect(resolveCosmetic('frame-unicorn', 'frame')).toBeNull();
    expect(cosmeticClassName('frame-unicorn', 'frame')).toBe('');
  });

  it('refuses a frame token asked for as an aura, and the reverse', () => {
    expect(resolveCosmetic('frame-gold', 'aura')).toBeNull();
    expect(resolveCosmetic('aura-fire', 'frame')).toBeNull();
  });

  it('treats every empty-ish value as nothing equipped', () => {
    for (const raw of [null, undefined, '', '   ']) {
      expect(resolveCosmetic(raw, 'frame')).toBeNull();
      expect(cosmeticClassName(raw, 'aura')).toBe('');
    }
  });

  it('never throws on hostile input', () => {
    // equipped_frame is a bare `text` column with no CHECK constraint, so this
    // is reachable by anything that can write the row.
    for (const raw of ['<script>', '../../etc/passwd', '"; drop table profiles; --', '🂡']) {
      expect(() => resolveCosmetic(raw, 'frame')).not.toThrow();
      expect(resolveCosmetic(raw, 'frame')).toBeNull();
    }
  });

  it('looks up by exact id', () => {
    expect(cosmeticById('aura-glitch')?.label).toBe('Glitch');
    expect(cosmeticById('aura-glitchy')).toBeNull();
  });
});

describe('isCosmeticOwned', () => {
  const gold = AVATAR_FRAMES[0];

  it('grants vip-tier cosmetics to a VIP', () => {
    expect(isCosmeticOwned(gold, { isVip: true, unlockedTokens: new Set() })).toBe(true);
  });

  it('grants a cosmetic that appears in the unlock ledger', () => {
    expect(isCosmeticOwned(gold, { isVip: false, unlockedTokens: new Set(['frame_gold']) })).toBe(
      true
    );
  });

  it('refuses when the player is neither VIP nor granted', () => {
    expect(isCosmeticOwned(gold, { isVip: false, unlockedTokens: new Set() })).toBe(false);
  });

  it('does not accept a NEIGHBOURING token as ownership', () => {
    // 'gold' alone is how the shop stores an AVATAR slug. It must not unlock the
    // gold FRAME: the namespace is the whole reason cosmetics can share the
    // avatar_unlocks ledger without colliding with avatar art.
    expect(isCosmeticOwned(gold, { isVip: false, unlockedTokens: new Set(['gold']) })).toBe(false);
    expect(isCosmeticOwned(gold, { isVip: false, unlockedTokens: new Set(['frame_golden']) })).toBe(
      false
    );
  });
});
