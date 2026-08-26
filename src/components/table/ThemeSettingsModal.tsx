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
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import './ThemeSettingsModal.css';
import { reportError } from '../../utils/errorReporter';

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
  crimson_lounge: { name: 'Crimson Lounge', vipOnly: false },
  ocean_abyss: { name: 'Ocean Abyss', vipOnly: false },
  golden_dusk: { name: 'Golden Dusk', vipOnly: false },
  galaxy: { name: 'Galaxy', vipOnly: false },
  carbon_grid: { name: 'Carbon Grid', vipOnly: true },
  ice_frost: { name: 'Ice Frost', vipOnly: true },
  jade_neon: { name: 'Jade Neon', vipOnly: true },
};

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

const THEME_ASSETS: Record<ThemeTab, ThemeAsset[]> = {
  themes: [
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
  ],
  table: TABLE_ASSETS,
  button: [
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
  ],
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
  table_id: 'neon_city',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
};

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
  const toast = useToast();
  const navigate = useNavigate();
  const [showVipPrompt, setShowVipPrompt] = useState(false);
  const [activeTab, setActiveTab] = useState<ThemeTab>('themes');
  const [gameType, setGameType] = useState<string>('ALL');
  const [selection, setSelection] = useState<ThemeSelection>({ ...DEFAULT_SELECTION });
  const [saving, setSaving] = useState(false);
  /** Card backs bought with diamonds in the store. See canAccessAsset. */
  const [ownedCardBacks, setOwnedCardBacks] = useState<string[]>([]);

  // The live selection, readable from a callback without making every callback
  // depend on it. handleSave needs the value it is replacing so it can put it
  // back if the write fails.
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

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
          .select('theme_id, table_id, button_id, background_id, cards_id')
          .eq('user_id', userId)
          .eq('game_type', gameType)
          .maybeSingle();

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

        if (data && mounted) {
          setSelection({
            theme_id: data.theme_id || DEFAULT_SELECTION.theme_id,
            // Normalised for the same reason cards_id is: rows hold legacy
            // aliases ('dark-felt', 'diamond-pattern' are both live in
            // production) which paint correctly but match no tile, so the tab
            // looked like it had forgotten the player's choice.
            table_id: normalizeFeltId(data.table_id || DEFAULT_SELECTION.table_id),
            button_id: data.button_id || DEFAULT_SELECTION.button_id,
            background_id: normalizeBackgroundId(
              data.background_id || DEFAULT_SELECTION.background_id
            ),
            // Dan 2026-08-20: normalise, or a row still holding one of the old
            // invented ids (standard-red, premium-platinum, ...) highlights no
            // tile at all and the tab looks like it forgot the user's choice.
            cards_id: normalizeCardBack(data.cards_id || DEFAULT_SELECTION.cards_id),
          });
        } else if (mounted) {
          // No saved theme for this game type — try ALL fallback
          if (gameType !== 'ALL') {
            const { data: fallback } = await supabase
              .from('user_theme_settings')
              .select('theme_id, table_id, button_id, background_id, cards_id')
              .eq('user_id', userId)
              .eq('game_type', 'ALL')
              .maybeSingle();

            if (fallback && mounted) {
              setSelection({
                theme_id: fallback.theme_id || DEFAULT_SELECTION.theme_id,
                table_id: normalizeFeltId(fallback.table_id || DEFAULT_SELECTION.table_id),
                button_id: fallback.button_id || DEFAULT_SELECTION.button_id,
                background_id: normalizeBackgroundId(
                  fallback.background_id || DEFAULT_SELECTION.background_id
                ),
                cards_id: normalizeCardBack(fallback.cards_id || DEFAULT_SELECTION.cards_id),
              });
            } else if (mounted) {
              setSelection({ ...DEFAULT_SELECTION });
            }
          } else if (mounted) {
            setSelection({ ...DEFAULT_SELECTION });
          }
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
  }, [isOpen, userId, gameType]);

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
    async (overrideSelection?: Partial<ThemeSelection>) => {
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
        toast.error('Please Sign In To Save Your Theme.');
        return false;
      }
      const previous = selectionRef.current;
      const currentToSave = { ...previous, ...(overrideSelection || {}) };
      setSaving(true);
      // 1. Live, before the network.
      masterBus.emit('UI_THEME_CHANGED', { key: gameType, value: currentToSave });
      try {
        const { error } = await supabase.from('user_theme_settings').upsert(
          {
            user_id: userId,
            game_type: gameType,
            ...currentToSave,
          },
          { onConflict: 'user_id,game_type' }
        );

        if (error) {
          setSelection(previous);
          masterBus.emit('UI_THEME_CHANGED', { key: gameType, value: previous });
          toast.error('Could Not Save Your Theme. Please Try Again.');
          reportError(error, 'ThemeSettingsModal.Save_failed');
        } else {
          toast.success('Theme Applied');
          // No longer closing modal on auto-save
        }
        setSaving(false);
        return !error;
      } catch (err) {
        setSelection(previous);
        masterBus.emit('UI_THEME_CHANGED', { key: gameType, value: previous });
        toast.error('Could Not Save Your Theme. Please Try Again.');
        reportError(err, 'ThemeSettingsModal.Unexpected_save_error');
        setSaving(false);
        return false;
      }
    },
    [userId, gameType, toast]
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
      setSelection((prev) => ({ ...prev, ...newSel }));
      void handleSave(newSel).then((ok) => {
        if (ok === false) setSelection(before);
      });
    },
    [isVip, ownedCardBacks, handleSave]
  );

  /**
   * RESET DID NOTHING (2026-08-25). It set local state and stopped: no write,
   * no bus emit, no toast. The grid snapped back to the defaults, the table
   * behind the modal kept the old theme, and the moment you closed and
   * reopened, your old theme was back — because it had never been replaced.
   * It now goes through exactly the same path as picking a tile.
   */
  const handleReset = useCallback(() => {
    setSelection({ ...DEFAULT_SELECTION });
    handleSave({ ...DEFAULT_SELECTION });
  }, [handleSave]);

  if (!isOpen) return null;

  const currentField = TAB_TO_FIELD[activeTab];
  const currentAssets = THEME_ASSETS[activeTab];
  const currentSelected = selection[currentField];

  return (
    <div className="theme-modal-overlay" onClick={onClose}>
      <div className="theme-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="theme-modal__header">
          <h3 className="theme-modal__title">Theme Settings</h3>
          <button className="theme-modal__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Game Type Selector */}
        <div className="theme-modal__game-type">
          <label className="theme-modal__game-label">Game Type:</label>
          <select
            className="theme-modal__game-select"
            value={gameType}
            onChange={(e) => setGameType(e.target.value)}
          >
            {GAME_TYPES.map((gt) => (
              <option key={gt} value={gt}>
                {GAME_TYPE_LABELS[gt] ?? gt}
              </option>
            ))}
          </select>
        </div>

        {/* Tab Bar */}
        <div className="theme-modal__tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              className={`theme-modal__tab ${activeTab === tab.key ? 'theme-modal__tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Asset Grid */}
        <div className="theme-modal__grid">
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
              <div
                key={asset.id}
                className={`theme-asset ${isSelected ? 'theme-asset--selected' : ''} ${isLocked ? 'theme-asset--locked' : ''}`}
                onClick={() => handleAssetSelect(activeTab, asset.id, asset.vipOnly)}
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
                {asset.vipOnly && !isLocked && <span className="theme-asset__tier-badge">VIP</span>}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="theme-modal__footer">
          <button className="theme-modal__btn theme-modal__btn--reset" onClick={handleReset}>
            Reset
          </button>
          <button
            className="theme-modal__btn theme-modal__btn--save"
            onClick={() => handleSave()}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Confirm'}
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
