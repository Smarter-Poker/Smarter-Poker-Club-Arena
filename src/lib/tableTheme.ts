/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE THEME RESOLUTION — pure
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Moved out of TablePage.tsx on 2026-08-19. Two one-line lookups, but they are
 * the lookups that decide a player never sees a blank table: any stored id that
 * is unknown, renamed, or simply absent has to fall back to a real asset rather
 * than to undefined.
 */
import {
  TABLE_SKINS,
  TABLE_BACKGROUNDS,
  TABLE_SKIN_IDS,
  TABLE_BACKGROUND_IDS,
} from '../assets/tableAssets';

// ═══════════════════════════════════════════════════════════════════════════════
// EVERY THEME PRESET PAINTS A REAL, DISTINCT TABLE (2026-08-29)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Table Studio offers composite presets whose ids are intentionally not direct
// TABLE_SKINS keys. Before this alias registry existed, every preset fell
// through to classic green wherever its theme id reached resolveSkin. Ten
// premium names would have meant one felt.
//
// The CSS written for them was inert in the same way: a block per preset
// setting --felt-gradient / --bg-gradient, custom properties defined 37 times
// across the stylesheets and read by var() exactly zero times. Left over from a
// gradient-painted table that the image-based skin system replaced, so it
// looked like a feature and did nothing.
//
// One named alias map rather than a special case inside resolveSkin, and the
// SAME map supplies ThemeSettingsModal's preset bundles, so the felt a preset
// paints and the felt it saves cannot drift apart.
//
// Two bundled pairings were also simply wrong: "Rustic Wood" bundled the green
// casino felt and "Casino Green" bundled the VIP jade neon felt. Each preset
// now names the skin its label promises, and no two name the same one.
export type ThemePresetTier = 'free' | 'vip';

export interface ThemePresetDefinition {
  id: string;
  name: string;
  thumbnail: string;
  tier: ThemePresetTier;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
}

/**
 * ONE composite-preset catalog for the picker, the marketplace editor and the
 * persistence layer. A table theme is not a decorative label: it is a bundle
 * of five independently guarded assets. Keeping those bundle fields next to
 * the public id makes it impossible for a shop item to sell a name that cannot
 * paint a real table, or for the preview and the saved row to drift apart.
 *
 * The matching rows in `theme_preset_catalog` are asserted by
 * 20260829190000_cosmetic_checkout_and_entitlement_delivery.sql.
 */
export const THEME_PRESET_CATALOG: readonly ThemePresetDefinition[] = [
  {
    id: 'default-dark',
    name: 'House Classic',
    thumbnail: 'linear-gradient(135deg, #1a1a2e, #16213e)',
    tier: 'free',
    table_id: 'classic_green',
    button_id: 'classic-white',
    background_id: 'midnight',
    cards_id: 'classic_red',
  },
  {
    id: 'classic-brown',
    name: 'Carbon Club',
    thumbnail: 'linear-gradient(135deg, #3e2723, #5d4037)',
    tier: 'free',
    table_id: 'carbon_red',
    button_id: 'gray-d-gear',
    background_id: 'midnight',
    cards_id: 'classic_red',
  },
  {
    id: 'neon-blue',
    name: 'Neon Ice',
    thumbnail: 'linear-gradient(135deg, #0d47a1, #1565c0)',
    tier: 'vip',
    table_id: 'ice_cavern',
    button_id: 'blue-crystal',
    background_id: 'galaxy',
    cards_id: 'classic_blue',
  },
  {
    id: 'rustic-wood',
    name: 'Golden Dusk',
    thumbnail: 'linear-gradient(135deg, #4e342e, #795548)',
    tier: 'vip',
    table_id: 'golden_sand',
    button_id: 'gold-star',
    background_id: 'golden_dusk',
    cards_id: 'gold',
  },
  {
    id: 'casino-green',
    name: 'Jade Casino',
    thumbnail: 'linear-gradient(135deg, #1b5e20, #2e7d32)',
    tier: 'vip',
    table_id: 'jade_city',
    button_id: 'gold-star',
    background_id: 'jade_neon',
    cards_id: 'carbon',
  },
  {
    id: 'ocean-depths',
    name: 'Ocean Suite',
    thumbnail: 'linear-gradient(135deg, #061a2c, #0b6584)',
    tier: 'free',
    table_id: 'ocean_blue',
    button_id: 'classic-white',
    background_id: 'royal_indigo',
    cards_id: 'classic_blue',
  },
  {
    id: 'crimson-club',
    name: 'Crimson Club',
    thumbnail: 'linear-gradient(135deg, #26070d, #8f142c)',
    tier: 'vip',
    table_id: 'crimson',
    button_id: 'red-d-gear',
    background_id: 'crimson_lounge',
    cards_id: 'classic_red',
  },
  {
    id: 'arctic-suite',
    name: 'Arctic Suite',
    thumbnail: 'linear-gradient(135deg, #dce9f0, #55748a)',
    tier: 'vip',
    table_id: 'arctic_white',
    button_id: 'ocean-pearl',
    background_id: 'ice_frost',
    cards_id: 'diamond-foil',
  },
  {
    id: 'amethyst-night',
    name: 'Amethyst Night',
    thumbnail: 'linear-gradient(135deg, #160b27, #63389a)',
    tier: 'vip',
    table_id: 'amethyst_cavern',
    button_id: 'amethyst-chip',
    background_id: 'royal_indigo',
    cards_id: 'royal',
  },
  {
    id: 'carbon-ion',
    name: 'Carbon Ion',
    thumbnail: 'linear-gradient(135deg, #080d0f, #167f78)',
    tier: 'vip',
    table_id: 'carbon_ion',
    button_id: 'carbon-ion',
    background_id: 'carbon_grid',
    cards_id: 'carbon',
  },
];

export const THEME_PRESET_SKINS: Readonly<Record<string, string>> = Object.fromEntries(
  THEME_PRESET_CATALOG.map((preset) => [preset.id, preset.table_id])
);

export const THEME_PRESET_BUNDLES: Readonly<
  Record<
    string,
    Pick<ThemePresetDefinition, 'table_id' | 'button_id' | 'background_id' | 'cards_id'>
  >
> = Object.fromEntries(
  THEME_PRESET_CATALOG.map(({ id, table_id, button_id, background_id, cards_id }) => [
    id,
    { table_id, button_id, background_id, cards_id },
  ])
);

/** Legacy receipts already sold by VIP rewards and club marketplaces. */
export const THEME_PRESET_ALIASES: Readonly<Record<string, string>> = {
  neon: 'neon-blue',
  midnight_casino: 'carbon-ion',
  cosmic: 'amethyst-night',
  midnight_felt: 'carbon-ion',
  midnight_a: 'carbon-ion',
  royal_gold: 'rustic-wood',
  royal_b: 'rustic-wood',
};

export function normalizeThemePresetId(themeId: string | undefined | null): string | null {
  if (!themeId) return null;
  if (THEME_PRESET_CATALOG.some((preset) => preset.id === themeId)) return themeId;
  return THEME_PRESET_ALIASES[themeId] ?? null;
}

/** The skin asset for an id, or undefined if nothing real is behind it. */
function skinAsset(tid: string): string | undefined {
  const direct = TABLE_SKINS[tid];
  if (direct) return direct;
  const aliased = THEME_PRESET_SKINS[tid];
  return aliased ? TABLE_SKINS[aliased] : undefined;
}

/** Resolve a stored table/theme id to a skin asset; default stays green. */
export function resolveSkin(tid: string): string {
  return skinAsset(tid) || TABLE_SKINS.classic_green;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE FELT CATALOGUE — one list, every surface
// ═══════════════════════════════════════════════════════════════════════════════
//
// Dan 2026-08-25. Two components offered a felt and they did not agree on what
// a felt IS. ThemeSettingsModal's Table tab typed out thirteen ids that happen
// to match TABLE_SKINS; TableFeltSelector typed out eight FLAT COLOURS —
// classic_green, navy, burgundy, charcoal, purple, crimson, midnight, emerald.
// Only TWO of those eight paint what their label says. Five (navy, burgundy,
// charcoal, purple, midnight) are not skins at all - `midnight` is a BACKGROUND
// id - so resolveSkin sent all five to classic green, and picking Royal Purple
// or Charcoal produced the identical green felt. The eighth, `emerald`, is a
// legacy alias pointing at the GOLDEN SAND skin, so that tile was simply
// mislabelled.
//
// Same shape as the card-back defect, same cause: a second copy of a list.
// Both surfaces now read this one, which is generated against TABLE_SKIN_IDS,
// so an id cannot appear in a picker unless a skin file exists behind it.
// feltCatalog.test.ts pins the coverage in both directions.

export type FeltTier = 'standard' | 'vip';

export interface TableFeltDesign {
  id: string;
  name: string;
  tier: FeltTier;
  /** Fallback gradient, painted only if the skin image has not arrived yet. */
  thumbnail: string;
}

/** Display name, tier and fallback gradient per skin id. */
const FELT_META: Record<string, Omit<TableFeltDesign, 'id'>> = {
  neon_city: {
    name: 'Neon City',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #2b2b33 40%, #d446b8 75%, #2ad4d4)',
  },
  classic_green: {
    name: 'Classic Green',
    tier: 'standard',
    thumbnail: 'linear-gradient(135deg, #0f9d63, #0a3d24)',
  },
  carbon_red: {
    name: 'Carbon Red',
    tier: 'standard',
    thumbnail: 'linear-gradient(135deg, #232326 55%, #b3221f)',
  },
  ice_cavern: {
    name: 'Ice Cavern',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #0c1524 40%, #3f6fae 75%, #bcd6ee)',
  },
  arctic_white: {
    name: 'Arctic White',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #f2f2f0 35%, #3f8fd4)',
  },
  mahogany_red: {
    name: 'Royal Mahogany',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #3a1410 30%, #b3273a 70%, #d8a437)',
  },
  ocean_blue: {
    name: 'Ocean Blue',
    tier: 'standard',
    thumbnail: 'linear-gradient(135deg, #1a4a7a, #0a243d)',
  },
  crimson: {
    name: 'Crimson',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #7a1a3a, #3d0a20)',
  },
  electric_purple: {
    name: 'Electric Purple',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #4a1a7a, #240a3d)',
  },
  golden_sand: {
    name: 'Golden Sand',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #7a6a1a, #3d380a)',
  },
  jade_city: {
    name: 'Jade City',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #14261c 40%, #2fae6f 75%, #9fe8c0)',
  },
  amethyst_cavern: {
    name: 'Amethyst Cavern',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #180c24 40%, #7d3fae 75%, #d9bcee)',
  },
  carbon_ion: {
    name: 'Carbon Ion',
    tier: 'vip',
    thumbnail: 'linear-gradient(135deg, #232326 55%, #1fb392)',
  },
};

/** Display order for the felt pickers. Ids not listed follow, so a newly
 *  added skin appears on its own rather than waiting for someone to notice. */
const FELT_ORDER = [
  'neon_city',
  'classic_green',
  'carbon_red',
  'ice_cavern',
  'arctic_white',
  'mahogany_red',
  'ocean_blue',
  'crimson',
  'electric_purple',
  'golden_sand',
  'jade_city',
  'amethyst_cavern',
  'carbon_ion',
];

const FELT_FALLBACK_GRADIENT = 'linear-gradient(135deg, #0f9d63, #0a3d24)';

export const TABLE_FELT_CATALOG: readonly TableFeltDesign[] = [
  ...FELT_ORDER.filter((id) => TABLE_SKIN_IDS.includes(id)),
  ...TABLE_SKIN_IDS.filter((id) => !FELT_ORDER.includes(id)),
].map((id) => ({
  id,
  name: FELT_META[id]?.name ?? id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  tier: FELT_META[id]?.tier ?? 'standard',
  thumbnail: FELT_META[id]?.thumbnail ?? FELT_FALLBACK_GRADIENT,
}));

/** The catalogue entry for a stored table_id. Never undefined. */
export function feltDesign(tid: string | undefined | null): TableFeltDesign {
  const match = TABLE_FELT_CATALOG.find((f) => f.id === tid);
  if (match) return match;
  return TABLE_FELT_CATALOG.find((f) => f.id === 'classic_green') ?? TABLE_FELT_CATALOG[0];
}

/**
 * Map a stored table_id onto the canonical id whose TILE the picker shows.
 *
 * The database really does hold legacy aliases: a live row on 2026-08-25 had
 * `table_id: 'dark-felt'`. resolveSkin paints that correctly (Neon City), but
 * the picker highlighted NOTHING, because no tile carries that id. From the
 * player's side the modal had forgotten their table. Exactly the defect
 * normalizeCardBack was added to fix on the Cards tab; felts needed it too.
 *
 * Resolution is by ASSET, not by a second alias table, so it follows any
 * future alias automatically.
 */
export function normalizeFeltId(tid: string | undefined | null): string {
  const fallback = 'classic_green'; // what resolveSkin actually paints on a miss
  if (!tid) return fallback;
  if (TABLE_FELT_CATALOG.some((f) => f.id === tid)) return tid;
  // skinAsset, not TABLE_SKINS, so a theme-preset id highlights the tile it
  // actually paints instead of highlighting nothing.
  const asset = skinAsset(tid);
  if (asset) {
    const match = TABLE_FELT_CATALOG.find((f) => TABLE_SKINS[f.id] === asset);
    if (match) return match.id;
  }
  return fallback;
}

/** Same idea for background_id: legacy ids such as 'diamond-pattern' paint
 *  midnight but used to highlight no tile at all. */
export function normalizeBackgroundId(bid: string | undefined | null): string {
  const fallback = 'midnight';
  if (!bid) return fallback;
  const asset = TABLE_BACKGROUNDS[bid];
  if (!asset) return fallback;
  if (TABLE_BACKGROUND_IDS.includes(bid)) return bid;
  const canonical = TABLE_BACKGROUND_IDS.find((id) => TABLE_BACKGROUNDS[id] === asset);
  return canonical ?? fallback;
}

/** VIP felts need VIP. Everything else is free. */
export function isFeltUnlocked(
  tid: string | undefined | null,
  opts: { isVip?: boolean } = {}
): boolean {
  return feltDesign(tid).tier === 'standard' || !!opts.isVip;
}

// Dan 2026-08-18 — INTERCHANGEABLE DESIGNED BACKGROUNDS.
// The blurred-skin backdrop is gone ("remove the weird images around the
// table"). The page behind the table is now one of ten standalone designed
// backgrounds, selected on the Theme modal's Background tab and stored in
// user_theme_settings.background_id. Legacy ids alias to the closest design.

export function resolveBackground(bid: string): string {
  return TABLE_BACKGROUNDS[bid] || TABLE_BACKGROUNDS.midnight;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT BACKDROP — Dan 2026-08-20: "EVERY SINGLE TABLE NEEDS A BACKGROUND...
// IT SHOULD NEVER BE BLANK. WE NEED A DEFAULT BACKGROUND."
// ═══════════════════════════════════════════════════════════════════════════════
//
// resolveBackground() always returns a real asset URL, but a URL is not a
// rendered pixel: if the JPG 404s (pruned/renamed asset, CDN miss), fails to
// decode, or is still in flight on a cold connection, `background-image:
// url(...)` paints NOTHING and the player stares at a blank page.
//
// The fix is a painted floor. CSS multi-layer backgrounds composite top-to-
// bottom and each layer fails independently, so listing the designed artwork
// FIRST and a pure-CSS backdrop BENEATH it means the CSS always paints —
// instantly, with no network — and the artwork simply layers over it when it
// arrives. There is no state in which the page has no background.
//
// The backdrop is deliberately designed rather than a flat fill: a warm centre
// pool where the table sits, a cool corner falloff, and a fine diagonal weave
// so large screens read as a room instead of a void. It also carries the
// desktop composition for the ten designed backgrounds, which are authored
// portrait (750x1624) and therefore crop to a near-featureless slice on a wide
// viewport.

/**
 * AMBIENCE — painted ON TOP of the artwork.
 *
 * 2026-08-20 follow-up: guaranteeing a layer *underneath* stopped the page
 * being empty when an asset fails, but it did nothing for the reported
 * symptom, because the artwork does load — it is simply almost invisible.
 * Update 2026-08-27: Backgrounds are portrait-native 1440x2560 private-room
 * compositions. Their central 70% is intentionally quiet and contains no
 * second table; architecture and material detail live at the phone edges
 * around the real table. A backdrop hidden *behind* that reads exactly as blank.
 *
 * So the ambience moves above the art: a soft pool lifts the centre where the
 * table sits, and a vignette frames the edges. The artwork still reads —
 * these are translucent — but the page is now unmistakably a lit room instead
 * of a void, on every design and at every viewport ratio.
 */
export const DEFAULT_TABLE_AMBIENCE = [
  // Vignette frames the edges (topmost)
  'radial-gradient(ellipse 120% 100% at 50% 55%, transparent 30%, rgba(0,0,0,0.5) 100%)',
  // Soft pool of light where the table sits
  'radial-gradient(ellipse 88% 60% at 50% 46%, rgba(84,116,168,0.30) 0%, rgba(38,54,86,0.16) 45%, transparent 74%)',
].join(', ');

/**
 * Pure-CSS designed floor, painted UNDER the artwork. Zero network
 * dependency — this is what guarantees the page is never blank.
 */
export const DEFAULT_TABLE_BACKDROP = [
  // Fine diagonal weave — texture that survives any upscale
  'repeating-linear-gradient(45deg, rgba(255,255,255,0.014) 0px, rgba(255,255,255,0.014) 1px, transparent 1px, transparent 14px)',
  // Deep base gradient
  'linear-gradient(180deg, #101828 0%, #0b1424 45%, #060a12 100%)',
].join(', ');

/** Solid base colour — the last line of defence behind every layer. */
export const DEFAULT_TABLE_BACKDROP_COLOR = '#0a1020';

/**
 * Full `background-image` value for the table page: the selected design first,
 * the always-paints CSS backdrop underneath.
 *
 * @param bid stored background_id (unknown/empty ids fall back to midnight)
 */
export function resolveBackgroundLayers(bid?: string | null): string {
  const asset = resolveBackground(bid || 'midnight');
  // Paint order, top to bottom: ambience over artwork over the always-paints
  // CSS floor. Layers fail independently, so the floor survives any asset
  // problem and the ambience survives even that.
  return asset
    ? `${DEFAULT_TABLE_AMBIENCE}, url(${asset}), ${DEFAULT_TABLE_BACKDROP}`
    : `${DEFAULT_TABLE_AMBIENCE}, ${DEFAULT_TABLE_BACKDROP}`;
}

// Five layers: vignette, pool, artwork, weave, base. Only the weave tiles.
/** Matching background-size list. */
export const TABLE_BACKGROUND_SIZE = 'cover, cover, cover, auto, cover';
/** Matching background-position list. */
export const TABLE_BACKGROUND_POSITION =
  'center center, center center, center center, center center, center center';
/** Matching background-repeat list — only the weave tiles. */
export const TABLE_BACKGROUND_REPEAT = 'no-repeat, no-repeat, no-repeat, repeat, no-repeat';
