/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THEME SETTINGS MODAL — Bible V8 §11.2
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Theme customization modal with:
 *   - Game type selector dropdown (ALL, NLH, FLH, 6+, PLO, etc.)
 *   - 5-tab layout (Themes, Table, Button, Background, Cards)
 *   - Binary VIP gating (Free items vs VIP-only items)
 *   - Per-game-type persistence via user_theme_settings table
 *
 * Bible V8 §11.2.4: Stored in user_theme_settings table
 *   Schema: user_id, game_type, theme_id, table_id, button_id, background_id, cards_id
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { TABLE_SKINS, TABLE_BACKGROUNDS, TABLE_BACKGROUND_IDS } from '../../assets/tableAssets';
import {
  TABLE_FELT_CATALOG,
  isFeltUnlocked,
  normalizeFeltId,
  normalizeBackgroundId,
  THEME_PRESET_SKINS,
} from '../../lib/tableTheme';
import { CardBack, normalizeCardBack, CARD_BACK_CATALOG, isCardBackUnlocked } from './CardImage';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import './ThemeSettingsModal.css';
import { reportError } from '../../utils/errorReporter';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { avatarService } from '../../services/AvatarService';
import TableStudioGameplayPreview from './TableStudioGameplayPreview';
import { applyTableAppearance, type AppearancePatch } from '../../lib/applyTableAppearance';
import { pickThemeRow } from '../../hooks/useUserThemeSettings';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ThemeSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  /** Whether the user is a VIP member (binary: free or VIP) */
  isVip: boolean;
}

interface ThemeSelection {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
}

type ThemeTab = 'themes' | 'table' | 'button' | 'background' | 'cards';
type BackgroundGroup = 'places-rooms' | 'skins';
type AssetFilter = 'all' | 'free' | 'vip' | 'favorites' | 'recent';

interface ThemeAsset {
  id: string;
  name: string;
  thumbnail: string; // CSS gradient or image URL for preview
  /** Whether the asset requires VIP access */
  vipOnly: boolean;
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
  { key: 'themes', label: 'Themes' },
  { key: 'table', label: 'Table' },
  { key: 'button', label: 'Button' },
  { key: 'background', label: 'Background' },
  { key: 'cards', label: 'Cards' },
];

const TAB_DESCRIPTIONS: Record<ThemeTab, string> = {
  themes: 'Complete, coordinated table looks',
  table: 'The felt and rail at the center of play',
  button: 'Dealer marker finish and color',
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
  place_las_vegas: { name: 'Las Vegas', vipOnly: false },
  place_paris: { name: 'Paris', vipOnly: false },
  place_london: { name: 'London', vipOnly: false },
  place_tokyo: { name: 'Tokyo', vipOnly: false },
  place_dubai: { name: 'Dubai', vipOnly: true },
  place_sydney: { name: 'Sydney Harbour', vipOnly: false },
  place_rio: { name: 'Rio De Janeiro', vipOnly: false },
  place_santorini: { name: 'Santorini', vipOnly: true },
  place_new_york: { name: 'New York', vipOnly: false },
  place_monaco: { name: 'Monte Carlo', vipOnly: true },
  skin_shadow_suits: { name: 'Shadow Suits', vipOnly: false },
  skin_gilded_fall: { name: 'Gilded Fall', vipOnly: false },
  skin_crimson_damask: { name: 'Crimson Damask', vipOnly: false },
  skin_graphite_embossed: { name: 'Graphite Embossed', vipOnly: false },
  skin_obsidian_micro: { name: 'Obsidian Micro', vipOnly: false },
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

export const THEME_PRESETS: ThemeAsset[] = [
  {
    id: 'default-dark',
    name: 'Default Dark',
    thumbnail: 'linear-gradient(135deg, #1a1a2e, #16213e)',
    vipOnly: false,
  },
  {
    id: 'classic-brown',
    name: 'Classic Brown',
    thumbnail: 'linear-gradient(135deg, #3e2723, #5d4037)',
    vipOnly: false,
  },
  {
    id: 'neon-blue',
    name: 'Neon Blue',
    thumbnail: 'linear-gradient(135deg, #0d47a1, #1565c0)',
    vipOnly: true,
  },
  {
    id: 'rustic-wood',
    name: 'Rustic Wood',
    thumbnail: 'linear-gradient(135deg, #4e342e, #795548)',
    vipOnly: true,
  },
  {
    id: 'casino-green',
    name: 'Casino Green',
    thumbnail: 'linear-gradient(135deg, #1b5e20, #2e7d32)',
    vipOnly: true,
  },
  {
    id: 'ocean-depths',
    name: 'Ocean Depths',
    thumbnail: 'linear-gradient(135deg, #061a2c, #0b6584)',
    vipOnly: false,
  },
  {
    id: 'crimson-club',
    name: 'Crimson Club',
    thumbnail: 'linear-gradient(135deg, #26070d, #8f142c)',
    vipOnly: true,
  },
  {
    id: 'arctic-suite',
    name: 'Arctic Suite',
    thumbnail: 'linear-gradient(135deg, #dce9f0, #55748a)',
    vipOnly: true,
  },
  {
    id: 'amethyst-night',
    name: 'Amethyst Night',
    thumbnail: 'linear-gradient(135deg, #160b27, #63389a)',
    vipOnly: true,
  },
  {
    id: 'carbon-ion',
    name: 'Carbon Ion',
    thumbnail: 'linear-gradient(135deg, #080d0f, #167f78)',
    vipOnly: true,
  },
];

export const BUTTON_ASSETS: ThemeAsset[] = [
  {
    // FIX-D7 2026-07-19: the app default is 'classic-white' but it wasn't a
    // selectable tile, so a fresh user / Reset showed no button highlighted.
    // Add it (matches the [data-button-theme='classic-white'] CSS token).
    id: 'classic-white',
    name: 'Classic White',
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
    thumbnail: 'linear-gradient(135deg, #33691e, #558b2f)',
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

function readLocalJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || '') as T;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

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

/**
 * Dan 2026-08-17 (STEP 8) — Tab 1 preset bundles. Picking a Theme fills the
 * other four categories with a coordinated set (each tab can still be
 * overridden before Confirm). Free presets bundle only free assets; the two
 * VIP presets may bundle VIP assets because the preset tile itself is
 * VIP-gated by canAccessAsset before the bundle is applied.
 *
 * Dan 2026-08-25: the `table_id` half is NOT written here. It comes from
 * THEME_PRESET_SKINS in lib/tableTheme, the same map resolveSkin consults when
 * a stored row carries a theme id and no table id. Two copies of that pairing
 * is precisely how "Rustic Wood" ended up bundling the green casino felt while
 * the felt code sent the same preset somewhere else entirely.
 */
const PRESET_TRIMMINGS: Record<string, Omit<Partial<ThemeSelection>, 'table_id'>> = {
  'default-dark': {
    button_id: 'classic-white',
    background_id: 'midnight',
    cards_id: 'classic_red',
  },
  'classic-brown': {
    button_id: 'gray-d-gear',
    background_id: 'midnight',
    cards_id: 'classic_red',
  },
  'neon-blue': {
    button_id: 'blue-crystal',
    background_id: 'galaxy',
    cards_id: 'classic_blue',
  },
  'rustic-wood': {
    button_id: 'gold-star',
    background_id: 'golden_dusk',
    cards_id: 'gold',
  },
  'casino-green': {
    button_id: 'gold-star',
    background_id: 'jade_neon',
    cards_id: 'carbon',
  },
  'ocean-depths': {
    button_id: 'ocean-pearl',
    background_id: 'ocean_abyss',
    cards_id: 'classic_blue',
  },
  'crimson-club': {
    button_id: 'red-d-gear',
    background_id: 'crimson_lounge',
    cards_id: 'classic_red',
  },
  'arctic-suite': {
    button_id: 'ocean-pearl',
    background_id: 'ice_frost',
    cards_id: 'diamond-foil',
  },
  'amethyst-night': {
    button_id: 'amethyst-chip',
    background_id: 'royal_indigo',
    cards_id: 'royal',
  },
  'carbon-ion': {
    button_id: 'carbon-ion',
    background_id: 'carbon_grid',
    cards_id: 'carbon',
  },
};

const THEME_PRESET_BUNDLES: Record<string, Partial<ThemeSelection>> = Object.fromEntries(
  Object.entries(PRESET_TRIMMINGS).map(([id, rest]) => [
    id,
    { table_id: THEME_PRESET_SKINS[id], ...rest },
  ])
);

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
 * Card backs therefore route through the shared isCardBackUnlocked rule, which
 * accepts either VIP or a purchase. Felts and backgrounds have no purchase
 * path at all, so for them VIP remains the only key.
 */
function canAccessAsset(
  tab: ThemeTab,
  assetId: string,
  isVip: boolean,
  vipOnly: boolean,
  ownedCardBacks: readonly string[]
): boolean {
  if (!vipOnly) return true; // Free items always accessible
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
 *   table       the actual 896x1200 skin composite, object-fit cover
 *   background  the actual room .jpg
 *   button      a live dealer button carrying data-button-theme, so it picks
 *               up the very --dealer-btn-bg / --dealer-btn-color the table
 *               will use (TablePage.css)
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
    const src = TABLE_SKINS[asset.id];
    return src ? (
      <img className="theme-asset__img" src={src} alt="" loading="lazy" decoding="async" />
    ) : (
      fallback
    );
  }

  if (tab === 'background') {
    const src = TABLE_BACKGROUNDS[asset.id];
    return src ? (
      <img className="theme-asset__img" src={src} alt="" loading="lazy" decoding="async" />
    ) : (
      fallback
    );
  }

  if (tab === 'button') {
    // The real dealer button, styled by the same attribute the table sets.
    return (
      <div className="theme-asset__btnstage" data-button-theme={asset.id}>
        <span className="theme-asset__dealerbtn">D</span>
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
    ? TABLE_BACKGROUNDS[bundle.background_id] || TABLE_BACKGROUNDS.midnight
    : undefined;
  const tableSrc = bundle?.table_id
    ? TABLE_SKINS[bundle.table_id] || TABLE_SKINS.classic_green
    : undefined;
  if (!bgSrc && !tableSrc) return fallback;
  return (
    <div className="theme-asset__scene">
      {bgSrc && <img className="theme-asset__scene-bg" src={bgSrc} alt="" loading="lazy" />}
      {tableSrc && (
        <img className="theme-asset__scene-table" src={tableSrc} alt="" loading="lazy" />
      )}
    </div>
  );
}

export function ThemeSettingsModal({ isOpen, onClose, userId, isVip }: ThemeSettingsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const [showVipPrompt, setShowVipPrompt] = useState(false);
  const [activeTab, setActiveTab] = useState<ThemeTab>('themes');
  const [backgroundGroup, setBackgroundGroup] = useState<BackgroundGroup>('places-rooms');
  const [gameType, setGameType] = useState<string>('ALL');
  const [selection, setSelection] = useState<ThemeSelection>({ ...DEFAULT_SELECTION });
  const [saving, setSaving] = useState(false);
  const [previewFinalTable, setPreviewFinalTable] = useState(false);
  const [previewAvatars, setPreviewAvatars] = useState<string[]>([]);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [assetSearch, setAssetSearch] = useState('');
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [loadoutRevision, setLoadoutRevision] = useState(0);
  /** Card backs bought with diamonds in the store. See canAccessAsset. */
  const [ownedCardBacks, setOwnedCardBacks] = useState<string[]>([]);
  const uiMode = useSettingsStore((state) => state.theme);
  const setUiMode = useSettingsStore((state) => state.setTheme);

  // The live selection, readable from a callback without making every callback
  // depend on it. handleSave needs the value it is replacing so it can put it
  // back if the write fails.
  const selectionRef = useRef(selection);
  const gameTypeRef = useRef(gameType);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const pendingSavesRef = useRef(0);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const replaceSelection = useCallback((next: ThemeSelection) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    const focusable = () =>
      Array.from(
        modal?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'
        ) || []
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
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
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

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

  useEffect(() => {
    if (!isOpen) return;
    const owner = userId || 'guest';
    const favorites = readLocalJson<unknown>(`table-studio-favorites:${owner}`, []);
    const recent = readLocalJson<unknown>(`table-studio-recent:${owner}`, []);
    setFavoriteIds(
      Array.isArray(favorites) ? favorites.filter((id) => typeof id === 'string') : []
    );
    setRecentIds(Array.isArray(recent) ? recent.filter((id) => typeof id === 'string') : []);
  }, [isOpen, userId]);

  // ── Which paid card backs has this player actually bought? ──
  // Without this the modal padlocks a design the player owns (see
  // canAccessAsset). Missing rows are not an error: nobody has bought one yet.
  useEffect(() => {
    if (!isOpen || !userId) return;
    let mounted = true;
    supabase
      .from('feature_purchases')
      .select('feature')
      .eq('user_id', userId)
      .like('feature', 'card_back_%')
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          // Not fatal, and not silently swallowed either: a failure here means
          // paid designs read as locked, so it has to be visible somewhere.
          reportError(error, 'ThemeSettingsModal.Owned_card_backs_load_failed');
          return;
        }
        setOwnedCardBacks(
          (data || []).map((r: { feature: string }) => r.feature.replace('card_back_', ''))
        );
      });
    return () => {
      mounted = false;
    };
  }, [isOpen, userId]);

  // Load existing theme for selected game type
  useEffect(() => {
    if (!isOpen || !userId) return;

    let mounted = true;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('user_theme_settings')
          .select('game_type, theme_id, table_id, button_id, background_id, cards_id')
          .eq('user_id', userId);

        if (error) {
          // A FAILED READ IS NOT "YOU HAVE THE DEFAULT THEME" (2026-08-25).
          // This used to console.warn and return, leaving the grid showing
          // DEFAULT_SELECTION — indistinguishable from a player who really has
          // the defaults. They would then "correct" it, and the first tile they
          // touched would overwrite the theme they could not see.
          console.warn('[ThemeSettings] Load failed:', error.message);
          reportError(error, 'ThemeSettingsModal.Load_failed');
          if (mounted) toast.error('Could Not Load Your Saved Theme. Try Again In A Moment.');
          return;
        }

        if (mounted) {
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
        }
      } catch (err) {
        console.warn('[ThemeSettings] Unexpected error:', err);
        reportError(err, 'ThemeSettingsModal.Load_failed');
        if (mounted) toast.error('Could Not Load Your Saved Theme. Try Again In A Moment.');
      }
    };

    load();
    return () => {
      mounted = false;
    };
    // `toast` is stable for the life of the provider; listing it would re-run
    // the load on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, userId, gameType, replaceSelection]);

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

  const handleAssetSelect = useCallback(
    (tab: ThemeTab, assetId: string, vipOnly: boolean) => {
      if (!canAccessAsset(tab, assetId, isVip, vipOnly, ownedCardBacks)) {
        setShowVipPrompt(true);
        return;
      }
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
      setRecentIds((previous) => {
        const next = [recentKey, ...previous.filter((id) => id !== recentKey)].slice(0, 12);
        writeLocalJson(`table-studio-recent:${userId || 'guest'}`, next);
        return next;
      });
      void handleSave(newSel, previousPatch);
    },
    [isVip, ownedCardBacks, handleSave, replaceSelection, userId]
  );

  /**
   * RESET DID NOTHING (2026-08-25). It set local state and stopped: no write,
   * no bus emit, no toast. The grid snapped back to the defaults, the table
   * behind the modal kept the old theme, and the moment you closed and
   * reopened, your old theme was back — because it had never been replaced.
   * It now goes through exactly the same path as picking a tile.
   */
  const handleReset = useCallback(() => {
    const previous = { ...selectionRef.current };
    replaceSelection({ ...DEFAULT_SELECTION });
    void handleSave({ ...DEFAULT_SELECTION }, previous);
  }, [handleSave, replaceSelection]);

  const toggleFavorite = useCallback(
    (tab: ThemeTab, assetId: string) => {
      const favoriteKey = `${tab}:${assetId}`;
      setFavoriteIds((previous) => {
        const next = previous.includes(favoriteKey)
          ? previous.filter((id) => id !== favoriteKey)
          : [favoriteKey, ...previous];
        writeLocalJson(`table-studio-favorites:${userId || 'guest'}`, next);
        return next;
      });
    },
    [userId]
  );

  const randomizeAccessibleLook = useCallback(() => {
    const pick = (assets: ThemeAsset[], tab: ThemeTab) => {
      const accessible = assets.filter((asset) =>
        canAccessAsset(tab, asset.id, isVip, asset.vipOnly, ownedCardBacks)
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
  }, [handleSave, isVip, ownedCardBacks, replaceSelection]);

  const loadoutKey = `table-studio-loadouts:${userId || 'guest'}`;
  const readLoadouts = useCallback((): Array<ThemeSelection | null> => {
    const stored = readLocalJson<unknown>(loadoutKey, []);
    if (!Array.isArray(stored)) return [null, null, null];
    return [0, 1, 2].map((slot) => normalizeStoredSelection(stored[slot]));
  }, [loadoutKey]);
  const savedLoadouts = readLoadouts();
  void loadoutRevision;

  const saveLoadout = useCallback(
    (slot: number) => {
      const next = readLoadouts();
      next[slot] = selectionRef.current;
      if (!writeLocalJson(loadoutKey, next)) {
        toast.error('Could Not Save This Loadout On This Device');
        return;
      }
      setLoadoutRevision((value) => value + 1);
      toast.success(`Loadout ${slot + 1} Saved`);
    },
    [loadoutKey, readLoadouts, toast]
  );

  const applyLoadout = useCallback(
    (slot: number) => {
      const saved = readLoadouts()[slot];
      if (!saved) return;
      const previous = { ...selectionRef.current };
      replaceSelection(saved);
      void handleSave(saved, previous);
    },
    [handleSave, readLoadouts, replaceSelection]
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
    if (assetFilter === 'favorites') return favoriteIds.includes(key);
    if (assetFilter === 'recent') return recentIds.includes(key);
    return true;
  });
  const currentSelected = selection[currentField];

  const selectedCardName =
    CARD_BACK_CATALOG.find((design) => design.id === normalizeCardBack(selection.cards_id))?.name ||
    'Classic Red';

  return (
    <div className="theme-modal-overlay" onClick={onClose}>
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
          <button className="theme-modal__close" onClick={onClose} aria-label="Close table studio">
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
          <span className="theme-modal__autosave" aria-live="polite">
            <span className="theme-modal__autosave-dot" />
            {saving ? 'Saving selection' : 'Changes save automatically'}
          </span>
        </div>

        <fieldset className="theme-modal__mode" aria-label="Club Arena appearance mode">
          <legend>Interface</legend>
          <div className="theme-modal__mode-options">
            {(['light', 'dark'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`theme-modal__mode-option ${uiMode === mode ? 'theme-modal__mode-option--active' : ''}`}
                aria-pressed={uiMode === mode}
                onClick={() => setUiMode(mode)}
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
          <div className="theme-modal__preview-switch" aria-label="Preview table state">
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

        {/* Tab Bar */}
        <div
          className="theme-modal__tabs"
          role="tablist"
          aria-label="Table customization categories"
        >
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`theme-modal__tab ${activeTab === tab.key ? 'theme-modal__tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
              role="tab"
              aria-selected={activeTab === tab.key}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'background' && (
          <div className="theme-modal__background-groups" aria-label="Background categories">
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
          <div className="theme-modal__filters" aria-label="Filter customization choices">
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

        {/* Asset Grid */}
        <div className="theme-modal__grid">
          {currentAssets.length === 0 && (
            <div className="theme-modal__empty">
              <strong>No Matching Designs</strong>
              <span>Try Another Search Or Filter.</span>
            </div>
          )}
          {currentAssets.map((asset) => {
            const isSelected = currentSelected === asset.id;
            const isLocked = !canAccessAsset(
              activeTab,
              asset.id,
              isVip,
              asset.vipOnly,
              ownedCardBacks
            );

            return (
              <div className="theme-asset-wrap" key={asset.id}>
                <button
                  type="button"
                  className={`theme-asset ${isSelected ? 'theme-asset--selected' : ''} ${isLocked ? 'theme-asset--locked' : ''}`}
                  onClick={() => handleAssetSelect(activeTab, asset.id, asset.vipOnly)}
                  aria-pressed={isSelected}
                  aria-label={`${asset.name}${isLocked ? ', VIP required' : ''}`}
                >
                  <div className="theme-asset__preview">
                    {/* ── Dan 2026-08-18: show the actual thing, not a colour ──
                      Every tab used to render `background: asset.thumbnail`,
                      a hand-written gradient that (in its own words)
                      "approximates each composite's palette" - so you picked a
                      table by looking at a colour smear. Each tab now renders
                      the real asset; the gradient survives only as a fallback
                      where no real asset exists for that id. */}
                    {renderAssetPreview(activeTab, asset)}
                    {isLocked && (
                      <div className="theme-asset__lock">
                        <span className="theme-asset__lock-icon">VIP</span>
                      </div>
                    )}
                    {isSelected && !isLocked && <div className="theme-asset__check">✓</div>}
                  </div>
                  <span className="theme-asset__name">{asset.name}</span>
                  {asset.vipOnly && !isLocked && (
                    <span className="theme-asset__tier-badge">VIP</span>
                  )}
                </button>
                <button
                  type="button"
                  className={`theme-asset__favorite ${favoriteIds.includes(`${activeTab}:${asset.id}`) ? 'active' : ''}`}
                  aria-label={`${favoriteIds.includes(`${activeTab}:${asset.id}`) ? 'Remove' : 'Add'} ${asset.name} ${favoriteIds.includes(`${activeTab}:${asset.id}`) ? 'from' : 'to'} favorites`}
                  onClick={() => toggleFavorite(activeTab, asset.id)}
                >
                  {favoriteIds.includes(`${activeTab}:${asset.id}`) ? 'Saved' : 'Save'}
                </button>
              </div>
            );
          })}
        </div>

        <div className="theme-modal__loadouts" aria-label="Saved table loadouts">
          <button
            type="button"
            className="theme-modal__randomize"
            onClick={randomizeAccessibleLook}
          >
            Shuffle Look
          </button>
          {[0, 1, 2].map((slot) => (
            <div key={slot} className="theme-modal__loadout">
              <button type="button" onClick={() => saveLoadout(slot)}>
                Save {slot + 1}
              </button>
              <button
                type="button"
                onClick={() => applyLoadout(slot)}
                disabled={!savedLoadouts[slot]}
              >
                Use
              </button>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="theme-modal__footer">
          <button className="theme-modal__btn theme-modal__btn--reset" onClick={handleReset}>
            Restore Defaults
          </button>
          <button
            className="theme-modal__btn theme-modal__btn--save"
            /* Every tile auto-saves through the ordered writer. Done closes
               the studio; it must not launch a redundant full-row write that
               can race the final tap the player just made. */
            onClick={onClose}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Done'}
          </button>
        </div>

        {/* FIX 221: VIP Upgrade Prompt — Bible V8 §11.2.3 */}
        {showVipPrompt && (
          <div className="theme-vip-prompt-overlay" onClick={() => setShowVipPrompt(false)}>
            <div className="theme-vip-prompt" onClick={(e) => e.stopPropagation()}>
              <div className="theme-vip-prompt__icon">VIP</div>
              <h4 className="theme-vip-prompt__title">VIP Theme Unlocked</h4>
              <p className="theme-vip-prompt__text">
                This Theme Is Exclusive To VIP Members. Upgrade To Unlock Premium Themes, Tables,
                And More.
              </p>
              <div className="theme-vip-prompt__actions">
                <button
                  className="theme-vip-prompt__btn theme-vip-prompt__btn--upgrade"
                  onClick={() => {
                    setShowVipPrompt(false);
                    onClose();
                    navigate('/vip');
                  }}
                >
                  Upgrade To VIP
                </button>
                <button
                  className="theme-vip-prompt__btn theme-vip-prompt__btn--cancel"
                  onClick={() => setShowVipPrompt(false)}
                >
                  Maybe Later
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ThemeSettingsModal;
