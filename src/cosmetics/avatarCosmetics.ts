/**
 * ♠ CLUB ARENA — Avatar Cosmetics (frames + auras)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE IS A CATALOG AND NOT AN ASSET FOLDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `profiles.equipped_frame` / `profiles.equipped_aura` and the matching pair on
 * `user_avatars` have existed since 2026-08-21 and until now NOTHING in this
 * repo read or wrote either one. Before building a picker on top of them the
 * first question had to be answered honestly: WHAT ARTWORK ACTUALLY EXISTS?
 *
 * The answer, verified on disk 2026-08-25:
 *
 *   club-arena/public/**            ZERO frame images, ZERO aura images.
 *                                   `public/images/frames/frame-1..5.{jpg,webp}`
 *                                   exist but are club-card chrome, referenced
 *                                   by nothing, and are not avatar frames.
 *   World-Hub/public/**             ZERO frame images, ZERO aura images.
 *   World-Hub AvatarGallery.jsx     FOUR frames and TWO auras, defined as pure
 *                                   CSS (border + box-shadow + keyframes) at
 *                                   lines 721-747.
 *
 * So the cosmetics are real, but they are CSS, not files. That is the whole
 * reason this catalog is code: a cosmetic that resolves to a missing PNG is the
 * defect this codebase keeps repeating (see `/avatars/default-player.png`,
 * referenced by SpectatorOverlay and shipped by nobody). A CSS cosmetic cannot
 * 404. There is no image to fail to load.
 *
 * The six ids below are BYTE-IDENTICAL to the World Hub's class names on
 * purpose. A player who equips `frame-gold` at smarter.poker/hub/avatars sees
 * the same gold frame on the felt, because both apps key off the same token and
 * both write the same two columns. Adding a seventh cosmetic means adding it in
 * BOTH places or the two surfaces silently disagree.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  OWNERSHIP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `avatar_unlocks` is the ledger — the same one avatars already use. Cosmetics
 * are namespaced inside it (`frame_gold`, `aura_fire`) so they cannot collide
 * with an avatar slug, and they are matched through `normalizeUnlockToken` so
 * `frame-gold`, `frame_gold` and `FRAME GOLD` are one identity.
 *
 * VIP members own every `vip`-tier cosmetic outright. That is not an invention:
 * `VIPBenefitsGrid.tsx:57` has been promising "Exclusive avatar frames &
 * badges" to paying members, and `RewardsMarketplace.tsx` has been listing an
 * `avatar-gold-frame` reward, since long before any code could render one.
 *
 * THE UI IS NOT THE GUARD. `supabase/migrations/20260825120000_avatar_cosmetics_ownership_guard.sql`
 * puts the same rule in a BEFORE UPDATE trigger on both tables, because
 * `avatar_unlocks` has a "Users can insert their own unlocks" policy and
 * `profiles_update` lets a player write their own row — a rule that lives only
 * in a component is not a rule, it is a suggestion with a nice font.
 */

export type CosmeticKind = 'frame' | 'aura';
/**
 * Dan 2026-08-27: "CHOSE 3 THAT ARE FREE TO INTERCHANGE AND USE, AND THE REST
 * ARE VIP LOCKED FOR ALL CUSTOMIZABLE FUNCTIONS AND FEATURES."
 *
 * Frames and auras had NO free tier at all — every one of the six was VIP — so
 * applying the rule by demoting existing ones would have GIVEN AWAY three of
 * four VIP frames rather than locking anything. Dan's instruction was to author
 * three new free ones instead, which is what the `free` tier below is: three
 * deliberately plain CSS frames and three quiet auras, enough to make the
 * feature discoverable without touching a single thing a member pays for.
 */
export type CosmeticTier = 'free' | 'vip';

export interface AvatarCosmetic {
  /** Canonical token. Stored verbatim in equipped_frame / equipped_aura. */
  id: string;
  kind: CosmeticKind;
  /** Player-facing name. Already Title Case; safe for toasts. */
  label: string;
  tier: CosmeticTier;
  /**
   * The `avatar_unlocks.avatar_id` value that grants this cosmetic, already
   * normalized. Kept explicit rather than derived so a shop grant can be
   * written against a literal that greps.
   */
  unlockToken: string;
}

export const AVATAR_FRAMES: readonly AvatarCosmetic[] = [
  /* ── THE THREE FREE FRAMES (Dan 2026-08-27) ─────────────────────────────
     Plain by design: a single solid ring each, no glow, no animation. They
     exist so every player can find and use the feature; the paid frames keep
     every effect that distinguishes them. Their CSS lives beside the VIP
     frames in BOTH repos — see the byte-identical note at the top of this
     file. `unlockToken` is still populated so a free cosmetic can be
     represented in the ledger exactly like a paid one if that is ever
     wanted; nothing requires a row to equip them. */
  { id: 'frame-slate', kind: 'frame', label: 'Slate', tier: 'free', unlockToken: 'frame_slate' },
  { id: 'frame-ivory', kind: 'frame', label: 'Ivory', tier: 'free', unlockToken: 'frame_ivory' },
  { id: 'frame-copper', kind: 'frame', label: 'Copper', tier: 'free', unlockToken: 'frame_copper' },
  { id: 'frame-gold', kind: 'frame', label: 'Gold', tier: 'vip', unlockToken: 'frame_gold' },
  {
    id: 'frame-diamond',
    kind: 'frame',
    label: 'Diamond',
    tier: 'vip',
    unlockToken: 'frame_diamond',
  },
  { id: 'frame-cyber', kind: 'frame', label: 'Cyber', tier: 'vip', unlockToken: 'frame_cyber' },
  {
    id: 'frame-hellfire',
    kind: 'frame',
    label: 'Hellfire',
    tier: 'vip',
    unlockToken: 'frame_hellfire',
  },
] as const;

export const AVATAR_AURAS: readonly AvatarCosmetic[] = [
  /* The three free auras: a soft static halo each, no pulse, no animation.
     Same reasoning as the free frames above. */
  { id: 'aura-mist', kind: 'aura', label: 'Mist', tier: 'free', unlockToken: 'aura_mist' },
  { id: 'aura-dusk', kind: 'aura', label: 'Dusk', tier: 'free', unlockToken: 'aura_dusk' },
  { id: 'aura-moss', kind: 'aura', label: 'Moss', tier: 'free', unlockToken: 'aura_moss' },
  { id: 'aura-fire', kind: 'aura', label: 'Fire', tier: 'vip', unlockToken: 'aura_fire' },
  { id: 'aura-glitch', kind: 'aura', label: 'Glitch', tier: 'vip', unlockToken: 'aura_glitch' },
] as const;

export const ALL_COSMETICS: readonly AvatarCosmetic[] = [...AVATAR_FRAMES, ...AVATAR_AURAS];

const BY_ID = new Map<string, AvatarCosmetic>(ALL_COSMETICS.map((c) => [c.id, c]));

/**
 * Normalize any of the three id spellings onto one token.
 *
 * Deliberately identical to `AvatarService.normalizeUnlockToken` — the two must
 * not drift, and `tests/unit/avatarCosmetics.test.ts` asserts they agree.
 */
export function normalizeCosmeticToken(raw: string | null | undefined): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * The catalog entry for a stored token, or null.
 *
 * NULL IS THE IMPORTANT RETURN. A row can hold anything: a token from a future
 * release, a value typed into the SQL editor, a cosmetic that was retired. Every
 * render site routes through here precisely so an unknown token draws NOTHING
 * rather than emitting `class="cosmetic-frame frame-whatever"` and inheriting
 * whatever a stylesheet happens to define for that name.
 */
export function resolveCosmetic(
  token: string | null | undefined,
  kind: CosmeticKind
): AvatarCosmetic | null {
  if (!token) return null;
  const normalized = normalizeCosmeticToken(token);
  for (const cosmetic of ALL_COSMETICS) {
    if (cosmetic.kind !== kind) continue;
    if (normalizeCosmeticToken(cosmetic.id) === normalized) return cosmetic;
  }
  return null;
}

/** The CSS class a resolved cosmetic renders with, or '' when unresolvable. */
export function cosmeticClassName(token: string | null | undefined, kind: CosmeticKind): string {
  return resolveCosmetic(token, kind)?.id ?? '';
}

export function cosmeticById(id: string): AvatarCosmetic | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Does this player own this cosmetic?
 *
 * `isVip` is a TRISTATE in the caller's world — the VIP flag is read
 * asynchronously and `undefined` means "not answered yet". Treating unknown as
 * false would paywall a paying member for the length of a round trip, which is
 * the exact complaint AvatarContext documents on the Hub side; treating it as
 * true would hand VIP art to everyone the first time the query hiccups. So the
 * caller decides, and this function takes a definite boolean.
 */
export function isCosmeticOwned(
  cosmetic: AvatarCosmetic,
  opts: { isVip: boolean; unlockedTokens: ReadonlySet<string> }
): boolean {
  // A free cosmetic is owned by everyone, always — no ledger row required
  // (Dan 2026-08-27, the three-free rule).
  if (cosmetic.tier === 'free') return true;
  if (opts.isVip && cosmetic.tier === 'vip') return true;
  return opts.unlockedTokens.has(cosmetic.unlockToken);
}
