/**
 * AvatarService cosmetics — the equip gate and the failure-vs-empty rule.
 *
 * The database trigger `trg_profiles_cosmetics_ownership` is the guard that
 * cannot be skipped. This layer exists so the player gets a sentence instead of
 * a Postgres error, and so an unowned equip never reaches the network at all.
 *
 * The cases that matter here are the ones where "broken" and "empty" look the
 * same:
 *
 *   - a failed ownership read must NOT be reported as "you own nothing", and
 *     must NOT let an equip through either. It has to fail closed AND say so.
 *   - a token this build does not know must be refused before the write, not
 *     stored and then rendered as nothing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = { data: any; error: any };

const state = {
  profileSelect: { data: {}, error: null } as Row,
  unlockSelect: { data: [] as Array<{ avatar_id: string }>, error: null } as Row,
  profileUpdate: { data: null, error: null } as Row,
  avatarsUpdate: { data: null, error: null } as Row,
  lastProfileUpdatePayload: null as any,
  profileUpdateCalls: 0,
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'avatar_unlocks') {
        return { select: () => ({ eq: () => Promise.resolve(state.unlockSelect) }) };
      }
      if (table === 'user_avatars') {
        return {
          update: () => ({ eq: () => Promise.resolve(state.avatarsUpdate) }),
          select: () => ({
            eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
          }),
        };
      }
      // profiles
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve(state.profileSelect) }),
        }),
        update: (payload: any) => {
          state.profileUpdateCalls += 1;
          state.lastProfileUpdatePayload = payload;
          return { eq: () => Promise.resolve(state.profileUpdate) };
        },
      };
    },
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: vi.fn(),
  reportWarning: vi.fn(),
}));

import { avatarService } from '../../src/services/AvatarService';

const USER = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  state.profileSelect = {
    data: { is_vip: false, equipped_frame: null, equipped_aura: null },
    error: null,
  };
  state.unlockSelect = { data: [], error: null };
  state.profileUpdate = { data: null, error: null };
  state.avatarsUpdate = { data: null, error: null };
  state.lastProfileUpdatePayload = null;
  state.profileUpdateCalls = 0;
});

describe('getCosmetics', () => {
  it('resolves stored tokens rather than passing them through', () => {
    state.profileSelect = {
      data: { equipped_frame: 'FRAME_GOLD', equipped_aura: 'aura-fire' },
      error: null,
    };
    return avatarService.getCosmetics(USER).then((r) => {
      expect(r).toEqual({ frame: 'frame-gold', aura: 'aura-fire', ok: true });
    });
  });

  it('drops a token this build does not know instead of returning it', async () => {
    state.profileSelect = { data: { equipped_frame: 'frame-unicorn' }, error: null };
    const r = await avatarService.getCosmetics(USER);
    expect(r.frame).toBeNull();
    expect(r.ok).toBe(true);
  });

  it('reports a read failure as ok:false, distinct from nothing equipped', async () => {
    state.profileSelect = { data: null, error: { code: '42501' } };
    const r = await avatarService.getCosmetics(USER);
    expect(r).toEqual({ frame: null, aura: null, ok: false });
  });
});

describe('getCosmeticCatalog', () => {
  it('marks every PAID cosmetic unowned for a plain account, and every free one owned', async () => {
    /* 2026-08-27: the catalog gained a free tier (three frames, three auras)
       when Dan set the three-free rule. "Everything unowned" was the right
       assertion when all six cosmetics were VIP; now the meaningful claim is
       that the PAID ones stay locked while the free ones are available to an
       account with no VIP and no ledger row. */
    const { cosmetics, ok } = await avatarService.getCosmeticCatalog(USER);
    expect(ok).toBe(true);
    expect(cosmetics).toHaveLength(12);
    expect(cosmetics.filter((c) => c.tier === 'vip').every((c) => !c.isOwned)).toBe(true);
    expect(cosmetics.filter((c) => c.tier === 'free').every((c) => c.isOwned)).toBe(true);
    expect(cosmetics.filter((c) => c.tier === 'free')).toHaveLength(6);
  });

  it('marks everything owned for a VIP', async () => {
    state.profileSelect = { data: { is_vip: true }, error: null };
    const { cosmetics, ok } = await avatarService.getCosmeticCatalog(USER);
    expect(ok).toBe(true);
    expect(cosmetics.every((c) => c.isOwned)).toBe(true);
  });

  it('honours a shop grant for a non-VIP', async () => {
    state.unlockSelect = { data: [{ avatar_id: 'frame_hellfire' }], error: null };
    const { cosmetics } = await avatarService.getCosmeticCatalog(USER);
    expect(cosmetics.find((c) => c.id === 'frame-hellfire')?.isOwned).toBe(true);
    expect(cosmetics.find((c) => c.id === 'frame-gold')?.isOwned).toBe(false);
  });

  it('fails CLOSED for a plain account when the ledger read errors', async () => {
    // Failing open would hand every VIP cosmetic to the whole player base the
    // first time this query hiccups.
    state.unlockSelect = { data: null, error: { code: '42501' } };
    const { cosmetics, ok } = await avatarService.getCosmeticCatalog(USER);
    expect(ok).toBe(false);
    // The PAID tier fails closed. Free cosmetics are unaffected by a ledger
    // failure because they never consult the ledger.
    expect(cosmetics.filter((c) => c.tier === 'vip').every((c) => !c.isOwned)).toBe(true);
  });

  it('still credits a VIP when only the ledger read errors', async () => {
    /* The two sources are independent and are tracked separately for exactly
       this case. An earlier version ANDed one `ok` into every `isOwned`, which
       looks prudent and is not: a paying member whose unrelated unlock query
       hiccupped was told they owned nothing, and the frame they pay for
       vanished on a transient error. VIP membership is a COMPLETE answer for a
       vip-tier cosmetic; it does not need the ledger to have replied. */
    state.profileSelect = { data: { is_vip: true }, error: null };
    state.unlockSelect = { data: null, error: { code: '42501' } };
    const { cosmetics, ok } = await avatarService.getCosmeticCatalog(USER);
    expect(ok).toBe(false); // the picture is incomplete, and says so
    expect(cosmetics.every((c) => c.isOwned)).toBe(true); // but this part is known
  });

  it('still honours a grant when only the VIP read errors', async () => {
    state.profileSelect = { data: null, error: { code: '42501' } };
    state.unlockSelect = { data: [{ avatar_id: 'aura_glitch' }], error: null };
    const { cosmetics, ok } = await avatarService.getCosmeticCatalog(USER);
    expect(ok).toBe(false);
    expect(cosmetics.find((c) => c.id === 'aura-glitch')?.isOwned).toBe(true);
    expect(cosmetics.find((c) => c.id === 'frame-gold')?.isOwned).toBe(false);
  });

  it('owns nothing when BOTH sources fail', async () => {
    state.profileSelect = { data: null, error: { code: '42501' } };
    state.unlockSelect = { data: null, error: { code: '42501' } };
    const { cosmetics, ok } = await avatarService.getCosmeticCatalog(USER);
    expect(ok).toBe(false);
    // Both entitlement sources are dead, so nothing PAID may be credited.
    // The free tier still stands: it depends on neither source.
    expect(cosmetics.filter((c) => c.tier === 'vip').every((c) => !c.isOwned)).toBe(true);
    expect(cosmetics.filter((c) => c.tier === 'free').every((c) => c.isOwned)).toBe(true);
  });
});

describe('setCosmetics', () => {
  it('refuses an unowned frame WITHOUT touching the database', async () => {
    const r = await avatarService.setCosmetics(USER, 'frame-gold', null);
    expect(r).toEqual({ ok: false, reason: 'not-owned' });
    expect(state.profileUpdateCalls).toBe(0);
  });

  it('refuses a token this build does not know, before any read', async () => {
    const r = await avatarService.setCosmetics(USER, 'frame-unicorn', null);
    expect(r).toEqual({ ok: false, reason: 'unknown-cosmetic' });
    expect(state.profileUpdateCalls).toBe(0);
  });

  it('refuses a frame token handed in as an aura', async () => {
    state.profileSelect = { data: { is_vip: true }, error: null };
    const r = await avatarService.setCosmetics(USER, null, 'frame-gold');
    expect(r).toEqual({ ok: false, reason: 'unknown-cosmetic' });
    expect(state.profileUpdateCalls).toBe(0);
  });

  it('refuses when ownership could not be checked', async () => {
    state.unlockSelect = { data: null, error: { code: '42501' } };
    const r = await avatarService.setCosmetics(USER, 'frame-gold', null);
    expect(r).toEqual({ ok: false, reason: 'not-owned' });
    expect(state.profileUpdateCalls).toBe(0);
  });

  it('lets a VIP equip even when the unrelated ledger read fails', async () => {
    // The other half of the split-source rule. A blanket `if (!ok) return
    // not-owned` here would refuse a paying member their own frame because a
    // query they do not depend on happened to error.
    state.profileSelect = { data: { is_vip: true }, error: null };
    state.unlockSelect = { data: null, error: { code: '42501' } };
    const r = await avatarService.setCosmetics(USER, 'frame-gold', null);
    expect(r.ok).toBe(true);
    expect(state.lastProfileUpdatePayload).toEqual({
      equipped_frame: 'frame-gold',
      equipped_aura: null,
    });
  });

  it('writes the canonical id for an owned cosmetic', async () => {
    state.profileSelect = { data: { is_vip: true }, error: null };
    const r = await avatarService.setCosmetics(USER, 'FRAME_GOLD', 'aura-fire');
    expect(r.ok).toBe(true);
    expect(state.lastProfileUpdatePayload).toEqual({
      equipped_frame: 'frame-gold',
      equipped_aura: 'aura-fire',
    });
  });

  it('always allows unequipping, with no ownership check at all', async () => {
    const r = await avatarService.setCosmetics(USER, null, null);
    expect(r.ok).toBe(true);
    expect(state.lastProfileUpdatePayload).toEqual({
      equipped_frame: null,
      equipped_aura: null,
    });
  });

  it('translates the database ownership trigger into not-owned', async () => {
    // Reachable when the entitlement lapses between the check and the write.
    state.profileSelect = { data: { is_vip: true }, error: null };
    state.profileUpdate = { data: null, error: { code: '23514', message: 'check_violation' } };
    const r = await avatarService.setCosmetics(USER, 'frame-gold', null);
    expect(r).toEqual({ ok: false, reason: 'not-owned' });
  });

  it('reports a genuine write failure as write-failed, not not-owned', async () => {
    state.profileSelect = { data: { is_vip: true }, error: null };
    state.profileUpdate = { data: null, error: { code: '08006', message: 'connection failure' } };
    const r = await avatarService.setCosmetics(USER, 'frame-gold', null);
    expect(r).toEqual({ ok: false, reason: 'write-failed' });
  });

  it('still succeeds when only the user_avatars mirror fails', async () => {
    // profiles is the source of truth: it is what the engine's seat query reads
    // and what every other player's subscription watches. The mirror exists for
    // World Hub parity and must not be able to fail the equip.
    state.profileSelect = { data: { is_vip: true }, error: null };
    state.avatarsUpdate = { data: null, error: { code: '42501', message: 'denied' } };
    const r = await avatarService.setCosmetics(USER, 'frame-gold', null);
    expect(r.ok).toBe(true);
  });
});
