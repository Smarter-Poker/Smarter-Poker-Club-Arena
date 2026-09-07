/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THEME SETTINGS MODAL — Bible V8 §11.2
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Theme customization modal with:
 *   - Game type selector dropdown (ALL, NLH, FLH, 6+, PLO, etc.)
 *   - 5-tab layout (Themes, Table, Buttons, Background, Cards)
 *   - Three free choices per category; premium via VIP or permanent purchase
 *   - Per-game-type persistence via user_theme_settings table
 *
 * Bible V8 §11.2.4: Stored in user_theme_settings table
 *   Schema: user_id, game_type, theme_id, table_id, button_id, background_id, cards_id
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  TABLE_SKINS,
  TABLE_BACKGROUNDS,
  TABLE_BACKGROUND_IDS,
  TABLE_SKIN_THUMBNAILS,
  TABLE_BACKGROUND_THUMBNAILS,
} from '../../assets/tableAssets';
import {
  TABLE_FELT_CATALOG,
  isFeltUnlocked,
  normalizeFeltId,
  normalizeBackgroundId,
  THEME_PRESET_BUNDLES,
  THEME_PRESET_CATALOG,
} from '../../lib/tableTheme';
import {
  CardBack,
  normalizeCardBack,
  CARD_BACK_CATALOG,
  cardBackDesign,
  isCardBackUnlocked,
} from './CardImage';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import './ControlThemeTokens.css';
import './ThemeSettingsModal.css';
import { reportError } from '../../utils/errorReporter';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { avatarService } from '../../services/AvatarService';
import TableStudioGameplayPreview from './TableStudioGameplayPreview';
import { applyTableAppearance, type AppearancePatch } from '../../lib/applyTableAppearance';
import {
  canonicalGameType,
  pickThemeRow,
  useUserThemeRealtime,
} from '../../hooks/useUserThemeSettings';
import { persistInterfaceTheme, type InterfaceTheme } from '../../lib/persistInterfaceTheme';
import { masterBus } from '../../core/MasterBus';
import { useWalletStore } from '../../stores/useWalletStore';
import { DiamondTopUpModal } from '../vip/DiamondTopUpModal';
import {
  useTableStudioCollections,
  type TableStudioLoadout,
} from '../../hooks/useTableStudioCollections';
import {
  TABLE_STUDIO_CHECKOUT_RETURN_PARAMS,
  clearTableStudioCheckoutIntent,
  clearTableStudioCheckoutReturnUrl,
  readTableStudioCheckoutIntent,
  rememberTableStudioCheckoutIntent,
  type TableStudioCheckoutResult,
} from '../../lib/tableStudioCheckoutResume';
import { recordCustomizationOperation } from '../../services/CustomizationOperationsTelemetry';
import { retryFetch } from '../../utils/retryFetch';
import {
  clearSessionPurchaseRequestId,
  readOrCreateSessionPurchaseRequestId,
} from '../../utils/sessionPurchaseRequest';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ThemeSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  /** Whether the user is a VIP member (binary: free or VIP) */
  isVip: boolean;
  /** Set only by the global Stripe-return owner; hidden modal copies stay idle. */
  checkoutReturnResult?: TableStudioCheckoutResult | null;
}

type ThemeSelection = Omit<TableStudioLoadout, 'name' | 'saved_at'>;

type ThemeTab = 'themes' | 'table' | 'button' | 'background' | 'cards';
type BackgroundGroup = 'places-rooms' | 'skins';
type AssetFilter = 'all' | 'free' | 'vip' | 'favorites' | 'recent';

/**
 * Table Studio opens several independent, security-sensitive reads at once.
 * PostgREST can briefly answer PGRST002 while its schema cache reconnects;
 * treating that one response as permanent leaves the editor locked until the
 * player manually retries every panel. Keep the retry window bounded and
 * short enough that the modal still reports a real outage promptly.
 */
const STUDIO_READ_RETRY = { maxRetries: 4, baseDelayMs: 500 } as const;

interface ThemeAsset {
  id: string;
  name: string;
  thumbnail: string; // CSS gradient or image URL for preview
  /** Whether the asset requires VIP access */
  vipOnly: boolean;
}

interface PendingAssetPurchase {
  userId: string;
  id: string;
  name: string;
  price: number;
  tab: ThemeTab;
  feature: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — Bible V8 §11.2.1 Game Types
// ═══════════════════════════════════════════════════════════════════════════════

// Game-type categories for per-game-type theming. Must match the platform's
// approved variants — FIX 116 removed FLH / FLO / MIXED (dead variants), so
// they no longer appear here (a user could otherwise save a theme against a
// game type that can never be played). Pineapple is an approved variant.
const GAME_TYPES = ['ALL', 'NLH', '6+', 'PLO', 'PINEAPPLE', 'MTT', 'SNG'] as const;

/* Dan 2026-08-21: 'SNG' is what the DB stores and what user_theme_settings is
   keyed on, so the VALUE must not change - only what a player reads. Heads Up
   is the product's name for it. */
const GAME_TYPE_LABELS: Record<string, string> = {
  SNG: 'Heads Up',
};

const TABS: { key: ThemeTab; label: string }[] = [
  { key: 'themes', label: 'Looks' },
  { key: 'table', label: 'Tables' },
  { key: 'background', label: 'Scenes' },
  { key: 'button', label: 'Buttons' },
  { key: 'cards', label: 'Cards' },
];

const TAB_DESCRIPTIONS: Record<ThemeTab, string> = {
  themes: 'Complete, coordinated table looks',
  table: 'The felt and rail at the center of play',
  button: 'Dealer marker and action-control finish',
  background: 'The room surrounding your table',
  cards: 'The design shown on every face-down card',
};

// ═══════════════════════════════════════════════════════════════════════════════
// THEME ASSETS — Bible V8 §11.2.2
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Display name + VIP flag per background. The ORDER and the very existence of
 * a tile come from TABLE_BACKGROUND_IDS (the same registry TablePage paints
 * from), so this map only supplies the labels. An id here that the registry
 * dropped simply stops appearing; an id the registry gains appears with a
 * title-cased name until someone gives it a nicer one.
 */
const BACKGROUND_META: Record<string, { name: string; vipOnly: boolean }> = {
  midnight: { name: 'Midnight', vipOnly: false },
  royal_indigo: { name: 'Royal Indigo', vipOnly: false },
  emerald_room: { name: 'Emerald Room', vipOnly: false },
  crimson_lounge: { name: 'Crimson Lounge', vipOnly: true },
  ocean_abyss: { name: 'Ocean Abyss', vipOnly: true },
  golden_dusk: { name: 'Golden Dusk', vipOnly: true },
  galaxy: { name: 'Galaxy', vipOnly: true },
  carbon_grid: { name: 'Carbon Grid', vipOnly: true },
  ice_frost: { name: 'Ice Frost', vipOnly: true },
  jade_neon: { name: 'Jade Neon', vipOnly: true },
  place_las_vegas: { name: 'Las Vegas', vipOnly: true },
  place_paris: { name: 'Paris', vipOnly: true },
  place_london: { name: 'London', vipOnly: true },
  place_tokyo: { name: 'Tokyo', vipOnly: true },
  place_dubai: { name: 'Dubai', vipOnly: true },
  place_sydney: { name: 'Sydney Harbour', vipOnly: true },
  place_rio: { name: 'Rio De Janeiro', vipOnly: true },
  place_santorini: { name: 'Santorini', vipOnly: true },
  place_new_york: { name: 'New York', vipOnly: true },
  place_monaco: { name: 'Monte Carlo', vipOnly: true },
  skin_shadow_suits: { name: 'Shadow Suits', vipOnly: true },
  skin_gilded_fall: { name: 'Gilded Fall', vipOnly: true },
  skin_crimson_damask: { name: 'Crimson Damask', vipOnly: true },
  skin_graphite_embossed: { name: 'Graphite Embossed', vipOnly: true },
  skin_obsidian_micro: { name: 'Obsidian Micro', vipOnly: true },
  skin_emerald_argyle: { name: 'Emerald Argyle', vipOnly: true },
  skin_ultraviolet_suits: { name: 'Ultraviolet Suits', vipOnly: true },
  skin_black_gold_chips: { name: 'Black Gold Chips', vipOnly: true },
  skin_golden_sparks: { name: 'Golden Sparks', vipOnly: true },
  skin_platinum_deco: { name: 'Platinum Deco', vipOnly: true },
};

export const BACKGROUND_SKIN_IDS = new Set([
  'skin_shadow_suits',
  'skin_gilded_fall',
  'skin_crimson_damask',
  'skin_graphite_embossed',
  'skin_obsidian_micro',
  'skin_emerald_argyle',
  'skin_ultraviolet_suits',
  'skin_black_gold_chips',
  'skin_golden_sparks',
  'skin_platinum_deco',
]);

const BACKGROUND_FALLBACK_GRADIENT = 'radial-gradient(ellipse at 50% 35%, #2c323c, #0a0c10)';

const BACKGROUND_ASSETS: ThemeAsset[] = TABLE_BACKGROUND_IDS.map((id) => ({
  id,
  name:
    BACKGROUND_META[id]?.name ?? id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  thumbnail: BACKGROUND_FALLBACK_GRADIENT,
  vipOnly: BACKGROUND_META[id]?.vipOnly ?? false,
}));

/**
 * FELTS AND CARD BACKS COME FROM THE SHARED CATALOGUES (2026-08-25).
 *
 * Both lists used to be typed out here as well as in the other picker that
 * sells the same thing, and every time this repo has fixed one copy the other
 * has gone on being wrong for days. Generating them means:
 *
 *   - a felt tile cannot exist unless a skin file exists behind it (the old
 *     TableFeltSelector offered five ids that were not skins at all, every one
 *     of which painted classic green, plus one mislabelled alias);
 *   - a card-back tile cannot exist unless artwork exists for it, and the four
 *     designs that were shipped but never offered anywhere — diamond, dragon,
 *     galaxy, neon — now appear here on their own.
 */
const TABLE_ASSETS: ThemeAsset[] = TABLE_FELT_CATALOG.map((felt) => ({
  id: felt.id,
  name: felt.name,
  thumbnail: felt.thumbnail,
  vipOnly: felt.tier === 'vip',
}));

const CARD_ASSETS: ThemeAsset[] = CARD_BACK_CATALOG.map((design) => ({
  id: design.id,
  name: design.name,
  // Only a fallback: renderAssetPreview draws the real <CardBack/>.
  thumbnail: BACKGROUND_FALLBACK_GRADIENT,
  vipOnly: design.tier !== 'standard',
}));

export const THEME_PRESETS: ThemeAsset[] = THEME_PRESET_CATALOG.map((preset) => ({
  id: preset.id,
  name: preset.name,
  thumbnail: preset.thumbnail,
  vipOnly: preset.tier === 'vip',
}));

export const BUTTON_ASSETS: ThemeAsset[] = [
  {
    // FIX-D7 2026-07-19: the app default is 'classic-white' but it wasn't a
    // selectable tile, so a fresh user / Reset showed no button highlighted.
    // Add it (matches the [data-button-theme='classic-white'] CSS token).
    id: 'classic-white',
    name: 'White D',
    thumbnail: 'linear-gradient(145deg, #ffffff 0%, #e8e8e8 50%, #d0d0d0 100%)',
    vipOnly: false,
  },
  {
    id: 'red-d-gear',
    name: 'Red D',
    thumbnail: 'linear-gradient(135deg, #c62828, #e53935)',
    vipOnly: false,
  },
  {
    id: 'gray-d-gear',
    name: 'Gray D',
    thumbnail: 'linear-gradient(135deg, #616161, #757575)',
    vipOnly: false,
  },
  {
    id: 'blue-crystal',
    name: 'Blue Crystal',
    thumbnail: 'linear-gradient(135deg, #1565c0, #42a5f5)',
    vipOnly: true,
  },
  {
    id: 'gold-star',
    name: 'Gold Star',
    thumbnail: 'linear-gradient(135deg, #f57f17, #fbc02d)',
    vipOnly: true,
  },
  {
    id: 'sports-themed',
    name: 'Sports',
    thumbnail: 'linear-gradient(135deg, #2ea043, #4dc660)',
    vipOnly: true,
  },
  {
    id: 'jade-seal',
    name: 'Jade Seal',
    thumbnail: 'linear-gradient(145deg, #a7e5c2, #176344)',
    vipOnly: true,
  },
  {
    id: 'amethyst-chip',
    name: 'Amethyst Chip',
    thumbnail: 'linear-gradient(145deg, #d4b8ff, #5b2d91)',
    vipOnly: true,
  },
  {
    id: 'carbon-ion',
    name: 'Carbon Ion',
    thumbnail: 'linear-gradient(145deg, #263238, #101416)',
    vipOnly: true,
  },
  {
    id: 'ocean-pearl',
    name: 'Ocean Pearl',
    thumbnail: 'linear-gradient(145deg, #eaf8ff, #4da6c8)',
    vipOnly: true,
  },
];

const THEME_ASSETS: Record<ThemeTab, ThemeAsset[]> = {
  themes: THEME_PRESETS,
  table: TABLE_ASSETS,
  button: BUTTON_ASSETS,
  // Dan 2026-08-18: ten standalone designed backgrounds (see
  // src/assets/backgrounds/, applied via TABLE_BACKGROUNDS in TablePage).
  //
  // Dan 2026-08-20: GENERATED from TABLE_BACKGROUND_IDS rather than typed out
  // a second time. The tiles render the real room artwork (renderAssetPreview
  // reads TABLE_BACKGROUNDS); the `thumbnail` gradient below is only the
  // fallback for an id with no artwork behind it. Deriving the list from the
  // registry means that fallback can never be what a player actually sees:
  // an id can no longer appear here without artwork existing for it, and a
  // newly added background shows up in the picker on its own.
  background: BACKGROUND_ASSETS,
  cards: CARD_ASSETS,
};

const TAB_TO_FIELD: Record<ThemeTab, keyof ThemeSelection> = {
  themes: 'theme_id',
  table: 'table_id',
  button: 'button_id',
  background: 'background_id',
  cards: 'cards_id',
};

const DEFAULT_SELECTION: ThemeSelection = {
  theme_id: 'default-dark',
  table_id: 'classic_green',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
};

function normalizeStoredSelection(value: unknown): ThemeSelection | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ThemeSelection>;
  if (!raw.table_id || !raw.button_id || !raw.background_id || !raw.cards_id) return null;
  return {
    theme_id: raw.theme_id || DEFAULT_SELECTION.theme_id,
    table_id: normalizeFeltId(raw.table_id),
    button_id: BUTTON_ASSETS.some((asset) => asset.id === raw.button_id)
      ? raw.button_id
      : DEFAULT_SELECTION.button_id,
    background_id: normalizeBackgroundId(raw.background_id),
    cards_id: normalizeCardBack(raw.cards_id),
  };
}

function storefrontFeature(tab: ThemeTab, assetId: string): string {
  return tab === 'cards'
    ? `card_back_${normalizeCardBack(assetId)}`
    : `studio:${TAB_TO_FIELD[tab]}:${assetId}`;
}

/**
 * Can this player use this asset?
 *
 * Dan 2026-08-25: "a VIP/premium item must not be selectable by someone who
 * does not own it, and an owned item must not be gated."
 *
 * The second half is the one that was broken. This modal gated every paid
 * design on VIP status ALONE, while the diamond store next to it gated the
 * SAME designs on a purchase alone. So a player who had spent 150 diamonds on
 * Premium Gold in the store opened Theme Settings and found it padlocked, with
 * an invitation to buy VIP to get the thing they had already bought.
 *
 * Card backs route through the shared legacy-receipt rule. Every category also
 * accepts its exact theme_asset_unlocks row, delivered atomically by Table
 * Studio checkout, club rewards, or a complete preset grant.
 */
function canAccessAsset(
  tab: ThemeTab,
  assetId: string,
  isVip: boolean,
  vipOnly: boolean,
  ownedCardBacks: readonly string[],
  ownedThemeAssets: readonly string[]
): boolean {
  if (!vipOnly) return true; // Free items always accessible
  if (ownedThemeAssets.includes(`${TAB_TO_FIELD[tab]}:${assetId}`)) return true;
  if (tab === 'cards') return isCardBackUnlocked(assetId, { isVip, owned: ownedCardBacks });
  if (tab === 'table') return isFeltUnlocked(assetId, { isVip });
  return isVip; // VIP-only items require VIP status
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render a REAL preview for one option.
 *
 * Dan 2026-08-18: "the themes and tables should show the actual theme and table
 * layouts not just a color. same for buttons, show the actual button in the
 * settings and same for cards."
 *
 * Per tab, what "real" means:
 *   table       the actual transparent table composite, fully contained
 *   background  the actual room .jpg
 *   button      the live dealer marker plus the Fold / Check / Raise control
 *               finish driven by the same data-button-theme as gameplay
 *   cards       a real <CardBack>, the same component the felt renders
 *   themes      a composite mini-table: the preset's own table skin with its
 *               background behind it, which is the only honest way to show
 *               what a preset actually does (it is a bundle of the others)
 *
 * Anything without a real asset falls back to the original gradient rather
 * than rendering an empty box.
 */
function renderAssetPreview(tab: ThemeTab, asset: ThemeAsset) {
  const fallback = <div className="theme-asset__swatch" style={{ background: asset.thumbnail }} />;

  if (tab === 'table') {
    const src = TABLE_SKIN_THUMBNAILS[asset.id] || TABLE_SKINS[asset.id];
    return src ? (
      <img
        className="theme-asset__img theme-asset__img--table"
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
      />
    ) : (
      fallback
    );
  }

  if (tab === 'background') {
    const src = TABLE_BACKGROUND_THUMBNAILS[asset.id] || TABLE_BACKGROUNDS[asset.id];
    return src ? (
      <div className="theme-asset__image-stage">
        <img className="theme-asset__ambient" src={src} alt="" loading="lazy" decoding="async" />
        <img
          className="theme-asset__img theme-asset__img--background"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
        />
      </div>
    ) : (
      fallback
    );
  }

  if (tab === 'button') {
    // The real dealer marker and action-control finish, both driven by the
    // same attribute the table sets.
    return (
      <div className="theme-asset__btnstage" data-button-theme={asset.id}>
        <span className="theme-asset__dealerbtn">D</span>
        <span className="theme-asset__actionset" aria-hidden="true">
          <i>F</i>
          <i>C</i>
          <i>R</i>
        </span>
      </div>
    );
  }

  if (tab === 'cards') {
    // The real CardBack component. normalizeCardBack maps the Cards-tab ids
    // onto actual designs, so a preview can never be a blank rectangle.
    return (
      <div className="theme-asset__cardstage">
        <CardBack style={normalizeCardBack(asset.id)} size="sm" />
        <CardBack style={normalizeCardBack(asset.id)} size="sm" />
      </div>
    );
  }

  // themes: a preset bundles a table + background, so show both.
  // THEME_PRESET_BUNDLES holds Partial<ThemeSelection>, so both ids are
  // optional - a preset may set only some of the five slots.
  const bundle = THEME_PRESET_BUNDLES[asset.id];
  // A preset naming a background id that isn't in the registry (renamed or
  // removed design) used to yield `undefined` and render a blank preview.
  // Fall back to the default backdrop artwork so a preview tile is never empty.
  const bgSrc = bundle?.background_id
    ? TABLE_BACKGROUND_THUMBNAILS[bundle.background_id] ||
      TABLE_BACKGROUNDS[bundle.background_id] ||
      TABLE_BACKGROUND_THUMBNAILS.midnight ||
      TABLE_BACKGROUNDS.midnight
    : undefined;
  const tableSrc = bundle?.table_id
    ? TABLE_SKIN_THUMBNAILS[bundle.table_id] ||
      TABLE_SKINS[bundle.table_id] ||
      TABLE_SKIN_THUMBNAILS.classic_green ||
      TABLE_SKINS.classic_green
    : undefined;
  if (!bgSrc && !tableSrc) return fallback;
  return (
    <div className="theme-asset__scene">
      {bgSrc && (
        <>
          <img
            className="theme-asset__scene-ambient"
            src={bgSrc}
            alt=""
            loading="lazy"
            decoding="async"
          />
          <img
            className="theme-asset__scene-bg"
            src={bgSrc}
            alt=""
            loading="lazy"
            decoding="async"
          />
        </>
      )}
      {tableSrc && (
        <img
          className="theme-asset__scene-table"
          src={tableSrc}
          alt=""
          loading="lazy"
          decoding="async"
        />
      )}
    </div>
  );
}

/** A saved look should be recognizable before it is equipped. The locker uses
 * the same production artwork and button tokens as the full gameplay preview,
 * compressed into a casino plaque-sized cartridge rather than a generic color
 * chip or numbered database slot. */
function renderLoadoutPreview(loadout: ThemeSelection) {
  const backgroundId = normalizeBackgroundId(loadout.background_id);
  const tableId = normalizeFeltId(loadout.table_id);
  const background =
    TABLE_BACKGROUND_THUMBNAILS[backgroundId] ||
    TABLE_BACKGROUNDS[backgroundId] ||
    TABLE_BACKGROUND_THUMBNAILS.midnight ||
    TABLE_BACKGROUNDS.midnight;
  const table =
    TABLE_SKIN_THUMBNAILS[tableId] ||
    TABLE_SKINS[tableId] ||
    TABLE_SKIN_THUMBNAILS.classic_green ||
    TABLE_SKINS.classic_green;
  const buttonFinish =
    BUTTON_ASSETS.find((asset) => asset.id === loadout.button_id)?.thumbnail ||
    BUTTON_ASSETS[0].thumbnail;

  return (
    <div
      className="theme-loadout__scene"
      data-button-theme={loadout.button_id}
      style={{ '--loadout-dealer-bg': buttonFinish } as React.CSSProperties}
    >
      {background && (
        <>
          <img className="theme-loadout__ambient" src={background} alt="" decoding="async" />
          <img className="theme-loadout__background" src={background} alt="" decoding="async" />
        </>
      )}
      {table && <img className="theme-loadout__table" src={table} alt="" decoding="async" />}
      <span className="theme-loadout__dealer" aria-hidden="true">
        D
      </span>
      <span className="theme-loadout__cards" aria-hidden="true">
        <CardBack style={normalizeCardBack(loadout.cards_id)} size="sm" />
        <CardBack style={normalizeCardBack(loadout.cards_id)} size="sm" />
      </span>
    </div>
  );
}

export function ThemeSettingsModal({
  isOpen,
  onClose,
  userId,
  isVip,
  checkoutReturnResult = null,
}: ThemeSettingsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const vipPromptRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<ThemeTab>('themes');
  const [backgroundGroup, setBackgroundGroup] = useState<BackgroundGroup>('places-rooms');
  const [gameType, setGameType] = useState<string>('ALL');
  const [selection, setSelection] = useState<ThemeSelection>({ ...DEFAULT_SELECTION });
  const [saving, setSaving] = useState(false);
  const [previewFinalTable, setPreviewFinalTable] = useState(false);
  const [previewAvatars, setPreviewAvatars] = useState<string[]>([]);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [assetSearch, setAssetSearch] = useState('');
  const collections = useTableStudioCollections(isOpen, userId);
  const appearanceRealtime = useUserThemeRealtime(userId, isOpen);
  /** Card backs bought with diamonds in the store. See canAccessAsset. */
  const [ownedCardBacks, setOwnedCardBacks] = useState<string[]>([]);
  /** Every category-specific entitlement issued by rewards, clubs or checkout. */
  const [ownedThemeAssets, setOwnedThemeAssets] = useState<string[]>([]);
  const [assetPrices, setAssetPrices] = useState<Record<string, number>>({});
  const [pricingState, setPricingState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [pricingRevision, setPricingRevision] = useState(0);
  const [pendingAssetPurchaseState, setPendingAssetPurchase] =
    useState<PendingAssetPurchase | null>(null);
  const pendingAssetPurchase =
    pendingAssetPurchaseState?.userId === userId ? pendingAssetPurchaseState : null;
  const [purchaseBusyUserId, setPurchaseBusyUserId] = useState<string | null>(null);
  const purchaseBusy = purchaseBusyUserId === userId;
  const [diamondStoreUserId, setDiamondStoreUserId] = useState<string | null>(null);
  const diamondStoreOpen = diamondStoreUserId === userId && Boolean(userId);
  const [pendingLoadoutClear, setPendingLoadoutClear] = useState<number | null>(null);
  const purchaseBusyRef = useRef(false);
  const assetPurchaseGenerationRef = useRef(0);
  const [themeLoadState, setThemeLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [themeLoadRevision, setThemeLoadRevision] = useState(0);
  const [ownershipState, setOwnershipState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  );
  const [ownershipRevision, setOwnershipRevision] = useState(0);
  const [entitlementRealtimeState, setEntitlementRealtimeState] = useState<
    'local' | 'connecting' | 'live' | 'error'
  >('local');
  const [entitlementRealtimeRevision, setEntitlementRealtimeRevision] = useState(0);
  const [checkoutReturn, setCheckoutReturn] = useState<TableStudioCheckoutResult | null>(
    checkoutReturnResult
  );
  const [checkoutBalanceSyncUserId, setCheckoutBalanceSyncUserId] = useState<string | null>(null);
  const checkoutBalanceSyncing = checkoutBalanceSyncUserId === userId && Boolean(userId);
  const checkoutPollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [modeSaving, setModeSaving] = useState(false);
  const uiMode = useSettingsStore((state) => state.theme);
  const setUiMode = useSettingsStore((state) => state.setTheme);
  const diamonds = useWalletStore((state) => state.diamonds);
  const loadDiamonds = useWalletStore((state) => state.loadDiamonds);
  const modeRevisionRef = useRef(0);

  // The live selection, readable from a callback without making every callback
  // depend on it. handleSave needs the value it is replacing so it can put it
  // back if the write fails.
  const selectionRef = useRef(selection);
  const gameTypeRef = useRef(gameType);
  gameTypeRef.current = gameType;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const assetPurchaseUserRef = useRef(userId);
  if (assetPurchaseUserRef.current !== userId) {
    assetPurchaseUserRef.current = userId;
    assetPurchaseGenerationRef.current += 1;
    purchaseBusyRef.current = false;
  }
  const ownershipScopeRef = useRef<string | null>(null);
  const ownershipRequestRef = useRef(0);
  const themeLoadScopeRef = useRef<string | null>(null);
  const themeLoadRequestRef = useRef(0);
  const themeLoadReadyScopeRef = useRef<string | null>(null);
  const selectionMutationRevisionRef = useRef(0);
  const pendingSavesRef = useRef(0);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const stopCheckoutBalancePolling = useCallback(() => {
    checkoutPollTimersRef.current.forEach(clearTimeout);
    checkoutPollTimersRef.current = [];
    setCheckoutBalanceSyncUserId(null);
  }, []);

  useEffect(() => {
    stopCheckoutBalancePolling();
    setPendingAssetPurchase(null);
    setDiamondStoreUserId(null);
    setPurchaseBusyUserId(null);
    purchaseBusyRef.current = false;
  }, [stopCheckoutBalancePolling, userId]);

  useEffect(() => stopCheckoutBalancePolling, [stopCheckoutBalancePolling]);

  const replaceSelection = useCallback((next: ThemeSelection) => {
    selectionMutationRevisionRef.current += 1;
    selectionRef.current = next;
    setSelection(next);
  }, []);

  // Keep an already-open studio synchronized with every other appearance
  // writer. The gameplay table already consumes this discrete event; without
  // the matching editor subscription a card back changed from /settings (or a
  // second customization surface) repainted the felt while this modal kept the
  // old tile selected. Only the same account and exact editor bucket may touch
  // the form — an ALL change must not overwrite a PLO-specific row being
  // edited, even though gameplay may use ALL as a fallback.
  useEffect(() => {
    if (!isOpen) return undefined;
    return masterBus.subscribe('UI_THEME_CHANGED', (event) => {
      const body = event.payload;
      if (body.userId && body.userId !== userId) return;
      if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) return;
      if (canonicalGameType(body.key) !== gameType) return;

      const raw = body.value as Partial<ThemeSelection>;
      const patch: Partial<ThemeSelection> = {};
      if (
        typeof raw.theme_id === 'string' &&
        THEME_PRESETS.some((item) => item.id === raw.theme_id)
      ) {
        patch.theme_id = raw.theme_id;
      }
      if (typeof raw.table_id === 'string') patch.table_id = normalizeFeltId(raw.table_id);
      if (
        typeof raw.button_id === 'string' &&
        BUTTON_ASSETS.some((item) => item.id === raw.button_id)
      ) {
        patch.button_id = raw.button_id;
      }
      if (typeof raw.background_id === 'string') {
        patch.background_id = normalizeBackgroundId(raw.background_id);
      }
      if (typeof raw.cards_id === 'string') patch.cards_id = normalizeCardBack(raw.cards_id);
      if (!Object.keys(patch).length) return;

      setSelection((current) => {
        const next = { ...current, ...patch };
        selectionMutationRevisionRef.current += 1;
        selectionRef.current = next;
        return next;
      });
    });
  }, [gameType, isOpen, userId]);

  useEffect(() => {
    if (!isOpen) return undefined;
    // DiamondTopUpModal becomes the only active dialog while its secure
    // checkout catalog is open. Suspending this trap prevents the Studio
    // behind it from stealing Tab/Escape and focus.
    if (diamondStoreOpen) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const activeDialog = pendingAssetPurchase ? vipPromptRef.current : modalRef.current;
    const focusable = () =>
      Array.from(
        activeDialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'
        ) || []
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (purchaseBusyRef.current) return;
        if (pendingAssetPurchase) setPendingAssetPurchase(null);
        else onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [diamondStoreOpen, isOpen, onClose, pendingAssetPurchase]);

  useEffect(() => {
    if (isOpen) return;
    setDiamondStoreUserId(null);
    setPendingAssetPurchase(null);
    setPendingLoadoutClear(null);
  }, [isOpen]);

  // The preview uses the same production library as AvatarGallery. No preview-
  // only portraits are bundled or generated. The first six stable library
  // entries become the representative table seats; a failed library request
  // leaves neutral loading silhouettes instead of inventing replacement art.
  useEffect(() => {
    if (!isOpen) return undefined;
    let mounted = true;
    avatarService
      .getAvatarLibraryResult(userId)
      .then(({ avatars }) => {
        if (!mounted) return;
        setPreviewAvatars(avatars.slice(0, 6).map((avatar) => avatar.thumbUrl || avatar.imageUrl));
      })
      .catch((error) => reportError(error, 'ThemeSettingsModal.Avatar_preview_load_failed'));
    return () => {
      mounted = false;
    };
  }, [isOpen, userId]);

  // ── Which premium assets does this player actually own? ──
  // A club redemption and a VIP-points reward now issue category-specific
  // rows for the complete preset bundle. Reading only feature_purchases made
  // those legitimately purchased felts/buttons/backgrounds look VIP-locked.
  useEffect(() => {
    const nextScope = isOpen ? userId || 'anonymous' : null;
    const scopeChanged = ownershipScopeRef.current !== nextScope;
    ownershipScopeRef.current = nextScope;
    if (scopeChanged) {
      setOwnedCardBacks([]);
      setOwnedThemeAssets([]);
    }
    if (!isOpen) {
      ownershipRequestRef.current += 1;
      setOwnershipState('idle');
      return undefined;
    }
    if (!userId) {
      ownershipRequestRef.current += 1;
      setOwnershipState('ready');
      return undefined;
    }
    const requestedScope = nextScope;
    const requestId = ++ownershipRequestRef.current;
    // Revisions are background reconciliations. Clearing verified ownership or
    // dropping the Studio back into a loading state on every entitlement burst
    // makes paid designs visibly re-lock and can let a later stale read erase
    // inserts that were already delivered. Only a new open/user scope owns the
    // initial loading transition; every subsequent snapshot is merged in place.
    if (scopeChanged) setOwnershipState('loading');
    Promise.all([
      retryFetch(
        () =>
          supabase
            .from('feature_purchases')
            .select('feature')
            .eq('user_id', userId)
            .like('feature', 'card_back_%')
            .then((result) => result),
        STUDIO_READ_RETRY
      ),
      retryFetch(
        () =>
          supabase
            .from('theme_asset_unlocks')
            .select('category, asset_id')
            .eq('user_id', userId)
            .then((result) => result),
        STUDIO_READ_RETRY
      ),
    ])
      .then(([cardBacks, assets]) => {
        // Ownership is permanent and snapshots are merged, so an older read is
        // still safe to apply after a newer reconciliation starts. Its status is
        // not authoritative, though, and a response for a closed/different user
        // must never touch the current Studio.
        if (ownershipScopeRef.current !== requestedScope) return;
        if (cardBacks.error || assets.error) {
          // Not fatal, and not silently swallowed either: a failure here means
          // paid designs read as locked, so it has to be visible somewhere.
          reportError(
            cardBacks.error || assets.error,
            'ThemeSettingsModal.Cosmetic_ownership_load_failed'
          );
          if (requestId === ownershipRequestRef.current) setOwnershipState('error');
          return;
        }
        // Merge the authoritative snapshot into any INSERT events that arrived
        // while this read was in flight. Replacing either array here opens a
        // second race: an entitlement can be delivered after the SELECT snapshot
        // was taken but before React applies its result, and the stale snapshot
        // would put the lock back on that just-purchased design.
        const purchasedCardBacks = (cardBacks.data || []).map((r: { feature: string }) =>
          r.feature.replace('card_back_', '')
        );
        const unlockedAssets = (assets.data || []).map(
          (row: { category: string; asset_id: string }) => `${row.category}:${row.asset_id}`
        );
        setOwnedCardBacks((current) => [...new Set([...current, ...purchasedCardBacks])]);
        setOwnedThemeAssets((current) => [...new Set([...current, ...unlockedAssets])]);
        // Ownership only grows and every same-scope snapshot is merged. A newer
        // two-second reconciliation may already be in flight when this one
        // succeeds, especially on a slow mobile/database connection. Requiring
        // this response to still be the newest request starves `ready` forever
        // when each SELECT takes longer than the cadence: the Studio stays
        // aria-busy even though valid snapshots keep arriving. Any successful
        // response for the active user proves the ledger is readable; a later
        // current failure can still move the state back to error.
        setOwnershipState('ready');
      })
      .catch((error) => {
        if (ownershipScopeRef.current !== requestedScope) return;
        reportError(error, 'ThemeSettingsModal.Cosmetic_ownership_load_failed');
        if (requestId === ownershipRequestRef.current) setOwnershipState('error');
      });
    return undefined;
  }, [isOpen, userId, ownershipRevision]);

  // Prices are server truth. Every premium category has a permanent SKU; if
  // the catalog cannot be read, a paid tile stays visibly unavailable and we
  // never quote a local fallback that could disagree with checkout.
  useEffect(() => {
    if (!isOpen) return undefined;
    let mounted = true;
    setPricingState('loading');
    retryFetch(
      () =>
        supabase
          .from('feature_pricing')
          .select('feature, diamond_cost')
          .then((result) => result),
      STUDIO_READ_RETRY
    )
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          reportError(error, 'ThemeSettingsModal.Asset_pricing_load_failed');
          setAssetPrices({});
          setPricingState('error');
          return;
        }
        setAssetPrices(
          Object.fromEntries(
            (data || [])
              .filter(
                (row: { feature: string; diamond_cost: number }) =>
                  row.feature.startsWith('studio:') || row.feature.startsWith('card_back_')
              )
              .map(
                (row: { feature: string; diamond_cost: number }) =>
                  [row.feature, Number(row.diamond_cost)] as [string, number]
              )
              .filter(([, price]) => Number.isFinite(price) && price > 0)
          )
        );
        setPricingState('ready');
      })
      .catch((error) => {
        if (!mounted) return;
        reportError(error, 'ThemeSettingsModal.Asset_pricing_load_failed');
        setAssetPrices({});
        setPricingState('error');
      });
    return () => {
      mounted = false;
    };
  }, [isOpen, pricingRevision]);

  useEffect(() => {
    if (!isOpen || !userId) return undefined;
    void loadDiamonds(userId);
    return masterBus.subscribe('COSMETIC_OWNERSHIP_CHANGED', (event) => {
      if (event.payload.userId !== userId) return;
      if (event.payload.category === 'avatar') return;
      // Exact-category purchases can be merged in the same render, including
      // cross-tab broadcasts. Composite themes refresh because their one
      // receipt atomically delivers all five linked categories.
      if (event.payload.category !== 'theme_id' && event.payload.assetId) {
        const assetId = event.payload.assetId;
        if (event.payload.category === 'cards_id') {
          setOwnedCardBacks((current) =>
            current.includes(assetId) ? current : [...current, assetId]
          );
        }
        setOwnedThemeAssets((current) => {
          const key = `${event.payload.category}:${assetId}`;
          return current.includes(key) ? current : [...current, key];
        });
        return;
      }
      // Theme redemptions deliver five linked assets server-side, so refresh
      // the complete bundle rather than guessing its component ids here.
      setOwnershipRevision((revision) => revision + 1);
    });
  }, [isOpen, loadDiamonds, userId]);

  // A purchase made in another browser profile or on another device does not
  // travel through MasterBus. Follow the server-owned entitlement ledger so an
  // already-open Studio unlocks the exact tile as soon as the checkout
  // transaction commits. Card-back purchases land in this same ledger through
  // trg_deliver_card_back_entitlement, so one channel covers every category.
  useEffect(() => {
    if (!isOpen || !userId || typeof (supabase as { channel?: unknown }).channel !== 'function') {
      setEntitlementRealtimeState(userId ? 'error' : 'local');
      return undefined;
    }

    setEntitlementRealtimeState('connecting');
    let reconciliationTimer: ReturnType<typeof setTimeout> | null = null;
    const reconcileAfterBurst = () => {
      if (reconciliationTimer) clearTimeout(reconciliationTimer);
      reconciliationTimer = setTimeout(() => {
        reconciliationTimer = null;
        setOwnershipRevision((revision) => revision + 1);
      }, 250);
    };
    const channel = supabase
      .channel(`table-studio-entitlements:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'theme_asset_unlocks',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as { category?: unknown; asset_id?: unknown };
          if (typeof row.category !== 'string' || typeof row.asset_id !== 'string') return;
          if (!Object.values(TAB_TO_FIELD).includes(row.category as keyof ThemeSelection)) return;

          const category = row.category as keyof ThemeSelection;
          const assetId = row.asset_id;
          if (category === 'cards_id') {
            setOwnedCardBacks((current) =>
              current.includes(assetId) ? current : [...current, assetId]
            );
          }
          setOwnedThemeAssets((current) => {
            const key = `${category}:${assetId}`;
            return current.includes(key) ? current : [...current, key];
          });
          setOwnershipState('ready');
          masterBus.emit('COSMETIC_OWNERSHIP_CHANGED', {
            userId,
            category,
            assetId,
            source: 'realtime-entitlement',
          });
          // Postgres Changes is the fast path, not the source of truth. A
          // preset can commit six entitlement rows at once and a larger
          // checkout burst can exceed what a tab processes one event at a
          // time. Coalesce the burst, then reconcile the complete ledger so a
          // missed websocket frame cannot leave one paid tile locked.
          reconcileAfterBurst();
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Close the SELECT -> SUBSCRIBE gap before declaring the Studio live.
          // Purchases may commit after the initial ownership read but before
          // the websocket acknowledgement. A fresh snapshot, merged with any
          // events received meanwhile, makes that handoff lossless.
          setOwnershipState('loading');
          setOwnershipRevision((revision) => revision + 1);
          setEntitlementRealtimeState('live');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setEntitlementRealtimeState('error');
          reportError(
            new Error(`Table Studio entitlement channel ${status.toLowerCase()}`),
            'ThemeSettingsModal.Entitlement_realtime_failed'
          );
        }
      });

    return () => {
      if (reconciliationTimer) clearTimeout(reconciliationTimer);
      void supabase.removeChannel(channel);
    };
  }, [entitlementRealtimeRevision, isOpen, userId]);

  // Realtime transports are intentionally low-latency, not durable queues.
  // While the small Studio surface is open, a lightweight authoritative read
  // repairs the rare case where every notification in a burst was missed
  // (mobile sleep/wake, radio handoff, websocket backpressure). Immediate
  // events still update the tile in the same render; this two-second cadence is
  // only the bounded safety net and pauses when the page is hidden.
  useEffect(() => {
    if (!isOpen || !userId || entitlementRealtimeState !== 'live') return undefined;
    const reconcile = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setOwnershipRevision((revision) => revision + 1);
    };
    const interval = window.setInterval(reconcile, 2_000);
    window.addEventListener('focus', reconcile);
    window.addEventListener('online', reconcile);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('online', reconcile);
    };
  }, [entitlementRealtimeState, isOpen, userId]);

  // Stripe Checkout is a full-page redirect. Restore the exact design that
  // sent this player to the Diamond Store, but rebuild its price and feature
  // from the live catalog instead of trusting session storage. Webhook credit
  // can trail the redirect by several seconds, so refresh the server-owned
  // balance on the same bounded cadence used by the Marketplace return path.
  useEffect(() => {
    if (!isOpen || !checkoutReturn || !userId) return;
    const intent = readTableStudioCheckoutIntent(userId);
    if (!intent) {
      clearTableStudioCheckoutReturnUrl();
      setCheckoutReturn(null);
      toast.error('Your Previous Design Could Not Be Restored. Choose It Again To Continue.');
      return;
    }
    if (pricingState !== 'ready' || ownershipState !== 'ready') return;

    const asset = THEME_ASSETS[intent.tab].find((item) => item.id === intent.assetId);
    const feature = storefrontFeature(intent.tab, intent.assetId);
    const price = assetPrices[feature];
    if (!asset || !asset.vipOnly || !Number.isFinite(price) || price <= 0) {
      clearTableStudioCheckoutIntent();
      clearTableStudioCheckoutReturnUrl();
      setCheckoutReturn(null);
      toast.error('This Design Is No Longer Available For Purchase.');
      return;
    }

    setActiveTab(intent.tab);
    setAssetSearch('');
    if (intent.tab === 'background') {
      setBackgroundGroup(BACKGROUND_SKIN_IDS.has(intent.assetId) ? 'skins' : 'places-rooms');
    }

    if (
      canAccessAsset(
        intent.tab,
        intent.assetId,
        isVip,
        asset.vipOnly,
        ownedCardBacks,
        ownedThemeAssets
      )
    ) {
      clearTableStudioCheckoutIntent();
      clearTableStudioCheckoutReturnUrl();
      setCheckoutReturn(null);
      toast.info(`${asset.name} Is Already Unlocked And Ready To Equip.`);
      return;
    }

    setPendingAssetPurchase({
      userId,
      id: intent.assetId,
      name: asset.name,
      price,
      tab: intent.tab,
      feature,
    });
    clearTableStudioCheckoutIntent();
    clearTableStudioCheckoutReturnUrl();
    setCheckoutReturn(null);

    if (checkoutReturn === 'canceled') {
      toast.info('Checkout Canceled. No Charge Was Made; Your Design Is Still Waiting.');
      return;
    }

    setCheckoutBalanceSyncUserId(userId);
    toast.success(`Payment Received. Restoring ${asset.name}.`);
    const refresh = () => void loadDiamonds(userId, { force: true });
    refresh();
    checkoutPollTimersRef.current = [1_500, 5_000, 12_000].map((delay, index) =>
      setTimeout(() => {
        void loadDiamonds(userId, { force: true }).finally(() => {
          if (index === 2) {
            setCheckoutBalanceSyncUserId((current) => (current === userId ? null : current));
          }
        });
      }, delay)
    );
  }, [
    assetPrices,
    checkoutReturn,
    isOpen,
    isVip,
    loadDiamonds,
    ownedCardBacks,
    ownedThemeAssets,
    ownershipState,
    pricingState,
    toast,
    userId,
  ]);

  useEffect(() => {
    if (checkoutBalanceSyncing && pendingAssetPurchase && diamonds >= pendingAssetPurchase.price) {
      stopCheckoutBalancePolling();
    }
  }, [checkoutBalanceSyncing, diamonds, pendingAssetPurchase, stopCheckoutBalancePolling]);

  // Load existing theme for selected game type
  useEffect(() => {
    const nextScope = isOpen ? `${userId || 'anonymous'}:${canonicalGameType(gameType)}` : null;
    const scopeChanged = themeLoadScopeRef.current !== nextScope;
    themeLoadScopeRef.current = nextScope;
    if (scopeChanged) themeLoadReadyScopeRef.current = null;
    if (!isOpen) {
      themeLoadRequestRef.current += 1;
      setThemeLoadState('idle');
      return undefined;
    }
    if (!userId) {
      themeLoadRequestRef.current += 1;
      replaceSelection({ ...DEFAULT_SELECTION });
      themeLoadReadyScopeRef.current = nextScope;
      setThemeLoadState('ready');
      return undefined;
    }

    let mounted = true;
    const requestedScope = nextScope;
    const requestId = ++themeLoadRequestRef.current;
    const mutationRevision = selectionMutationRevisionRef.current;
    if (scopeChanged) setThemeLoadState('loading');
    const load = async () => {
      try {
        const { data, error } = await retryFetch(
          () =>
            supabase
              .from('user_theme_settings')
              .select(
                'game_type, theme_id, table_id, button_id, background_id, cards_id, updated_at'
              )
              .eq('user_id', userId)
              .then((result) => result),
          STUDIO_READ_RETRY
        );

        if (error) {
          // A FAILED READ IS NOT "YOU HAVE THE DEFAULT THEME" (2026-08-25).
          // This used to console.warn and return, leaving the grid showing
          // DEFAULT_SELECTION — indistinguishable from a player who really has
          // the defaults. They would then "correct" it, and the first tile they
          // touched would overwrite the theme they could not see.
          console.warn('[ThemeSettings] Load failed:', error.message);
          reportError(error, 'ThemeSettingsModal.Load_failed');
          if (
            mounted &&
            themeLoadScopeRef.current === requestedScope &&
            requestId === themeLoadRequestRef.current &&
            themeLoadReadyScopeRef.current !== requestedScope
          ) {
            setThemeLoadState('error');
            toast.error('Could Not Load Your Saved Theme. Try Again In A Moment.');
          }
          return;
        }

        if (
          mounted &&
          themeLoadScopeRef.current === requestedScope &&
          requestId === themeLoadRequestRef.current
        ) {
          // A reconciliation SELECT may have started immediately before a local
          // tap or a Realtime row arrived. Never let that older snapshot paint
          // over a newer visible choice; the next bounded cadence will read the
          // now-durable row. This is the appearance equivalent of the permanent
          // ownership ledger's monotonic merge.
          if (
            pendingSavesRef.current > 0 ||
            selectionMutationRevisionRef.current !== mutationRevision
          ) {
            if (themeLoadReadyScopeRef.current === requestedScope) setThemeLoadState('ready');
            return;
          }
          /* The reader and this editor now use the same precedence: exact
             bucket, then a legacy raw variant that canonicalises to it, then
             ALL. A stored `plo4` row can no longer paint the table while this
             modal confidently highlights unrelated defaults. */
          const row = pickThemeRow(data || [], gameType as (typeof GAME_TYPES)[number]);
          replaceSelection({
            theme_id: row?.theme_id || DEFAULT_SELECTION.theme_id,
            // Normalised for the same reason cards_id is: rows hold legacy
            // aliases ('dark-felt', 'diamond-pattern' are both live in
            // production) which paint correctly but match no tile, so the tab
            // looked like it had forgotten the player's choice.
            table_id: normalizeFeltId(row?.table_id || DEFAULT_SELECTION.table_id),
            button_id: row?.button_id || DEFAULT_SELECTION.button_id,
            background_id: normalizeBackgroundId(
              row?.background_id || DEFAULT_SELECTION.background_id
            ),
            // Dan 2026-08-20: normalise, or a row still holding one of the old
            // invented ids (standard-red, premium-platinum, ...) highlights no
            // tile at all and the tab looks like it forgot the user's choice.
            cards_id: normalizeCardBack(row?.cards_id || DEFAULT_SELECTION.cards_id),
          });
          themeLoadReadyScopeRef.current = requestedScope;
          setThemeLoadState('ready');
        }
      } catch (err) {
        console.warn('[ThemeSettings] Unexpected error:', err);
        reportError(err, 'ThemeSettingsModal.Load_failed');
        if (
          mounted &&
          themeLoadScopeRef.current === requestedScope &&
          requestId === themeLoadRequestRef.current &&
          themeLoadReadyScopeRef.current !== requestedScope
        ) {
          setThemeLoadState('error');
          toast.error('Could Not Load Your Saved Theme. Try Again In A Moment.');
        }
      }
    };

    load();
    return () => {
      mounted = false;
    };
    // `toast` is stable for the life of the provider; listing it would re-run
    // the load on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen,
    userId,
    gameType,
    replaceSelection,
    themeLoadRevision,
    appearanceRealtime.reconciliationRevision,
  ]);

  // Postgres Changes is a low-latency signal, not a durable queue. Keep the
  // open Studio's preview honest if a mobile radio handoff or a busy Realtime
  // connection drops the appearance event: one authoritative snapshot every
  // two seconds repairs the editor without reloading the page.
  //
  // Do this while the Studio is OPEN even when the document is backgrounded.
  // A second device/tab can miss one websocket frame while its Studio remains
  // mounted; pausing the only durable reconciliation merely because that page
  // is hidden leaves its preview stale indefinitely. This is one five-column
  // row read at most every two seconds, bounded to an open modal. Browsers may
  // throttle the timer, but the application must not disable it itself.
  // The request guard above prevents an older snapshot from rolling back a tap
  // or a newer event while the read is in flight.
  useEffect(() => {
    if (!isOpen || !userId || appearanceRealtime.state !== 'live') return undefined;
    const reconcile = () => {
      setThemeLoadRevision((revision) => revision + 1);
    };
    const interval = window.setInterval(reconcile, 2_000);
    window.addEventListener('focus', reconcile);
    window.addEventListener('online', reconcile);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('online', reconcile);
    };
  }, [appearanceRealtime.state, isOpen, userId]);

  const handleUiModeChange = useCallback(
    async (mode: InterfaceTheme) => {
      if (mode === uiMode) return;
      const previous = uiMode;
      const revision = ++modeRevisionRef.current;
      setUiMode(mode, userId || undefined);

      if (!userId) return;

      setModeSaving(true);
      const result = await persistInterfaceTheme(userId, mode);
      if (!result.ok && modeRevisionRef.current === revision) {
        setUiMode(previous, userId);
        toast.error('Could Not Save Interface Mode. Please Try Again.');
        reportError(result.error, 'ThemeSettingsModal.Interface_mode_save_failed');
      }
      if (modeRevisionRef.current === revision) setModeSaving(false);
    },
    [setUiMode, toast, uiMode, userId]
  );

  /**
   * APPLY NOW, PERSIST, AND UNDO IF THE PERSIST FAILED.
   *
   * Dan 2026-08-25: a selection must "actually change and update in real time
   * when selected" AND "need a success toast or save feature". Both, and they
   * have to stay consistent with each other:
   *
   *   1. the new selection is broadcast on the bus IMMEDIATELY, so the felt
   *      under the modal repaints on the tap rather than after a round trip;
   *   2. it is written to user_theme_settings;
   *   3. if that write fails the UI is put BACK — state, bus and all — and the
   *      failure is reported. It previously toasted the error while leaving the
   *      tile ticked and the table repainted, so the next time the player
   *      opened the modal their choice had silently reverted.
   */
  const handleSave = useCallback(
    async (patch: AppearancePatch, previous: AppearancePatch) => {
      /* Dan 2026-08-26: "if a user changes their avatar, deck color, table,
         background, button or anything else, it needs to change, save and
         update in real time."

         This used to be a bare `if (!userId) return;` — the single worst
         shape a guard can have here. HamburgerMenu mounts this modal with
         `userId={user?.id || ''}` (its own line 1532), so before auth
         resolves every tile tap set local state, drew a tick, emitted
         NOTHING and saved NOTHING, and said nothing about it. The player saw
         their pick land and the felt never moved — indistinguishable from
         the feature being broken.

         Now it tells them, and it does not paint a tick it cannot honour.
         The caller (`handleAssetSelect`) reverts its optimistic state on a
         false return. */
      if (!userId) {
        replaceSelection({ ...selectionRef.current, ...previous });
        toast.error('Please Sign In To Save Your Theme.');
        return false;
      }
      const savedFor = gameType;
      pendingSavesRef.current += 1;
      setSaving(true);
      const result = await applyTableAppearance(patch, {
        userId,
        gameType: savedFor,
        previous,
      });

      if (!result.ok) {
        /* Reconcile only fields the ordered writer actually rolled back, and
           only if this modal is still displaying the bucket that was saved.
           An older failed request must not erase a newer tap or a newly chosen
           game-type tab. */
        if (userIdRef.current === userId && gameTypeRef.current === savedFor && result.reverted) {
          const reverted = result.reverted;
          setSelection((current) => {
            const next = { ...current };
            for (const field of Object.keys(reverted) as (keyof ThemeSelection)[]) {
              if (current[field] === patch[field] && reverted[field]) {
                next[field] = reverted[field] as string;
              }
            }
            selectionRef.current = next;
            return next;
          });
        }
        toast.error('Could Not Save Your Theme. Please Try Again.');
        reportError(result.error, 'ThemeSettingsModal.Save_failed');
      } else {
        toast.success('Theme Applied');
      }
      pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
      if (pendingSavesRef.current === 0) setSaving(false);
      return result.ok;
    },
    [userId, gameType, toast, replaceSelection]
  );

  const applyAccessibleAsset = useCallback(
    async (tab: ThemeTab, assetId: string): Promise<boolean> => {
      const field = TAB_TO_FIELD[tab];
      let newSel: Partial<ThemeSelection> = {};

      if (tab === 'themes') {
        const bundle = THEME_PRESET_BUNDLES[assetId];
        newSel = { [field]: assetId, ...(bundle || {}) };
      } else {
        newSel = { [field]: assetId };
      }

      /* Optimistic, then honest: if the save could not happen at all (no
         signed-in user), put the tick back where it was rather than leaving
         the player looking at a selection the server never received. A
         FAILED write already restores `previous` inside handleSave. */
      const before = selectionRef.current;
      const next = { ...before, ...newSel };
      replaceSelection(next);
      const previousPatch: AppearancePatch = {};
      for (const field of Object.keys(newSel) as (keyof ThemeSelection)[]) {
        previousPatch[field] = before[field];
      }
      const recentKey = `${tab}:${assetId}`;
      collections.rememberRecent(recentKey);
      return handleSave(newSel, previousPatch);
    },
    [collections, handleSave, replaceSelection]
  );

  const handleAssetSelect = useCallback(
    (tab: ThemeTab, assetId: string, vipOnly: boolean) => {
      if (themeLoadState !== 'ready') return;
      if (vipOnly && !isVip && ownershipState !== 'ready') return;
      if (!canAccessAsset(tab, assetId, isVip, vipOnly, ownedCardBacks, ownedThemeAssets)) {
        const feature = storefrontFeature(tab, assetId);
        const price = assetPrices[feature];
        if (pricingState !== 'ready' || !Number.isFinite(price) || price <= 0) {
          toast.error('This Design Is Temporarily Unavailable For Purchase.');
          return;
        }
        const card = tab === 'cards' ? cardBackDesign(assetId) : null;
        const asset = THEME_ASSETS[tab].find((item) => item.id === assetId);
        setPendingAssetPurchase({
          userId,
          id: card?.id || assetId,
          name: card?.name || asset?.name || 'Premium Design',
          price,
          tab,
          feature,
        });
        return;
      }
      void applyAccessibleAsset(tab, assetId);
    },
    [
      applyAccessibleAsset,
      assetPrices,
      isVip,
      ownedCardBacks,
      ownedThemeAssets,
      ownershipState,
      pricingState,
      themeLoadState,
      toast,
      userId,
    ]
  );

  const openDiamondStoreForPending = useCallback(() => {
    if (!pendingAssetPurchase || !userId) return;
    rememberTableStudioCheckoutIntent({
      userId,
      tab: pendingAssetPurchase.tab,
      assetId: pendingAssetPurchase.id,
    });
    setDiamondStoreUserId(userId);
  }, [pendingAssetPurchase, userId]);

  const cancelPendingAssetPurchase = useCallback(() => {
    stopCheckoutBalancePolling();
    clearTableStudioCheckoutIntent();
    setPendingAssetPurchase(null);
  }, [stopCheckoutBalancePolling]);

  const handleAssetPurchase = useCallback(async () => {
    const pending = pendingAssetPurchase;
    if (!pending || !userId || purchaseBusyRef.current) return;
    const requestedUserId = userId;
    const purchaseGeneration = ++assetPurchaseGenerationRef.current;
    const isCurrentPurchase = () =>
      userIdRef.current === requestedUserId &&
      assetPurchaseGenerationRef.current === purchaseGeneration;
    const purchaseStartedAt = globalThis.performance?.now?.() ?? Date.now();
    purchaseBusyRef.current = true;
    setPurchaseBusyUserId(requestedUserId);
    try {
      const requestScope = `table-studio:${requestedUserId}:${pending.feature}`;
      const requestId = readOrCreateSessionPurchaseRequestId(requestScope);
      const { data, error } = await supabase.rpc('fn_purchase_feature_v2', {
        p_user_id: requestedUserId,
        p_feature: pending.feature,
        p_request_id: requestId,
      });
      if (!isCurrentPurchase()) return;
      if (error) throw error;
      // Any structured response is authoritative. Transport failures keep this
      // key so a retry proves whether Postgres committed the first request.
      clearSessionPurchaseRequestId(requestScope);

      const alreadyOwned = data?.error === 'already_owned' || data?.already_owned === true;
      const reconciledPurchase = alreadyOwned || data?.idempotent === true;
      if (!data?.success && !alreadyOwned) {
        const reason = String(data?.error || 'Purchase failed');
        recordCustomizationOperation({
          userId: requestedUserId,
          event: 'purchase_failed',
          surface: 'table-studio',
          category: pending.tab,
          durationMs: (globalThis.performance?.now?.() ?? Date.now()) - purchaseStartedAt,
          reasonCode: reason.toLowerCase().includes('insufficient')
            ? 'insufficient_balance'
            : 'server_refused',
        });
        if (reason.toLowerCase().includes('insufficient')) {
          toast.info('Add Diamonds To Finish Unlocking This Design.');
          void loadDiamonds(requestedUserId, { force: true });
          rememberTableStudioCheckoutIntent({
            userId: requestedUserId,
            tab: pending.tab,
            assetId: pending.id,
          });
          setDiamondStoreUserId(requestedUserId);
        } else {
          toast.error('Design Purchase Failed. Please Try Again.');
          reportError(new Error(reason), 'ThemeSettingsModal.Asset_purchase_refused');
        }
        return;
      }

      // Permission lands before the paint. Updating both ownership views makes
      // the tile unlock in this render; the event refreshes every other open
      // Studio (including another browser tab) from the authoritative ledger.
      const category = TAB_TO_FIELD[pending.tab];
      if (pending.tab === 'cards') {
        setOwnedCardBacks((current) =>
          current.includes(pending.id) ? current : [...current, pending.id]
        );
      }
      if (pending.tab === 'themes') {
        setOwnershipRevision((revision) => revision + 1);
      } else {
        setOwnedThemeAssets((current) => {
          const key = `${category}:${pending.id}`;
          return current.includes(key) ? current : [...current, key];
        });
      }
      setOwnershipState('ready');
      clearTableStudioCheckoutIntent();
      stopCheckoutBalancePolling();
      setPendingAssetPurchase(null);
      masterBus.emit('COSMETIC_OWNERSHIP_CHANGED', {
        userId: requestedUserId,
        category,
        assetId: pending.id,
        source: reconciledPurchase ? 'ownership-reconciled' : 'diamond-purchase',
      });
      if (!reconciledPurchase && data?.granted !== false) {
        masterBus.emit('DIAMOND_SPENT', {
          amount: Number(data.cost) || pending.price,
          item: pending.id,
          category: 'table_studio',
        });
      }
      recordCustomizationOperation({
        userId: requestedUserId,
        event: 'purchase_succeeded',
        surface: 'table-studio',
        category: pending.tab,
        durationMs: (globalThis.performance?.now?.() ?? Date.now()) - purchaseStartedAt,
        reasonCode: reconciledPurchase ? 'ownership_reconciled' : 'diamond_purchase',
      });
      // The purchase completes the user's original selection. Do not make them
      // tap the same card a second time after checkout.
      if (!isCurrentPurchase()) return;
      const applied = await applyAccessibleAsset(pending.tab, pending.id);
      if (!isCurrentPurchase()) return;
      toast.success(
        reconciledPurchase
          ? applied
            ? 'Design Restored And Applied'
            : 'Design Restored'
          : applied
            ? `${pending.name} Purchased And Applied`
            : `${pending.name} Purchased`
      );
    } catch (error) {
      if (!isCurrentPurchase()) return;
      recordCustomizationOperation({
        userId: requestedUserId,
        event: 'purchase_failed',
        surface: 'table-studio',
        category: pending.tab,
        durationMs: (globalThis.performance?.now?.() ?? Date.now()) - purchaseStartedAt,
        reasonCode: 'transport_or_rpc_error',
      });
      toast.error('Design Purchase Failed. Please Try Again.');
      reportError(error, 'ThemeSettingsModal.Asset_purchase_failed');
    } finally {
      if (isCurrentPurchase()) {
        purchaseBusyRef.current = false;
        setPurchaseBusyUserId(null);
      }
    }
  }, [
    applyAccessibleAsset,
    loadDiamonds,
    pendingAssetPurchase,
    stopCheckoutBalancePolling,
    toast,
    userId,
  ]);

  /**
   * RESET DID NOTHING (2026-08-25). It set local state and stopped: no write,
   * no bus emit, no toast. The grid snapped back to the defaults, the table
   * behind the modal kept the old theme, and the moment you closed and
   * reopened, your old theme was back — because it had never been replaced.
   * It now goes through exactly the same path as picking a tile.
   */
  const handleReset = useCallback(() => {
    if (themeLoadState !== 'ready') return;
    const previous = { ...selectionRef.current };
    replaceSelection({ ...DEFAULT_SELECTION });
    void handleSave({ ...DEFAULT_SELECTION }, previous);
  }, [handleSave, replaceSelection, themeLoadState]);

  const toggleFavorite = useCallback(
    (tab: ThemeTab, assetId: string) => {
      collections.toggleFavorite(`${tab}:${assetId}`);
    },
    [collections]
  );

  const randomizeAccessibleLook = useCallback(() => {
    if (themeLoadState !== 'ready') return;
    const pick = (assets: ThemeAsset[], tab: ThemeTab) => {
      const accessible = assets.filter((asset) =>
        canAccessAsset(tab, asset.id, isVip, asset.vipOnly, ownedCardBacks, ownedThemeAssets)
      );
      return accessible[Math.floor(Math.random() * accessible.length)]?.id;
    };
    const randomized: ThemeSelection = {
      theme_id: selectionRef.current.theme_id,
      table_id: pick(TABLE_ASSETS, 'table') || DEFAULT_SELECTION.table_id,
      button_id: pick(BUTTON_ASSETS, 'button') || DEFAULT_SELECTION.button_id,
      background_id: pick(BACKGROUND_ASSETS, 'background') || DEFAULT_SELECTION.background_id,
      cards_id: pick(CARD_ASSETS, 'cards') || DEFAULT_SELECTION.cards_id,
    };
    const previous = { ...selectionRef.current };
    replaceSelection(randomized);
    void handleSave(randomized, previous);
  }, [handleSave, isVip, ownedCardBacks, ownedThemeAssets, replaceSelection, themeLoadState]);

  const savedLoadouts = collections.loadouts.map((loadout) => normalizeStoredSelection(loadout));

  const saveLoadout = useCallback(
    (slot: number) => {
      if (themeLoadState !== 'ready') return;
      const existing = collections.loadouts[slot];
      collections.saveLoadout(slot, {
        ...selectionRef.current,
        name: existing?.name || `Look ${slot + 1}`,
        saved_at: new Date().toISOString(),
      });
      toast.success(
        existing ? `${existing.name || `Look ${slot + 1}`} Updated` : `Look ${slot + 1} Saved`
      );
    },
    [collections, themeLoadState, toast]
  );

  const renameLoadout = useCallback(
    (slot: number, name: string) => {
      collections.renameLoadout(slot, name);
    },
    [collections]
  );

  const clearLoadout = useCallback(
    (slot: number) => {
      collections.clearLoadout(slot);
      setPendingLoadoutClear(null);
      toast.success(`Look ${slot + 1} Cleared`);
    },
    [collections, toast]
  );

  const applyLoadout = useCallback(
    (slot: number) => {
      if (themeLoadState !== 'ready') return;
      const saved = savedLoadouts[slot];
      if (!saved) return;
      const candidate: ThemeSelection = { ...saved };
      const fields: Array<[ThemeTab, keyof ThemeSelection, ThemeAsset[]]> = [
        ['themes', 'theme_id', THEME_PRESETS],
        ['table', 'table_id', TABLE_ASSETS],
        ['button', 'button_id', BUTTON_ASSETS],
        ['background', 'background_id', BACKGROUND_ASSETS],
        ['cards', 'cards_id', CARD_ASSETS],
      ];
      let removedLockedChoice = false;
      for (const [tab, field, assets] of fields) {
        const asset = assets.find((item) => item.id === candidate[field]);
        if (
          !asset ||
          !canAccessAsset(
            tab,
            candidate[field],
            isVip,
            asset.vipOnly,
            ownedCardBacks,
            ownedThemeAssets
          )
        ) {
          candidate[field] = selectionRef.current[field];
          removedLockedChoice = true;
        }
      }
      if (removedLockedChoice) {
        toast.warning('Locked Or Retired Choices Were Kept On Your Current Design');
      }
      const previous = { ...selectionRef.current };
      replaceSelection(candidate);
      void handleSave(candidate, previous);
    },
    [
      handleSave,
      isVip,
      ownedCardBacks,
      ownedThemeAssets,
      replaceSelection,
      savedLoadouts,
      themeLoadState,
      toast,
    ]
  );

  if (!isOpen) return null;

  const currentField = TAB_TO_FIELD[activeTab];
  const categoryAssets =
    activeTab === 'background'
      ? THEME_ASSETS.background.filter((asset) =>
          backgroundGroup === 'skins'
            ? BACKGROUND_SKIN_IDS.has(asset.id)
            : !BACKGROUND_SKIN_IDS.has(asset.id)
        )
      : THEME_ASSETS[activeTab];
  const currentAssets = categoryAssets.filter((asset) => {
    const key = `${activeTab}:${asset.id}`;
    if (assetSearch && !asset.name.toLowerCase().includes(assetSearch.trim().toLowerCase())) {
      return false;
    }
    if (assetFilter === 'free') return !asset.vipOnly;
    if (assetFilter === 'vip') return asset.vipOnly;
    if (assetFilter === 'favorites') return collections.favorites.includes(key);
    if (assetFilter === 'recent') return collections.recent.includes(key);
    return true;
  });
  const currentSelected = selection[currentField];

  const selectedCardName =
    CARD_BACK_CATALOG.find((design) => design.id === normalizeCardBack(selection.cards_id))?.name ||
    'Classic Red';
  const selectedTableName =
    TABLE_ASSETS.find((asset) => asset.id === normalizeFeltId(selection.table_id))?.name ||
    'Classic Green';
  const selectedBackgroundName =
    BACKGROUND_ASSETS.find((asset) => asset.id === normalizeBackgroundId(selection.background_id))
      ?.name || 'Midnight';
  const selectedButtonName =
    BUTTON_ASSETS.find((asset) => asset.id === selection.button_id)?.name || 'White D';
  const collectionNeedsAttention =
    collections.syncState === 'error' || collections.realtimeState === 'error';
  const collectionSyncing =
    collections.syncState === 'loading' || collections.realtimeState === 'connecting';
  const studioNeedsAttention =
    collectionNeedsAttention ||
    entitlementRealtimeState === 'error' ||
    ownershipState === 'error' ||
    pricingState === 'error' ||
    themeLoadState === 'error' ||
    appearanceRealtime.state === 'error';
  const studioSyncing =
    collectionSyncing ||
    ownershipState === 'idle' ||
    ownershipState === 'loading' ||
    (Boolean(userId) && entitlementRealtimeState !== 'live') ||
    pricingState === 'loading' ||
    checkoutBalanceSyncing ||
    themeLoadState === 'loading' ||
    appearanceRealtime.state === 'connecting';
  const collectionStatus = collectionNeedsAttention
    ? 'error'
    : collectionSyncing
      ? 'loading'
      : collections.syncState;

  const activateTab = (tab: ThemeTab) => {
    setActiveTab(tab);
    setAssetSearch('');
  };

  return (
    <div
      className="theme-modal-overlay"
      onClick={() => {
        if (!purchaseBusyRef.current) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="theme-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-studio-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="theme-modal__header">
          <div>
            <span className="theme-modal__eyebrow">PLAYER TABLE STUDIO</span>
            <h3 id="theme-studio-title" className="theme-modal__title">
              Make The Table Yours
            </h3>
          </div>
          <button
            className="theme-modal__close"
            onClick={() => {
              if (!purchaseBusyRef.current) onClose();
            }}
            disabled={purchaseBusy}
            aria-label="Close Table Studio"
          >
            ×
          </button>
        </div>

        <div className="theme-modal__studio-bar">
          <div className="theme-modal__game-type">
            <label className="theme-modal__game-label" htmlFor="theme-game-type">
              Apply To
            </label>
            <select
              id="theme-game-type"
              className="theme-modal__game-select"
              value={gameType}
              onChange={(e) => {
                gameTypeRef.current = e.target.value;
                setGameType(e.target.value);
              }}
            >
              {GAME_TYPES.map((gt) => (
                <option key={gt} value={gt}>
                  {GAME_TYPE_LABELS[gt] ?? gt}
                </option>
              ))}
            </select>
          </div>
          <div
            className={`theme-modal__live-link theme-modal__live-link--${appearanceRealtime.state} ${studioNeedsAttention ? 'theme-modal__live-link--attention' : ''}`}
            aria-live="polite"
          >
            <span className="theme-modal__live-signal" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="theme-modal__live-copy">
              <small>Table Art Link</small>
              <strong>
                {saving || modeSaving
                  ? 'Applying...'
                  : appearanceRealtime.state === 'error'
                    ? 'Reconnect'
                    : studioSyncing
                      ? checkoutBalanceSyncing
                        ? 'Balance Sync'
                        : 'Linking...'
                      : studioNeedsAttention
                        ? 'Review Sync'
                        : 'Table Art Live'}
              </strong>
            </span>
            {appearanceRealtime.state === 'error' && (
              <button type="button" onClick={appearanceRealtime.retry}>
                Retry
              </button>
            )}
          </div>
        </div>

        <div className="theme-modal__workspace">
          <aside className="theme-modal__visual-rail" aria-label="Live Table Design Preview">
            <fieldset className="theme-modal__mode" aria-label="Club Arena Appearance Mode">
              <legend>Interface</legend>
              <div className="theme-modal__mode-options">
                {(['light', 'dark'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`theme-modal__mode-option ${uiMode === mode ? 'theme-modal__mode-option--active' : ''}`}
                    aria-pressed={uiMode === mode}
                    disabled={modeSaving}
                    onClick={() => void handleUiModeChange(mode)}
                  >
                    <span
                      className={`theme-modal__mode-icon theme-modal__mode-icon--${mode}`}
                      aria-hidden="true"
                    />
                    {mode === 'light' ? 'Light' : 'Dark'}
                  </button>
                ))}
              </div>
              <span className="theme-modal__mode-note">
                Changes Menus And Controls. Your Table Design Stays Yours.
              </span>
            </fieldset>

            <div className="theme-modal__preview-shell">
              <div className="theme-modal__preview-switch" aria-label="Preview Table State">
                <button
                  type="button"
                  className={!previewFinalTable ? 'active' : ''}
                  aria-pressed={!previewFinalTable}
                  onClick={() => setPreviewFinalTable(false)}
                >
                  Standard
                </button>
                <button
                  type="button"
                  className={previewFinalTable ? 'active' : ''}
                  aria-pressed={previewFinalTable}
                  onClick={() => setPreviewFinalTable(true)}
                >
                  Final Table
                </button>
              </div>
              <div className="theme-modal__live-preview">
                <TableStudioGameplayPreview
                  selection={selection}
                  avatarUrls={previewAvatars}
                  finalTable={previewFinalTable}
                />
                <div className="theme-modal__live-caption">
                  <span>{previewFinalTable ? 'AUTOMATIC MTT EVENT' : 'LIVE GAMEPLAY PREVIEW'}</span>
                  <strong>
                    {selectedCardName} · {GAME_TYPE_LABELS[gameType] ?? gameType}
                  </strong>
                </div>
              </div>
            </div>

            <div className="theme-modal__selection-ledger" aria-label="Current Table Configuration">
              {[
                ['Table', selectedTableName],
                ['Background', selectedBackgroundName],
                ['Buttons', selectedButtonName],
                ['Card Back', selectedCardName],
              ].map(([label, value]) => (
                <div className="theme-modal__selection-item" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </aside>

          <section className="theme-modal__catalog" data-theme-tab={activeTab}>
            {/* Tab Bar */}
            <div
              className="theme-modal__tabs"
              role="tablist"
              aria-label="Table Customization Categories"
            >
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  id={`theme-tab-${tab.key}`}
                  className={`theme-modal__tab ${activeTab === tab.key ? 'theme-modal__tab--active' : ''}`}
                  onClick={() => activateTab(tab.key)}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const current = TABS.findIndex((item) => item.key === tab.key);
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? TABS.length - 1
                          : (current + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) %
                            TABS.length;
                    activateTab(TABS[next].key);
                    document.getElementById(`theme-tab-${TABS[next].key}`)?.focus();
                  }}
                  role="tab"
                  aria-selected={activeTab === tab.key}
                  aria-controls="theme-studio-catalog-panel"
                  tabIndex={activeTab === tab.key ? 0 : -1}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div
              id="theme-studio-catalog-panel"
              className="theme-modal__catalog-scroll"
              role="tabpanel"
              aria-labelledby={`theme-tab-${activeTab}`}
            >
              {activeTab === 'background' && (
                <div className="theme-modal__background-groups" aria-label="Background Categories">
                  {(
                    [
                      ['places-rooms', 'Places & Rooms'],
                      ['skins', 'Skins'],
                    ] as const
                  ).map(([group, label]) => (
                    <button
                      key={group}
                      type="button"
                      className={`theme-modal__background-group ${backgroundGroup === group ? 'theme-modal__background-group--active' : ''}`}
                      aria-pressed={backgroundGroup === group}
                      onClick={() => setBackgroundGroup(group)}
                    >
                      {label}
                      <span>
                        {
                          THEME_ASSETS.background.filter((asset) =>
                            group === 'skins'
                              ? BACKGROUND_SKIN_IDS.has(asset.id)
                              : !BACKGROUND_SKIN_IDS.has(asset.id)
                          ).length
                        }
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <div className="theme-modal__discovery">
                <label>
                  <span className="sr-only">
                    Search {TABS.find((tab) => tab.key === activeTab)?.label}
                  </span>
                  <input
                    type="search"
                    value={assetSearch}
                    onChange={(event) => setAssetSearch(event.target.value)}
                    placeholder={`Search ${TABS.find((tab) => tab.key === activeTab)?.label}`}
                  />
                </label>
                <div className="theme-modal__filters" aria-label="Filter Customization Choices">
                  {(['all', 'free', 'vip', 'favorites', 'recent'] as const).map((filter) => (
                    <button
                      type="button"
                      key={filter}
                      className={assetFilter === filter ? 'active' : ''}
                      aria-pressed={assetFilter === filter}
                      onClick={() => setAssetFilter(filter)}
                    >
                      {filter === 'all' ? 'All' : filter[0].toUpperCase() + filter.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="theme-modal__section-heading">
                <div>
                  <strong>{TABS.find((tab) => tab.key === activeTab)?.label}</strong>
                  <span>{TAB_DESCRIPTIONS[activeTab]}</span>
                </div>
                <span className="theme-modal__count">{currentAssets.length} Choices</span>
              </div>

              {themeLoadState === 'loading' && (
                <div className="theme-modal__state" role="status">
                  <strong>Loading Your Saved Design</strong>
                  <span>Choices Unlock When Your Current Table Is Ready.</span>
                </div>
              )}
              {themeLoadState === 'error' && (
                <div className="theme-modal__state theme-modal__state--error" role="alert">
                  <div>
                    <strong>Your Saved Design Could Not Be Loaded</strong>
                    <span>Choices Stay Locked So An Older Design Is Not Overwritten.</span>
                  </div>
                  <button type="button" onClick={() => setThemeLoadRevision((value) => value + 1)}>
                    Try Again
                  </button>
                </div>
              )}
              {!isVip && ownershipState === 'loading' && (
                <div className="theme-modal__state" role="status">
                  <strong>Checking Your Purchases And Rewards</strong>
                  <span>Owned Designs Unlock As Soon As Entitlements Are Confirmed.</span>
                </div>
              )}
              {!isVip && ownershipState === 'error' && (
                <div className="theme-modal__state theme-modal__state--error" role="alert">
                  <div>
                    <strong>Purchases Could Not Be Verified</strong>
                    <span>Premium Designs Stay Locked Until The Check Succeeds.</span>
                  </div>
                  <button type="button" onClick={() => setOwnershipRevision((value) => value + 1)}>
                    Try Again
                  </button>
                </div>
              )}
              {pricingState === 'error' && (
                <div className="theme-modal__state theme-modal__state--error" role="alert">
                  <div>
                    <strong>Purchase Prices Could Not Be Loaded</strong>
                    <span>Owned And Free Designs Still Work. Paid Designs Stay Unavailable.</span>
                  </div>
                  <button type="button" onClick={() => setPricingRevision((value) => value + 1)}>
                    Try Again
                  </button>
                </div>
              )}
              {userId && entitlementRealtimeState === 'error' && (
                <div className="theme-modal__state theme-modal__state--error" role="alert">
                  <div>
                    <strong>Live Unlock Updates Are Disconnected</strong>
                    <span>
                      Your Purchases Stay Safe. Reconnect To Receive Other-Device Unlocks.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setOwnershipRevision((value) => value + 1);
                      setEntitlementRealtimeRevision((value) => value + 1);
                    }}
                  >
                    Reconnect
                  </button>
                </div>
              )}

              {/* Asset Grid */}
              <div
                className={`theme-modal__grid${themeLoadState !== 'ready' ? ' theme-modal__grid--loading' : ''}`}
                aria-busy={
                  themeLoadState === 'loading' ||
                  ownershipState === 'idle' ||
                  ownershipState === 'loading' ||
                  pricingState === 'loading'
                }
              >
                {currentAssets.length === 0 && (
                  <div className="theme-modal__empty">
                    <strong>No Matching Designs</strong>
                    <span>Try Another Search Or Filter.</span>
                  </div>
                )}
                {currentAssets.map((asset) => {
                  const isSelected = currentSelected === asset.id;
                  const explicitKey = `${TAB_TO_FIELD[activeTab]}:${asset.id}`;
                  const isExplicitlyOwned =
                    ownedThemeAssets.includes(explicitKey) ||
                    (activeTab === 'cards' &&
                      isCardBackUnlocked(asset.id, { owned: ownedCardBacks }));
                  const ownershipPending = asset.vipOnly && !isVip && ownershipState === 'loading';
                  const ownershipUnavailable =
                    asset.vipOnly && !isVip && ownershipState === 'error';
                  const isLocked = !canAccessAsset(
                    activeTab,
                    asset.id,
                    isVip,
                    asset.vipOnly,
                    ownedCardBacks,
                    ownedThemeAssets
                  );
                  const assetStatus = isSelected
                    ? 'Selected'
                    : asset.vipOnly
                      ? isExplicitlyOwned
                        ? 'Owned'
                        : isVip
                          ? 'VIP Included'
                          : 'Premium'
                      : 'Included';

                  return (
                    <div className="theme-asset-wrap" key={asset.id}>
                      <button
                        type="button"
                        className={`theme-asset ${isSelected ? 'theme-asset--selected' : ''} ${isLocked ? 'theme-asset--locked' : ''}`}
                        onClick={() => handleAssetSelect(activeTab, asset.id, asset.vipOnly)}
                        disabled={
                          themeLoadState !== 'ready' || ownershipPending || ownershipUnavailable
                        }
                        aria-pressed={isSelected}
                        aria-label={`${asset.name}${ownershipPending ? ', Checking Ownership' : ownershipUnavailable ? ', Ownership Unavailable' : isLocked ? ', Purchase Or VIP Required' : ''}`}
                      >
                        <div className={`theme-asset__preview theme-asset__preview--${activeTab}`}>
                          {/* ── Dan 2026-08-18: show the actual thing, not a colour ──
                      Every tab used to render `background: asset.thumbnail`,
                      a hand-written gradient that (in its own words)
                      "approximates each composite's palette" - so you picked a
                      table by looking at a colour smear. Each tab now renders
                      the real asset; the gradient survives only as a fallback
                      where no real asset exists for that id. */}
                          {renderAssetPreview(activeTab, asset)}
                          {ownershipPending || ownershipUnavailable ? (
                            <div className="theme-asset__lock theme-asset__lock--checking">
                              <span className="theme-asset__lock-icon">
                                {ownershipPending ? 'Checking' : 'Unavailable'}
                              </span>
                            </div>
                          ) : isLocked ? (
                            <div className="theme-asset__lock">
                              <span className="theme-asset__lock-icon">
                                {pricingState === 'ready'
                                  ? `${assetPrices[storefrontFeature(activeTab, asset.id)] ?? '-'} ◆`
                                  : 'Unavailable'}
                              </span>
                            </div>
                          ) : null}
                          {isSelected && !isLocked && <div className="theme-asset__check">✓</div>}
                        </div>
                        <span className="theme-asset__name">{asset.name}</span>
                        {!isLocked && !ownershipPending && !ownershipUnavailable && (
                          <span
                            className={`theme-asset__tier-badge${isSelected ? ' theme-asset__tier-badge--selected' : ''}`}
                          >
                            {assetStatus}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className={`theme-asset__favorite ${collections.favorites.includes(`${activeTab}:${asset.id}`) ? 'active' : ''}`}
                        aria-label={`${collections.favorites.includes(`${activeTab}:${asset.id}`) ? 'Remove' : 'Add'} ${asset.name} ${collections.favorites.includes(`${activeTab}:${asset.id}`) ? 'From' : 'To'} Favorites`}
                        aria-pressed={collections.favorites.includes(`${activeTab}:${asset.id}`)}
                        title={
                          collections.favorites.includes(`${activeTab}:${asset.id}`)
                            ? 'Remove From Favorites'
                            : 'Add To Favorites'
                        }
                        onClick={() => toggleFavorite(activeTab, asset.id)}
                      >
                        {/* "Favorite", not "Save" (Dan 2026-08-28): "INSIDE THE THEME
                      SETTINGS YOU SHOULDN'T HAVE TO CLICK SAVE ON EACH ONE, IT
                      SHOULD AUTO SAVE WHEN YOU CLICK ON ONE AND THE CHECK MARK
                      APPEARS."

                      He is describing the LABEL, not the behaviour. Tapping a
                      tile already saves: handleAssetSelect calls
                      applyTableAppearance, the tick is painted only on a write
                      that succeeded, and the header says "Changes save
                      automatically". This button never had anything to do with
                      that — it toggles the tile into the Favorites filter above,
                      and its own aria-label has always said so.

                      But a button labelled "Save" sitting on every tile, next to
                      a tick, reads as "your pick is not kept until you press
                      this" — which is why a selected tile showing "Saved" looked
                      like confirmation of the selection rather than of a
                      favourite. Naming it after what it does removes the
                      contradiction without touching a working save path. The
                      note under the grid already warns that favourites stay on
                      this device. */}
                        <span aria-hidden="true">
                          {collections.favorites.includes(`${activeTab}:${asset.id}`) ? '★' : '☆'}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>

              <section className="theme-modal__loadouts" aria-labelledby="theme-loadout-title">
                <div className="theme-modal__loadout-header">
                  <div>
                    <span>SAVED LOOKS</span>
                    <strong id="theme-loadout-title">My Looks</strong>
                    <small>Keep Three Complete Designs Ready To Deal.</small>
                  </div>
                  <button
                    type="button"
                    className="theme-modal__randomize"
                    disabled={themeLoadState !== 'ready'}
                    onClick={randomizeAccessibleLook}
                  >
                    Shuffle Look
                  </button>
                </div>

                <div className="theme-modal__loadout-rack" role="list">
                  {[0, 1, 2].map((slot) => {
                    const stored = collections.loadouts[slot];
                    const look = savedLoadouts[slot];
                    const tableName = look
                      ? TABLE_ASSETS.find((asset) => asset.id === look.table_id)?.name || 'Table'
                      : '';
                    const backgroundName = look
                      ? BACKGROUND_ASSETS.find((asset) => asset.id === look.background_id)?.name ||
                        'Room'
                      : '';
                    return (
                      <div
                        key={slot}
                        role="listitem"
                        className={`theme-modal__loadout${look ? '' : ' theme-modal__loadout--empty'}`}
                      >
                        <div className="theme-loadout__slotline">
                          <span>LOOK {String(slot + 1).padStart(2, '0')}</span>
                          <b>{look ? 'READY' : 'OPEN SLOT'}</b>
                        </div>
                        {look ? (
                          <>
                            {renderLoadoutPreview(look)}
                            <label className="theme-loadout__name">
                              <span className="sr-only">Name For Look {slot + 1}</span>
                              <input
                                key={`${slot}:${stored?.name || ''}`}
                                defaultValue={stored?.name || `Look ${slot + 1}`}
                                maxLength={32}
                                onBlur={(event) => renameLoadout(slot, event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') event.currentTarget.blur();
                                }}
                              />
                            </label>
                            <span className="theme-loadout__summary">
                              {tableName} · {backgroundName}
                            </span>
                            {pendingLoadoutClear === slot ? (
                              <div className="theme-loadout__confirm" role="alert">
                                <span>Clear This Look?</span>
                                <button type="button" onClick={() => setPendingLoadoutClear(null)}>
                                  Keep
                                </button>
                                <button type="button" onClick={() => clearLoadout(slot)}>
                                  Clear
                                </button>
                              </div>
                            ) : (
                              <div className="theme-loadout__actions">
                                <button
                                  type="button"
                                  className="theme-loadout__equip"
                                  onClick={() => applyLoadout(slot)}
                                  disabled={themeLoadState !== 'ready'}
                                >
                                  Equip
                                </button>
                                <button
                                  type="button"
                                  onClick={() => saveLoadout(slot)}
                                  disabled={themeLoadState !== 'ready'}
                                >
                                  Update
                                </button>
                                <button type="button" onClick={() => setPendingLoadoutClear(slot)}>
                                  Clear
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          <button
                            type="button"
                            className="theme-loadout__empty-action"
                            onClick={() => saveLoadout(slot)}
                            disabled={themeLoadState !== 'ready'}
                          >
                            <span aria-hidden="true">+</span>
                            <strong>Save Current Look</strong>
                            <small>Table · Room · Buttons · Cards</small>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div
                  className={`theme-modal__loadout-sync theme-modal__loadout-sync--${collectionStatus}`}
                  aria-live="polite"
                >
                  <span>
                    {userId
                      ? collectionNeedsAttention
                        ? 'Cloud Sync Needs Attention. Your Looks Are Safe On This Device.'
                        : collectionSyncing
                          ? 'Syncing Favorites And Looks...'
                          : 'Favorites And Looks Sync Across Your Devices.'
                      : 'Sign In To Sync Favorites And Looks.'}
                  </span>
                  {userId && collectionNeedsAttention && (
                    <button type="button" onClick={collections.retrySync}>
                      Retry Sync
                    </button>
                  )}
                </div>
              </section>
            </div>

            {/* Footer */}
            <div className="theme-modal__footer">
              <button
                className="theme-modal__btn theme-modal__btn--reset"
                onClick={handleReset}
                disabled={themeLoadState !== 'ready' || purchaseBusy}
              >
                Restore Defaults
              </button>
              <button
                className="theme-modal__btn theme-modal__btn--save"
                /* Every tile auto-saves through the ordered writer. Done closes
               the studio; it must not launch a redundant full-row write that
               can race the final tap the player just made. */
                onClick={() => {
                  if (!purchaseBusyRef.current) onClose();
                }}
                disabled={saving || modeSaving || purchaseBusy}
              >
                {saving || modeSaving ? 'Saving...' : 'Done'}
              </button>
            </div>
          </section>
        </div>

        {pendingAssetPurchase && !diamondStoreOpen && (
          <div
            className="theme-vip-prompt-overlay"
            onClick={() => {
              if (!purchaseBusyRef.current) cancelPendingAssetPurchase();
            }}
          >
            <div
              ref={vipPromptRef}
              className="theme-vip-prompt"
              role="dialog"
              aria-modal="true"
              aria-labelledby="theme-purchase-title"
              aria-describedby="theme-purchase-description"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="theme-vip-prompt__icon" aria-hidden="true">
                ◆
              </div>
              <h4 id="theme-purchase-title" className="theme-vip-prompt__title">
                Unlock {pendingAssetPurchase.name}
              </h4>
              <p id="theme-purchase-description" className="theme-vip-prompt__text">
                Purchase This Design For {pendingAssetPurchase.price.toLocaleString()} Diamonds. It
                Will Unlock Permanently And Apply To The Live Table Immediately.
              </p>
              <div className="theme-purchase-balance" aria-live="polite">
                <span>{checkoutBalanceSyncing ? 'Syncing Your Balance' : 'Your Balance'}</span>
                <strong>{diamonds.toLocaleString()} ◆</strong>
              </div>
              <div className="theme-vip-prompt__actions">
                <button
                  type="button"
                  className="theme-vip-prompt__btn theme-vip-prompt__btn--upgrade"
                  disabled={purchaseBusy || checkoutBalanceSyncing}
                  onClick={() => {
                    if (diamonds < pendingAssetPurchase.price) {
                      openDiamondStoreForPending();
                      return;
                    }
                    void handleAssetPurchase();
                  }}
                >
                  {purchaseBusy
                    ? 'Processing...'
                    : checkoutBalanceSyncing
                      ? 'Syncing Diamond Balance...'
                      : diamonds < pendingAssetPurchase.price
                        ? `Add ${(pendingAssetPurchase.price - diamonds).toLocaleString()} Diamonds`
                        : `Buy For ${pendingAssetPurchase.price.toLocaleString()} ◆`}
                </button>
                <button
                  type="button"
                  className="theme-vip-prompt__btn theme-vip-prompt__btn--cancel"
                  disabled={purchaseBusy}
                  onClick={cancelPendingAssetPurchase}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        <DiamondTopUpModal
          isOpen={diamondStoreOpen}
          returnParams={TABLE_STUDIO_CHECKOUT_RETURN_PARAMS}
          onClose={() => {
            setDiamondStoreUserId(null);
            clearTableStudioCheckoutIntent();
            if (userId) void loadDiamonds(userId, { force: true });
          }}
        />
      </div>
    </div>
  );
}

export default ThemeSettingsModal;
